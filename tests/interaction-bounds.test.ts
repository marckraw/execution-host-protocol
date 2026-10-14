import { describe, expect, it } from "vitest";
import {
  decodeExecutionConversationItem,
  decodeExecutionEventEnvelope,
  EXECUTION_INTERACTION_DESCRIPTION_MAX_LENGTH,
  EXECUTION_INTERACTION_HEADER_MAX_LENGTH,
  EXECUTION_INTERACTION_LABEL_MAX_LENGTH,
  EXECUTION_INTERACTION_OPTIONS_MAX_COUNT,
  EXECUTION_INTERACTION_PREVIEW_MAX_LENGTH,
  EXECUTION_INTERACTION_QUESTION_ID_MAX_LENGTH,
  EXECUTION_INTERACTION_QUESTION_MAX_LENGTH,
  EXECUTION_INTERACTION_QUESTIONS_MAX_COUNT,
} from "../src/index.js";
import { conversationItemFixtures } from "./fixtures/contract-fixtures.js";

const REQUEST = "event.delta.item.request";
const inputRequest = conversationItemFixtures["input-request"].value;

const option = (
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  label: `Option ${index}`,
  description: `What option ${index} does.`,
  ...overrides,
});
const question = (
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: `q${index}`,
  question: `Question ${index}?`,
  header: `Q${index}`,
  options: [option(0), option(1)],
  multiSelect: false,
  ...overrides,
});
const choice = (questions: unknown[]) => ({ kind: "choice", questions });

/** The raw text of an envelope adding an input request with `request`. */
const envelopeWith = (request: unknown) =>
  JSON.stringify({
    protocolVersion: 1,
    sessionId: "session-1",
    seq: 1,
    event: {
      kind: "delta",
      delta: {
        kind: "conversation.item.add",
        item: { ...inputRequest, request },
      },
    },
  });

function decodeRequest(request: unknown) {
  const decoded = decodeExecutionEventEnvelope(envelopeWith(request));
  if (
    !decoded.ok ||
    decoded.value.event.kind !== "delta" ||
    decoded.value.event.delta.kind !== "conversation.item.add" ||
    decoded.value.event.delta.item.kind !== "input-request"
  ) {
    throw new Error("the input request was not read");
  }
  const item = decoded.value.event.delta.item;
  return { item, request: item.request, warnings: decoded.warnings ?? [] };
}

