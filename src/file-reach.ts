import {
  isBoundedString,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
} from "./guards.js";
import type { ExecutionDecodeResult, ExecutionDecodeWarning } from "./types.js";

/**
 * A session's file reach (MAR-4352): which of its places the host's kernel
 * lets its provider, and everything that provider starts, touch. A host
 * advertising `start.fileReach.v1` takes `fileReach` on a start, holds the
 * session to it, or refuses the start with an `ExecutionFileReachRefusal`;
 * it never starts the session with less of a fence than it was asked for.
 *
 * A reach names places, never a host's paths: the host maps each to the
 * session's own folder, and no real path travels here.
 *
 * ```text
 * path    = "{" place "}" *( "/" segment ) [ "/**" ]
 * segment = 1*( ALPHA / DIGIT / "." / "_" / "-" / "@" / "+" ), never "." or ".."
 * access  = "read" | "write"     ; write includes read
 * ```
 *
 * A rule on a folder covers everything in it; a trailing `/**` says so for
 * the reader, and means the same. Rights add up: a `write` entry inside a
 * `read` one makes that folder writable.
 */

/**
 * The places this protocol names. `worktree`: the session's own checkout, or
 * its own scratch folder. `tmp`: its own temporary folder, its TMPDIR.
 * `clone`: the shared clone its worktree came from. `home`: its own HOME, its
 * provider's state and config. `attachments`: the files sent to it. A host
 * advertises the ones it knows, and may know more.
 */
export const EXECUTION_FILE_REACH_PLACES = [
  "worktree",
  "tmp",
  "clone",
  "home",
  "attachments",
] as const;
export type KnownExecutionFileReachPlace =
  (typeof EXECUTION_FILE_REACH_PLACES)[number];
export type ExecutionFileReachPlace =
  KnownExecutionFileReachPlace | (string & {});

/** `read` also lists and runs; `write` also creates, changes, renames and removes. */
export const EXECUTION_FILE_REACH_ACCESS = ["read", "write"] as const;
export type ExecutionFileReachAccess =
  (typeof EXECUTION_FILE_REACH_ACCESS)[number];

export interface ExecutionFileReachEntry {
  /** `{worktree}`, `{worktree}/apps/server/src/**`, ...: never an absolute path. */
  path: string;
  access: ExecutionFileReachAccess;
}

/**
 * `ExecutionStartRequest.fileReach`: what the session may touch, at most
 * `EXECUTION_FILE_REACH_MAX_ENTRIES` entries. It can only narrow what the
 * host would give the session: an entry past the host's ceiling is refused,
 * never granted. The host adds what every fenced process reads (its
 * toolchain) and its floor (`ExecutionHostFileReach.floor`).
 */
export interface ExecutionFileReach {
  entries: ExecutionFileReachEntry[];
}

export const EXECUTION_FILE_REACH_MAX_ENTRIES = 32;
export const EXECUTION_FILE_REACH_PATH_MAX_LENGTH = 256;

/**
 * The oldest Landlock a fence holds with: ABI 4, Linux 6.7. Below it there
 * is no `REFER` across directories, no `TRUNCATE` and no TCP rights a host
 * relies on, so a fence claimed on it is no fence: an advertisement or an
 * echo naming an older ABI is read as none.
 */
export const EXECUTION_FILE_REACH_MIN_LANDLOCK_ABI = 4;

/**
 * How a host holds a session to a reach: `fileReach` in authenticated
 * `GET /v0/host`, on a host advertising `start.fileReach.v1`.
 *
 * - `fence`: `landlock` where this host fences sessions (Linux's Landlock,
 *   its self-test passed at boot); `none` where it can't, and refuses every
 *   start carrying a reach, coded `cannot-fence`. Open to fences this reader
 *   does not know: anything but `landlock` is a fence it can't describe.
 * - `abi`: the kernel's Landlock ABI where it was asked; null where not. A
 *   `landlock` fence names `EXECUTION_FILE_REACH_MIN_LANDLOCK_ABI` (4) or
 *   newer: one that doesn't is unreadable, and dropped.
 * - `places`: the places a reach may name here.
 * - `ceiling`: the most each place may be granted. A place left out is never
 *   granted. Empty where the fence is `none`.
 * - `floor`: places every fenced session here gets to write, whatever its
 *   reach says: its own `home` and `tmp`, which its provider can't run
 *   without, and which hold nothing of anyone else's.
 * - `reason`: why there is no fence, where there isn't, for a person.
 */
