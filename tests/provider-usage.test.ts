import { describe, expect, it } from "vitest";
import {
  decodeExecutionProviderListResponse,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROVIDER_USAGE_CREDITS_BALANCE_MAX_LENGTH,
  EXECUTION_PROVIDER_USAGE_TEXT_MAX_LENGTH,
  executionProviderUsageWindowLimits,
  type ExecutionProvider,
  type ExecutionProviderUsage,
  type ExecutionProviderUsageCredits,
  type ExecutionProviderUsageWindow,
} from "../src/index.js";
import { PROVIDERS_BODY } from "./client/stub-host.js";

/**
 * MAR-4198: how much of a provider's account's limits are used, as its host
 * last heard it. It never costs the catalogue, and what cannot be read is
 * unknown: never "0%", never "limited".
 */

/** One provider carrying `usage`, read; the catalogue must still read. */
const read = (usage: unknown): ExecutionProvider => {
  const result = decodeExecutionProviderListResponse({
    providers: [{ id: "claude", label: "Claude", models: [], usage }],
  });
  if (!result.ok) throw new Error(`the catalogue failed: ${result.reason}`);
  return result.value.providers[0]!;
};

const WITHOUT_USAGE: ExecutionProvider = {
  id: "claude",
  label: "Claude",
  effortLevels: [],
  models: [],
};

const OBSERVED_AT = "2026-10-17T14:02:11.000Z";

/** A usage carrying one window, read; the window as read, or none. */
const readWindow = (
  window: unknown,
): ExecutionProviderUsageWindow | undefined =>
  read({ observedAt: OBSERVED_AT, source: "turn", windows: [window] }).usage
    ?.windows[0];

const SESSION_WINDOW = {
  id: "five_hour",
  span: "session",
  label: "Session",
  usedPercent: 2,
  resetsAt: "2026-10-17T18:00:00.000Z",
};

