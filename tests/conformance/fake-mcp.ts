import {
  EXECUTION_MCP_REFUSAL_STATUSES,
  type ExecutionMcpProvider,
  type ExecutionMcpRefusalCode,
  type ExecutionMcpServer,
  type ExecutionMcpSignIn,
  type ExecutionMcpSignInStatus,
} from "../../src/index.js";

/**
 * Which host the stand-in is: `personal` manages MCP connections, `shared`
 * refuses them `unavailable-on-host`, and `absent` predates them, answering
 * the routes 404 with no code.
 */
export type FakeMcpProfile = "personal" | "shared" | "absent";

/** A host's refusal, by its code: the API face throws it typed, the HTTP face answers it. */
export class FakeMcpRefusal extends Error {
  constructor(readonly code: ExecutionMcpRefusalCode) {
    super(`refused: ${code}`);
  }
  get status(): number {
    return EXECUTION_MCP_REFUSAL_STATUSES[this.code];
  }
}

interface FakeSignIn {
  /** When it expires: `signIn.expiresAt`, until `expire` brings it forward. */
  deadline: number;
  nonce: string;
  signIn: ExecutionMcpSignIn;
  status: ExecutionMcpSignInStatus;
}

/**
 * The stand-in for a personal host's MCP connections (MAR-5668), as C2's
 * runtime keeps them: each provider's servers with their states, and each
 * server's latest sign-in, which the owner's browser finishes by coming back
 * to the provider's own loopback (`complete`) or which `finish` finishes from
 * the URL it landed on.
 */
export class FakeMcp {
  readonly servers = new Map<ExecutionMcpProvider, ExecutionMcpServer[]>([
    [
      "claude",
      [
        {
          name: "atlassian",
          source: "user",
          transport: "http",
          state: "needs-sign-in",
          urlHost: "mcp.atlassian.com",
        },
        {
          name: "plugin:figma:figma",
          source: "plugin",
          transport: "http",
          state: "needs-sign-in",
          urlHost: "mcp.figma.com",
        },
        {
          name: "claude.ai Gmail",
          source: "claude.ai",
          transport: "http",
          state: "connected",
        },
        {
          name: "filesystem",
          source: "project",
          transport: "stdio",
          state: "connected",
        },
      ],
    ],
    [
      "codex",
      [
        {
          name: "linear",
          source: "user",
          transport: "http",
          state: "needs-sign-in",
          urlHost: "mcp.linear.app",
        },
      ],
    ],
  ]);
  private readonly signIns = new Map<string, FakeSignIn>();
  private minted = 0;

  constructor(
    readonly profile: FakeMcpProfile,
    private readonly expiresInMs = 300_000,
  ) {}

  list(provider: ExecutionMcpProvider): ExecutionMcpServer[] {
    this.open();
    return this.servers.get(provider)!.map((server) => ({ ...server }));
  }

  signIn(provider: ExecutionMcpProvider, name: string): ExecutionMcpSignIn {
    const server = this.signable(provider, name);
    const pending = this.latest(provider, server.name);
    if (pending?.status.state === "pending") return { ...pending.signIn };
    this.minted += 1;
    const nonce = `nonce-${this.minted}`;
    const signIn: ExecutionMcpSignIn = {
      signInUrl: `https://auth.example.test/authorize?client=accent&state=${nonce}`,
      callbackExpected: true,
      expiresAt: new Date(Date.now() + this.expiresInMs).toISOString(),
    };
    this.signIns.set(key(provider, name), {
      deadline: Date.parse(signIn.expiresAt),
      nonce,
      signIn,
      status: { state: "pending" },
    });
    return { ...signIn };
  }

  state(
    provider: ExecutionMcpProvider,
    name: string,
  ): ExecutionMcpSignInStatus {
    return { ...this.existing(provider, name).status };
  }

  finish(
    provider: ExecutionMcpProvider,
    name: string,
    callbackUrl: string,
  ): ExecutionMcpSignInStatus {
    const record = this.existing(provider, name);
    if (record.status.state !== "pending") return { ...record.status };
    if (new URL(callbackUrl).searchParams.get("state") !== record.nonce) {
      throw new FakeMcpRefusal("rejected");
    }
    this.connect(provider, name, record);
    return { ...record.status };
  }

  cancel(
    provider: ExecutionMcpProvider,
    name: string,
  ): ExecutionMcpSignInStatus {
    const record = this.existing(provider, name);
    if (record.status.state === "pending") {
      record.status = { state: "cancelled" };
    }
    return { ...record.status };
  }

  signOut(provider: ExecutionMcpProvider, name: string): void {
    const server = this.signable(provider, name);
    this.signIns.delete(key(provider, name));
    server.state = "needs-sign-in";
  }

  /** The owner's browser came back to the provider's own loopback. */
  complete(provider: ExecutionMcpProvider, name: string): void {
    const record = this.latest(provider, name);
    if (record?.status.state !== "pending") {
      throw new Error(`no pending sign-in for ${name}`);
    }
    this.connect(provider, name, record);
  }

  /** Makes the pending sign-in's time run out now, as `expiresAt` passing does. */
  expire(provider: ExecutionMcpProvider, name: string): void {
    const record = this.signIns.get(key(provider, name));
    if (record?.status.state !== "pending") {
      throw new Error(`no pending sign-in for ${name}`);
    }
    record.deadline = 0;
  }

  /** The URL the provider's page sends the browser to, for this sign-in. */
  callbackUrl(signIn: ExecutionMcpSignIn): string {
    const nonce = new URL(signIn.signInUrl).searchParams.get("state");
    return `http://localhost:52009/callback?code=fake-code&state=${nonce}`;
  }

  private connect(
    provider: ExecutionMcpProvider,
    name: string,
    record: FakeSignIn,
  ): void {
    record.status = { state: "connected" };
    this.server(provider, name).state = "connected";
  }

  /** Refuses every call on a host that does not manage MCP connections. */
  private open(): void {
    if (this.profile === "shared") {
      throw new FakeMcpRefusal("unavailable-on-host");
    }
  }

  private server(
    provider: ExecutionMcpProvider,
    name: string,
  ): ExecutionMcpServer {
    this.open();
    const server = this.servers
      .get(provider)!
      .find((entry) => entry.name === name);
    if (!server) throw new FakeMcpRefusal("unknown-server");
    return server;
  }

  /** A server a sign-in is for: not one that needs none, nor a claude.ai connector. */
  private signable(
    provider: ExecutionMcpProvider,
    name: string,
  ): ExecutionMcpServer {
    const server = this.server(provider, name);
    if (server.source === "claude.ai" || server.transport === "stdio") {
      throw new FakeMcpRefusal("not-offered");
    }
    return server;
  }

  /** The server's latest sign-in, expired once its time is up. */
  private latest(
    provider: ExecutionMcpProvider,
    name: string,
  ): FakeSignIn | undefined {
    const record = this.signIns.get(key(provider, name));
    if (record?.status.state === "pending" && Date.now() >= record.deadline) {
      record.status = { state: "failed", reason: "The sign-in expired" };
    }
    return record;
  }

  private existing(provider: ExecutionMcpProvider, name: string): FakeSignIn {
    this.server(provider, name);
    const record = this.latest(provider, name);
    if (!record) throw new FakeMcpRefusal("no-sign-in");
    return record;
  }
}

function key(provider: ExecutionMcpProvider, name: string): string {
  return `${provider}\u0000${name}`;
}
