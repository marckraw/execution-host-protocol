import { describe, expect, it } from "vitest";
import {
  decodeExecutionProviderListResponse,
  EXECUTION_PROVIDER_ACCOUNT_TEXT_MAX_LENGTH,
  type ExecutionProvider,
} from "../src/index.js";
import { PROVIDERS_BODY } from "./client/stub-host.js";

/**
 * MAR-3821: the account a provider is signed in as, as its host says it. It
 * never costs the catalogue, and never reaches a reader as it came.
 */

/** One provider carrying `account`, read; the catalogue must still read. */
const read = (account: unknown): ExecutionProvider => {
  const result = decodeExecutionProviderListResponse({
    providers: [{ id: "codex", label: "Codex", models: [], account }],
  });
  if (!result.ok) throw new Error(`the catalogue failed: ${result.reason}`);
  return result.value.providers[0]!;
};

const WITHOUT_ACCOUNT: ExecutionProvider = {
  id: "codex",
  label: "Codex",
  effortLevels: [],
  models: [],
};

describe("a provider's account", () => {
  it("reads one from the provider's sign-in, with its plan", () => {
    expect(
      read({ label: "marc@example.com", plan: "pro", source: "sign-in" }),
    ).toStrictEqual({
      ...WITHOUT_ACCOUNT,
      account: { label: "marc@example.com", plan: "pro", source: "sign-in" },
    });
  });

  it("reads one an operator labelled, with the day its token ends", () => {
    expect(
      read({
        label: "marc@example.com",
        source: "label",
        expiresOn: "2027-09-30",
      }),
    ).toStrictEqual({
      ...WITHOUT_ACCOUNT,
      account: {
        label: "marc@example.com",
        source: "label",
        expiresOn: "2027-09-30",
      },
    });
  });

  it("leaves an older host's catalogue exactly as it read before", () => {
    const result = decodeExecutionProviderListResponse(PROVIDERS_BODY);
    expect(result.ok).toBe(true);
    for (const provider of result.ok ? result.value.providers : []) {
      expect("account" in provider).toBe(false);
    }
    expect("account" in read(undefined)).toBe(false);
    expect("account" in read(null)).toBe(false);
  });

  it("keeps none of what the host sent beyond the named fields", () => {
    const account = read({
      label: "marc@example.com",
      source: "sign-in",
      idToken: "made-up.header.claims",
      verified: true,
    }).account;
    expect(account).toStrictEqual({
      label: "marc@example.com",
      source: "sign-in",
    });
  });

  it("leaves out an account it cannot read, and the catalogue reads", () => {
    const unreadable: Array<[string, unknown]> = [
      ["a string", "marc@example.com"],
      ["a list", [{ label: "marc@example.com", source: "sign-in" }]],
      ["a number", 1],
      ["a boolean", true],
      ["no source", { label: "marc@example.com" }],
      [
        "a source nobody knows",
        { label: "marc@example.com", source: "operator" },
      ],
      ["a source of the wrong case", { label: "m@e.com", source: "Sign-In" }],
      ["a source that is not a string", { label: "m@e.com", source: 1 }],
      ["no label", { source: "label" }],
      ["a label that is not a string", { label: 42, source: "label" }],
      ["an empty label", { label: "", source: "label" }],
      ["a blank label", { label: "  \t ", source: "label" }],
      [
        "a label of control characters only",
        { label: "\u0000\u001b\u007f\u0085‮", source: "label" },
      ],
    ];
    for (const [name, account] of unreadable) {
      expect(read(account), name).toStrictEqual(WITHOUT_ACCOUNT);
    }
  });

  it("cuts a label of 100,000 characters, rather than refuse it", () => {
    const account = read({
      label: "a".repeat(100_000),
      source: "label",
    }).account!;
    expect(EXECUTION_PROVIDER_ACCOUNT_TEXT_MAX_LENGTH).toBe(256);
    expect(account.label).toBe("a".repeat(256));
    // A real email (at most 254) is never cut.
    const email = `${"m".repeat(64)}@${"e".repeat(185)}.com`;
    expect(email).toHaveLength(254);
    expect(read({ label: email, source: "sign-in" }).account!.label).toBe(
      email,
    );
  });

  it("never ends a cut label on half a character", () => {
    const label = `${"a".repeat(255)}😀😀`;
    const cut = read({ label, source: "label" }).account!.label;
    expect(cut).toBe("a".repeat(255));
  });

  it("cleans control and reordering characters out of a label and a plan", () => {
    const account = read({
      label: " marc\u0000@\nexam\u001bple\u0085.com‮⁦ \t",
      plan: "p\u0007r‏o",
      source: "sign-in",
    }).account!;
    expect(account).toStrictEqual({
      label: "marc@example.com",
      plan: "pro",
      source: "sign-in",
    });
  });

  it("keeps what an email or a name may hold", () => {
    expect(
      read({ label: "Łukasz Żółć <łukasz@example.com>", source: "label" })
        .account!.label,
    ).toBe("Łukasz Żółć <łukasz@example.com>");
  });

  it("cuts and cleans a plan the way it does a label", () => {
    expect(
      read({ label: "m@e.com", plan: "x".repeat(10_000), source: "sign-in" })
        .account!.plan,
    ).toBe("x".repeat(256));
  });

  it("leaves out a plan it cannot read, and keeps the account", () => {
    for (const plan of [3, "", " ", "\u0000", { tier: "pro" }, null]) {
      expect(read({ label: "m@e.com", plan, source: "sign-in" })).toStrictEqual(
        {
          ...WITHOUT_ACCOUNT,
          account: { label: "m@e.com", source: "sign-in" },
        },
      );
    }
  });

  it("reads a day the calendar has, and leaves out one it doesn't", () => {
    const expiresOn = (value: unknown) =>
      read({ label: "m@e.com", source: "label", expiresOn: value }).account;

    for (const day of [
      "2027-09-30",
      "2028-02-29",
      "2000-02-29",
      "2027-12-31",
    ]) {
      expect(expiresOn(day), day).toStrictEqual({
        label: "m@e.com",
        source: "label",
        expiresOn: day,
      });
    }
    const notDays: unknown[] = [
      "2027-02-30",
      "2027-02-29",
      "2100-02-29",
      "2027-04-31",
      "2027-13-01",
      "2027-00-10",
      "2027-09-00",
      "2027-9-30",
      "27-09-30",
      "2027-09-30T00:00:00Z",
      " 2027-09-30",
      "2027-09-30\n",
      "30/09/2027",
      "２０２７-09-30",
      "soon",
      "",
      20270930,
      Date.UTC(2027, 8, 30),
      { year: 2027 },
      null,
    ];
    for (const day of notDays) {
      expect(expiresOn(day), String(day)).toStrictEqual({
        label: "m@e.com",
        source: "label",
      });
    }
  });

  it("costs nothing to the providers beside it", () => {
    const result = decodeExecutionProviderListResponse({
      providers: [
        { id: "claude", account: { label: "x".repeat(100_000) } },
        {
          id: "codex",
          account: { label: "marc@example.com", source: "sign-in" },
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        providers: [
          { id: "claude", label: "claude", effortLevels: [], models: [] },
          {
            id: "codex",
            label: "codex",
            effortLevels: [],
            models: [],
            account: { label: "marc@example.com", source: "sign-in" },
          },
        ],
      },
    });
    expect(result.ok && "account" in result.value.providers[0]!).toBe(false);
  });
});

/**
 * A consumer written against 0.21.0 still compiles: it builds a provider
 * without an account, and reads one field by field. `npm run typecheck`
 * checks this file.
 */
export const olderConsumer = (provider: ExecutionProvider): string => {
  const built: ExecutionProvider = {
    id: provider.id,
    label: provider.label,
    effortLevels: provider.effortLevels,
    models: provider.models,
  };
  return `${built.label}: ${built.available === true ? "ready" : "unknown"}`;
};
