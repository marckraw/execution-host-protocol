import {
  isBoundedString,
  isRecord,
  isSafeNonNegativeInteger,
} from "./guards.js";
import type {
  ExecutionActor,
  ExecutionActorVia,
  ExecutionDecodeResult,
} from "./types.js";

/**
 * Who may drive a provider on a host, and how many of its sessions run at
 * once (MAR-5634): `drivePolicy` on a provider in `GET /v0/providers`, on a
 * host advertising `providers.drivePolicy.v1`.
 *
 * It is configuration on the host, the operator's, and the host enforces it
 * on every start and every command. A client reads it to say why a start
 * would be refused before it sends one, and to show the owner their switches;
 * it never changes it. Both sides decide with `drivePolicyRefusalOf`, so they
 * agree.
 */
export interface ExecutionDrivePolicy {
  /**
   * The accent. person whose sign-in the provider runs on: their user id, as
   * an actor's `id` carries it. Null when nobody is signed in, and then
   * nothing drives it.
   */
  ownerId: string | null;
  allow: {
    /** The owner's AI app, through one of their tokens (`via: "token"`). */
    tokenDriven: boolean;
    /** Automations and schedules, and the personas they start (`via: "automation"`). */
    automations: boolean;
    /**
     * A single start that waits in its host's line for a free turn, and the
     * line firing it (`via: "line"`). A host's default: on.
     */
    waitForRoom: boolean;
    /**
     * A start chained `after` another session, which the line fires when
     * that one merges. A host's default: off.
     */
    afterChains: boolean;
    /** Starts that let the line pick any host. */
    anyHost: boolean;
    /** Anyone but the owner. */
    others: boolean;
  };
  /** How many of its sessions may be live at once. 0 starts none. */
  maxConcurrentSessions: number;
  /** How many are live now, as the host counts them. */
  liveSessions: number;
}

/** What is asked of a provider, for `drivePolicyRefusalOf`. */
export interface ExecutionDriveAsk {
  /** The provider asked, as `GET /v0/providers` names it: the flags are its. */
  providerId: string;
  /** Who is asking. Absent when the sender did not say. */
  actor?: ExecutionActor;
  /**
   * `start` a session, `input` to one (a message, a steer, an answer), or
   * `control` one (interrupt, stop, stop-task, cancel-queued).
   */
  act: "start" | "input" | "control";
  /** A start that may wait in its host's line for a free turn. */
  waitForRoom?: boolean;
  /** A start chained `after` another session, to start when that one merges. */
  afterChain?: boolean;
  /** A start that lets the line pick any host. */
  anyHost?: boolean;
  /** Whether it needs a provider process the host is not running yet. */
  needsNewProcess: boolean;
}

export const EXECUTION_DRIVE_POLICY_REFUSED = "drive-policy-refused" as const;

export const EXECUTION_DRIVE_POLICY_REFUSAL_REASONS = [
  "no-owner",
  "no-actor",
  "not-owner",
  "token-driven-off",
  "automation",
  "wait-for-room",
  "after-chain",
  "any-host",
  "at-capacity",
] as const;
export type ExecutionDrivePolicyRefusalReason =
  (typeof EXECUTION_DRIVE_POLICY_REFUSAL_REASONS)[number];

/**
 * Why a provider's drive policy refuses an ask, and the host's flag that
 * would allow it, as `<providerId>.<flag>` (`antigravity.allowTokenDriven`).
 * `no-owner` and `no-actor` name none: no flag allows them.
 */
export interface ExecutionDrivePolicyRefusal {
  code: typeof EXECUTION_DRIVE_POLICY_REFUSED;
  reason: ExecutionDrivePolicyRefusalReason;
  flag?: string;
  /** For a person to read. */
  message: string;
}

/** The bound on a policy's `ownerId`, as on an actor's `id`. */
const OWNER_ID_MAX_LENGTH = 256;

