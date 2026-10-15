import { describe, expect, it } from "vitest";
import {
  EXECUTION_INTERACTION_REQUEST_KINDS,
  EXECUTION_PROTOCOL_VERSION,
  decodeExecutionEventEnvelope,
  decodeExecutionProviderListResponse,
  decodeExecutionSessionPatchRequest,
  decodeExecutionSessionPatchResponse,
  decodeExecutionStartRequest,
  encodeExecutionEventEnvelope,
  encodeExecutionSessionPatchRequest,
  encodeExecutionStartRequest,
  type ExecutionHostEventEnvelope,
  type ExecutionInteractionRequest,
  type ExecutionPermissionConfig,
  type ExecutionSessionPatchRequest,
  type ExecutionStartRequest,
} from "../src/index.js";

/**
 * MAR-4052: a running session's mode changes by a session patch; Codex's
 * reviewer and plan collaboration mode; and the provider listing says which
 * modes each provider has and which ones ask.
 */

const ask: ExecutionPermissionConfig = {
  preset: "custom",
  claudeCode: { permissionMode: "default" },
};
const fullAccess: ExecutionPermissionConfig = { preset: "yolo" };
const codexPlan: ExecutionPermissionConfig = {
  preset: "custom",
  codex: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
    collaborationMode: "plan",
  },
};

const sessionPatch = (patch: Record<string, unknown>) =>
  JSON.stringify({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "accent_8f2c",
    seq: 9,
    event: { kind: "delta", delta: { kind: "session.patch", patch } },
  });

