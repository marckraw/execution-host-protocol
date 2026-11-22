import { describe, expect, it } from "vitest";
import {
  EXECUTION_DRIVE_POLICY_REFUSAL_REASONS,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  decodeExecutionDrivePolicy,
  decodeExecutionDrivePolicyRefusal,
  decodeExecutionProviderListResponse,
  drivePolicyRefusalOf,
  type ExecutionActor,
  type ExecutionDriveAsk,
  type ExecutionDrivePolicy,
  type ExecutionDrivePolicyRefusalReason,
} from "../src/index.js";

/**
 * MAR-5634: who may drive a provider on a host. The defaults are Antigravity's
 * as MAR-5633 decided them: the owner's tokens and waiting for a free turn on,
 * everything else off, and at most 2 live sessions.
 */

const OWNER = "usr_marcin";

const policy = (
  overrides: Partial<Omit<ExecutionDrivePolicy, "allow">> & {
    allow?: Partial<ExecutionDrivePolicy["allow"]>;
  } = {},
): ExecutionDrivePolicy => ({
  ownerId: OWNER,
  maxConcurrentSessions: 2,
  liveSessions: 0,
  ...overrides,
  allow: {
    tokenDriven: true,
    automations: false,
    waitForRoom: true,
    afterChains: false,
    anyHost: false,
    others: false,
    ...overrides.allow,
  },
});

const actor = (
  via: ExecutionActor["via"],
  overrides: Partial<ExecutionActor> = {},
): ExecutionActor => ({
  kind: "person",
  id: OWNER,
  displayName: "Marcin",
  via,
  ...overrides,
});

const ask = (
  overrides: Partial<ExecutionDriveAsk> = {},
): ExecutionDriveAsk => ({
  providerId: "antigravity",
  actor: actor("app"),
  act: "start",
  needsNewProcess: true,
  ...overrides,
});

const allowAll = {
  tokenDriven: true,
  automations: true,
  waitForRoom: true,
  afterChains: true,
  anyHost: true,
  others: true,
};

describe("drivePolicyRefusalOf: every reason (MAR-5634)", () => {
  const cases: Array<
    [
      ExecutionDrivePolicyRefusalReason,
      ExecutionDrivePolicy,
      ExecutionDriveAsk,
      string | undefined,
    ]
  > = [
    ["no-owner", policy({ ownerId: null }), ask(), undefined],
    ["no-actor", policy(), ask({ actor: undefined }), undefined],
    [
      "not-owner",
      policy(),
      ask({ actor: actor("app", { id: "usr_piotr" }) }),
      "antigravity.allowOthers",
    ],
    [
      "token-driven-off",
      policy({ allow: { tokenDriven: false } }),
      ask({ actor: actor("token") }),
      "antigravity.allowTokenDriven",
    ],
    [
      "automation",
      policy(),
      ask({ actor: actor("automation") }),
      "antigravity.allowAutomations",
    ],
    [
      "wait-for-room",
      policy({ allow: { waitForRoom: false } }),
      ask({ waitForRoom: true }),
      "antigravity.allowWaitForRoom",
    ],
    [
      "after-chain",
      policy(),
      ask({ afterChain: true }),
      "antigravity.allowAfterChains",
    ],
    ["any-host", policy(), ask({ anyHost: true }), "antigravity.allowAnyHost"],
    [
      "at-capacity",
      policy({ liveSessions: 2 }),
      ask(),
      "antigravity.maxConcurrentSessions",
    ],
  ];

  it("covers every reason there is", () => {
    expect(cases.map(([reason]) => reason).sort()).toEqual(
      [...EXECUTION_DRIVE_POLICY_REFUSAL_REASONS].sort(),
    );
  });

  it.each(cases)("refuses with %s", (reason, given, asked, flag) => {
    const refusal = drivePolicyRefusalOf(given, asked);

    expect(refusal).toEqual({
      code: "drive-policy-refused",
      reason,
      ...(flag === undefined ? {} : { flag }),
      message: expect.stringContaining("antigravity"),
    });
  });

  it("names the provider asked in the flag", () => {
    expect(
      drivePolicyRefusalOf(
        policy({ allow: { tokenDriven: false } }),
        ask({ providerId: "cursor", actor: actor("token") }),
      ),
    ).toMatchObject({ flag: "cursor.allowTokenDriven" });
  });
});