const ALLOW_FIELDS = [
  "tokenDriven",
  "automations",
  "waitForRoom",
  "afterChains",
  "anyHost",
  "others",
] as const;

const VIA_REFUSALS: Partial<
  Record<
    ExecutionActorVia,
    {
      allowed: keyof ExecutionDrivePolicy["allow"];
      reason: ExecutionDrivePolicyRefusalReason;
    }
  >
> = {
  token: { allowed: "tokenDriven", reason: "token-driven-off" },
  automation: { allowed: "automations", reason: "automation" },
  line: { allowed: "waitForRoom", reason: "wait-for-room" },
};

/** The host's flag behind each `allow` switch, and behind the cap. */
const FLAGS = {
  tokenDriven: "allowTokenDriven",
  automations: "allowAutomations",
  waitForRoom: "allowWaitForRoom",
  afterChains: "allowAfterChains",
  anyHost: "allowAnyHost",
  others: "allowOthers",
  maxConcurrentSessions: "maxConcurrentSessions",
} as const;

const VIA_WORDS: Record<ExecutionActorVia, string> = {
  app: "from the app",
  token: "from an AI app through a token",
  automation: "for automations",
  line: "starts that waited in the line for a free turn",
};

/**
 * Whether a provider's drive policy refuses an ask, and why (MAR-5634): null
 * when it allows it. Pure, and the one rule the host, the in-app runtime,
 * accent.'s server and its UI all apply.
 *
 * `control` is never refused: whoever may see a session may always stop it.
 * Anything else is checked in this order, and the first refusal is the one
 * returned:
 *
 * 1. `no-owner`: nobody is signed in to the provider, so it drives nothing.
 * 2. `no-actor`: the ask does not say who sent it.
 * 3. `not-owner`: the owner is the `person` actor whose `id` is `ownerId`;
 *    anyone else needs `others`.
 * 4. By `via`: `token` needs `tokenDriven` (`token-driven-off`), `automation`
 *    needs `automations` (`automation`), and `line` needs `waitForRoom`
 *    (`wait-for-room`), unless what it fires is an `after` chain, which is
 *    the chain's switch alone. `app` needs no switch.
 * 5. `wait-for-room`: a start that may wait for a free turn needs
 *    `waitForRoom`.
 * 6. `after-chain`: a start chained `after` another session needs
 *    `afterChains`, whoever sends it.
 * 7. `any-host`: a start letting the line pick its host needs `anyHost`.
 * 8. `at-capacity`: an ask that needs a new process, while `liveSessions`
 *    has reached `maxConcurrentSessions`.
 */
export function drivePolicyRefusalOf(
  policy: ExecutionDrivePolicy,
  ask: ExecutionDriveAsk,
): ExecutionDrivePolicyRefusal | null {
  if (ask.act === "control") return null;
  const provider = ask.providerId;
  const refuse = (
    reason: ExecutionDrivePolicyRefusalReason,
    message: string,
    flag?: keyof typeof FLAGS,
  ): ExecutionDrivePolicyRefusal => ({
    code: EXECUTION_DRIVE_POLICY_REFUSED,
    reason,
    ...(flag === undefined ? {} : { flag: `${provider}.${FLAGS[flag]}` }),
    message,
  });

  if (policy.ownerId === null) {
    return refuse("no-owner", `Nobody is signed in to ${provider} here.`);
  }
  const { actor } = ask;
  if (actor === undefined) {
    return refuse(
      "no-actor",
      `${provider} here does not run for a sender who does not say who they are.`,
    );
  }
  const isOwner = actor.kind === "person" && actor.id === policy.ownerId;
  if (!isOwner && !policy.allow.others) {
    return refuse(
      "not-owner",
      `${provider} here runs only for the person signed in to it.`,
      "others",
    );
  }
  // The line fires both kinds of waiting start; a chain is the chain's switch.
  const viaRefusal =
    actor.via === "line" && ask.afterChain
      ? undefined
      : VIA_REFUSALS[actor.via];
  if (viaRefusal && !policy.allow[viaRefusal.allowed]) {
    return refuse(
      viaRefusal.reason,
      `${provider} here does not run ${VIA_WORDS[actor.via]}.`,
      viaRefusal.allowed,
    );
  }
  if (ask.waitForRoom && !policy.allow.waitForRoom) {
    return refuse(
      "wait-for-room",
      `${provider} here does not run starts that wait in the line for a free turn.`,
      "waitForRoom",
    );
  }
  if (ask.afterChain && !policy.allow.afterChains) {
    return refuse(
      "after-chain",
      `${provider} here does not run starts chained after another session.`,
      "afterChains",
    );
  }
  if (ask.anyHost && !policy.allow.anyHost) {
    return refuse(
      "any-host",
      `${provider} here does not run starts that let the line pick any host.`,
      "anyHost",
    );
  }
  if (
    ask.needsNewProcess &&
    policy.liveSessions >= policy.maxConcurrentSessions
  ) {
    return refuse(
      "at-capacity",
      `${provider} here runs at most ${policy.maxConcurrentSessions} ${
        policy.maxConcurrentSessions === 1 ? "session" : "sessions"
      } at once, and ${policy.liveSessions} ${
        policy.liveSessions === 1 ? "is" : "are"
      } live.`,
      "maxConcurrentSessions",
    );
  }
  return null;
}

