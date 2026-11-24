import { describe, expect, it } from "vitest";
import {
  decodeExecutionPullRequests,
  EXECUTION_PULL_REQUEST_MENTIONS_MAX,
  isExecutionPullRequestRepository,
  primaryPullRequestOf,
  pullRequestKeyOf,
  type ExecutionPullRequestFact,
  type ExecutionPullRequestRole,
  type ExecutionPullRequestState,
  type ExecutionPullRequestStatus,
} from "../src/index.js";

const minute = (n: number) =>
  new Date(Date.UTC(2026, 10, 24, 10, n)).toISOString();

function fact(
  role: ExecutionPullRequestRole,
  number: number,
  at: number,
  extra: Partial<ExecutionPullRequestFact> = {},
): ExecutionPullRequestFact {
  return {
    repository: "acme/app",
    number,
    role,
    source: "command",
    at: minute(at),
    ...extra,
  };
}

function stateOf(
  state: ExecutionPullRequestStatus,
  extra: Partial<ExecutionPullRequestState> = {},
): ExecutionPullRequestState {
  return {
    state,
    checks: { passed: 4, failed: 0, running: 1 },
    title: "Fix the login form",
    url: "https://github.com/acme/app/pull/7",
    checkedAt: minute(30),
    ...extra,
  };
}

