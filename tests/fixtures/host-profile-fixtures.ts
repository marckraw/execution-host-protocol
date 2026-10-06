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
 * `dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-4.xml`
 * (`sys-img2-5.xml` names the same levels): each `id` is a package path, and
 * its `<api-level>` string is split into `apiLevel` and `apiMinor`. `36x`,
 * an extension image, reports the level it extends. Four images say `37.1`:
 * the stable release, and previews told apart by `codename` and `id`.
 */
export const sdkRepositorySystemImagesFixture = [
  // <api-level>36</api-level>
  {
    id: "system-images;android-36;google_apis_playstore;arm64-v8a",
    apiLevel: 36,
    abi: "arm64-v8a",
  },
  // <api-level>36.1</api-level>
  {
    id: "system-images;android-36.1;google_apis_playstore;arm64-v8a",
    apiLevel: 36,
    apiMinor: 1,
    abi: "arm64-v8a",
  },
  // <api-level>37.0</api-level>
  {
    id: "system-images;android-37.0;google_apis_playstore;arm64-v8a",
    apiLevel: 37,
    apiMinor: 0,
    abi: "arm64-v8a",
  },
  // <api-level>37.1</api-level>
  {
    id: "system-images;android-37.1;google_apis_playstore_ps16k;arm64-v8a",
    apiLevel: 37,
    apiMinor: 1,
    abi: "arm64-v8a",
  },
  // <api-level>36x</api-level><extension-level>19</extension-level>
  {
    id: "system-images;android-36-ext19;google_apis_playstore;arm64-v8a",
    apiLevel: 36,
    abi: "arm64-v8a",
  },
  // <api-level>37.1</api-level><codename>CANARY</codename>
  {
    id: "system-images;android-CANARY;google_apis_playstore_ps16k;arm64-v8a",
    apiLevel: 37,
    apiMinor: 1,
    codename: "CANARY",
    abi: "arm64-v8a",
  },
  // <api-level>37.1</api-level><codename>CinnamonBun</codename>
  {
    id: "system-images;android-37.2-beta1;google_apis_playstore_ps16k;arm64-v8a",
    apiLevel: 37,
    apiMinor: 1,
    codename: "CinnamonBun",
    abi: "arm64-v8a",
  },
] satisfies ExecutionHostAndroidSystemImage[];
