import {
  isBoundedString,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isStringArray,
} from "./guards.js";
import {
  EXECUTION_START_REQUIREMENTS_UNMET,
  type ExecutionDecodeResult,
  type ExecutionDecodeWarning,
  type ExecutionHostAndroidEmulator,
  type ExecutionHostAndroidSystemImage,
  type ExecutionHostDeviceSlots,
  type ExecutionHostIosSimulator,
  type ExecutionHostProfile,
  type ExecutionHostToolchain,
  type ExecutionStartRequirementsRefusal,
} from "./types.js";

/** The longest id, name, version or label a profile may carry. */
const MAX_PROFILE_STRING_LENGTH = 256;
/** The most entries read from one list; the rest are dropped, named once. */
const MAX_PROFILE_LIST_ENTRIES = 1024;
/** The most dropped entries one profile names; past it, they go unnamed. */
const MAX_PROFILE_ENTRY_WARNINGS = 64;

/**
 * Names what a profile had to drop. A dropped entry is named until 64 are;
 * a dropped `devices` or device family, and a list cut at its cap, are always
 * named: there are at most eight of them, and each loses more than an entry.
 */
interface Drops {
  entry(path: string): void;
  whole(path: string): void;
  cut(path: string): void;
}

const isProfileString = (value: unknown): value is string =>
  isBoundedString(value, MAX_PROFILE_STRING_LENGTH);

/**
 * Reads authenticated `GET /v0/host` (MAR-3699). Unknown fields, traits and
 * platforms are tolerated. The host's identity and platform are strict: one
 * unreadable is `invalid-payload`, with the field at `path`. The inventory
 * degrades instead (MAR-3725): an unreadable trait, toolchain, runtime, device
 * type, system image or AVD is dropped, and so is an unreadable device family,
 * each named in `warnings`. A drop under-claims; it never invents a tool.
 *
 * Bounded, so a hostile body costs little: strings are 1 to 256 characters,
 * a list is read to its 1024th entry and the rest named once, as
 * `dropped-excess-entries` at the list's path, and at most 64 dropped entries
 * are named. A dropped `devices` or device family is always named.
 */
export function decodeExecutionHostProfile(
  raw: unknown,
): ExecutionDecodeResult<ExecutionHostProfile> {
  if (!isRecord(raw)) return { ok: false, reason: "invalid-payload" };
  const refused = (path: string) =>
    ({ ok: false, reason: "invalid-payload", path }) as const;
  const { platform } = raw;
  if (!isProfileString(raw.id)) return refused("id");
  if (!isProfileString(raw.label)) return refused("label");
  if (!isRecord(platform)) return refused("platform");
  if (!isProfileString(platform.os)) return refused("platform.os");
  if (!isProfileString(platform.arch)) return refused("platform.arch");
  if (!(
    platform.osVersion === null ||
    (typeof platform.osVersion === "string" &&
      platform.osVersion.length <= MAX_PROFILE_STRING_LENGTH)
  ))
    return refused("platform.osVersion");
  if (!Array.isArray(raw.traits)) return refused("traits");
  if (!Array.isArray(raw.toolchains)) return refused("toolchains");
  if (!isProfileString(raw.checkedAt)) return refused("checkedAt");

  const warnings: ExecutionDecodeWarning[] = [];
  let namedEntries = 0;
  const warn: Drops = {
    entry: (path) => {
      if (namedEntries >= MAX_PROFILE_ENTRY_WARNINGS) return;
      namedEntries += 1;
      warnings.push({ reason: "dropped-invalid-field", path });
    },
    whole: (path) => warnings.push({ reason: "dropped-invalid-field", path }),
    cut: (path) => warnings.push({ reason: "dropped-excess-entries", path }),
  };
  const traits = readList(raw.traits, "traits", warn, (entry) =>
    isProfileString(entry) ? entry : null,
  );
  const toolchains = readList(
    raw.toolchains,
    "toolchains",
    warn,
    decodeToolchain,
  );
  const devices = decodeDevices(raw.devices, warn);
  const profile: ExecutionHostProfile = {
    id: raw.id,
    label: raw.label,
    platform: {
      os: platform.os,
      arch: platform.arch,
      osVersion: platform.osVersion as string | null,
    },
    traits,
    toolchains,
    ...(devices === undefined ? {} : { devices }),
    checkedAt: raw.checkedAt,
  };
  return warnings.length > 0
    ? { ok: true, value: profile, warnings }
    : { ok: true, value: profile };
}

/**
 * Whether a host's 201 for a start, or its 409 for a session it already has,
 * echoes every trait the start required (`start.requires.v1`, MAR-3725). An
 * answer without the echo, from a process that dropped `requires` whatever
 * `/health` said, confirms nothing. An echo entry that is not a trait id is
 * ignored rather than held against an honest host.
 */
export function confirmsExecutionStartRequirements(
  answer: unknown,
  requires: readonly string[],
): boolean {
  if (!isRecord(answer) || !Array.isArray(answer.requires)) return false;
  const checked = new Set(answer.requires);
  return requires.every((trait) => checked.has(trait));
}

/**
 * Reads a host's refusal of a start whose `requires` it cannot meet
 * (`start.requires.v1`, MAR-3725). Any other refusal body, including one
 * from a host predating the code, is `invalid-payload`.
 */
