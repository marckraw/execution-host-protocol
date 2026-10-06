import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  ExecutionOneShotError,
  type ExecutionOneShotOptions,
} from "../../src/client/index.js";
import { EXECUTION_ONESHOT_TEXT_MAX_LENGTH } from "../../src/index.js";
import { createStubHost, type StubHost, HEALTH_BODY } from "./stub-host.js";

/** agents-daemon 0.26.1's `/health`, from a build that promises `oneshot.v1`. */
const ONESHOT_HEALTH_BODY = {
  ...HEALTH_BODY,
  executionProtocol: {
    ...HEALTH_BODY.executionProtocol,
    capabilities: [...HEALTH_BODY.executionProtocol.capabilities, "oneshot.v1"],
  },
};

/** A prompt worth stealing, to show it reaches no error. */
const PROMPT = "Name this session: the merger with Initech, codename BLUEBIRD";

const ASK: ExecutionOneShotOptions = {
  provider: "claude",
  model: "claude-haiku-4-5-20251001",
  prompt: PROMPT,
};

let host: StubHost;
/** Every request the client made, in order. */
let requests: Array<{ method: string; path: string }>;
beforeEach(() => {
  host = createStubHost();
  host.healthBody = ONESHOT_HEALTH_BODY;
  requests = [];
});
afterEach(() => {
  vi.useRealTimers();
});

const counting =
  (fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    requests.push({ method: init?.method ?? "GET", path: url.pathname });
    return fetch(input, init);
  };

const client = (fetch: typeof globalThis.fetch = host.fetch) =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token: host.token,
    fetch: counting(fetch),
  });

/** The error a call threw, for a test to read. */
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** Everything an error says, cause included, as one string. */
function everythingIn(error: unknown): string {
  const parts: string[] = [];
  let next: unknown = error;
  while (next instanceof Error) {
    parts.push(next.message, JSON.stringify(next), String(next.stack));
    next = next.cause;
  }
  return parts.join("\n");
}

/** A fetch that answers `/v0/oneshot` with `answer`, and the stub elsewhere. */
const answering =
  (answer: () => Response): typeof globalThis.fetch =>
  (input, init) =>
    String(input).endsWith("/v0/oneshot")
      ? Promise.resolve(answer())
      : host.fetch(input, init);