describe("structured choice bounds (MAR-4002)", () => {
  it("keeps a request at every bound byte for byte, without a warning", () => {
    const longest = (length: number, fill: string) => fill.repeat(length);
    const request = choice(
      Array.from(
        { length: EXECUTION_INTERACTION_QUESTIONS_MAX_COUNT },
        (_, q) =>
          question(q, {
            id: `${q}`.padEnd(
              EXECUTION_INTERACTION_QUESTION_ID_MAX_LENGTH,
              "i",
            ),
            question: longest(EXECUTION_INTERACTION_QUESTION_MAX_LENGTH, "?"),
            header: longest(EXECUTION_INTERACTION_HEADER_MAX_LENGTH, "h"),
            multiSelect: q % 2 === 1,
            options: Array.from(
              { length: EXECUTION_INTERACTION_OPTIONS_MAX_COUNT },
              (_, o) => ({
                label: `${o}`.padEnd(
                  EXECUTION_INTERACTION_LABEL_MAX_LENGTH,
                  "l",
                ),
                description: longest(
                  EXECUTION_INTERACTION_DESCRIPTION_MAX_LENGTH,
                  "d",
                ),
                preview: longest(EXECUTION_INTERACTION_PREVIEW_MAX_LENGTH, "p"),
              }),
            ),
          }),
      ),
    );
    const raw = envelopeWith(request);
    const decoded = decodeExecutionEventEnvelope(raw);
    expect(decoded).toEqual({ ok: true, value: JSON.parse(raw) });
    expect(JSON.stringify(decoded.ok && decoded.value)).toBe(raw);
  });

  it("keeps the hand-made fixture, and an empty description, as they were", () => {
    const request = choice([
      question(0, {
        options: [{ label: "Local", description: "" }, { label: "Remote" }],
      }),
    ]);
    const raw = envelopeWith(request);
    expect(decodeExecutionEventEnvelope(raw)).toEqual({
      ok: true,
      value: JSON.parse(raw),
    });
    expect(
      decodeExecutionEventEnvelope(envelopeWith(inputRequest.request)),
    ).toEqual({
      ok: true,
      value: JSON.parse(envelopeWith(inputRequest.request)),
    });
  });

  it("drops the whole request past the questions cap, named alone", () => {
    const { item, request, warnings } = decodeRequest(
      choice(
        Array.from(
          { length: EXECUTION_INTERACTION_QUESTIONS_MAX_COUNT + 1 },
          (_, index) => question(index),
        ),
      ),
    );
    // Every question past the cap would be answered empty by the host.
    expect(request).toBeUndefined();
    expect(item).not.toHaveProperty("request");
    expect(item.prompt).toBe(inputRequest.prompt);
    expect(warnings).toEqual([
      { reason: "dropped-invalid-field", path: REQUEST },
    ]);
  });

  it("reads no question of a request past the cap", () => {
    let reads = 0;
    const watched = (index: number) =>
      new Proxy(question(index), {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
    const decoded = decodeExecutionConversationItem({
      ...inputRequest,
      request: choice(
        Array.from(
          { length: EXECUTION_INTERACTION_QUESTIONS_MAX_COUNT + 1 },
          (_, index) => watched(index),
        ),
      ),
    });
    expect(decoded).toMatchObject({
      ok: true,
      warnings: [{ reason: "dropped-invalid-field", path: "item.request" }],
    });
    expect(reads).toBe(0);
  });

  it("cuts options past the cap, and keeps the question", () => {
    const options = Array.from(
      { length: EXECUTION_INTERACTION_OPTIONS_MAX_COUNT + 1 },
      (_, index) => option(index),
    );
    const { request, warnings } = decodeRequest(
      choice([question(0, { options }), question(1)]),
    );
    expect(request).toEqual(
      choice([
        question(0, {
          options: options.slice(0, EXECUTION_INTERACTION_OPTIONS_MAX_COUNT),
        }),
        question(1),
      ]),
    );
    expect(warnings).toEqual([
      {
        reason: "dropped-excess-entries",
        path: `${REQUEST}.questions.0.options`,
      },
    ]);
  });

  it("keeps a Claude question whose id is its own long text", () => {
    // AskUserQuestion gives a question no id; agents-daemon uses its text.
    const text = `${"Which of these migration strategies should we use ".repeat(6)}?`;
    expect(text.length).toBeGreaterThan(300);
    const claude = question(0, { id: text, question: text });
    const { request, warnings } = decodeRequest(choice([claude]));
    expect(request).toEqual(choice([claude]));
    expect(warnings).toEqual([]);
  });

  it.each([
    ["id", EXECUTION_INTERACTION_QUESTION_ID_MAX_LENGTH],
    ["question", EXECUTION_INTERACTION_QUESTION_MAX_LENGTH],
    ["header", EXECUTION_INTERACTION_HEADER_MAX_LENGTH],
  ])(
    "drops the whole request when a question's %s is past %i",
    (field, max) => {
      const { item, request, warnings } = decodeRequest(
        choice([
          question(0, {
            options: [option(0), { label: "" }],
          }),
          question(1, { [field]: "x".repeat(max + 1) }),
          question(2),
        ]),
      );
      // A partial request would be answered partly, and the host would fill
      // the question nobody saw with an empty answer.
      expect(request).toBeUndefined();
      expect(item.prompt).toBe(inputRequest.prompt);
      expect(warnings).toEqual([
        { reason: "dropped-invalid-field", path: REQUEST },
      ]);
    },
  );

  it("drops an option whose label is past the bound, and keeps the rest", () => {
    const { request, warnings } = decodeRequest(
      choice([
        question(0, {
          options: [
            option(0),
            option(1, {
              label: "x".repeat(EXECUTION_INTERACTION_LABEL_MAX_LENGTH + 1),
            }),
            option(2),
          ],
        }),
        question(1),
      ]),
    );
    expect(request).toEqual(
      choice([question(0, { options: [option(0), option(2)] }), question(1)]),
    );
    expect(warnings).toEqual([
      {
        reason: "dropped-invalid-field",
        path: `${REQUEST}.questions.0.options.1`,
      },
    ]);
  });

  it.each([
    ["description", EXECUTION_INTERACTION_DESCRIPTION_MAX_LENGTH],
    ["preview", EXECUTION_INTERACTION_PREVIEW_MAX_LENGTH],
  ])(
    "drops a %s past %i from its option, and keeps the option",
    (field, max) => {
      const { request, warnings } = decodeRequest(
        choice([
          question(0, {
            options: [option(0), option(1, { [field]: "x".repeat(max + 1) })],
          }),
        ]),
      );
      const { [field]: _dropped, ...rest } = option(1, { [field]: "" });
      expect(request).toEqual(
        choice([question(0, { options: [option(0), rest] })]),
      );
      expect(warnings).toEqual([
        {
          reason: "dropped-invalid-field",
          path: `${REQUEST}.questions.0.options.1.${field}`,
        },
      ]);
    },
  );

  it("drops one malformed option, not the request", () => {
    const { item, request, warnings } = decodeRequest(
      choice([
        question(0, {
          options: [
            option(0),
            { description: "no label" },
            option(2, { preview: 7 }),
          ],
        }),
      ]),
    );
    expect(item.prompt).toBe(inputRequest.prompt);
    expect(request).toEqual(
      choice([question(0, { options: [option(0), option(2)] })]),
    );
    expect(warnings).toEqual([
      {
        reason: "dropped-invalid-field",
        path: `${REQUEST}.questions.0.options.1`,
      },
      {
        reason: "dropped-invalid-field",
        path: `${REQUEST}.questions.0.options.2.preview`,
      },
    ]);
  });

  it.each([
    ["is malformed", question(1, { multiSelect: "yes" })],
    ["is not a question", "q1"],
    [
      "has every option dropped",
      question(1, {
        options: [
          { label: "x".repeat(EXECUTION_INTERACTION_LABEL_MAX_LENGTH + 1) },
          { description: "no label" },
        ],
      }),
    ],
  ])("drops the whole request when one question %s", (_, broken) => {
    const { item, request, warnings } = decodeRequest(
      choice([question(0), broken]),
    );
    expect(request).toBeUndefined();
    expect(item).not.toHaveProperty("request");
    expect(warnings).toEqual([
      { reason: "dropped-invalid-field", path: REQUEST },
    ]);
  });

  it("keeps a question that came with no options, as it did before", () => {
    const { request, warnings } = decodeRequest(
      choice([question(0, { options: [] })]),
    );
    expect(request).toEqual(choice([question(0, { options: [] })]));
    expect(warnings).toEqual([]);
  });

  it.each([
    ["no question left", choice([question(0, { header: "" })])],
    ["an empty list", choice([])],
    ["no list", { kind: "choice", questions: "q0" }],
  ])("drops the request with %s, named alone, and keeps the item", (_, raw) => {
    const { item, request, warnings } = decodeRequest(raw);
    expect(request).toBeUndefined();
    expect(item).not.toHaveProperty("request");
    expect(item.prompt).toBe(inputRequest.prompt);
    expect(warnings).toEqual([
      { reason: "dropped-invalid-field", path: REQUEST },
    ]);
  });

  it("bounds the standalone item reader the same way", () => {
    const decoded = decodeExecutionConversationItem({
      ...inputRequest,
      request: choice([
        question(0, {
          options: [
            option(0, {
              label: "x".repeat(EXECUTION_INTERACTION_LABEL_MAX_LENGTH + 1),
            }),
            option(1),
          ],
        }),
      ]),
    });
    expect(decoded).toEqual({
      ok: true,
      value: {
        ...inputRequest,
        request: choice([question(0, { options: [option(1)] })]),
      },
      warnings: [
        {
          reason: "dropped-invalid-field",
          path: "item.request.questions.0.options.0",
        },
      ],
    });
  });
});
