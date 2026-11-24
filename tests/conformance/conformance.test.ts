import { MessageChannel } from "node:worker_threads";
import { describe, it } from "vitest";
import { createExecutionHostClient } from "../../src/client/index.js";
import {
  createPortClient,
  servePort,
  type ExecutionHostPort,
} from "../../src/port/index.js";
import { describeExecutionHostConformance } from "../../src/testing/index.js";
import { MessagePortMainLike } from "../port/electron-port.js";
import { FakeHostModel, fakeApi, fakeFetch, modelHooks } from "./fake-host.js";

// The suite holds the model's own API to the contract first: the port and
// HTTP runs below then show the carriers change nothing.
describeExecutionHostConformance(
  { describe, it },
  "fake API, in process",
  () => {
    const model = new FakeHostModel();
    return { api: fakeApi(model), ...modelHooks(model) };
  },
);

describeExecutionHostConformance(
  { describe, it },
  "fake API over a MessageChannel",
  () => {
    const model = new FakeHostModel();
    const { port1, port2 } = new MessageChannel();
    const server = servePort(port2, fakeApi(model));
    const api = createPortClient(port1);
    return {
      api,
      ...modelHooks(model),
      close: () => {
        api.close();
        server.close();
      },
    };
  },
);

describeExecutionHostConformance(
  { describe, it },
  "fake API over Electron-shaped ports",
  () => {
    const model = new FakeHostModel();
    const { port1, port2 } = new MessageChannel();
    const host: ExecutionHostPort = new MessagePortMainLike(port2);
    const server = servePort(host, fakeApi(model));
    const api = createPortClient(new MessagePortMainLike(port1));
    return {
      api,
      ...modelHooks(model),
      close: () => {
        api.close();
        server.close();
      },
    };
  },
);

describeExecutionHostConformance(
  { describe, it },
  "HTTP client with a fake fetch",
  () => {
    const model = new FakeHostModel();
    const api = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "conformance-token",
      fetch: fakeFetch(model, "conformance-token"),
    });
    return { api, ...modelHooks(model) };
  },
);

// A host predating turns.usage.v1 (MAR-4943), mcp.connections.v1 (MAR-5668)
// and sessions.pullRequests.v1 (MAR-5696) passes too, by refusing the history
// as not-found and MCP calls as unsupported, and saying no pullRequests, over
// a port and over HTTP.
describeExecutionHostConformance(
  { describe, it },
  "a host without turn usage, over a MessageChannel",
  () => {
    const model = new FakeHostModel({
      recordsUsage: false,
      mcp: "absent",
      pullRequests: "none",
    });
    const { port1, port2 } = new MessageChannel();
    const server = servePort(port2, fakeApi(model));
    const api = createPortClient(port1);
    return {
      api,
      ...modelHooks(model),
      close: () => {
        api.close();
        server.close();
      },
    };
  },
);

describeExecutionHostConformance(
  { describe, it },
  "a host without turn usage, behind the HTTP client",
  () => {
    const model = new FakeHostModel({
      recordsUsage: false,
      mcp: "absent",
      pullRequests: "none",
    });
    const api = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "conformance-token",
      fetch: fakeFetch(model, "conformance-token"),
    });
    return { api, ...modelHooks(model) };
  },
);

// A shared host (MAR-5668) passes by refusing every MCP call
// unavailable-on-host, and reports pull requests without reading GitHub
// itself (MAR-5696), over a port and over HTTP.
describeExecutionHostConformance(
  { describe, it },
  "a shared host without MCP connections, over a MessageChannel",
  () => {
    const model = new FakeHostModel({ mcp: "shared", pullRequests: "facts" });
    const { port1, port2 } = new MessageChannel();
    const server = servePort(port2, fakeApi(model));
    const api = createPortClient(port1);
    return {
      api,
      ...modelHooks(model),
      close: () => {
        api.close();
        server.close();
      },
    };
  },
);

describeExecutionHostConformance(
  { describe, it },
  "a shared host without MCP connections, behind the HTTP client",
  () => {
    const model = new FakeHostModel({ mcp: "shared", pullRequests: "facts" });
    const api = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "conformance-token",
      fetch: fakeFetch(model, "conformance-token"),
    });
    return { api, ...modelHooks(model) };
  },
);