/**
 * Reads a provider's `drivePolicy` (MAR-5634), strictly: an `ownerId` that is
 * a non-empty string of at most 256 characters or null, every `allow` switch
 * a boolean, and both counts non-negative integers. Fields beyond those are
 * ignored. The provider listing reads one it cannot read as absent, with a
 * warning, and never as more permissive than it is.
 */
export function decodeExecutionDrivePolicy(
  raw: unknown,
): ExecutionDecodeResult<ExecutionDrivePolicy> {
  if (
    !isRecord(raw) ||
    !(
      raw.ownerId === null || isBoundedString(raw.ownerId, OWNER_ID_MAX_LENGTH)
    ) ||
    !isRecord(raw.allow) ||
    !isSafeNonNegativeInteger(raw.maxConcurrentSessions) ||
    !isSafeNonNegativeInteger(raw.liveSessions)
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  const allow = raw.allow;
  if (!ALLOW_FIELDS.every((field) => typeof allow[field] === "boolean")) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      ownerId: raw.ownerId as string | null,
      allow: {
        tokenDriven: allow.tokenDriven as boolean,
        automations: allow.automations as boolean,
        waitForRoom: allow.waitForRoom as boolean,
        afterChains: allow.afterChains as boolean,
        anyHost: allow.anyHost as boolean,
        others: allow.others as boolean,
      },
      maxConcurrentSessions: raw.maxConcurrentSessions,
      liveSessions: raw.liveSessions,
    },
  };
}

/**
 * Reads a host's refusal coded `drive-policy-refused` (MAR-5634): a `reason`
 * this build knows, and a `message` and `flag` when they are non-empty
 * strings. A refusal without a readable message gets one naming its reason.
 */
export function decodeExecutionDrivePolicyRefusal(
  raw: unknown,
): ExecutionDecodeResult<ExecutionDrivePolicyRefusal> {
  if (
    !isRecord(raw) ||
    raw.code !== EXECUTION_DRIVE_POLICY_REFUSED ||
    !(EXECUTION_DRIVE_POLICY_REFUSAL_REASONS as readonly unknown[]).includes(
      raw.reason,
    )
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  const reason = raw.reason as ExecutionDrivePolicyRefusalReason;
  return {
    ok: true,
    value: {
      code: EXECUTION_DRIVE_POLICY_REFUSED,
      reason,
      ...(typeof raw.flag === "string" && raw.flag.trim() !== ""
        ? { flag: raw.flag }
        : {}),
      message:
        typeof raw.message === "string" && raw.message.trim() !== ""
          ? raw.message
          : `The host's drive policy refused this: ${reason}`,
    },
  };
}
