import {
  createExecutionHostClient,
  type ExecutionFollowGap,
  type ExecutionFollowOptions,
  type ExecutionFollowSkip,
  type ExecutionFollowStatus,
  type ExecutionSessionFollow,
} from "../../src/client/index.js";
import type { ExecutionHostEventEnvelope } from "../../src/index.js";
import type { StubHost } from "./stub-host.js";

export interface Recording {
  follow: ExecutionSessionFollow;
  delivered: ExecutionHostEventEnvelope[];
  seqs: () => number[];
  gaps: ExecutionFollowGap[];
  skips: ExecutionFollowSkip[];
  statuses: ExecutionFollowStatus[];
  /** The attempt number of every reconnect wait; the waits themselves are 0. */
  delays: number[];
}

/**
 * Follows session-1 on a stub host, recording everything the follow says.
 * The follow is added to `follows` so a test's teardown can stop it.
 */
export function followOn(
  host: StubHost,
  follows: ExecutionSessionFollow[],
  options: Partial<ExecutionFollowOptions> = {},
  token = host.token,
): Recording {
  const client = createExecutionHostClient({
    baseUrl: "https://host.test",
    token,
    fetch: (input, init) => host.fetch(input, init),
  });
  const recording: Omit<Recording, "follow"> = {
    delivered: [],
    seqs: () => recording.delivered.map((envelope) => envelope.seq),
    gaps: [],
    skips: [],
    statuses: [],
    delays: [],
  };
  const followed = client.followSession("session-1", {
    onEnvelope: (envelope) => {
      recording.delivered.push(envelope);
    },
    onGap: (gap) => {
      recording.gaps.push(gap);
    },
    onSkip: (skip) => {
      recording.skips.push(skip);
    },
    onStatus: (status) => recording.statuses.push(status),
    retryDelayMs: (attempt) => {
      recording.delays.push(attempt);
      return 0;
    },
    ...options,
  });
  follows.push(followed);
  return { ...recording, follow: followed } as Recording;
}
