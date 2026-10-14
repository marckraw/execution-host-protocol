import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionInteractionResponseError,
  hostTakesStructuredInteractions,
} from "../../src/client/index.js";
import {
  encodeExecutionCommandEnvelope,
  type ExecutionHostCommand,
} from "../../src/index.js";
import { createStubHost, HEALTH_BODY, type StubHost } from "./stub-host.js";

let host: StubHost;
beforeEach(() => {
  host = createStubHost();
});
const client = (fetch: typeof globalThis.fetch = host.fetch) =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token: host.token,
    fetch,
  });

/** Every request the client made, as `METHOD /path`, and every body it sent. */
function counted(stub: StubHost) {
  const requests: string[] = [];
  const bodies: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    requests.push(
      `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`,
    );
    if (typeof init?.body === "string") bodies.push(init.body);
    return stub.fetch(input, init);
  };
  return { requests, bodies, fetch };
}

/** A host advertising every id the stub does, but `interactions.structured`. */
function withoutStructuredInteractions(stub: StubHost) {
  stub.healthBody = {
    ...HEALTH_BODY,
    executionProtocol: {
      version: 1,
      capabilities: HEALTH_BODY.executionProtocol.capabilities.filter(
        (id) => id !== "interactions.structured",
      ),
    },
  };
}

const COMMANDS = "POST /v0/execution/sessions/session-1/commands";
const answer: ExecutionHostCommand = {
  kind: "send-message",
  text: "Local",
  options: {
    deliveryMode: "answer",
    queuedInputId: "input-1",
    interactionResponse: {
      kind: "choice",
      answers: [{ questionId: "target", values: ["Local"] }],
    },
  },
};
const { interactionResponse: _, ...plainOptions } =
  answer.kind === "send-message" ? answer.options! : {};
const plainAnswer: ExecutionHostCommand = {
  kind: "send-message",
  text: "Local",
  options: plainOptions,
};

describe("an answer naming choices (MAR-4002)", () => {
  it("is sent as it always was, after one /health, to a host advertising it", async () => {
    const { requests, bodies, fetch } = counted(host);
    expect(
      await client(fetch).command("session-1", answer, { commandId: "c-1" }),
    ).toEqual({ status: "accepted", commandId: "c-1" });
    expect(requests).toEqual(["GET /health", COMMANDS]);
    expect(bodies).toEqual([
      encodeExecutionCommandEnvelope({
        protocolVersion: 1,
        sessionId: "session-1",
        commandId: "c-1",
        command: answer,
      }),
    ]);
  });

  it("is refused before any request but /health on a host without the id", async () => {
    withoutStructuredInteractions(host);
    const { requests, fetch } = counted(host);
    const refusal = await client(fetch)
      .command("session-1", answer)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionInteractionResponseError);
    expect(refusal).toMatchObject({
      code: "interactions-unsupported",
      operation: "command send-message",
    });
    expect((refusal as Error).message).toContain("interactions.structured");
    expect((refusal as Error).message).toContain("nothing was sent");
    expect(requests).toEqual(["GET /health"]);
    expect(host.commandRequests).toEqual([]);
  });

  it.each([
    ["a near miss", ["interactions.structured.v2", "interactions"]],
    ["none", []],
  ])("is refused on a host advertising %s", async (_label, capabilities) => {
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: { version: 1, capabilities },
    };
    await expect(client().command("session-1", answer)).rejects.toMatchObject({
      code: "interactions-unsupported",
    });
    expect(host.commandRequests).toEqual([]);
  });

  it("is refused on a host whose descriptor is unreadable", async () => {
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: {
        version: 99,
        capabilities: ["interactions.structured"],
      },
    };
    const refusal = (await client()
      .command("session-1", answer)
      .catch((error: unknown) => error)) as ExecutionInteractionResponseError;
    expect(refusal.code).toBe("interactions-unsupported");
    expect(refusal.reason).toContain("descriptor is unreadable");
    expect(host.commandRequests).toEqual([]);
  });

  it("sends nothing when the probe fails, and says so as the probe", async () => {
    host.healthStatus = 503;
    await expect(client().command("session-1", answer)).rejects.toMatchObject({
      kind: "http",
      operation: "health",
    });
    expect(host.commandRequests).toEqual([]);
  });

  it("leaves an answer without choices as one request, as before", async () => {
    withoutStructuredInteractions(host);
    const { requests, bodies, fetch } = counted(host);
    expect(
      await client(fetch).command("session-1", plainAnswer, {
        commandId: "c-2",
      }),
    ).toEqual({ status: "accepted", commandId: "c-2" });
    expect(requests).toEqual([COMMANDS]);
    expect(bodies).toEqual([
      JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-1",
        commandId: "c-2",
        command: {
          kind: "send-message",
          text: "Local",
          options: { deliveryMode: "answer", queuedInputId: "input-1" },
        },
      }),
    ]);
  });

  it("tells hostTakesStructuredInteractions apart from its neighbours", () => {
    expect(
      hostTakesStructuredInteractions({ capabilities: ["commands.approval"] }),
    ).toBe(false);
    expect(
      hostTakesStructuredInteractions({
        capabilities: ["interactions.structured"],
      }),
    ).toBe(true);
  });
});