export interface ExecutionHostFileReach {
  fence: "landlock" | "none" | (string & {});
  abi: number | null;
  places: ExecutionFileReachPlace[];
  ceiling: Partial<Record<ExecutionFileReachPlace, ExecutionFileReachAccess>>;
  floor: ExecutionFileReachPlace[];
  reason?: string;
}

/** The `code` of a host's refusal of a start's `fileReach`. */
export const EXECUTION_FILE_REACH_REFUSED = "file-reach-refused";

/**
 * Why a host refuses a reach, each about one entry unless it says otherwise.
 *
 * - `unknown-place`: the entry names no place the host knows (or no place).
 * - `escapes-place`: an absolute path, `.` or `..`, an empty segment, a
 *   character a segment can't hold, or a symlink: it isn't a plain path
 *   below its place.
 * - `past-ceiling`: it asks for more than the host allows that place.
 * - `path-missing`: its path isn't there when the session starts (refused,
 *   never skipped: a rule on nothing grants nothing).
 * - `cannot-fence`: about the whole reach (`entry: null`): this host, or this
 *   session's provider or folder, can't be fenced.
 */
export const EXECUTION_FILE_REACH_PROBLEMS = [
  "unknown-place",
  "escapes-place",
  "past-ceiling",
  "path-missing",
  "cannot-fence",
] as const;
export type ExecutionFileReachProblemCode =
  (typeof EXECUTION_FILE_REACH_PROBLEMS)[number];

export interface ExecutionFileReachProblem {
  problem: ExecutionFileReachProblemCode;
  /** The index of the entry in `fileReach.entries`; null for the whole reach. */
  entry: number | null;
}

/**
 * The body of a host's refusal of a start's reach, sent with a 400 before
 * anything is prepared. `code` is what a client branches on; `problems` say
 * which entry and why, never empty; `error` is for a person.
 */
export interface ExecutionFileReachRefusal {
  error: string;
  code: typeof EXECUTION_FILE_REACH_REFUSED;
  problems: ExecutionFileReachProblem[];
}

/**
 * What a host advertising `start.fileReach.v1` adds to its answer to a start
 * carrying `fileReach`: on a 201, the entries it holds the session to, as
 * they were asked, and the ABI it fences with. On a 409, the same for the
 * session it already has, or null when that one runs with no reach of the
 * wire's. A process that dropped `fileReach` answers without it.
 */
export interface ExecutionFileReachEcho {
  fileReach: { entries: ExecutionFileReachEntry[]; abi: number } | null;
}

/** Whether `abi` is a Landlock ABI a fence holds with: an integer, 4 or newer. */
function isUsableLandlockAbi(abi: unknown): abi is number {
  return (
    isSafePositiveInteger(abi) && abi >= EXECUTION_FILE_REACH_MIN_LANDLOCK_ABI
  );
}

/** Whether an advertisement is a fence a reach can be held to. */
function fencesWithLandlock(host: ExecutionHostFileReach): boolean {
  return host.fence === "landlock" && isUsableLandlockAbi(host.abi);
}

const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const PLACE = /^\{([^{}/]*)\}(?:\/(.*))?$/;

/**
 * A reach path's place and the segments below it, or why it isn't one: an
 * absolute path or one that is no plain path below its place is
 * `escapes-place`, one naming no place `unknown-place`. Whether the place is
 * one a host knows is the caller's question. A trailing `/**` is dropped:
 * it means what the path means without it, `{worktree}/**` included.
 */
export function parseExecutionFileReachPath(
  path: string,
):
  | { ok: true; place: string; segments: string[] }
  | { ok: false; problem: "unknown-place" | "escapes-place" } {
  if (path.startsWith("/")) return { ok: false, problem: "escapes-place" };
  const match = PLACE.exec(path);
  if (!match || !match[1]) return { ok: false, problem: "unknown-place" };
  const below = match[2];
  if (below === undefined) return { ok: true, place: match[1], segments: [] };
  const segments = below.split("/");
  if (segments.at(-1) === "**") segments.pop();
  // `{worktree}/**` is `{worktree}`; an empty segment, `{worktree}/` or
  // `{worktree}//**` included, never is.
  if (
    segments.some(
      (segment) =>
        !SEGMENT.test(segment) || segment === "." || segment === "..",
    )
  ) {
    return { ok: false, problem: "escapes-place" };
  }
  return { ok: true, place: match[1], segments };
}