/** Every order of `items`: the rule must not care which one it was given. */
function orders<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    orders([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

function expectPrimary(
  facts: ExecutionPullRequestFact[],
  expected: ExecutionPullRequestFact | null,
) {
  for (const order of orders(facts)) {
    expect(primaryPullRequestOf(order)).toBe(expected);
  }
}

describe("primaryPullRequestOf (MAR-5695, board 4)", () => {
  it("is none for no facts, and for mentions alone", () => {
    expect(primaryPullRequestOf([])).toBeNull();
    expectPrimary([fact("mentioned", 1, 1), fact("mentioned", 2, 2)], null);
  });

  it("takes the PR it opened over every other role, however new they are", () => {
    const opened = fact("opened", 1, 1);
    expectPrimary(
      [
        opened,
        fact("pushed", 2, 5),
        fact("edited", 3, 6),
        fact("reviewed", 4, 7),
        fact("merged", 5, 8),
        fact("mentioned", 6, 9),
      ],
      opened,
    );
  });

  it("takes the PR it opened even once that one is closed", () => {
    const opened = fact("opened", 1, 1, { state: stateOf("closed") });
    expectPrimary([opened, fact("pushed", 2, 5)], opened);
  });

  it("takes the newest it opened when it opened several", () => {
    const newer = fact("opened", 2, 4);
    expectPrimary([fact("opened", 1, 1), newer, fact("opened", 3, 2)], newer);
  });

  it("takes the PR it pushed to when it opened none", () => {
    const pushed = fact("pushed", 2, 1, { source: "branch" });
    expectPrimary([pushed, fact("edited", 3, 6), fact("merged", 4, 7)], pushed);
  });

  it("takes the newest it pushed to when it pushed to several", () => {
    const newer = fact("pushed", 1, 3);
    expectPrimary([fact("pushed", 2, 2), newer], newer);
  });

  it("takes the newest still-open PR it edited or reviewed, before any it merged", () => {
    const reviewed = fact("reviewed", 3, 4, { state: stateOf("open") });
    expectPrimary(
      [
        fact("edited", 2, 2, { state: stateOf("open") }),
        reviewed,
        fact("merged", 4, 9),
      ],
      reviewed,
    );
  });

  it("counts a draft as open", () => {
    const draft = fact("edited", 2, 2, { state: stateOf("draft") });
    expectPrimary([draft, fact("merged", 4, 9)], draft);
  });

  it("never counts a PR whose state nobody read as still open: a confirmed merge beats it (review P2)", () => {
    const merged = fact("merged", 4, 1);
    expectPrimary([fact("edited", 3, 2), merged], merged);
    expectPrimary([fact("reviewed", 3, 2), merged], merged);
    // Alone, it is no primary at all.
    expectPrimary([fact("edited", 3, 2), fact("mentioned", 5, 3)], null);
  });

  it("still takes a PR it pushed to with no state at all", () => {
    const pushed = fact("pushed", 3, 1, { source: "branch" });
    expectPrimary(
      [
        pushed,
        fact("edited", 4, 2, { state: stateOf("open") }),
        fact("merged", 5, 3),
      ],
      pushed,
    );
  });

  it("reads a PR's state from whichever of its facts was read last (review P2)", () => {
    // The edit carries an open read from 10:10; a mention of the same PR
    // carries a closed one from 10:20. Closed it is: not still open.
    const merged = fact("merged", 9, 1);
    expectPrimary(
      [
        fact("edited", 2, 5, {
          state: stateOf("open", { checkedAt: minute(10) }),
        }),
        fact("mentioned", 2, 6, {
          state: stateOf("closed", { checkedAt: minute(20) }),
        }),
        merged,
      ],
      merged,
    );
    // And the other way round: reopened since it was read closed.
    const edited = fact("edited", 2, 5, {
      state: stateOf("closed", { checkedAt: minute(10) }),
    });
    expectPrimary(
      [
        edited,
        fact("reviewed", 2, 4, {
          state: stateOf("open", { checkedAt: minute(20) }),
        }),
        merged,
      ],
      edited,
    );
  });

  it("takes the more settled of two states read at once, in any order", () => {
    const merged = fact("merged", 9, 1);
    expectPrimary(
      [
        fact("edited", 2, 5, { state: stateOf("open") }),
        fact("reviewed", 2, 6, { state: stateOf("closed") }),
        merged,
      ],
      merged,
    );
  });

  it("passes over a changed PR that is merged or closed, by its state or by the session's own merge", () => {
    const open = fact("edited", 1, 1, { state: stateOf("open") });
    expectPrimary(
      [
        open,
        fact("edited", 2, 5, { state: stateOf("closed") }),
        fact("reviewed", 3, 6, { state: stateOf("merged") }),
        fact("edited", 4, 7),
        fact("merged", 4, 8),
      ],
      open,
    );
  });

  it("passes over a changed PR another of its facts says ended, whichever fact carries the state", () => {
    // Edited with no state, then mentioned with a state that says it closed.
    const merged = fact("merged", 9, 1);
    expectPrimary(
      [
        fact("edited", 2, 5),
        fact("mentioned", 2, 6, { state: stateOf("closed") }),
        merged,
      ],
      merged,
    );
  });

  it("takes the newest it merged when nothing it changed is still open", () => {
    const newer = fact("merged", 2, 6);
    expectPrimary(
      [
        fact("merged", 1, 5),
        newer,
        fact("edited", 3, 9, { state: stateOf("closed") }),
        fact("mentioned", 4, 10),
      ],
      newer,
    );
  });

  it("is none when all it did was change PRs that have since ended", () => {
    expectPrimary(
      [
        fact("edited", 1, 1, { state: stateOf("merged") }),
        fact("reviewed", 2, 2, { state: stateOf("closed") }),
        fact("mentioned", 3, 3),
      ],
      null,
    );
  });

  describe("ties", () => {
    it("takes the higher number when two facts are as new", () => {
      const higher = fact("opened", 12, 1);
      expectPrimary([fact("opened", 11, 1), higher], higher);
    });

    it("reads the time, not the text: an offset and Z for one instant are a tie", () => {
      const higher = fact("pushed", 12, 0, { at: "2026-11-24T11:00:00+01:00" });
      expectPrimary(
        [fact("pushed", 11, 0, { at: "2026-11-24T10:00:00.000Z" }), higher],
        higher,
      );
      // And a later instant written earlier in the alphabet still wins.
      const later = fact("pushed", 1, 0, { at: "2026-11-24T10:30:00+00:00" });
      expectPrimary(
        [fact("pushed", 99, 0, { at: "2026-11-24T11:00:00+01:00" }), later],
        later,
      );
    });

    it("takes the repository first in order when the number is the same, without regard to case", () => {
      const first = fact("opened", 7, 1, { repository: "Acme/App" });
      expectPrimary(
        [
          fact("opened", 7, 1, { repository: "acme/lib" }),
          first,
          fact("opened", 7, 1, { repository: "zeta/app" }),
        ],
        first,
      );
    });

    it("takes the role first in EXECUTION_PULL_REQUEST_ROLES when one PR was edited and reviewed at once (review P3)", () => {
      const edited = fact("edited", 7, 1, { state: stateOf("open") });
      const reviewed = fact("reviewed", 7, 1, { state: stateOf("open") });
      expectPrimary([reviewed, edited], edited);
      expectPrimary([edited, reviewed], edited);
    });

    it("tells apart one PR spelt in two cases at once, by its spelling", () => {
      const upper = fact("pushed", 7, 1, { repository: "Acme/App" });
      expectPrimary(
        [fact("pushed", 7, 1, { repository: "acme/app" }), upper],
        upper,
      );
    });

    it("gives one answer for a whole session's facts in every order, ties and all (review P3)", () => {
      const state = { state: stateOf("open") };
      const facts = [
        fact("reviewed", 7, 1, state),
        fact("edited", 7, 1, state),
        fact("edited", 7, 1, { ...state, repository: "acme/lib" }),
        fact("reviewed", 8, 1, { ...state, repository: "Acme/App" }),
        fact("merged", 9, 1),
        fact("mentioned", 10, 1),
      ];
      // 720 orders: the newest, then the higher number, wins.
      expectPrimary(facts, facts[3]!);
      expectPrimary(facts.slice(0, 3), facts[1]!);
    });

    it("puts a fact whose time cannot be read last", () => {
      const readable = fact("opened", 1, 1);
      expectPrimary([fact("opened", 9, 0, { at: "soon" }), readable], readable);
    });
  });

  describe("repositories that differ", () => {
    it("treats the same number in two repositories as two PRs", () => {
      // acme/lib#7 was merged; acme/app#7 is still open, and the one to show.
      const app = fact("edited", 7, 1, {
        repository: "acme/app",
        state: stateOf("open"),
      });
      expectPrimary(
        [app, fact("merged", 7, 2, { repository: "acme/lib" })],
        app,
      );
    });

    it("treats one repository spelt in two cases as one PR", () => {
      // It edited Acme/App#7, then merged acme/app#7: the same PR, ended, so
      // not the still-open one it changed; its newest merge is the primary.
      const merged = fact("merged", 7, 2, { repository: "acme/app" });
      expectPrimary(
        [
          fact("edited", 7, 5, { repository: "Acme/App" }),
          merged,
          fact("merged", 3, 1, { repository: "other/x" }),
        ],
        merged,
      );
    });

    it("takes the newest across repositories, any repository at all", () => {
      const newest = fact("pushed", 1, 9, { repository: "someone/else" });
      expectPrimary(
        [
          fact("pushed", 400, 3, { repository: "acme/app" }),
          newest,
          fact("pushed", 2, 1, { repository: "acme/lib" }),
        ],
        newest,
      );
    });
  });

  it("hands back the fact it was given, in whatever wider shape", () => {
    // The server's rows, say: their own fields, a state of their own.
    const rows = [
      {
        id: "row-1",
        repository: "acme/app",
        number: 7,
        role: "reviewed" as const,
        at: minute(1),
        state: { state: "open" as const },
      },
      {
        id: "row-2",
        repository: "acme/app",
        number: 8,
        role: "merged" as const,
        at: minute(2),
      },
    ];
    const primary = primaryPullRequestOf(rows);
    expect(primary?.id).toBe("row-1");
  });
});

describe("pullRequestKeyOf", () => {
  it("is one key per PR: case aside, and the repository part of it", () => {
    expect(pullRequestKeyOf({ repository: "Acme/App", number: 7 })).toBe(
      pullRequestKeyOf({ repository: "acme/app", number: 7 }),
    );
    expect(pullRequestKeyOf({ repository: "acme/app", number: 7 })).not.toBe(
      pullRequestKeyOf({ repository: "acme/lib", number: 7 }),
    );
    expect(pullRequestKeyOf({ repository: "acme/app", number: 7 })).toBe(
      "acme/app#7",
    );
  });
});

describe("isExecutionPullRequestRepository", () => {
  it.each(["acme/app", "a/b", "Acme-Co/app.js", "acme/.github", "x/a_b-c.d"])(
    "takes %s",
    (repository) => {
      expect(isExecutionPullRequestRepository(repository)).toBe(true);
    },
  );
  it.each([
    "acme",
    "acme/",
    "/app",
    "acme/app/extra",
    "-acme/app",
    "acme-/app",
    "ac--me/app",
    "acme/..",
    "acme/.",
    "acme/app name",
    `${"a".repeat(40)}/app`,
    `acme/${"a".repeat(101)}`,
    "https://github.com/acme/app",
    7,
  ])("refuses %s", (repository) => {
    expect(isExecutionPullRequestRepository(repository)).toBe(false);
  });
});

describe("decodeExecutionPullRequests", () => {
  const opened = fact("opened", 7, 1, { itemId: "item-1" });

  it("reads a host's list as it is when it already keeps the contract", () => {
    const list = [
      fact("merged", 7, 3, { state: stateOf("merged") }),
      fact("reviewed", 9, 2, {
        repository: "acme/lib",
        source: "mcp-tool",
        agentRunId: "run-1",
        state: stateOf("open", {
          reviewDecision: "changes-requested",
          mergeable: false,
        }),
      }),
      { ...opened, state: stateOf("merged") },
    ];
    expect(decodeExecutionPullRequests(structuredClone(list))).toEqual({
      ok: true,
      value: list,
    });
  });

  it("refuses anything but a list", () => {
    for (const raw of [undefined, null, {}, opened, "acme/app#7"]) {
      expect(decodeExecutionPullRequests(raw)).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
    }
  });

  it("drops a fact it cannot read and names it, keeping the rest", () => {
    const broken: unknown[] = [
      opened,
      { ...opened, role: "approved" },
      { ...opened, source: "webhook" },
      { ...opened, repository: "acme" },
      { ...opened, number: 0 },
      { ...opened, number: 1.5 },
      { ...opened, number: "7" },
      { ...opened, at: "yesterday" },
      { ...opened, itemId: "" },
      { ...opened, agentRunId: "x".repeat(257) },
      "acme/app#7",
      null,
    ];
    const decoded = decodeExecutionPullRequests(broken);
    expect(decoded).toEqual({
      ok: true,
      value: [opened],
      warnings: broken.slice(1).map((_, index) => ({
        reason: "dropped-invalid-field",
        path: `pullRequests.${index + 1}`,
      })),
    });
  });

  it("keeps only what it knows of a fact: unknown fields go", () => {
    const decoded = decodeExecutionPullRequests([
      { ...opened, futureField: true, state: { ...stateOf("open"), extra: 1 } },
    ]);
    expect(decoded).toEqual({
      ok: true,
      value: [{ ...opened, state: stateOf("open") }],
    });
  });

  it("keeps one fact per PR and role, the newest, case aside", () => {
    const newer = fact("pushed", 7, 5, { repository: "Acme/App" });
    const decoded = decodeExecutionPullRequests([
      fact("pushed", 7, 1),
      newer,
      fact("pushed", 7, 3),
      fact("pushed", 7, 4, { repository: "acme/lib" }),
    ]);
    expect(decoded).toEqual({
      ok: true,
      value: [newer, fact("pushed", 7, 4, { repository: "acme/lib" })],
    });
  });

  it("puts the list newest first, whatever order it came in", () => {
    const facts = [
      fact("opened", 1, 1),
      fact("pushed", 1, 3),
      fact("mentioned", 2, 2),
    ];
    const decoded = decodeExecutionPullRequests([...facts].reverse());
    expect(decoded.ok && decoded.value).toEqual([facts[1], facts[2], facts[0]]);
  });

  it("gives every fact of a PR the state read last", () => {
    const older = stateOf("open", { checkedAt: minute(10) });
    const newer = stateOf("merged", { checkedAt: minute(20) });
    const decoded = decodeExecutionPullRequests([
      fact("opened", 7, 1, { state: newer }),
      fact("pushed", 7, 2, { state: older }),
      fact("reviewed", 7, 3),
      fact("opened", 8, 4, { state: older }),
    ]);
    expect(decoded.ok && decoded.value.map((one) => one.state)).toEqual([
      older,
      newer,
      newer,
      newer,
    ]);
  });

  it("drops a state it cannot read and names it, keeping the fact", () => {
    for (const state of [
      { ...stateOf("open"), state: "queued" },
      { ...stateOf("open"), checks: { passed: 1, failed: 0 } },
      { ...stateOf("open"), checks: { passed: -1, failed: 0, running: 0 } },
      { ...stateOf("open"), title: "" },
      { ...stateOf("open"), title: "‮\u0007" },
      { ...stateOf("open"), url: "javascript:alert(1)" },
      { ...stateOf("open"), url: "not a URL" },
      { ...stateOf("open"), checkedAt: "now" },
      "open",
    ]) {
      expect(decodeExecutionPullRequests([{ ...opened, state }])).toEqual({
        ok: true,
        value: [opened],
        warnings: [
          { reason: "dropped-invalid-field", path: "pullRequests.0.state" },
        ],
      });
    }
  });

  it("drops a review decision or mergeability it cannot read, keeping the state", () => {
    expect(
      decodeExecutionPullRequests([
        {
          ...opened,
          state: {
            ...stateOf("open"),
            reviewDecision: "APPROVED",
            mergeable: "UNKNOWN",
          },
        },
      ]),
    ).toEqual({
      ok: true,
      value: [{ ...opened, state: stateOf("open") }],
      warnings: [
        {
          reason: "dropped-invalid-field",
          path: "pullRequests.0.state.reviewDecision",
        },
        {
          reason: "dropped-invalid-field",
          path: "pullRequests.0.state.mergeable",
        },
      ],
    });
  });

  it("cleans a title of what reorders or breaks a line, and cuts it at 256", () => {
    const decoded = decodeExecutionPullRequests([
      {
        ...opened,
        state: { ...stateOf("open"), title: `  Fix‮ it\n${"x".repeat(300)}` },
      },
    ]);
    const title = decoded.ok ? decoded.value[0]?.state?.title : undefined;
    expect(title?.startsWith("Fix itx")).toBe(true);
    expect(title).toHaveLength(256);
  });

  it("takes a PR's state from the read made last, even when it sits on a fact dropped as older (review P2)", () => {
    const decoded = decodeExecutionPullRequests([
      fact("edited", 7, 0, {
        at: "2026-11-24T11:00:00.000Z",
        state: stateOf("closed", { checkedAt: "2026-11-24T13:00:00.000Z" }),
      }),
      fact("edited", 7, 0, { at: "2026-11-24T12:00:00.000Z" }),
    ]);
    expect(decoded).toEqual({
      ok: true,
      value: [
        fact("edited", 7, 0, {
          at: "2026-11-24T12:00:00.000Z",
          state: stateOf("closed", { checkedAt: "2026-11-24T13:00:00.000Z" }),
        }),
      ],
    });
  });

  it(`keeps every fact but mentions, and the newest ${EXECUTION_PULL_REQUEST_MENTIONS_MAX} mentions, saying so`, () => {
    const mentions = Array.from(
      { length: EXECUTION_PULL_REQUEST_MENTIONS_MAX + 5 },
      (_, index) =>
        fact("mentioned", index + 1, 0, {
          at: new Date(Date.UTC(2026, 10, 24, 12, 0, index)).toISOString(),
        }),
    );
    const others = (
      ["opened", "pushed", "merged", "edited", "reviewed"] as const
    ).map((role, index) => fact(role, 1000 + index, index));
    const decoded = decodeExecutionPullRequests([...others, ...mentions]);
    if (!decoded.ok) throw new Error(decoded.reason);
    const kept = decoded.value.filter((one) => one.role === "mentioned");
    expect(kept).toHaveLength(EXECUTION_PULL_REQUEST_MENTIONS_MAX);
    expect(kept[0]?.number).toBe(EXECUTION_PULL_REQUEST_MENTIONS_MAX + 5);
    expect(kept.at(-1)?.number).toBe(6);
    expect(decoded.value.filter((one) => one.role !== "mentioned")).toEqual(
      [...others].reverse(),
    );
    expect(decoded.warnings).toEqual([
      { reason: "dropped-excess-entries", path: "pullRequests" },
    ]);
  });

  it("never lets mentions erase the primary: one opened, then a hundred mentions (review P1)", () => {
    const opened = fact("opened", 1, 0);
    const mentions = Array.from({ length: 100 }, (_, index) =>
      fact("mentioned", index + 2, 1 + (index % 50), {
        repository: index < 50 ? "acme/lib" : "acme/docs",
      }),
    );
    const decoded = decodeExecutionPullRequests([opened, ...mentions]);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value).toHaveLength(101);
    expect(decoded.warnings).toBeUndefined();
    expect(primaryPullRequestOf(decoded.value)).toEqual(opened);
    // Past the mention cap too: the opened fact stays, the oldest mention goes.
    const more = decodeExecutionPullRequests([
      opened,
      ...mentions,
      fact("mentioned", 999, 59),
    ]);
    if (!more.ok) throw new Error(more.reason);
    expect(more.value).toContainEqual(opened);
    expect(primaryPullRequestOf(more.value)).toEqual(opened);
  });
});