describe("Codex's reviewer and collaboration mode", () => {
  const start = (permissionConfig: unknown) =>
    JSON.stringify({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      providerId: "codex",
      config: {
        sessionId: "accent_8f2c",
        initialMessage: "Plan the migration",
        model: null,
        effort: null,
        continuationToken: null,
        permissionConfig,
      },
    });

  it("round-trips both on a start", () => {
    const request: ExecutionStartRequest = {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      providerId: "codex",
      config: {
        sessionId: "accent_8f2c",
        initialMessage: "Plan the migration",
        model: null,
        effort: null,
        continuationToken: null,
        permissionConfig: codexPlan,
      },
    };
    expect(
      decodeExecutionStartRequest(encodeExecutionStartRequest(request)),
    ).toEqual({ ok: true, value: request });
  });

  it("takes each value Codex has", () => {
    for (const approvalsReviewer of ["user", "auto_review"]) {
      for (const collaborationMode of ["default", "plan"]) {
        const codex = {
          approvalPolicy: "never",
          sandbox: "read-only",
          approvalsReviewer,
          collaborationMode,
        };
        expect(
          decodeExecutionStartRequest(start({ preset: "custom", codex })),
        ).toMatchObject({
          ok: true,
          value: { config: { permissionConfig: { codex } } },
        });
      }
    }
  });

  it("leaves both absent when not named", () => {
    const decoded = decodeExecutionStartRequest(
      start({
        preset: "custom",
        codex: { approvalPolicy: "never", sandbox: "read-only" },
      }),
    );
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value.config.permissionConfig?.codex).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
  });

  it("refuses a value Codex does not have", () => {
    for (const codex of [
      { ...codexPlan.codex, approvalsReviewer: "auto" },
      { ...codexPlan.codex, approvalsReviewer: null },
      { ...codexPlan.codex, collaborationMode: "pair" },
      { ...codexPlan.codex, collaborationMode: true },
    ]) {
      expect(
        decodeExecutionStartRequest(start({ preset: "custom", codex })),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });
});

describe("a session patch changes a running session's mode", () => {
  const patches: Array<[string, ExecutionSessionPatchRequest]> = [
    ["Claude's ask mode", { permissionConfig: ask }],
    ["full access", { permissionConfig: fullAccess }],
    ["Codex's plan with its reviewer", { permissionConfig: codexPlan }],
    [
      "a mode beside a selection",
      { model: "claude-opus-5-5", effort: "high", permissionConfig: ask },
    ],
  ];

  it.each(patches)("round-trips %s", (_name, patch) => {
    expect(
      decodeExecutionSessionPatchRequest(
        encodeExecutionSessionPatchRequest(patch),
      ),
    ).toEqual({ ok: true, value: patch });
  });

  const refused: Array<[string, unknown]> = [
    ["null", { permissionConfig: null }],
    ["no preset", { permissionConfig: { claudeCode: ask.claudeCode } }],
    ["an unknown preset", { permissionConfig: { preset: "auto" } }],
    [
      "an unknown Claude mode",
      {
        permissionConfig: {
          preset: "custom",
          claudeCode: { permissionMode: "plan-ish" },
        },
      },
    ],
    [
      "a misspelt field",
      { permissionConfig: { preset: "yolo", claudeCodee: {} } },
    ],
    [
      "a misspelt Codex field",
      {
        permissionConfig: {
          preset: "custom",
          codex: { ...codexPlan.codex, approvalReviewer: "user" },
        },
      },
    ],
    [
      "a misspelt Claude field",
      {
        permissionConfig: {
          preset: "custom",
          claudeCode: { permissionMode: "default", mode: "plan" },
        },
      },
    ],
  ];

  it.each(refused)("refuses %s", (_name, body) => {
    expect(decodeExecutionSessionPatchRequest(JSON.stringify(body))).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});

describe("the host's answer to a mode change", () => {
  it("reads the policy the next turn runs under", () => {
    expect(
      decodeExecutionSessionPatchResponse({
        protocolVersion: 1,
        sessionId: "accent_8f2c",
        permissionConfig: codexPlan,
        appliesFrom: "next-turn",
      }),
    ).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        sessionId: "accent_8f2c",
        permissionConfig: codexPlan,
      },
    });
  });

  it("refuses a policy it cannot read", () => {
    for (const permissionConfig of [
      null,
      { preset: "auto" },
      { preset: "custom", codex: { approvalPolicy: "never" } },
    ]) {
      expect(
        decodeExecutionSessionPatchResponse({
          sessionId: "accent_8f2c",
          permissionConfig,
        }),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });
});

describe("followers hear a mode change in session.patch", () => {
  it.each([ask, fullAccess, codexPlan])(
    "round-trips %j",
    (permissionConfig) => {
      const envelope: ExecutionHostEventEnvelope = {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId: "accent_8f2c",
        seq: 9,
        event: {
          kind: "delta",
          delta: {
            kind: "session.patch",
            patch: { permissionConfig, updatedAt: "2026-10-15T08:00:00.000Z" },
          },
        },
      };
      expect(
        decodeExecutionEventEnvelope(encodeExecutionEventEnvelope(envelope)),
      ).toEqual({ ok: true, value: envelope });
    },
  );

  it("refuses a policy it cannot read, as it refuses any field it cannot read", () => {
    for (const permissionConfig of [
      null,
      "yolo",
      { preset: "custom", codex: { ...codexPlan.codex, sandbox: "none" } },
    ]) {
      expect(
        decodeExecutionEventEnvelope(sessionPatch({ permissionConfig })),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });
});

describe("the provider listing's permissions and interactions", () => {
  // agents-daemon's `features` as its providers list them at 1c9ab6c
  // (`codex-provider.ts`, `claude-provider.ts`), less what is not read here.
  const claude = {
    id: "claude",
    features: {
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      interactions: {
        inputRequests: ["choice", "plan"],
        passiveUpdates: [],
        unavailable: ["text", "form", "url"],
      },
      permissions: {
        presets: ["ask", "yolo", "custom"],
        claudeCode: {
          permissionModes: [
            "default",
            "acceptEdits",
            "auto",
            "dontAsk",
            "plan",
            "bypassPermissions",
          ],
        },
      },
    },
  };
  const codex = {
    id: "codex",
    features: {
      interactions: {
        inputRequests: [],
        passiveUpdates: [],
        unavailable: ["text", "choice", "plan", "form", "url"],
      },
      permissions: {
        presets: ["ask", "yolo", "custom"],
        codex: {
          approvalPolicies: ["untrusted", "on-request", "never"],
          sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
        },
      },
    },
  };
  const read = (...providers: unknown[]) => {
    const decoded = decodeExecutionProviderListResponse({ providers });
    if (!decoded.ok) throw new Error(decoded.reason);
    return decoded.value.providers;
  };

  it("reads what agents-daemon lists today", () => {
    expect(read(claude, codex)).toEqual([
      {
        id: "claude",
        label: "claude",
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        models: [],
        permissions: claude.features.permissions,
        interactions: {
          inputRequests: ["choice", "plan"],
          unavailable: ["text", "form", "url"],
        },
      },
      {
        id: "codex",
        label: "codex",
        effortLevels: [],
        models: [],
        permissions: codex.features.permissions,
        interactions: {
          inputRequests: [],
          unavailable: ["text", "choice", "plan", "form", "url"],
        },
      },
    ]);
  });

  it("reads Codex's reviewers and collaboration modes", () => {
    const permissions = {
      presets: ["custom"],
      codex: {
        ...codex.features.permissions.codex,
        approvalsReviewers: ["user", "auto_review"],
        collaborationModes: ["default", "plan"],
      },
    };
    expect(
      read({ id: "codex", features: { permissions } })[0]?.permissions,
    ).toEqual(permissions);
  });

  it("leaves out what the host does not say: unknown, not none", () => {
    const [provider] = read({ id: "gemini", features: {} });
    expect(provider).not.toHaveProperty("permissions");
    expect(provider).not.toHaveProperty("interactions");
  });

  it("drops a value it does not know, and keeps the rest", () => {
    const [provider] = read({
      id: "codex",
      features: {
        permissions: {
          presets: ["ask", "supervised", "ask"],
          codex: {
            approvalPolicies: ["never", "on-failure"],
            sandboxModes: ["read-only"],
            approvalsReviewers: ["auto_review", "committee"],
            collaborationModes: ["plan", "pair"],
          },
        },
        interactions: {
          inputRequests: ["choice", "voice"],
          unavailable: ["url", "video"],
        },
      },
    });
    expect(provider?.permissions).toEqual({
      presets: ["ask"],
      codex: {
        approvalPolicies: ["never"],
        sandboxModes: ["read-only"],
        approvalsReviewers: ["auto_review"],
        collaborationModes: ["plan"],
      },
    });
    expect(provider?.interactions).toEqual({
      inputRequests: ["choice"],
      unavailable: ["url"],
    });
  });

  it("never costs the catalogue a shape it cannot read", () => {
    for (const features of [
      { permissions: "all", interactions: [] },
      { permissions: { presets: "ask" }, interactions: { inputRequests: [] } },
      {
        permissions: { codex: codex.features.permissions.codex },
        interactions: { inputRequests: ["choice"], unavailable: null },
      },
    ]) {
      const [provider] = read({ id: "codex", features });
      expect(provider).toMatchObject({ id: "codex" });
      expect(provider).not.toHaveProperty("permissions");
      expect(provider).not.toHaveProperty("interactions");
    }
  });

  it("leaves out a provider's part it cannot read, and its optional lists alone", () => {
    const [provider] = read({
      id: "codex",
      features: {
        permissions: {
          presets: ["ask"],
          codex: {
            ...codex.features.permissions.codex,
            approvalsReviewers: "user",
            collaborationModes: [1],
          },
          claudeCode: { permissionModes: "plan" },
        },
      },
    });
    expect(provider?.permissions).toEqual({
      presets: ["ask"],
      codex: codex.features.permissions.codex,
    });
  });
});

describe("the interaction request kinds", () => {
  it("are every kind a request comes in", () => {
    const every: Record<ExecutionInteractionRequest["kind"], true> = {
      text: true,
      choice: true,
      plan: true,
      form: true,
      url: true,
    };
    expect([...EXECUTION_INTERACTION_REQUEST_KINDS].sort()).toEqual(
      Object.keys(every).sort(),
    );
  });
});