describe("drivePolicyRefusalOf: each flag on and off", () => {
  const flags: Array<
    [
      keyof ExecutionDrivePolicy["allow"],
      ExecutionDriveAsk,
      ExecutionDrivePolicyRefusalReason,
    ]
  > = [
    ["tokenDriven", ask({ actor: actor("token") }), "token-driven-off"],
    ["automations", ask({ actor: actor("automation") }), "automation"],
    ["waitForRoom", ask({ waitForRoom: true }), "wait-for-room"],
    ["waitForRoom", ask({ actor: actor("line") }), "wait-for-room"],
    ["afterChains", ask({ afterChain: true }), "after-chain"],
    [
      "afterChains",
      ask({ actor: actor("line"), afterChain: true }),
      "after-chain",
    ],
    ["anyHost", ask({ anyHost: true }), "any-host"],
    ["others", ask({ actor: actor("app", { id: "usr_piotr" }) }), "not-owner"],
    [
      "others",
      ask({ actor: actor("app", { kind: "agent", id: OWNER }) }),
      "not-owner",
    ],
  ];

  it.each(flags)("%s off refuses %j", (flag, asked, reason) => {
    expect(
      drivePolicyRefusalOf(
        policy({ allow: { ...allowAll, [flag]: false } }),
        asked,
      ),
    ).toMatchObject({ reason });
  });

  it.each(flags)("%s on allows %j", (flag, asked) => {
    expect(
      drivePolicyRefusalOf(
        policy({ allow: { ...allowAll, [flag]: true } }),
        asked,
      ),
    ).toBeNull();
  });

  it("asks only the chain's switch of an after chain the line fires", () => {
    const fired = ask({ actor: actor("line"), afterChain: true });

    expect(
      drivePolicyRefusalOf(
        policy({ allow: { waitForRoom: false, afterChains: true } }),
        fired,
      ),
    ).toBeNull();
  });

  it("asks the policy's switches of someone else, once others are allowed", () => {
    expect(
      drivePolicyRefusalOf(
        policy({ allow: { others: true, tokenDriven: false } }),
        ask({ actor: actor("token", { id: "usr_piotr" }) }),
      ),
    ).toMatchObject({ reason: "token-driven-off" });
  });

  it("refuses an after chain from the owner in the app too", () => {
    expect(
      drivePolicyRefusalOf(policy(), ask({ afterChain: true })),
    ).toMatchObject({ reason: "after-chain" });
  });
});

describe("drivePolicyRefusalOf: the cap", () => {
  const rows: Array<[number, number, boolean, boolean]> = [];
  for (const max of [0, 1, 2]) {
    for (let live = 0; live <= max + 1; live++) {
      for (const needsNewProcess of [true, false]) {
        rows.push([max, live, needsNewProcess, needsNewProcess && live >= max]);
      }
    }
  }

  it.each(rows)(
    "at most %i, %i live, needing a new process: %s, refused: %s",
    (maxConcurrentSessions, liveSessions, needsNewProcess, refused) => {
      const refusal = drivePolicyRefusalOf(
        policy({ maxConcurrentSessions, liveSessions }),
        ask({ needsNewProcess }),
      );

      if (refused) {
        expect(refusal).toMatchObject({
          reason: "at-capacity",
          flag: "antigravity.maxConcurrentSessions",
        });
      } else {
        expect(refusal).toBeNull();
      }
    },
  );

  it("caps input that needs a new process as it caps a start", () => {
    expect(
      drivePolicyRefusalOf(
        policy({ liveSessions: 2 }),
        ask({ act: "input", needsNewProcess: true }),
      ),
    ).toMatchObject({ reason: "at-capacity" });
    expect(
      drivePolicyRefusalOf(
        policy({ liveSessions: 2 }),
        ask({ act: "input", needsNewProcess: false }),
      ),
    ).toBeNull();
  });
});

describe("drivePolicyRefusalOf: control", () => {
  const closed = policy({
    ownerId: null,
    allow: {
      tokenDriven: false,
      automations: false,
      waitForRoom: false,
      afterChains: false,
      anyHost: false,
      others: false,
    },
    maxConcurrentSessions: 0,
    liveSessions: 5,
  });

  it.each([
    ["no actor", undefined],
    ["someone else by token", actor("token", { id: "usr_piotr" })],
    ["an automation", actor("automation")],
    ["the line", actor("line")],
  ])("is never refused, for %s", (_case, who) => {
    expect(
      drivePolicyRefusalOf(
        closed,
        ask({
          act: "control",
          actor: who,
          waitForRoom: true,
          afterChain: true,
          anyHost: true,
          needsNewProcess: true,
        }),
      ),
    ).toBeNull();
  });
});

describe("drivePolicyRefusalOf: the owner", () => {
  it("is allowed through the app", () => {
    expect(drivePolicyRefusalOf(policy(), ask())).toBeNull();
    expect(
      drivePolicyRefusalOf(
        policy(),
        ask({ act: "input", needsNewProcess: false }),
      ),
    ).toBeNull();
  });

  it("is allowed through a token while tokenDriven is on", () => {
    expect(
      drivePolicyRefusalOf(policy(), ask({ actor: actor("token") })),
    ).toBeNull();
    expect(
      drivePolicyRefusalOf(
        policy({ allow: { tokenDriven: false } }),
        ask({ actor: actor("token") }),
      ),
    ).toMatchObject({ reason: "token-driven-off" });
  });

  it("may wait for a free turn by default", () => {
    expect(
      drivePolicyRefusalOf(policy(), ask({ waitForRoom: true })),
    ).toBeNull();
    expect(
      drivePolicyRefusalOf(policy(), ask({ actor: actor("line") })),
    ).toBeNull();
  });
});

