import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  type ExecutionSessionFollow,
} from "../../src/client/index.js";
import { followOn } from "./follow-recording.js";
import { createStubHost, type StubHost, waitFor } from "./stub-host.js";

/**
 * MAR-3671: what accent.'s gateway asked a request of its own for — the
 * providers' catalogue and a session's teardown — and what it kept an adapter
 * for, a command sent without an id of the caller's.
 */

let host: StubHost;
let follows: ExecutionSessionFollow[];

beforeEach(() => {
  host = createStubHost();
  follows = [];
});

afterEach(async () => {
  await Promise.all(follows.map((follow) => follow.stop()));
});

const client = (token = host.token) =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token,
    fetch: host.fetch,
  });

describe("the providers' catalogue", () => {
  it("reads the providers with their models and the efforts each takes", async () => {
    const providers = await client().providers();

    expect(providers.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
    ]);
    expect(providers[0]).toMatchObject({
      label: "Claude",
      available: true,
      authenticated: true,
      effortLevels: ["low", "medium", "high"],
    });
    expect(providers[0]!.models[0]).toEqual({
      slug: "claude-opus-5-5",
      label: "Opus 5.5",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high"],
    });
    expect(providers[1]).toMatchObject({ authenticated: false, models: [] });
  });

  it("hands on a provider's account as read, and a bad one costs nothing (MAR-3821)", async () => {
    host.providersBody = {
      providers: [
        {
          id: "claude",
          account: { label: "ops@example.com\n", source: "label" },
        },
        { id: "codex", account: { label: "m@e.com", source: "who-knows" } },
      ],
    };

    const providers = await client().providers();

    expect(providers[0]!.account).toStrictEqual({
      label: "ops@example.com",
      source: "label",
    });
    expect("account" in providers[1]!).toBe(false);
  });

  it("asks with the token, which the catalogue sits behind", async () => {
    await expect(client("wrong-token").providers()).rejects.toMatchObject({
      kind: "auth",
      status: 401,
      operation: "providers",
    });
  });

  it("throws the host's refusal, in its words", async () => {
    host.providersStatus = 503;
    host.providersBody = { error: "Provider catalogue is still loading" };
    const error = await client()
      .providers()
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({
      kind: "http",
      status: 503,
      operation: "providers",
    });
    expect(error.reason).toContain("still loading");
  });

  it("refuses a catalogue it cannot read rather than guess one", async () => {
    host.providersBody = { providers: [{ models: [] }] };
    await expect(client().providers()).rejects.toMatchObject({
      kind: "malformed",
      operation: "providers",
    });
    host.providersBody = "not a catalogue";
    await expect(client().providers()).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("gives up at the health timeout, which is the catalogue's", async () => {
    const silent = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: host.token,
      healthTimeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    });
    await expect(silent.providers()).rejects.toMatchObject({
      kind: "timeout",
      operation: "providers",
    });
  });
});

describe("tearing a session down", () => {
  it("deletes the session on the host", async () => {
    expect(await client().deleteSession("session-1")).toEqual({
      status: "deleted",
      sessionId: "session-1",
    });
    expect(host.deleteRequests).toEqual(["session-1"]);
    expect(host.sessions.has("session-1")).toBe(false);
  });

  it("says no-session for one the host does not have, so a retry is safe", async () => {
    await client().deleteSession("session-1");
    expect(await client().deleteSession("session-1")).toEqual({
      status: "no-session",
      sessionId: "session-1",
    });
    expect(await client().deleteSession("never-was")).toEqual({
      status: "no-session",
      sessionId: "never-was",
    });
  });

  it("addresses the session by its encoded id", async () => {
    host.sessions.add("accent/odd id");
    expect(await client().deleteSession("accent/odd id")).toMatchObject({
      status: "deleted",
    });
    expect(host.deleteRequests).toEqual(["accent/odd id"]);
  });

  it("throws a refusal that is neither, with the host's words", async () => {
    host.deleteStatus = 500;
    const error = await client()
      .deleteSession("session-1")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({
      kind: "http",
      status: 500,
      operation: "delete session",
    });
    expect(error.reason).toContain("Teardown failed");
    // A refused teardown leaves the session where it was.
    expect(host.sessions.has("session-1")).toBe(true);
  });

  it("refuses a token the host refuses, and deletes nothing", async () => {
    await expect(
      client("wrong-token").deleteSession("session-1"),
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
    expect(host.deleteRequests).toEqual([]);
    expect(host.sessions.has("session-1")).toBe(true);
  });

  it("ends a follow of the session with no-session, as the host's streams close and reconnects hear 404", async () => {
    host.emit({ kind: "status", status: "running" });
    const recording = followOn(host, follows);
    await waitFor(() => recording.delivered.length === 1);

    await client().deleteSession("session-1");

    await expect(recording.follow.done).resolves.toMatchObject({
      reason: "no-session",
    });
    expect(host.openStreams()).toBe(0);
  });
});

describe("a command without an id of the caller's", () => {
  // MAR-3671's decision: the client always sends one. The protocol says a
  // command id is safe to send to any host — one predating them ignores it —
  // so accent.'s rule, "no id to a host that doesn't read one", is dropped
  // rather than made a `commandId: null` the client would have to honour.
  it("goes with a minted id, which is the one the answer names", async () => {
    const result = await client().command("session-1", { kind: "stop" });
    expect(result.status).toBe("accepted");
    expect(result.commandId).toEqual(expect.any(String));
    expect(host.commandRequests[0]!.body).toMatchObject({
      commandId: result.commandId,
    });
  });

  it("refuses null, which is no id and not the way to ask for none", async () => {
    await expect(
      client().command(
        "session-1",
        { kind: "stop" },
        {
          commandId: null as unknown as string,
        },
      ),
    ).rejects.toThrow(TypeError);
    expect(host.commandRequests).toEqual([]);
  });
});
