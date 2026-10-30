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
): Promise<unknown> {
  const found = executionHostConformanceCases.find(
    (entry) => entry.name === name,
  );
  if (!found) throw new Error(`no case named ${name}`);
  const model = new FakeHostModel();
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