/**
 * What a host would refuse in `reach`, from what it advertises: every entry
 * that names no place it knows, escapes its place, or asks past its ceiling,
 * and `cannot-fence` where it has no fence (anything but `landlock` on ABI
 * 4 or newer). Empty where the host would take
 * it, as far as an advertisement can tell: whether each path is there is
 * the host's to say (`path-missing`). A host checks a start's reach with it
 * before anything is prepared; a client may, before anything is sent.
 */
export function executionFileReachProblems(
  reach: ExecutionFileReach,
  host: ExecutionHostFileReach,
): ExecutionFileReachProblem[] {
  const problems: ExecutionFileReachProblem[] = [];
  if (!fencesWithLandlock(host)) {
    problems.push({ problem: "cannot-fence", entry: null });
  }
  reach.entries.forEach((entry, index) => {
    const parsed = parseExecutionFileReachPath(entry.path);
    if (!parsed.ok) {
      problems.push({ problem: parsed.problem, entry: index });
      return;
    }
    if (!host.places.includes(parsed.place)) {
      problems.push({ problem: "unknown-place", entry: index });
      return;
    }
    const most = Object.hasOwn(host.ceiling, parsed.place)
      ? host.ceiling[parsed.place]
      : undefined;
    if (!most || (entry.access === "write" && most === "read")) {
      problems.push({ problem: "past-ceiling", entry: index });
    }
  });
  return problems;
}

/**
 * Whether `raw` is a reach a start may carry: an object whose `entries` are
 * at most 32, each a path of 1 to 256 characters with an access of `read` or
 * `write`. Unknown fields are tolerated. What the paths say is the host's to
 * judge, with its coded refusal.
 */
export function isExecutionFileReach(raw: unknown): raw is ExecutionFileReach {
  return (
    isRecord(raw) &&
    Array.isArray(raw.entries) &&
    raw.entries.length <= EXECUTION_FILE_REACH_MAX_ENTRIES &&
    raw.entries.every(isFileReachEntry)
  );
}

function isFileReachEntry(raw: unknown): raw is ExecutionFileReachEntry {
  return (
    isRecord(raw) &&
    isBoundedString(raw.path, EXECUTION_FILE_REACH_PATH_MAX_LENGTH) &&
    (EXECUTION_FILE_REACH_ACCESS as readonly unknown[]).includes(raw.access)
  );
}

/** A reach as a start carries it: its entries, and nothing else. */
export function readExecutionFileReach(
  reach: ExecutionFileReach,
): ExecutionFileReach {
  return {
    entries: reach.entries.map((entry) => ({
      path: entry.path,
      access: entry.access,
    })),
  };
}

const MAX_PLACE_LENGTH = 64;
const MAX_REASON_LENGTH = 1024;
const MAX_PLACES = 64;
const isPlace = (value: unknown): value is string =>
  isBoundedString(value, MAX_PLACE_LENGTH);

/**
 * Reads a host's `fileReach` from its profile. Unknown fields and places are
 * tolerated; an unreadable place, ceiling entry or floor entry is dropped and
 * named, which under-claims. A `fence`, `abi`, `places`, `ceiling` or
 * `floor` that doesn't read leaves nothing to trust: `invalid-payload`, and
 * the profile drops `fileReach` whole, as a host that can't fence. So does a
 * `landlock` fence whose `abi` is null or below 4.
 */
