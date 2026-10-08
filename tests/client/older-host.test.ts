import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  type ExecutionFollowGap,
  type ExecutionFollowSkip,
  type ExecutionSessionFollow,
  type ExecutionWarningsNotice,
} from "../../src/client/index.js";
import type { ExecutionHostEventEnvelope } from "../../src/index.js";
import { waitFor } from "./stub-host.js";

/**
 * MAR-3823 through the client: a session as agents-daemon `3d2dbe2` (on
 * 0.17.0) served it, byte for byte, followed and snapshotted end to end. Its
 * turns carry no `origin` and read as a person's; nothing is dropped.
 */

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
const recordedSse = fixture("agents-daemon-0.17-session.sse.txt");
const recordedSnapshot = JSON.parse(
  fixture("agents-daemon-0.17-snapshot.json"),
) as { turns: Array<Record<string, unknown>>; lastSeq: number };
const recordedEnvelopes = [...recordedSse.matchAll(/^data: (.+)$/gm)]
  .map((match) => JSON.parse(match[1]!) as Record<string, unknown>)
  .filter(
    (data): data is ExecutionHostEventEnvelope & Record<string, unknown> =>
      "seq" in data,
  );

/**
 * The host as recorded: its stream replays the recording and stays open, its
 * snapshot is the one it served, and a start answers as it did.
 */
function recordedHost() {
  const encoder = new TextEncoder();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/v0/execution/sessions/session-1/events") {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(recordedSse));
          signal?.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (url.pathname === "/v0/execution/sessions/session-1") {
      return Response.json(recordedSnapshot);
    }
    if (url.pathname === "/v0/execution/sessions" && method === "POST") {
      return Response.json(
        { protocolVersion: 1, sessionId: "session-1" },
        { status: 201 },
      );
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  const warnings: ExecutionWarningsNotice[] = [];
  const client = createExecutionHostClient({
    baseUrl: "https://daemon.test",
    token: "token",
    fetch,
    onWarnings: (notice) => {
      warnings.push(notice);
    },
  });
  return { client, warnings };
}

const follows: ExecutionSessionFollow[] = [];
afterEach(async () => {
  await Promise.all(follows.splice(0).map((follow) => follow.stop()));
});

describe("following a session on a host that predates 0.19", () => {
  it("delivers every envelope it sent, its turns as a person's, nothing skipped", async () => {
    const { client } = recordedHost();
    const delivered: ExecutionHostEventEnvelope[] = [];
    const skips: ExecutionFollowSkip[] = [];
    const gaps: ExecutionFollowGap[] = [];
    follows.push(
      client.followSession("session-1", {
        onEnvelope: (envelope) => {
          delivered.push(envelope);
        },
        onSkip: (skip) => {
          skips.push(skip);
        },
        onGap: (gap) => {
          gaps.push(gap);
        },
      }),
    );
    await waitFor(() => delivered.length === recordedEnvelopes.length);

    expect(skips).toEqual([]);
    expect(gaps).toEqual([]);
    expect(delivered.map((envelope) => envelope.seq)).toEqual(
      recordedEnvelopes.map((envelope) => envelope.seq),
    );
    // As sent, but for the origin a turn without one reads as.
    expect(delivered).toEqual(
      recordedEnvelopes.map((envelope) => {
        const event = envelope.event;
        return event.kind === "delta" && event.delta.kind === "turn.add"
          ? {
              ...envelope,
              event: {
                ...event,
                delta: {
                  ...event.delta,
                  turn: { ...event.delta.turn, origin: "user" },
                },
              },
            }
          : envelope;
      }),
    );
    expect(
      delivered.flatMap((envelope) =>
        envelope.event.kind === "delta" &&
        envelope.event.delta.kind === "turn.add"
          ? [envelope.event.delta.turn.origin]
          : [],
      ),
    ).toEqual(["user", "user"]);
  });
});

describe("the snapshot of a session on a host that predates 0.19", () => {
  it("keeps every turn, each a person's, with no running tasks and no warning", async () => {
    const { client, warnings } = recordedHost();
    const snapshot = await client.snapshot("session-1");

    expect(warnings).toEqual([]);
    expect(snapshot).toMatchObject({
      status: "completed",
      runningTasks: 0,
      lastSeq: recordedSnapshot.lastSeq,
      turns: recordedSnapshot.turns.map((turn) => ({
        ...turn,
        origin: "user",
      })),
    });
    expect(snapshot?.turns).toHaveLength(2);
  });
});

describe("starting a session on a host that predates 0.20", () => {
  it("is started by its answer, which echoes no requires", async () => {
    const { client } = recordedHost();
    expect(
      await client.start({
        protocolVersion: 1,
        providerId: "claude",
        commandId: "start-1",
        config: {
          sessionId: "session-1",
          workingDirectory: "/workspace",
          initialMessage: "hello",
          model: null,
          effort: null,
          continuationToken: null,
        },
      }),
    ).toMatchObject({ status: "started", sessionId: "session-1" });
  });
});
