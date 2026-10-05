import { describe, expect, it } from "vitest";
import {
  decodeExecutionHostProfile,
  decodeExecutionProtocolDescriptor,
  decodeExecutionStartRequest,
  encodeExecutionStartRequest,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROTOCOL_VERSION,
} from "../src/index.js";
import { startRequestWithEnvironmentFixture } from "./fixtures/contract-fixtures.js";
import {
  linuxHostProfileFixture,
  macHostProfileFixture,
} from "./fixtures/host-profile-fixtures.js";

describe("host profiles (MAR-3699)", () => {
  it.each([linuxHostProfileFixture, macHostProfileFixture])(
    "reads $id without inventing traits or devices",
    (profile) => {
      expect(decodeExecutionHostProfile(profile)).toEqual({
        ok: true,
        value: profile,
      });
    },
  );

  it("preserves new platforms and trait ids while ignoring unknown fields at every level", () => {
    const profile = {
      ...macHostProfileFixture,
      platform: { os: "freebsd", arch: "riscv64", osVersion: null },
      traits: ["future.device"],
    };
    const raw = structuredClone(profile);
    const extra = (value: object) =>
      Object.assign(value, { future: { value: true } });
    extra(raw);
    extra(raw.platform);
    extra(raw.toolchains[0]!);
    for (const device of Object.values(raw.devices)) {
      extra(device);
      extra(device.slots);
    }
    extra(raw.devices);
    extra(raw.devices.iosSimulator.runtimes[0]!);
    extra(raw.devices.androidEmulator.systemImages[0]!);
    expect(decodeExecutionHostProfile(raw)).toEqual({
      ok: true,
      value: profile,
    });
  });

  it("allows empty inventories, an unsaid toolchain build, and either device family alone", () => {
    for (const devices of [
      {},
      {
        iosSimulator: {
          runtimes: [],
          deviceTypes: [],
          slots: { max: 0, inUse: 0 },
        },
      },
      {
        androidEmulator: {
          systemImages: [],
          avds: [],
          slots: { max: null, inUse: 0 },
        },
      },
    ]) {
      const profile = {
        ...linuxHostProfileFixture,
        toolchains: [{ id: "sdk", version: "1" }],
        devices,
      };
      expect(decodeExecutionHostProfile(profile)).toEqual({
        ok: true,
        value: profile,
      });
    }
  });

  it.each(["id", "label", "platform", "traits", "toolchains", "checkedAt"])(
    "refuses a profile missing %s",
    (field) => {
      const raw: Record<string, unknown> = { ...linuxHostProfileFixture };
      delete raw[field];
      expect(decodeExecutionHostProfile(raw)).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
    },
  );

  const ios = macHostProfileFixture.devices.iosSimulator;
  const android = macHostProfileFixture.devices.androidEmulator;
  const invalid: Array<[string, unknown]> = [
    ["null", null],
    ["array", []],
    ["string", "host"],
    ["empty id", { ...linuxHostProfileFixture, id: "" }],
    ["numeric label", { ...linuxHostProfileFixture, label: 1 }],
    ["empty checkedAt", { ...linuxHostProfileFixture, checkedAt: "" }],
    ["null platform", { ...linuxHostProfileFixture, platform: null }],
    ...[
      {},
      { os: "linux", arch: "x64" },
      { os: "", arch: "x64", osVersion: null },
      { os: "linux", arch: 1, osVersion: null },
      { os: "linux", arch: "x64", osVersion: 1 },
    ].map((platform): [string, unknown] => [
      "invalid platform",
      { ...linuxHostProfileFixture, platform },
    ]),
    ...[null, "ios.simulator", [""], [1]].map((traits): [string, unknown] => [
      "invalid traits",
      { ...linuxHostProfileFixture, traits },
    ]),
    ...[
      null,
      {},
      [null],
      [{ id: "xcode" }],
      [{ id: "", version: "1" }],
      [{ id: "xcode", version: "" }],
      [{ id: "xcode", version: "1", build: null }],
    ].map((toolchains): [string, unknown] => [
      "invalid toolchain",
      { ...linuxHostProfileFixture, toolchains },
    ]),
    ...[
      null,
      [],
      { iosSimulator: null },
      { androidEmulator: {} },
      { iosSimulator: { ...ios, runtimes: [null] } },
      { iosSimulator: { ...ios, runtimes: [{ id: "i", name: "n" }] } },
      { iosSimulator: { ...ios, deviceTypes: [1] } },
      { androidEmulator: { ...android, avds: "avd" } },
      {
        androidEmulator: {
          ...android,
          systemImages: [{ id: "a", apiLevel: 0, abi: "arm64" }],
        },
      },
      {
        androidEmulator: {
          ...android,
          systemImages: [{ id: "a", apiLevel: 36.5, abi: "arm64" }],
        },
      },
      {
        androidEmulator: {
          ...android,
          systemImages: [{ id: "a", apiLevel: 36, abi: "" }],
        },
      },
    ].map((devices): [string, unknown] => [
      "invalid device inventory",
      { ...macHostProfileFixture, devices },
    ]),
  ];

  it.each(invalid)("refuses %s rather than dropping facts", (_label, raw) => {
    expect(decodeExecutionHostProfile(raw)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });

  it.each([
    null,
    {},
    { max: -1, inUse: 0 },
    { max: 1.5, inUse: 0 },
    { max: 2, inUse: -1 },
    { max: 2, inUse: 0.5 },
    { max: Infinity, inUse: 0 },
    { max: null, inUse: NaN },
    { max: null, inUse: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses invalid slots %j for both device families", (slots) => {
    for (const devices of [
      { iosSimulator: { ...ios, slots } },
      { androidEmulator: { ...android, slots } },
    ]) {
      expect(
        decodeExecutionHostProfile({ ...macHostProfileFixture, devices }),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });

  it("names each new capability without changing the wire version", () => {
    const capabilities = [
      "host.profile.v1",
      "devices.iosSimulator.v1",
      "devices.androidEmulator.v1",
    ];
    expect(EXECUTION_PROTOCOL_VERSION).toBe(1);
    for (const capability of capabilities)
      expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(capability);
    expect(
      decodeExecutionProtocolDescriptor({ version: 1, capabilities }),
    ).toEqual({ ok: true, value: { version: 1, capabilities } });
  });
});

describe("session start trait requirements", () => {
  it.each(
    [[], ["ios.simulator"], ["ios.simulator", "future.trait"]].map(
      (requires) => ({ requires }),
    ),
  )("round-trips %j", ({ requires }) => {
    const request = {
      ...startRequestWithEnvironmentFixture.value,
      requires,
      future: true,
    };
    expect(
      decodeExecutionStartRequest(encodeExecutionStartRequest(request)),
    ).toEqual({
      ok: true,
      value: { ...startRequestWithEnvironmentFixture.value, requires },
    });
  });

  it("keeps a legacy start byte-identical when requirements are absent", () => {
    const raw = encodeExecutionStartRequest(
      startRequestWithEnvironmentFixture.value,
    );
    const decoded = decodeExecutionStartRequest(raw);
    expect(decoded).toEqual({
      ok: true,
      value: startRequestWithEnvironmentFixture.value,
    });
    if (!decoded.ok) throw new Error(decoded.reason);
    expect("requires" in decoded.value).toBe(false);
    expect(encodeExecutionStartRequest(decoded.value)).toBe(raw);
  });

  it.each(
    [null, "ios.simulator", {}, [""], [1], ["ios.simulator", null]].map(
      (requires) => ({ requires }),
    ),
  )("refuses malformed requirements %j", ({ requires }) => {
    expect(
      decodeExecutionStartRequest(
        JSON.stringify({
          ...startRequestWithEnvironmentFixture.value,
          requires,
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });
});
