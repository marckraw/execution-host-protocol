import type {
  ExecutionHostAndroidSystemImage,
  ExecutionHostProfile,
} from "../../src/index.js";

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

/**
 * System images as the Android SDK repository names them (MAR-3725), recorded
 * on 6 Oct 2026 from the manifest `sdkmanager --list` reads,
 * `dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-4.xml`:
 * each `id` is a package path, `apiLevel` its `<api-level>`, and `codename`
 * its `<codename>`. The repository writes `37.0` and `36.1`; it writes `36x`
 * for an extension image, which a host reports as the level it extends, the
 * extension staying in the `id`. Previews name the level they build on.
 */
export const sdkRepositorySystemImagesFixture = [
  {
    id: "system-images;android-36;google_apis_playstore;arm64-v8a",
    apiLevel: 36,
    abi: "arm64-v8a",
  },
  {
    id: "system-images;android-36.1;google_apis_playstore;arm64-v8a",
    apiLevel: 36.1,
    abi: "arm64-v8a",
  },
  {
    id: "system-images;android-37.0;google_apis_playstore;arm64-v8a",
    apiLevel: 37.0,
    abi: "arm64-v8a",
  },
  {
    id: "system-images;android-36-ext19;google_apis_playstore;arm64-v8a",
    apiLevel: 36,
    abi: "arm64-v8a",
  },
  {
    id: "system-images;android-CANARY;google_apis_playstore_ps16k;arm64-v8a",
    apiLevel: 37.1,
    codename: "CANARY",
    abi: "arm64-v8a",
  },
  {
    id: "system-images;android-37.2-beta1;google_apis_playstore_ps16k;arm64-v8a",
    apiLevel: 37.1,
    codename: "CinnamonBun",
    abi: "arm64-v8a",
  },
] satisfies ExecutionHostAndroidSystemImage[];