export function decodeExecutionStartRequirementsRefusal(
  raw: unknown,
): ExecutionDecodeResult<ExecutionStartRequirementsRefusal> {
  if (
    !isRecord(raw) ||
    raw.code !== EXECUTION_START_REQUIREMENTS_UNMET ||
    !isStringArray(raw.missingTraits) ||
    raw.missingTraits.length === 0
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      error:
        typeof raw.error === "string" && raw.error.trim() !== ""
          ? raw.error
          : `Missing required host traits: ${raw.missingTraits.join(", ")}`,
      code: EXECUTION_START_REQUIREMENTS_UNMET,
      missingTraits: [...raw.missingTraits],
    },
  };
}

function decodeToolchain(raw: unknown): ExecutionHostToolchain | null {
  if (
    !isRecord(raw) ||
    !isProfileString(raw.id) ||
    !isProfileString(raw.version) ||
    !(raw.build === undefined || isProfileString(raw.build))
  ) {
    return null;
  }
  return {
    id: raw.id,
    version: raw.version,
    ...(raw.build === undefined ? {} : { build: raw.build }),
  };
}

function decodeDevices(
  raw: unknown,
  warn: Drops,
): ExecutionHostProfile["devices"] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warn.whole("devices");
    return undefined;
  }
  const family = <T>(
    key: string,
    read: (value: unknown, path: string, warn: Drops) => T | null,
  ): T | undefined => {
    if (raw[key] === undefined) return undefined;
    const path = `devices.${key}`;
    const decoded = read(raw[key], path, warn);
    if (decoded === null) {
      warn.whole(path);
      return undefined;
    }
    return decoded;
  };
  const iosSimulator = family("iosSimulator", decodeIosSimulator);
  const androidEmulator = family("androidEmulator", decodeAndroidEmulator);
  return {
    ...(iosSimulator === undefined ? {} : { iosSimulator }),
    ...(androidEmulator === undefined ? {} : { androidEmulator }),
  };
}

/** A family is dropped whole when its lists or slots are unreadable; one entry, alone. */
function decodeIosSimulator(
  raw: unknown,
  path: string,
  warn: Drops,
): ExecutionHostIosSimulator | null {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.runtimes) ||
    !Array.isArray(raw.deviceTypes)
  )
    return null;
  const slots = decodeSlots(raw.slots);
  if (slots === null) return null;
  const runtimes = readList(raw.runtimes, `${path}.runtimes`, warn, (entry) =>
    isRecord(entry) &&
    isProfileString(entry.id) &&
    isProfileString(entry.name) &&
    isProfileString(entry.version)
      ? { id: entry.id, name: entry.name, version: entry.version }
      : null,
  );
  const deviceTypes = readList(
    raw.deviceTypes,
    `${path}.deviceTypes`,
    warn,
    (entry) => (isProfileString(entry) ? entry : null),
  );
  return { runtimes, deviceTypes, slots };
}

function decodeAndroidEmulator(
  raw: unknown,
  path: string,
  warn: Drops,
): ExecutionHostAndroidEmulator | null {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.systemImages) ||
    !Array.isArray(raw.avds)
  )
    return null;
  const slots = decodeSlots(raw.slots);
  if (slots === null) return null;
  const systemImages = readList(
    raw.systemImages,
    `${path}.systemImages`,
    warn,
    decodeSystemImage,
  );
  const avds = readList(raw.avds, `${path}.avds`, warn, (entry) =>
    isProfileString(entry) ? entry : null,
  );
  return { systemImages, avds, slots };
}

/**
 * The SDK repository names levels as strings: `36`, `36.1`, `37.0`, and `36x`
 * for an extension image. A host splits them into an integer `apiLevel` and
 * `apiMinor`, never a float, which would read `37.0` as `37` and `36.10` as
 * `36.1` (MAR-3725).
 */
function decodeSystemImage(
  raw: unknown,
): ExecutionHostAndroidSystemImage | null {
  if (
    !isRecord(raw) ||
    !isProfileString(raw.id) ||
    !isSafePositiveInteger(raw.apiLevel) ||
    !(raw.apiMinor === undefined || isSafeNonNegativeInteger(raw.apiMinor)) ||
    !(raw.codename === undefined || isProfileString(raw.codename)) ||
    !isProfileString(raw.abi)
  )
    return null;
  return {
    id: raw.id,
    apiLevel: raw.apiLevel,
    ...(raw.apiMinor === undefined ? {} : { apiMinor: raw.apiMinor }),
    ...(raw.codename === undefined ? {} : { codename: raw.codename }),
    abi: raw.abi,
  };
}

/** Counts a reader holds exactly; one past 2^53 is not the count the host sent. */
function decodeSlots(raw: unknown): ExecutionHostDeviceSlots | null {
  if (
    !isRecord(raw) ||
    !(raw.max === null || isSafeNonNegativeInteger(raw.max)) ||
    !isSafeNonNegativeInteger(raw.inUse)
  )
    return null;
  return { max: raw.max, inUse: raw.inUse };
}

/**
 * The readable entries of a list, each unreadable one named at `path.index`.
 * Past the cap the rest are dropped unread, named once at `path`.
 */
function readList<T>(
  raw: unknown[],
  path: string,
  warn: Drops,
  read: (entry: unknown) => T | null,
): T[] {
  const result: T[] = [];
  const readable = Math.min(raw.length, MAX_PROFILE_LIST_ENTRIES);
  for (let index = 0; index < readable; index += 1) {
    const decoded = read(raw[index]);
    if (decoded === null) warn.entry(`${path}.${index}`);
    else result.push(decoded);
  }
  if (raw.length > readable) warn.cut(path);
  return result;
}