describe("oneShot", () => {
  it("returns the host's text, sending the route's body as it is", async () => {
    const answer = await client().oneShot({
      ...ASK,
      effort: "low",
      timeoutMs: 20_000,
    });

    expect(answer).toEqual({
      text: `claude/claude-haiku-4-5-20251001/low read ${PROMPT.length} characters`,
    });
    expect(requests).toEqual([
      { method: "GET", path: "/health" },
      { method: "POST", path: "/v0/oneshot" },
    ]);
    expect(host.oneShotRequests).toEqual([
      {
        body: JSON.stringify({
          contract: "oneshot.v1",
          providerId: "claude",
          model: "claude-haiku-4-5-20251001",
          effort: "low",
          prompt: PROMPT,
          timeoutMs: 20_000,
        }),
        authorization: `Bearer ${host.token}`,
      },
    ]);
    expect(host.healthRequests).toEqual([{ authorization: null }]);
    expect(host.redirectModes).toEqual(["error", "error"]);
  });

  it("sends no effort or timeout it was not given", async () => {
    await client().oneShot(ASK);

    expect(JSON.parse(host.oneShotRequests[0]!.body)).toEqual({
      contract: "oneshot.v1",
      providerId: "claude",
      model: "claude-haiku-4-5-20251001",
      prompt: PROMPT,
    });
  });

  it("returns an empty answer as one, and ignores fields it does not know", async () => {
    host.oneShotAnswer = () => ({ text: "", usage: { tokens: 3 } });

    expect(await client().oneShot(ASK)).toEqual({ text: "" });
  });

  describe("a host that does not advertise oneshot.v1", () => {
    it("is refused before the prompt is sent: one request, /health", async () => {
      // Today's daemon: it serves the route, but has not made the promise.
      host.healthBody = HEALTH_BODY;

      const error = await failureOf(client().oneShot(ASK));

      expect(error).toBeInstanceOf(ExecutionOneShotError);
      expect(error).toMatchObject({
        code: "unsupported",
        operation: "oneshot",
        status: null,
        sent: false,
      });
      expect(requests).toEqual([{ method: "GET", path: "/health" }]);
      expect(host.oneShotRequests).toEqual([]);
    });

    it("is refused when its descriptor is unreadable", async () => {
      host.healthBody = {
        ...ONESHOT_HEALTH_BODY,
        executionProtocol: { version: 99, capabilities: ["oneshot.v1"] },
      };

      const error = await failureOf(client().oneShot(ASK));

      expect(error).toMatchObject({ code: "unsupported", sent: false });
      expect((error as Error).message).toContain("unreadable");
      expect(requests).toEqual([{ method: "GET", path: "/health" }]);
    });

    it.each([
      "oneshot.v2",
      "oneshot.v10",
      "oneshot.v1 ",
      " oneshot.v1",
      "Oneshot.v1",
      "oneshot",
    ])("is refused when it advertises only the near miss %j", async (near) => {
      host.healthBody = {
        ...HEALTH_BODY,
        executionProtocol: {
          ...HEALTH_BODY.executionProtocol,
          capabilities: [...HEALTH_BODY.executionProtocol.capabilities, near],
        },
      };

      const error = await failureOf(client().oneShot(ASK));

      expect(error).toMatchObject({ code: "unsupported", sent: false });
      expect(requests).toEqual([{ method: "GET", path: "/health" }]);
    });

    it("is a health error, unsent, when /health cannot be read", async () => {
      host.healthStatus = 503;

      const error = await failureOf(client().oneShot(ASK));

      expect(error).toBeInstanceOf(ExecutionHostError);
      expect(error).toMatchObject({ operation: "health", status: 503 });
      expect(host.oneShotRequests).toEqual([]);
    });
  });

  describe("a host released before oneshot.v1 that advertises it anyway", () => {
    // Rolled back between the probe and the POST, or lying: only the body's
    // `contract` stands between the prompt and a route with tools on.
    it("refuses the request on its contract, and never runs the prompt", async () => {
      host.oneShotRoute = "released";

      const error = await failureOf(client().oneShot(ASK));

      expect(error).toBeInstanceOf(ExecutionOneShotError);
      expect(error).toMatchObject({
        code: "rejected",
        status: 400,
        sent: true,
      });
      expect(host.oneShotRequests).toHaveLength(1);
      expect(host.oneShotRuns).toEqual([]);
    });

    it("runs a request without the contract: the stub is the released route", async () => {
      host.oneShotRoute = "released";

      // What a client without the field would send.
      const response = await host.fetch("https://host.test/v0/oneshot", {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({
          providerId: "claude",
          model: ASK.model,
          prompt: PROMPT,
        }),
      });

      expect(response.status).toBe(200);
      expect(host.oneShotRuns).toEqual([PROMPT]);
    });
  });

  describe("refusals", () => {
    it.each([
      [404, "provider-unknown", "provider-unknown"],
      [503, "provider-unavailable", "provider-unavailable"],
      [429, "busy", "busy"],
      [504, "timed-out", "timed-out"],
      [502, "failed", "failed"],
      // The code wins where the host gave a known one.
      [503, "busy", "busy"],
      // Uncoded, the status says it: agents-daemon's route as it is.
      // A 404 with no code is no route — a proxy's, or a host without it.
      [404, null, "unsupported"],
      [422, null, "provider-unavailable"],
      [503, null, "provider-unavailable"],
      [429, null, "busy"],
      [504, null, "timed-out"],
      [502, null, "failed"],
      [500, null, "failed"],
      [400, null, "rejected"],
      [413, null, "rejected"],
      // A code this build does not know is no code at all.
      [503, "melted", "provider-unavailable"],
      [400, "melted", "rejected"],
      // A 401 is the token's, whatever the body claims: it may be a proxy's.
      [401, "busy", "rejected"],
      [403, null, "rejected"],
    ])(
      "HTTP %i with code %s is %s, and quotes neither the prompt nor the token",
      async (status, code, expected) => {
        host.oneShotStatus = status;
        host.oneShotCode = code;

        const error = await failureOf(client().oneShot(ASK));

        expect(error).toBeInstanceOf(ExecutionOneShotError);
        expect(error).toMatchObject({ code: expected, status, sent: true });
        const said = everythingIn(error);
        expect(said).not.toContain(PROMPT);
        expect(said).not.toContain("BLUEBIRD");
        expect(said).not.toContain(host.token);
        expect(host.oneShotRequests).toHaveLength(1);
      },
    );

    it("reads a refusal's body to 64 KiB and no further", async () => {
      let sent = 0;
      let cancelled = false;
      // A finite refusal, 1 MiB long, that would be read whole without a cap.
      const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
      const long = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent >= 1024 * 1024) return controller.close();
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        );

      const error = await failureOf(client(answering(long)).oneShot(ASK));

      expect(error).toMatchObject({
        code: "provider-unavailable",
        status: 503,
      });
      expect(cancelled).toBe(true);
      expect(sent).toBeLessThanOrEqual(64 * 1024 + 3 * chunk.byteLength);
    });

    it("is provider-unknown for a provider the host does not have", async () => {
      const error = await failureOf(
        client().oneShot({ ...ASK, provider: "gemini" }),
      );

      expect(error).toMatchObject({ code: "provider-unknown", status: 404 });
    });

    it("is timed-out, with no status, when the host does not answer in time", async () => {
      vi.useFakeTimers();
      const hanging: typeof globalThis.fetch = (input, init) =>
        String(input).endsWith("/v0/oneshot")
          ? new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            })
          : host.fetch(input, init);

      const pending = failureOf(
        client(hanging).oneShot({ ...ASK, timeoutMs: 1_000 }),
      );
      // The provider's second, then the host's grace to say so.
      await vi.advanceTimersByTimeAsync(10_999);
      expect(requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;

      expect(error).toBeInstanceOf(ExecutionOneShotError);
      expect(error).toMatchObject({
        code: "timed-out",
        status: null,
        sent: true,
      });
      expect((error as Error).message).toContain("11 s");
    });
  });

  describe("an answer it cannot read", () => {
    it.each([
      ["not JSON", "Here is your title: BLUEBIRD"],
      ["no text", JSON.stringify({ title: "BLUEBIRD" })],
      ["text that is not a string", JSON.stringify({ text: ["BLUEBIRD"] })],
      [
        "text over the cap",
        JSON.stringify({
          text: `BLUEBIRD${"x".repeat(EXECUTION_ONESHOT_TEXT_MAX_LENGTH)}`,
        }),
      ],
    ])(
      "is malformed: %s, and the error does not quote it",
      async (_case, body) => {
        const error = await failureOf(
          client(answering(() => new Response(body, { status: 200 }))).oneShot(
            ASK,
          ),
        );

        expect(error).toBeInstanceOf(ExecutionOneShotError);
        expect(error).toMatchObject({
          code: "malformed",
          status: 200,
          sent: true,
        });
        expect(everythingIn(error)).not.toContain("BLUEBIRD");
      },
    );

    it("stops reading a body past 512 KiB, however much more the host sends", async () => {
      let sent = 0;
      let cancelled = false;
      const chunk = new TextEncoder().encode(`"${"x".repeat(64 * 1024 - 2)}"`);
      const endless = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        );

      const error = await failureOf(client(answering(endless)).oneShot(ASK));

      expect(error).toMatchObject({ code: "malformed", status: 200 });
      expect((error as Error).message).toContain("524288 bytes");
      expect(cancelled).toBe(true);
      // Within a chunk or two of the cap, and nowhere near "endless".
      expect(sent).toBeLessThanOrEqual(512 * 1024 + 3 * chunk.byteLength);
    });

    it("measures a body a fetch without streams hands over whole", async () => {
      const whole = () => {
        const response = new Response(
          JSON.stringify({
            text: "y".repeat(EXECUTION_ONESHOT_TEXT_MAX_LENGTH),
          }),
          { status: 200 },
        );
        // Older React Native: no body stream, only text().
        Object.defineProperty(response, "body", { value: null });
        return response;
      };

      expect((await client(answering(whole)).oneShot(ASK)).text.length).toBe(
        EXECUTION_ONESHOT_TEXT_MAX_LENGTH,
      );
    });
  });

  describe("the caller's mistakes are refused unsent", () => {
    it.each<[string, Partial<ExecutionOneShotOptions>]>([
      ["a blank prompt", { prompt: " \n\t " }],
      ["an empty prompt", { prompt: "" }],
      ["a prompt over the cap", { prompt: `BLUEBIRD${"x".repeat(65_536)}` }],
      ["a blank provider", { provider: " " }],
      ["a provider over 256 characters", { provider: "p".repeat(257) }],
      ["an empty model", { model: "" }],
      ["an empty effort", { effort: "" }],
      ["a timeout of zero", { timeoutMs: 0 }],
      ["a fractional timeout", { timeoutMs: 1.5 }],
      ["a timeout past 120 s", { timeoutMs: 120_001 }],
      ["a timeout that is not a number", { timeoutMs: "5000" as never }],
      ["tools it does not take", { tools: ["Bash"] } as never],
      ["a workspace it does not take", { workspace: "/srv/app" } as never],
    ])("%s", async (_case, change) => {
      const error = await failureOf(
        client().oneShot({ ...ASK, prompt: `${PROMPT} BLUEBIRD`, ...change }),
      );

      expect(error).toBeInstanceOf(TypeError);
      expect(everythingIn(error)).not.toContain("BLUEBIRD");
      expect(requests).toEqual([]);
    });

    it("takes a prompt exactly at the cap, and a timeout of exactly 120 s", async () => {
      const prompt = "x".repeat(65_536);

      await client().oneShot({ ...ASK, prompt, timeoutMs: 120_000 });

      expect(JSON.parse(host.oneShotRequests[0]!.body)).toMatchObject({
        prompt,
        timeoutMs: 120_000,
      });
    });
  });

  it("lets the caller's abort end the /health probe, and sends nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("navigated away");
    const stalled: typeof globalThis.fetch = (input, init) =>
      String(input).endsWith("/health")
        ? new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal!.reason),
            );
            setTimeout(() => controller.abort(reason), 5);
          })
        : host.fetch(input, init);
    const connection = createExecutionHostClient({
      baseUrl: "https://host.test/",
      token: host.token,
      fetch: counting(stalled),
      // Short, so a probe deaf to the caller fails as a timeout, not a hang.
      healthTimeoutMs: 200,
    });

    const error = await failureOf(
      connection.oneShot({ ...ASK, signal: controller.signal }),
    );

    expect(error).toBe(reason);
    expect(requests).toEqual([{ method: "GET", path: "/health" }]);
  });

  it("rethrows the caller's abort as it came", async () => {
    const controller = new AbortController();
    const reason = new Error("navigated away");
    const aborting: typeof globalThis.fetch = (input, init) => {
      if (String(input).endsWith("/v0/oneshot")) controller.abort(reason);
      return host.fetch(input, init);
    };

    const error = await failureOf(
      client(aborting).oneShot({ ...ASK, signal: controller.signal }),
    );

    expect(error).toBe(reason);
  });

  it("says a broken connection in its own words, whatever fetch quoted", async () => {
    // A fetch whose own error quotes the request it failed to send.
    const quoting: typeof globalThis.fetch = (input, init) =>
      String(input).endsWith("/v0/oneshot")
        ? Promise.reject(
            Object.assign(
              new TypeError(`fetch failed sending ${String(init?.body)}`),
              { cause: new Error(`socket closed after ${String(init?.body)}`) },
            ),
          )
        : host.fetch(input, init);

    const error = await failureOf(client(quoting).oneShot(ASK));

    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({
      kind: "network",
      operation: "oneshot",
      status: null,
      reason: "the connection to the host failed",
    });
    expect((error as Error).cause).toBeUndefined();
    expect(everythingIn(error)).not.toContain("BLUEBIRD");
  });

  it("is a network error, quoting no prompt, when the host cannot be reached", async () => {
    const broken: typeof globalThis.fetch = (input, init) =>
      String(input).endsWith("/v0/oneshot")
        ? Promise.reject(
            Object.assign(new TypeError("fetch failed"), {
              cause: { code: "ECONNRESET" },
            }),
          )
        : host.fetch(input, init);

    const error = await failureOf(client(broken).oneShot(ASK));

    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({ kind: "network", operation: "oneshot" });
    expect(everythingIn(error)).not.toContain("BLUEBIRD");
  });
});
