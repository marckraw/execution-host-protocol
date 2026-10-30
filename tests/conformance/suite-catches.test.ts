import { describe, expect, it, vi } from "vitest";
import {
  ExecutionHostError,
  type ExecutionHostApi,
} from "../../src/client/index.js";
import {
  ExecutionHostConformanceError,
  executionHostConformanceCases,
  type ExecutionHostConformanceHost,
} from "../../src/testing/index.js";
import { CONFORMANCE_POLL_MS } from "../../src/testing/conformance.js";
import { FakeHostModel, fakeApi, modelHooks } from "./fake-host.js";

/**
 * The suite is only worth what it catches: each host here breaks one rule,
 * and the case about that rule fails it.
 */
async function runCase(
  name: string,
  breakIt: (api: ExecutionHostApi) => ExecutionHostApi,
  model = new FakeHostModel(),
): Promise<unknown> {
  const found = executionHostConformanceCases.find(
    (entry) => entry.name === name,
  );
  if (!found) throw new Error(`no case named ${name}`);
  const host: ExecutionHostConformanceHost = {
    api: breakIt(fakeApi(model)),
    ...modelHooks(model),
  };
  return found.run(host, { waitMs: 500 }).then(
    () => null,
    (error: unknown) => error,
  );
}

describe("the conformance suite", () => {
  it("passes the fake API as it is", async () => {
    for (const entry of executionHostConformanceCases) {
      expect(await runCase(entry.name, (api) => api), entry.name).toBeNull();
    }
  });

  it("passes a fake host that records no turn usage", async () => {
    for (const entry of executionHostConformanceCases) {
      expect(
        await runCase(
          entry.name,
          (api) => api,
          new FakeHostModel({ recordsUsage: false }),
        ),
        entry.name,
      ).toBeNull();
    }
  });

  it("fails a host that answers an unknown session's snapshot", async () => {
    const error = await runCase(
      "snapshots a session it has, and answers null for one it does not",
      (api) => ({
        ...api,
        snapshot: async (sessionId, options) =>
          (await api.snapshot(sessionId, options)) ??
          (await api.snapshot("never", options)) ??
          ({ sessionId } as never),
      }),
    );
    expect(error).toBeInstanceOf(ExecutionHostConformanceError);
  });

  it("fails a follow that hands an envelope on twice", async () => {
    const error = await runCase(
      "follows a session from the start, each envelope once and in order",
      (api) => ({
        ...api,
        followSession: (sessionId, options) =>
          api.followSession(sessionId, {
            ...options,
            onEnvelope: async (envelope, info) => {
              await options.onEnvelope(envelope, info);
              await options.onEnvelope(envelope, info);
            },
          }),
      }),
    );
    expect(error).toBeInstanceOf(ExecutionHostConformanceError);
    expect(String(error)).toMatch(/out of order or twice/);
  });

  it("fails a resume that starts over", async () => {
    const error = await runCase(
      "resumes after a given seq with nothing missing and nothing twice",
      (api) => ({
        ...api,
        followSession: (sessionId, options) =>
          api.followSession(sessionId, { ...options, afterSeq: 0 }),
      }),
    );
    expect(error).toBeInstanceOf(ExecutionHostConformanceError);
  });

  it("fails an error that lost its kind", async () => {
    const error = await runCase(
      "refuses an attachment it does not have as not-found",
      (api) => ({
        ...api,
        downloadAttachment: (...args) =>
          api.downloadAttachment(...args).catch((failure: unknown) => {
            throw new Error(String(failure));
          }),
      }),
    );
    expect(error).toBeInstanceOf(ExecutionHostConformanceError);
    expect(String(error)).toMatch(/not an ExecutionHostError/);
  });

  it("fails a follow that outlives its session", async () => {
    const error = await runCase(
      "ends a follow with not-found once the session is gone",
      (api) => ({
        ...api,
        // A follow whose end never comes, whatever the session does.
        followSession: (sessionId, options) => {
          const inner = api.followSession(sessionId, options);
          return {
            sessionId,
            get lastSeq() {
              return inner.lastSeq;
            },
            done: new Promise(() => {}),
            stop: () => inner.stop(),
          };
        },
      }),
    );
    expect(error).toBeInstanceOf(ExecutionHostConformanceError);
  });

  it("fails a host that ignores the caller's abort", async () => {
    const error = await runCase(
      "rejects with the caller's reason when its signal aborts",
      (api) => ({
        ...api,
        snapshot: (sessionId) => api.snapshot(sessionId),
      }),
    );
    expect(error).toBeInstanceOf(ExecutionHostConformanceError);
  });

  it("names a not-found error of another kind", async () => {
    const error = await runCase(
      "refuses an attachment it does not have as not-found",
      (api) => ({
        ...api,
        downloadAttachment: async () => {
          throw new ExecutionHostError("http", "nope", {
            operation: "download attachment",
          });
        },
      }),
    );
    expect(String(error)).toMatch(/failed as http, not not-found/);
  });

  describe("turn usage (MAR-4943)", () => {
    const HISTORY_CASE =
      "lists turn usage in the order recorded, each once, and catches up from its last cursor";

    it("fails a snapshot whose turns lost their usage", async () => {
      const error = await runCase(
        "hands a turn's usage to its followers and its snapshot",
        (api) => ({
          ...api,
          snapshot: async (sessionId, options) => {
            const snapshot = await api.snapshot(sessionId, options);
            return (
              snapshot && {
                ...snapshot,
                turns: snapshot.turns.map(({ usage: _, ...turn }) => turn),
              }
            );
          },
        }),
      );
      expect(String(error)).toMatch(/carries no usage/);
    });

    it("fails a followed turn.patch whose usage changed on the way", async () => {
      const error = await runCase(
        "hands a turn's usage to its followers and its snapshot",
        (api) => ({
          ...api,
          followSession: (sessionId, options) =>
            api.followSession(sessionId, {
              ...options,
              onEnvelope: (envelope, info) => {
                const event = envelope.event;
                if (
                  event.kind === "delta" &&
                  event.delta.kind === "turn.patch" &&
                  event.delta.patch.usage
                ) {
                  // Codex's way: cached tokens counted in the input too.
                  const usage = event.delta.patch.usage;
                  const tokens = {
                    ...usage.tokens,
                    input: usage.tokens.input + usage.tokens.cacheRead,
                  };
                  return options.onEnvelope(
                    {
                      ...envelope,
                      event: {
                        ...event,
                        delta: {
                          ...event.delta,
                          patch: {
                            ...event.delta.patch,
                            usage: { ...usage, tokens },
                          },
                        },
                      },
                    },
                    info,
                  );
                }
                return options.onEnvelope(envelope, info);
              },
            }),
        }),
      );
      expect(String(error)).toMatch(/the turn's turn.patch carries/);
    });

    it("fails a history that lists a turn twice", async () => {
      const error = await runCase(HISTORY_CASE, (api) => ({
        ...api,
        listTurnUsage: async (query, options) => {
          const page = await api.listTurnUsage(query, options);
          return { ...page, records: [...page.records, ...page.records] };
        },
      }));
      expect(String(error)).toMatch(/times, not once|a page of at most/);
    });

    it("fails a history whose last cursor starts over instead of catching up", async () => {
      const error = await runCase(HISTORY_CASE, (api) => ({
        ...api,
        listTurnUsage: async (query, options) => {
          const page = await api.listTurnUsage(query, options);
          // The fake's cursor is a position: the end's is back at the start.
          return page.hasMore ? page : { ...page, nextCursor: "0|" };
        },
      }));
      expect(String(error)).toMatch(/listed turns read before it/);
    });

    it("fails a history that ignores since", async () => {
      const error = await runCase(
        "lists only the turn usage of turns that ended since a given time",
        (api) => ({
          ...api,
          listTurnUsage: (query, options) =>
            api.listTurnUsage(
              query?.since === undefined
                ? query
                : { ...query, since: undefined },
              options,
            ),
        }),
      );
      expect(String(error)).toMatch(/since/);
    });

    const SINCE_PAGES_CASE =
      "pages turn usage since a given time, keeping since on every cursor";
    const SINCE_CATCH_UP_CASE =
      "catches up from a read since a given time with only what ended since";

    it("passes a fake host that records live usage but does not backfill", async () => {
      for (const entry of executionHostConformanceCases) {
        expect(
          await runCase(
            entry.name,
            (api) => api,
            new FakeHostModel({ backfillsUsage: false }),
          ),
          entry.name,
        ).toBeNull();
      }
    });

    // Review of #66: a carrier that loses `since` from every cursor passed
    // every usage case there was. The fake's cursor is `position|since`.
    const dropsSince = (api: ExecutionHostApi): ExecutionHostApi => ({
      ...api,
      listTurnUsage: (query, options) =>
        api.listTurnUsage(
          query?.cursor === undefined
            ? query
            : { ...query, cursor: query.cursor.replace(/\|.*$/, "|") },
          options,
        ),
    });

    it.each([SINCE_PAGES_CASE, SINCE_CATCH_UP_CASE])(
      "fails a carrier that drops since from its cursors: %s",
      async (name) => {
        const error = await runCase(name, dropsSince);
        expect(error).toBeInstanceOf(ExecutionHostConformanceError);
        expect(String(error)).toMatch(/before it/);
      },
    );

    it("fails a cursor that counts in the filtered list but reads without since, with no backfill", async () => {
      const model = new FakeHostModel({ backfillsUsage: false });
      const error = await runCase(
        SINCE_PAGES_CASE,
        (api) => ({
          ...api,
          listTurnUsage: async (query = {}) => {
            const limit = query.limit ?? 2;
            const offset =
              query.cursor === undefined ? 0 : Number(query.cursor);
            const since = query.since;
            const pool =
              since === undefined
                ? model.usage
                : model.usage.filter(
                    (record) => Date.parse(record.endedAt) >= Date.parse(since),
                  );
            const records = pool.slice(offset, offset + limit);
            const next = offset + records.length;
            return {
              records,
              nextCursor: String(next),
              hasMore: next < pool.length,
              warnings: [],
            };
          },
        }),
        model,
      );
      expect(error).toBeInstanceOf(ExecutionHostConformanceError);
      expect(String(error)).toMatch(/a page at a time lists .*, not /);
    });

    it("fails a host that answers the history but cannot record usage", async () => {
      const model = new FakeHostModel({ recordsUsage: false });
      const error = await runCase(
        HISTORY_CASE,
        (api) => ({
          ...api,
          listTurnUsage: async () => ({
            records: [],
            nextCursor: null,
            hasMore: false,
            warnings: [],
          }),
        }),
        model,
      );
      expect(String(error)).toMatch(/resolved; it should reject/);
    });

    it("fails a host that lets a bad query through", async () => {
      const error = await runCase(
        "refuses a turn usage query the protocol would refuse",
        (api) => ({
          ...api,
          listTurnUsage: async () => ({
            records: [],
            nextCursor: null,
            hasMore: false,
            warnings: [],
          }),
        }),
      );
      expect(String(error)).toMatch(/since with a cursor resolved/);
    });
  });

  it("leaves no timer behind when a live envelope never comes (Codex review of #64)", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const error = await runCase(
        "resumes after a given seq with nothing missing and nothing twice",
        (api) => ({
          ...api,
          // Replays, then never hands on what happens live.
          followSession: (sessionId, options) =>
            api.followSession(sessionId, {
              ...options,
              onEnvelope: (envelope, info) =>
                info.replay ? options.onEnvelope(envelope, info) : undefined,
            }),
        }),
      );
      expect(String(error)).toMatch(/a live envelope: nothing within 500 ms/);
      const looks = () =>
        spy.mock.calls.filter(([, delay]) => delay === CONFORMANCE_POLL_MS)
          .length;
      const after = looks();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(looks()).toBe(after);
    } finally {
      spy.mockRestore();
    }
  });
});