export function decodeExecutionHostFileReach(
  raw: unknown,
  path = "fileReach",
): ExecutionDecodeResult<ExecutionHostFileReach> {
  const refused = { ok: false as const, reason: "invalid-payload" as const };
  if (!isRecord(raw)) return refused;
  if (!isPlace(raw.fence)) return refused;
  if (!(raw.abi === null || isSafeNonNegativeInteger(raw.abi))) return refused;
  // A Landlock fence on an ABI too old to hold one claims what it can't.
  if (raw.fence === "landlock" && !isUsableLandlockAbi(raw.abi)) {
    return refused;
  }
  if (!Array.isArray(raw.places) || !Array.isArray(raw.floor)) return refused;
  if (!isRecord(raw.ceiling)) return refused;
  if (!(raw.reason === undefined || typeof raw.reason === "string")) {
    return refused;
  }
  const warnings: ExecutionDecodeWarning[] = [];
  const list = (entries: unknown[], at: string): string[] => {
    const read: string[] = [];
    entries.slice(0, MAX_PLACES).forEach((entry, index) => {
      if (isPlace(entry)) {
        if (!read.includes(entry)) read.push(entry);
      } else {
        warnings.push({
          reason: "dropped-invalid-field",
          path: `${path}.${at}.${index}`,
        });
      }
    });
    if (entries.length > MAX_PLACES) {
      warnings.push({
        reason: "dropped-excess-entries",
        path: `${path}.${at}`,
      });
    }
    return read;
  };
  const places = list(raw.places, "places");
  const floor = list(raw.floor, "floor");
  const ceiling: ExecutionHostFileReach["ceiling"] = {};
  for (const [place, access] of Object.entries(raw.ceiling).slice(
    0,
    MAX_PLACES,
  )) {
    if (
      isPlace(place) &&
      place !== "__proto__" &&
      (EXECUTION_FILE_REACH_ACCESS as readonly unknown[]).includes(access)
    ) {
      ceiling[place] = access as ExecutionFileReachAccess;
    } else {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `${path}.ceiling.${place}`,
      });
    }
  }
  const value: ExecutionHostFileReach = {
    fence: raw.fence,
    abi: raw.abi as number | null,
    places,
    ceiling,
    floor,
    ...(typeof raw.reason === "string" && raw.reason.length > 0
      ? { reason: raw.reason.slice(0, MAX_REASON_LENGTH) }
      : {}),
  };
  return warnings.length > 0
    ? { ok: true, value, warnings }
    : { ok: true, value };
}

/**
 * Whether a host's 201 for a start, or its 409 for a session it already
 * has, echoes that it holds the session to exactly `reach`: the same
 * entries, path for path and access for access, and an ABI a fence holds
 * with (4 or newer). An answer
 * without the echo, from a process that dropped `fileReach` whatever
 * `/health` said, confirms nothing; neither does one holding the session to
 * more, or to less.
 */
export function confirmsExecutionFileReach(
  answer: unknown,
  reach: ExecutionFileReach,
): boolean {
  if (!isRecord(answer) || !isRecord(answer.fileReach)) return false;
  const echoed = answer.fileReach;
  if (!isUsableLandlockAbi(echoed.abi)) return false;
  if (!Array.isArray(echoed.entries)) return false;
  if (!echoed.entries.every(isFileReachEntry)) return false;
  const key = (entry: ExecutionFileReachEntry) =>
    `${entry.access}\u0000${entry.path}`;
  const held = new Set(echoed.entries.map(key));
  const asked = new Set(reach.entries.map(key));
  return (
    held.size === asked.size && [...asked].every((entry) => held.has(entry))
  );
}

/**
 * Reads a host's refusal of a start's reach. Any other refusal body,
 * including one from a host predating the code, is `invalid-payload`; so is
 * one naming no problem it knows.
 */
export function decodeExecutionFileReachRefusal(
  raw: unknown,
): ExecutionDecodeResult<ExecutionFileReachRefusal> {
  if (
    !isRecord(raw) ||
    raw.code !== EXECUTION_FILE_REACH_REFUSED ||
    !Array.isArray(raw.problems)
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  const problems: ExecutionFileReachProblem[] = [];
  for (const entry of raw.problems) {
    if (
      isRecord(entry) &&
      (EXECUTION_FILE_REACH_PROBLEMS as readonly unknown[]).includes(
        entry.problem,
      ) &&
      (entry.entry === null || isSafeNonNegativeInteger(entry.entry))
    ) {
      problems.push({
        problem: entry.problem as ExecutionFileReachProblemCode,
        entry: entry.entry as number | null,
      });
    }
  }
  if (problems.length === 0) return { ok: false, reason: "invalid-payload" };
  return {
    ok: true,
    value: {
      error:
        typeof raw.error === "string" && raw.error.trim() !== ""
          ? raw.error
          : `The host refused this session's file reach: ${problems.map((entry) => entry.problem).join(", ")}`,
      code: EXECUTION_FILE_REACH_REFUSED,
      problems,
    },
  };
}
