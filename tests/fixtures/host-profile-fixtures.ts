import type { ExecutionHostProfile } from "../../src/index.js";

/** Illustrative wire profiles for MAR-3699, not recordings of real probes. */
export const linuxHostProfileFixture = {
  id: "linux-host",
  label: "Linux host",
  platform: { os: "linux", arch: "x64", osVersion: null },
  traits: [],
  toolchains: [],
  checkedAt: "2026-10-05T10:00:00.000Z",
} satisfies ExecutionHostProfile;

export const macHostProfileFixture = {
  id: "mac-mini",
  label: "Mac Mini",
  platform: { os: "darwin", arch: "arm64", osVersion: "26.0" },
  traits: ["xcode", "ios.simulator", "android.emulator"],
  toolchains: [{ id: "xcode", version: "26.0", build: "17A324" }],
  devices: {
    iosSimulator: {
      runtimes: [{ id: "ios-26", name: "iOS 26.0", version: "26.0" }],
      deviceTypes: ["com.apple.CoreSimulator.SimDeviceType.iPhone-17"],
      slots: { max: 2, inUse: 1 },
    },
    androidEmulator: {
      systemImages: [
        {
          id: "android-36;google_apis;arm64-v8a",
          apiLevel: 36,
          abi: "arm64-v8a",
        },
      ],
      avds: ["Pixel_9_API_36"],
      slots: { max: null, inUse: 0 },
    },
  },
  checkedAt: "2026-10-05T10:00:00.000Z",
} satisfies ExecutionHostProfile;
