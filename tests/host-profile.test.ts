import { describe, expect, it } from "vitest";
import {
  decodeExecutionHostProfile,
  decodeExecutionProtocolDescriptor,
  decodeExecutionStartRequest,
  decodeExecutionStartRequirementsRefusal,
  encodeExecutionStartRequest,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROTOCOL_VERSION,
} from "../src/index.js";
import { startRequestWithEnvironmentFixture } from "./fixtures/contract-fixtures.js";
import {
  linuxHostProfileFixture,
  macHostProfileFixture,
  sdkRepositorySystemImagesFixture,
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
    "refuses a profile missing %s, naming it",
    (field) => {
      const raw: Record<string, unknown> = { ...linuxHostProfileFixture };
      delete raw[field];
      expect(decodeExecutionHostProfile(raw)).toEqual({
        ok: false,
        reason: "invalid-payload",
        path: field,
      });
    },
  );

  it.each([null, [], "host"])("refuses %j, which is no profile", (raw) => {
    expect(decodeExecutionHostProfile(raw)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });

  const linux = linuxHostProfileFixture;
  it.each([
    ["id", { ...linux, id: "" }],
    ["label", { ...linux, label: 1 }],
    ["checkedAt", { ...linux, checkedAt: "" }],
    ["platform", { ...linux, platform: null }],
    ["platform.os", { ...linux, platform: {} }],
    ["platform.os", { ...linux, platform: { ...linux.platform, os: "" } }],
    ["platform.arch", { ...linux, platform: { ...linux.platform, arch: 1 } }],
    [
      "platform.osVersion",
      { ...linux, platform: { os: "linux", arch: "x64" } },
    ],
    [
      "platform.osVersion",
      { ...linux, platform: { ...linux.platform, osVersion: 1 } },
    ],
    ["traits", { ...linux, traits: null }],
    ["traits", { ...linux, traits: "ios.simulator" }],
    ["toolchains", { ...linux, toolchains: {} }],
  ])(
    "keeps identity and platform strict: refuses an unreadable %s",
    (path, raw) => {
      expect(decodeExecutionHostProfile(raw)).toEqual({
        ok: false,
        reason: "invalid-payload",
        path,
      });
    },
  );

  const ios = macHostProfileFixture.devices.iosSimulator;
  const android = macHostProfileFixture.devices.androidEmulator;
  const dropped = (...paths: string[]) =>
    paths.map((path) => ({ reason: "dropped-invalid-field", path }));

  it.each([
    [
      "traits.1",
      { traits: ["xcode", "", "ios.simulator", 1] },
      { traits: ["xcode", "ios.simulator"] },
      ["traits.1", "traits.3"],
    ],
    ...[
      null,
      { id: "xcode" },
      { id: "", version: "1" },
      { id: "xcode", version: "" },
      { id: "xcode", version: "1", build: null },
    ].map((bad) => [
      `toolchain ${JSON.stringify(bad)}`,
      { toolchains: [bad, ...macHostProfileFixture.toolchains] },
      { toolchains: macHostProfileFixture.toolchains },
      ["toolchains.0"],
    ]),
    ...[null, { id: "i", name: "n" }, { id: "i", name: "", version: "1" }].map(
      (bad) => [
        `runtime ${JSON.stringify(bad)}`,
        {
          devices: {
            ...macHostProfileFixture.devices,
            iosSimulator: { ...ios, runtimes: [...ios.runtimes, bad] },
          },
        },
        {},
        ["devices.iosSimulator.runtimes.1"],
      ],
    ),
    [
      "device type",
      {
        devices: {
          ...macHostProfileFixture.devices,
          iosSimulator: { ...ios, deviceTypes: [1, ...ios.deviceTypes] },
        },
      },
      {},
      ["devices.iosSimulator.deviceTypes.0"],
    ],
    ...[
      { id: "a", apiLevel: 0, abi: "arm64" },
      { id: "a", apiLevel: -36, abi: "arm64" },
      { id: "a", apiLevel: "36.1", abi: "arm64" },
      { id: "a", apiLevel: 36, abi: "" },
      { id: "a", apiLevel: 36, codename: "", abi: "arm64" },
      { id: "a", apiLevel: 36, codename: null, abi: "arm64" },
    ].map((bad) => [
      `system image ${JSON.stringify(bad)}`,
      {
        devices: {
          ...macHostProfileFixture.devices,
          androidEmulator: {
            ...android,
            systemImages: [bad, ...android.systemImages],
          },
        },
      },
      {},
      ["devices.androidEmulator.systemImages.0"],
    ]),
    [
      "AVD",
      {
        devices: {
          ...macHostProfileFixture.devices,
          androidEmulator: { ...android, avds: [...android.avds, ""] },
        },
      },
      {},
      ["devices.androidEmulator.avds.1"],
    ],
  ] as Array<[string, object, object, string[]]>)(
    "drops an unreadable %s and keeps the rest of the profile",
    (_label, change, kept, paths) => {
      expect(
        decodeExecutionHostProfile({ ...macHostProfileFixture, ...change }),
      ).toEqual({
        ok: true,
        value: { ...macHostProfileFixture, ...kept },
        warnings: dropped(...paths),
      });
    },
  );

  it.each([
    null,
    "simulator",
    [],
    {},
    { ...ios, runtimes: null },
    { ...ios, deviceTypes: "iPhone" },
    { ...ios, slots: undefined },
  ])(
    "drops an unreadable iOS family %j, keeping identity and Android",
    (iosSimulator) => {
      expect(
        decodeExecutionHostProfile({
          ...macHostProfileFixture,
          devices: { ...macHostProfileFixture.devices, iosSimulator },
        }),
      ).toEqual({
        ok: true,
        value: {
          ...macHostProfileFixture,
          devices: { androidEmulator: android },
        },
        warnings: dropped("devices.iosSimulator"),
      });
    },
  );

  it.each([
    { ...android, systemImages: {} },
    { ...android, avds: "avd" },
  ])("drops an unreadable Android family %j", (androidEmulator) => {
    expect(
      decodeExecutionHostProfile({
        ...macHostProfileFixture,
        devices: { iosSimulator: ios, androidEmulator },
      }),
    ).toEqual({
      ok: true,
      value: { ...macHostProfileFixture, devices: { iosSimulator: ios } },
      warnings: dropped("devices.androidEmulator"),
    });
  });

  it.each([null, [], "devices"])(
    "drops unreadable devices %j as unknown, not empty",
    (devices) => {
      expect(
        decodeExecutionHostProfile({ ...linuxHostProfileFixture, devices }),
      ).toEqual({
        ok: true,
        value: linuxHostProfileFixture,
        warnings: dropped("devices"),
      });
    },
  );

  it.each([
    null,
    {},
    { max: -1, inUse: 0 },
    { max: 1.5, inUse: 0 },
    { max: 2, inUse: -1 },
    { max: 2, inUse: 0.5 },
    { max: Infinity, inUse: 0 },
    { max: null, inUse: NaN },
  ])("drops a device family whose slots are %j", (slots) => {
    expect(
      decodeExecutionHostProfile({
        ...macHostProfileFixture,
        devices: {
          iosSimulator: { ...ios, slots },
          androidEmulator: { ...android, slots },
        },
      }),
    ).toEqual({
      ok: true,
      value: { ...macHostProfileFixture, devices: {} },
      warnings: dropped("devices.iosSimulator", "devices.androidEmulator"),
    });
  });

  it("reads the API levels the Android SDK repository really names", () => {
    const profile = {
      ...macHostProfileFixture,
      devices: {
        androidEmulator: {
          ...android,
          systemImages: sdkRepositorySystemImagesFixture,
        },
      },
    };
    expect(decodeExecutionHostProfile(profile)).toEqual({
      ok: true,
      value: profile,
    });
  });

  it("carries no protocolVersion, and ignores one a host sends", () => {
    expect(
      decodeExecutionHostProfile({
        ...linuxHostProfileFixture,
        protocolVersion: 2,
      }),
    ).toEqual({ ok: true, value: linuxHostProfileFixture });
  });

  it("names each new capability without changing the wire version", () => {
    const capabilities = [
      "host.profile.v1",
      "devices.iosSimulator.v1",
      "devices.androidEmulator.v1",
      "start.requires.v1",
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

describe("a host's refusal of unmet requirements (MAR-3725)", () => {
  it("reads the code and the missing traits", () => {
    const refusal = {
      error: "Missing required host traits: ios.simulator",
      code: "requirements-unmet",
      missingTraits: ["ios.simulator"],
      future: true,
    };
    expect(decodeExecutionStartRequirementsRefusal(refusal)).toEqual({
      ok: true,
      value: {
        error: refusal.error,
        code: refusal.code,
        missingTraits: refusal.missingTraits,
      },
    });
  });

  it("says what is missing when the host gives no words", () => {
    expect(
      decodeExecutionStartRequirementsRefusal({
        code: "requirements-unmet",
        missingTraits: ["ios.simulator", "xcode"],
      }),
    ).toMatchObject({
      ok: true,
      value: { error: "Missing required host traits: ios.simulator, xcode" },
    });
  });

  it.each([
    null,
    { error: "Missing required host traits: ios.simulator" },
    { code: "other", missingTraits: ["ios.simulator"] },
    { code: "requirements-unmet" },
    { code: "requirements-unmet", missingTraits: [] },
    { code: "requirements-unmet", missingTraits: [""] },
  ])("does not mistake %j for one", (raw) => {
    expect(decodeExecutionStartRequirementsRefusal(raw)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});