describe("a provider's usage", () => {
  it("is a known capability", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain("providers.usage.v1");
  });

  it("reads Claude's, heard during a turn", () => {
    const usage = {
      observedAt: OBSERVED_AT,
      source: "turn",
      status: "ok",
      windows: [
        SESSION_WINDOW,
        {
          id: "seven_day",
          span: "week",
          label: "Week",
          usedPercent: 5,
          resetsAt: "2026-10-21T09:00:00.000Z",
        },
        {
          id: "seven_day_opus",
          span: "week",
          label: "Opus week",
          usedPercent: 41.5,
          resetsAt: "2026-10-21T09:00:00.000Z",
          modelFamily: "opus",
        },
      ],
    };
    expect(read(usage)).toStrictEqual({ ...WITHOUT_USAGE, usage });
  });

  it("reads Codex's, asked for, with no verdict", () => {
    const usage = {
      observedAt: "2026-10-17T14:02:11+02:00",
      source: "read",
      windows: [
        {
          id: "codex",
          span: "week",
          label: "Week",
          usedPercent: 5,
          resetsAt: "2026-10-24T10:14:55Z",
        },
      ],
    };
    expect(read(usage).usage).toStrictEqual(usage);
  });

  it("reads one that has heard no window yet", () => {
    expect(
      read({ observedAt: OBSERVED_AT, source: "read", windows: [] }).usage,
    ).toStrictEqual({ observedAt: OBSERVED_AT, source: "read", windows: [] });
  });

  it("leaves an older host's catalogue exactly as it read before", () => {
    const result = decodeExecutionProviderListResponse(PROVIDERS_BODY);
    expect(result.ok).toBe(true);
    for (const provider of result.ok ? result.value.providers : []) {
      expect("usage" in provider).toBe(false);
    }
    expect(read(undefined)).toStrictEqual(WITHOUT_USAGE);
    expect(read(null)).toStrictEqual(WITHOUT_USAGE);
  });

  it("keeps none of what the host sent beyond the named fields", () => {
    expect(
      read({
        observedAt: OBSERVED_AT,
        source: "turn",
        windows: [{ ...SESSION_WINDOW, utilization: 0.02, isUsingOverage: 1 }],
        overageStatus: "rejected",
        futureUsageField: { balance: "12" },
      }).usage,
    ).toStrictEqual({
      observedAt: OBSERVED_AT,
      source: "turn",
      windows: [SESSION_WINDOW],
    });
  });

  it("leaves out a usage it cannot read, and the catalogue reads", () => {
    const usage = { observedAt: OBSERVED_AT, source: "turn", windows: [] };
    const unreadable: Array<[string, unknown]> = [
      ["a string", "5%"],
      ["a number", 5],
      ["a list", [usage]],
      ["no observedAt", { source: "turn", windows: [] }],
      ["an observedAt in epoch seconds", { ...usage, observedAt: 1792242000 }],
      ["an observedAt with no time", { ...usage, observedAt: "2026-10-17" }],
      [
        "an observedAt the calendar lacks",
        { ...usage, observedAt: "2026-02-30T10:00:00Z" },
      ],
      ["no source", { observedAt: OBSERVED_AT, windows: [] }],
      ["a source nobody knows", { ...usage, source: "push" }],
      ["a source of the wrong case", { ...usage, source: "Turn" }],
      ["no windows", { observedAt: OBSERVED_AT, source: "turn" }],
      ["windows that are not a list", { ...usage, windows: SESSION_WINDOW }],
    ];
    for (const [name, raw] of unreadable) {
      expect(read(raw), name).toStrictEqual(WITHOUT_USAGE);
    }
  });

  it("leaves out a verdict it does not know, and keeps the usage", () => {
    for (const status of ["allowed_warning", "rejected", "OK", 1, null]) {
      expect(
        read({
          observedAt: OBSERVED_AT,
          source: "turn",
          status,
          windows: [SESSION_WINDOW],
        }).usage,
        String(status),
      ).toStrictEqual({
        observedAt: OBSERVED_AT,
        source: "turn",
        windows: [SESSION_WINDOW],
      });
    }
    for (const status of ["ok", "warning", "limited"]) {
      expect(
        read({ observedAt: OBSERVED_AT, source: "turn", status, windows: [] })
          .usage?.status,
      ).toBe(status);
    }
  });

  it("leaves out a window it cannot read, and keeps the rest", () => {
    const unreadable: Array<[string, unknown]> = [
      ["a string", "five_hour"],
      ["null", null],
      ["no id", { ...SESSION_WINDOW, id: undefined }],
      ["an id that is not a string", { ...SESSION_WINDOW, id: 5 }],
      ["a blank id", { ...SESSION_WINDOW, id: " \u0000 " }],
      ["no span", { ...SESSION_WINDOW, span: undefined }],
      ["a span that is not a string", { ...SESSION_WINDOW, span: 5 }],
      ["no usedPercent", { ...SESSION_WINDOW, usedPercent: undefined }],
      ["a usedPercent in words", { ...SESSION_WINDOW, usedPercent: "2" }],
      ["a usedPercent of null", { ...SESSION_WINDOW, usedPercent: null }],
    ];
    const week = {
      id: "seven_day",
      span: "week",
      label: "Week",
      usedPercent: 5,
    };
    for (const [name, window] of unreadable) {
      expect(
        read({
          observedAt: OBSERVED_AT,
          source: "turn",
          windows: [window, week],
        }).usage,
        name,
      ).toStrictEqual({
        observedAt: OBSERVED_AT,
        source: "turn",
        windows: [week],
      });
    }
  });

  it("keeps the first of two windows with one id", () => {
    expect(
      read({
        observedAt: OBSERVED_AT,
        source: "turn",
        windows: [SESSION_WINDOW, { ...SESSION_WINDOW, usedPercent: 99 }],
      }).usage?.windows,
    ).toStrictEqual([SESSION_WINDOW]);
  });

  it("reads a span it does not know as other, so the window still counts", () => {
    expect(readWindow({ ...SESSION_WINDOW, span: "month" })).toStrictEqual({
      ...SESSION_WINDOW,
      span: "other",
    });
    expect(readWindow({ ...SESSION_WINDOW, span: "other" })?.span).toBe(
      "other",
    );
  });

  it("clamps usedPercent to 0–100", () => {
    const used = (usedPercent: number) =>
      readWindow({ ...SESSION_WINDOW, usedPercent })?.usedPercent;
    expect(used(-3)).toBe(0);
    expect(used(0)).toBe(0);
    expect(used(41.5)).toBe(41.5);
    expect(used(100)).toBe(100);
    expect(used(140)).toBe(100);
    expect(used(1e308)).toBe(100);
  });

  it("drops a date it cannot read, not the window", () => {
    for (const resetsAt of [
      1792242000,
      "2026-10-17",
      "2026-02-30T10:00:00Z",
      "2026-10-17T24:00:00Z",
      "tomorrow",
      "",
      null,
    ]) {
      const { resetsAt: _, ...withoutReset } = SESSION_WINDOW;
      expect(
        readWindow({ ...SESSION_WINDOW, resetsAt }),
        String(resetsAt),
      ).toStrictEqual(withoutReset);
    }
  });

  it("falls back to the id for a label it cannot read", () => {
    for (const label of [undefined, 5, "", " \t", "\u0000‮"]) {
      expect(readWindow({ ...SESSION_WINDOW, label })?.label).toBe("five_hour");
    }
  });

  it("drops a model family it cannot read, not the window", () => {
    for (const modelFamily of [5, "", " ", "\u0007", ["opus"]]) {
      expect(
        readWindow({ ...SESSION_WINDOW, modelFamily }),
        String(modelFamily),
      ).toStrictEqual(SESSION_WINDOW);
    }
  });

  it("cleans and cuts its text as an account's", () => {
    expect(EXECUTION_PROVIDER_USAGE_TEXT_MAX_LENGTH).toBe(128);
    expect(
      readWindow({
        ...SESSION_WINDOW,
        id: " seven\u0000_day_opus\n",
        label: "Opus‮ week⁦",
        modelFamily: "op‏us",
      }),
    ).toStrictEqual({
      ...SESSION_WINDOW,
      id: "seven_day_opus",
      label: "Opus week",
      modelFamily: "opus",
    });
    const long = readWindow({
      ...SESSION_WINDOW,
      id: "i".repeat(10_000),
      label: "l".repeat(10_000),
      modelFamily: "m".repeat(10_000),
    });
    expect(long?.id).toBe("i".repeat(128));
    expect(long?.label).toBe("l".repeat(128));
    expect(long?.modelFamily).toBe("m".repeat(128));
  });
});

