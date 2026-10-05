import type {
  ExecutionDecodeResult,
  ExecutionHostAndroidEmulator,
  ExecutionHostDeviceSlots,
  ExecutionHostIosSimulator,
  ExecutionHostProfile,
  ExecutionHostToolchain,
} from "./types.js";

/**
 * Reads authenticated `GET /v0/host` (MAR-3699). Unknown fields, traits and
 * platforms are tolerated; malformed known fields refuse the whole profile
 * rather than claim that a host can run work its inventory does not support.
 */
export function decodeExecutionHostProfile(
  raw: unknown,
): ExecutionDecodeResult<ExecutionHostProfile> {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.label) ||
    !isRecord(raw.platform) ||
    !isNonEmptyString(raw.platform.os) ||
    !isNonEmptyString(raw.platform.arch) ||
    !(
      raw.platform.osVersion === null ||
      typeof raw.platform.osVersion === "string"
    ) ||
    !isStringArray(raw.traits) ||
    !isNonEmptyString(raw.checkedAt)
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  const toolchains = decodeList(raw.toolchains, decodeToolchain);
  const devices =
    raw.devices === undefined ? undefined : decodeDevices(raw.devices);
  if (toolchains === null || devices === null) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      id: raw.id,
      label: raw.label,
      platform: {
        os: raw.platform.os,
        arch: raw.platform.arch,
        osVersion: raw.platform.osVersion,
      },
      traits: [...raw.traits],
      toolchains,
      ...(devices === undefined ? {} : { devices }),
      checkedAt: raw.checkedAt,
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

function decodeDevices(raw: unknown): ExecutionHostProfile["devices"] | null {
  if (!isRecord(raw)) return null;
  const iosSimulator =
    raw.iosSimulator === undefined
      ? undefined
      : decodeIosSimulator(raw.iosSimulator);
  const androidEmulator =
    raw.androidEmulator === undefined
      ? undefined
      : decodeAndroidEmulator(raw.androidEmulator);
  if (iosSimulator === null || androidEmulator === null) return null;
  return {
    ...(iosSimulator === undefined ? {} : { iosSimulator }),
    ...(androidEmulator === undefined ? {} : { androidEmulator }),
  };
}

function decodeIosSimulator(raw: unknown): ExecutionHostIosSimulator | null {
  if (!isRecord(raw) || !isStringArray(raw.deviceTypes)) return null;
  const runtimes = decodeList(raw.runtimes, (entry) => {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.id) ||
      !isNonEmptyString(entry.name) ||
      !isNonEmptyString(entry.version)
    )
      return null;
    return { id: entry.id, name: entry.name, version: entry.version };
  });
  const slots = decodeSlots(raw.slots);
  if (runtimes === null || slots === null) return null;
  return { runtimes, deviceTypes: [...raw.deviceTypes], slots };
}

function decodeAndroidEmulator(
  raw: unknown,
): ExecutionHostAndroidEmulator | null {
  if (!isRecord(raw) || !isStringArray(raw.avds)) return null;
  const systemImages = decodeList(raw.systemImages, (entry) => {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.id) ||
      !isPositiveInteger(entry.apiLevel) ||
      !isNonEmptyString(entry.abi)
    )
      return null;
    return { id: entry.id, apiLevel: entry.apiLevel, abi: entry.abi };
  });
  const slots = decodeSlots(raw.slots);
  if (systemImages === null || slots === null) return null;
  return { systemImages, avds: [...raw.avds], slots };
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

function decodeList<T>(
  raw: unknown,
  read: (entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(raw)) return null;
  const result: T[] = [];
  for (const entry of raw) {
    const decoded = read(entry);
    if (decoded === null) return null;
    result.push(decoded);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}
