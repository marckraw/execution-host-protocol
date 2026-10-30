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