describe("a provider's usage credits (MAR-4249)", () => {
  const usage: ExecutionProviderUsage = {
    observedAt: OBSERVED_AT,
    source: "read",
    status: "limited",
    windows: [{ ...SESSION_WINDOW, span: "session", usedPercent: 100 }],
  };
  const credits: ExecutionProviderUsageCredits = {
    hasCredits: true,
    unlimited: false,
    balance: "9007199254740993.0012300",
    observedAt: "2026-10-17T14:01:00+02:00",
  };
  const readCredits = (raw: unknown) => read({ ...usage, credits: raw }).usage;

  it("preserves the provider's decimal string and separate observation time", () => {
    expect(readCredits(credits)).toStrictEqual({ ...usage, credits });
  });

  it("keeps absent credits absent, as on an older host", () => {
    expect(read(usage).usage).toStrictEqual(usage);
    expect(readCredits(undefined)).toStrictEqual(usage);
  });

  it.each([
    { hasCredits: true, unlimited: true },
    { hasCredits: false, unlimited: false },
    { hasCredits: false, unlimited: false, balance: "0.00" },
    { hasCredits: true, unlimited: false },
  ])(
    "reads credits without inferring a balance or changing limited usage: %j",
    (raw) => {
      expect(readCredits(raw)).toStrictEqual({ ...usage, credits: raw });
    },
  );

  it("cleans balance text as windows are cleaned and projects only known fields", () => {
    expect(
      readCredits({
        ...credits,
        balance: " \u000012.300\n\u202e\u2066 ",
        futureCreditsField: { amount: 7 },
      }),
    ).toStrictEqual({ ...usage, credits: { ...credits, balance: "12.300" } });
  });

  it.each(["0", "0012.3000", "-0.001", "9".repeat(128)])(
    "preserves a plain decimal amount exactly: %s",
    (balance) => {
      expect(readCredits({ ...credits, balance })?.credits?.balance).toBe(
        balance,
      );
    },
  );

  it("drops malformed credits, keeping all usage windows and the verdict", () => {
    expect(EXECUTION_PROVIDER_USAGE_CREDITS_BALANCE_MAX_LENGTH).toBe(128);
    const unreadable: Array<[string, unknown]> = [
      ["null", null],
      ["a list", [credits]],
      ["a string", "12.3"],
      ["a missing hasCredits", { unlimited: false, balance: "12.3" }],
      ["a missing unlimited", { hasCredits: true }],
      ["hasCredits as a number", { ...credits, hasCredits: 1 }],
      ["unlimited as a string", { ...credits, unlimited: "false" }],
      ["a number for balance", { ...credits, balance: 12.3 }],
      ["a null balance", { ...credits, balance: null }],
      ["an empty balance", { ...credits, balance: " \u0000 " }],
      ["a non-decimal balance", { ...credits, balance: "12 credits" }],
      ["an exponent", { ...credits, balance: "1e3" }],
      ["a non-finite amount", { ...credits, balance: "Infinity" }],
      ["an internal space", { ...credits, balance: "1 2" }],
      ["a missing fraction", { ...credits, balance: "12." }],
      ["a non-ASCII digit", { ...credits, balance: "١٢" }],
      ["one past the bound", { ...credits, balance: "9".repeat(129) }],
      ["a very long string", { ...credits, balance: "9".repeat(10_000) }],
    ];
    for (const [name, raw] of unreadable) {
      expect(readCredits(raw), name).toStrictEqual(usage);
    }
  });

  it("leaves out an unreadable observation time alone, falling back to usage", () => {
    const { observedAt: _, ...withoutTime } = credits;
    for (const observedAt of [
      undefined,
      null,
      1792242000,
      "2026-10-17",
      "2026-02-30T10:00:00Z",
    ]) {
      expect(readCredits({ ...credits, observedAt })).toStrictEqual({
        ...usage,
        credits: withoutTime,
      });
    }
  });

  it("round trips through JSON and the public catalogue codec without losing precision", () => {
    const providers = [{ ...WITHOUT_USAGE, usage: { ...usage, credits } }];
    const result = decodeExecutionProviderListResponse(
      JSON.parse(JSON.stringify({ protocolVersion: 1, providers })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toStrictEqual({ protocolVersion: 1, providers });
    expect(
      decodeExecutionProviderListResponse(
        JSON.parse(JSON.stringify(result.value)),
      ),
    ).toStrictEqual(result);
  });
});

describe("whether a usage window limits a model", () => {
  const AT = Date.parse("2026-10-17T15:00:00Z");
  const OPUS = { slug: "claude-opus-5-5", label: "Opus 5.5" };
  const HAIKU = { slug: "claude-haiku-4-5-20251001", label: "Haiku 4.5" };

  it("limits nothing at or past its reset", () => {
    expect(
      executionProviderUsageWindowLimits(
        { resetsAt: "2026-10-17T14:59:59Z" },
        OPUS,
        AT,
      ),
    ).toBe(false);
    expect(
      executionProviderUsageWindowLimits(
        { resetsAt: "2026-10-17T15:00:00Z" },
        OPUS,
        AT,
      ),
    ).toBe(false);
    expect(
      executionProviderUsageWindowLimits(
        { resetsAt: "2026-10-17T17:00:00+02:00" },
        OPUS,
        new Date(AT),
      ),
    ).toBe(false);
  });

  it("limits while its reset is ahead", () => {
    expect(
      executionProviderUsageWindowLimits(
        { resetsAt: "2026-10-17T15:00:01Z" },
        OPUS,
        AT,
      ),
    ).toBe(true);
    expect(
      executionProviderUsageWindowLimits(
        { resetsAt: "2026-10-17T15:00:00Z" },
        OPUS,
        new Date(AT - 1),
      ),
    ).toBe(true);
  });

  it("limits every model when it names no family", () => {
    for (const model of [OPUS, HAIKU, { slug: "gpt-5.1-codex" }]) {
      expect(executionProviderUsageWindowLimits({}, model, AT)).toBe(true);
    }
  });

  it("still limits when it does not say when it resets", () => {
    expect(executionProviderUsageWindowLimits({}, OPUS, AT)).toBe(true);
    expect(
      executionProviderUsageWindowLimits({ modelFamily: "opus" }, OPUS, AT),
    ).toBe(true);
    // Built by hand rather than read: a reset nobody can read is no reset.
    expect(
      executionProviderUsageWindowLimits({ resetsAt: "soon" }, OPUS, AT),
    ).toBe(true);
  });

  it("limits a model of its family, by slug or by label", () => {
    const opus = { modelFamily: "opus" };
    expect(executionProviderUsageWindowLimits(opus, OPUS, AT)).toBe(true);
    expect(executionProviderUsageWindowLimits(opus, { slug: "opus" }, AT)).toBe(
      true,
    );
    expect(
      executionProviderUsageWindowLimits(
        opus,
        { slug: "default", label: "Opus 5.5" },
        AT,
      ),
    ).toBe(true);
    expect(
      executionProviderUsageWindowLimits(
        { modelFamily: "Fable" },
        { slug: "claude-fable-5-1" },
        AT,
      ),
    ).toBe(true);
  });

  it("limits no model of another family", () => {
    const opus = { modelFamily: "opus" };
    expect(executionProviderUsageWindowLimits(opus, HAIKU, AT)).toBe(false);
    expect(
      executionProviderUsageWindowLimits(opus, { slug: "claude-opusx-1" }, AT),
    ).toBe(false);
  });

  it("limits a Codex model only by its whole slug", () => {
    const codex = { modelFamily: "gpt-5.1-codex" };
    expect(
      executionProviderUsageWindowLimits(codex, { slug: "gpt-5.1-codex" }, AT),
    ).toBe(true);
    expect(
      executionProviderUsageWindowLimits(codex, { slug: "GPT-5.1-Codex" }, AT),
    ).toBe(true);
    expect(
      executionProviderUsageWindowLimits(
        codex,
        { slug: "gpt-5.1-codex-max" },
        AT,
      ),
    ).toBe(false);
    expect(
      executionProviderUsageWindowLimits(codex, { slug: "gpt-5.1" }, AT),
    ).toBe(false);
  });

  it("limits nothing past its reset, whatever its family", () => {
    expect(
      executionProviderUsageWindowLimits(
        { modelFamily: "opus", resetsAt: "2026-10-17T14:00:00Z" },
        OPUS,
        AT,
      ),
    ).toBe(false);
  });
});
