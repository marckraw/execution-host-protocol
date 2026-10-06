import {
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
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

type Warnings = ExecutionDecodeWarning[];

/**
 * Reads authenticated `GET /v0/host` (MAR-3699). Unknown fields, traits and
 * platforms are tolerated. The host's identity and platform are strict: one
 * unreadable is `invalid-payload`, with the field at `path`. The inventory
 * degrades instead (MAR-3725): an unreadable trait, toolchain, runtime, device
 * type, system image or AVD is dropped, and so is an unreadable device family,
 * each named in `warnings`. A drop under-claims; it never invents a tool.
 */
export function decodeExecutionHostProfile(
  raw: unknown,
): ExecutionDecodeResult<ExecutionHostProfile> {
  if (!isRecord(raw)) return { ok: false, reason: "invalid-payload" };
  const refused = (path: string) =>
    ({ ok: false, reason: "invalid-payload", path }) as const;
  const { platform } = raw;
  if (!isNonEmptyString(raw.id)) return refused("id");
  if (!isNonEmptyString(raw.label)) return refused("label");
  if (!isRecord(platform)) return refused("platform");
  if (!isNonEmptyString(platform.os)) return refused("platform.os");
  if (!isNonEmptyString(platform.arch)) return refused("platform.arch");
  if (!(platform.osVersion === null || typeof platform.osVersion === "string"))
    return refused("platform.osVersion");
  if (!Array.isArray(raw.traits)) return refused("traits");
  if (!Array.isArray(raw.toolchains)) return refused("toolchains");
  if (!isNonEmptyString(raw.checkedAt)) return refused("checkedAt");

  const warnings: Warnings = [];
  const traits = readList(raw.traits, "traits", warnings, (entry) =>
    isNonEmptyString(entry) ? entry : null,
  );
  const toolchains = readList(
    raw.toolchains,
    "toolchains",
    warnings,
    decodeToolchain,
  );
  const devices = decodeDevices(raw.devices, warnings);
  const profile: ExecutionHostProfile = {
    id: raw.id,
    label: raw.label,
    platform: {
      os: platform.os,
      arch: platform.arch,
      osVersion: platform.osVersion,
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
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.version) ||
    !(raw.build === undefined || isNonEmptyString(raw.build))
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
  warnings: Warnings,
): ExecutionHostProfile["devices"] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push({ reason: "dropped-invalid-field", path: "devices" });
    return undefined;
  }
  const family = <T>(
    key: string,
    read: (value: unknown, path: string, warnings: Warnings) => T | null,
  ): T | undefined => {
    if (raw[key] === undefined) return undefined;
    const path = `devices.${key}`;
    const decoded = read(raw[key], path, warnings);
    if (decoded === null) {
      warnings.push({ reason: "dropped-invalid-field", path });
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
  warnings: Warnings,
): ExecutionHostIosSimulator | null {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.runtimes) ||
    !Array.isArray(raw.deviceTypes)
  )
    return null;
  const slots = decodeSlots(raw.slots);
  if (slots === null) return null;
  const runtimes = readList(
    raw.runtimes,
    `${path}.runtimes`,
    warnings,
    (entry) =>
      isRecord(entry) &&
      isNonEmptyString(entry.id) &&
      isNonEmptyString(entry.name) &&
      isNonEmptyString(entry.version)
        ? { id: entry.id, name: entry.name, version: entry.version }
        : null,
  );
  const deviceTypes = readList(
    raw.deviceTypes,
    `${path}.deviceTypes`,
    warnings,
    (entry) => (isNonEmptyString(entry) ? entry : null),
  );
  return { runtimes, deviceTypes, slots };
}

function decodeAndroidEmulator(
  raw: unknown,
  path: string,
  warnings: Warnings,
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
    warnings,
    decodeSystemImage,
  );
  const avds = readList(raw.avds, `${path}.avds`, warnings, (entry) =>
    isNonEmptyString(entry) ? entry : null,
  );
  return { systemImages, avds, slots };
}

/**
 * The SDK repository names levels such as `36`, `36.1` and `37.0`, and
 * previews by codename over the level they build on (MAR-3725).
 */
function decodeSystemImage(
  raw: unknown,
): ExecutionHostAndroidSystemImage | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.id) ||
    typeof raw.apiLevel !== "number" ||
    !Number.isFinite(raw.apiLevel) ||
    raw.apiLevel <= 0 ||
    !(raw.codename === undefined || isNonEmptyString(raw.codename)) ||
    !isNonEmptyString(raw.abi)
  )
    return null;
  return {
    id: raw.id,
    apiLevel: raw.apiLevel,
    ...(raw.codename === undefined ? {} : { codename: raw.codename }),
    abi: raw.abi,
  };
}

function decodeSlots(raw: unknown): ExecutionHostDeviceSlots | null {
  if (
    !isRecord(raw) ||
    !(raw.max === null || isNonNegativeInteger(raw.max)) ||
    !isNonNegativeInteger(raw.inUse)
  )
    return null;
  return { max: raw.max, inUse: raw.inUse };
}

/** The readable entries of a list, each unreadable one named at `path.index`. */
function readList<T>(
  raw: unknown[],
  path: string,
  warnings: Warnings,
  read: (entry: unknown) => T | null,
): T[] {
  const result: T[] = [];
  raw.forEach((entry, index) => {
    const decoded = read(entry);
    if (decoded === null) {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `${path}.${index}`,
      });
    } else {
      result.push(decoded);
    }
  });
  return result;
}