describe("decodeExecutionDrivePolicy", () => {
  const raw = {
    ownerId: OWNER,
    allow: {
      tokenDriven: true,
      automations: false,
      waitForRoom: true,
      afterChains: false,
      anyHost: false,
      others: false,
    },
    maxConcurrentSessions: 2,
    liveSessions: 1,
  };

  it("reads a policy, ignoring fields it does not define", () => {
    expect(
      decodeExecutionDrivePolicy({
        ...raw,
        allow: { ...raw.allow, allowEverything: true },
        note: "from .env",
      }),
    ).toEqual({ ok: true, value: raw });
  });

  it("reads a policy nobody is signed in to", () => {
    expect(decodeExecutionDrivePolicy({ ...raw, ownerId: null })).toEqual({
      ok: true,
      value: { ...raw, ownerId: null },
    });
  });

  it.each<[string, unknown]>([
    ["not an object", "open"],
    ["no owner", { ...raw, ownerId: undefined }],
    ["an empty owner", { ...raw, ownerId: "" }],
    ["an owner over 256 characters", { ...raw, ownerId: "u".repeat(257) }],
    ["no switches", { ...raw, allow: undefined }],
    [
      "the retired queued switch in place of the two",
      {
        ...raw,
        allow: {
          tokenDriven: true,
          automations: false,
          queued: false,
          anyHost: false,
          others: false,
        },
      },
    ],
    [
      "a switch that is a string",
      { ...raw, allow: { ...raw.allow, others: "no" } },
    ],
    [
      "a switch missing",
      { ...raw, allow: { ...raw.allow, afterChains: undefined } },
    ],
    ["a negative cap", { ...raw, maxConcurrentSessions: -1 }],
    ["a fractional cap", { ...raw, maxConcurrentSessions: 1.5 }],
    ["no live count", { ...raw, liveSessions: undefined }],
  ])("refuses %s", (_case, value) => {
    expect(decodeExecutionDrivePolicy(value)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});

describe("a provider's drive policy in the listing", () => {
  const listed = policy({ liveSessions: 1 });

  it("reads it beside the rest of the provider", () => {
    expect(
      decodeExecutionProviderListResponse({
        providers: [
          { id: "antigravity", label: "Antigravity", drivePolicy: listed },
          { id: "claude" },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        providers: [
          {
            id: "antigravity",
            label: "Antigravity",
            effortLevels: [],
            models: [],
            drivePolicy: listed,
          },
          { id: "claude", label: "claude", effortLevels: [], models: [] },
        ],
      },
    });
  });

  it("reads one it cannot read as absent, with a warning, and keeps the catalogue", () => {
    const decoded = decodeExecutionProviderListResponse({
      providers: [
        { id: "claude" },
        {
          id: "antigravity",
          drivePolicy: { ...listed, allow: { ...listed.allow, others: "yes" } },
        },
      ],
    });
    if (!decoded.ok) throw new Error(decoded.reason);

    expect(decoded.value.providers[1]).toEqual({
      id: "antigravity",
      label: "antigravity",
      effortLevels: [],
      models: [],
    });
    expect(decoded.warnings).toEqual([
      { reason: "dropped-invalid-field", path: "providers.1.drivePolicy" },
    ]);
  });

  it("says nothing of a provider without one", () => {
    const decoded = decodeExecutionProviderListResponse({
      providers: [{ id: "claude" }],
    });
    expect(decoded).toEqual({
      ok: true,
      value: {
        providers: [
          { id: "claude", label: "claude", effortLevels: [], models: [] },
        ],
      },
    });
  });
});

describe("decodeExecutionDrivePolicyRefusal", () => {
  it("reads what drivePolicyRefusalOf returns", () => {
    const refusal = drivePolicyRefusalOf(policy(), ask({ afterChain: true }));

    expect(decodeExecutionDrivePolicyRefusal(refusal)).toEqual({
      ok: true,
      value: refusal,
    });
  });

  it("speaks for a host that gave no words", () => {
    expect(
      decodeExecutionDrivePolicyRefusal({
        code: "drive-policy-refused",
        reason: "no-owner",
        message: " ",
      }),
    ).toEqual({
      ok: true,
      value: {
        code: "drive-policy-refused",
        reason: "no-owner",
        message: "The host's drive policy refused this: no-owner",
      },
    });
  });

  it.each<[string, unknown]>([
    ["another code", { code: "file-reach-refused", reason: "no-owner" }],
    [
      "a reason it does not know",
      { code: "drive-policy-refused", reason: "queued" },
    ],
    ["no reason", { code: "drive-policy-refused" }],
  ])("refuses %s", (_case, value) => {
    expect(decodeExecutionDrivePolicyRefusal(value)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});

describe("the capability", () => {
  it("is a known id", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(
      "providers.drivePolicy.v1",
    );
  });
});
