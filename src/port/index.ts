/**
 * `@mrck-labs/execution-host-protocol/port` — an `ExecutionHostApi` over a
 * `MessagePort` (MAR-4862): `servePort` on the side that runs the host,
 * `createPortClient` on the side that drives it. For a host in an Electron
 * utility process or a worker thread, where there is no network between the
 * two. Like `/client`, plain JavaScript with no dependencies beyond the
 * contract.
 */

export { createPortClient, type ExecutionHostPortClient } from "./client.js";
export {
  PORT_CHUNKS_IN_FLIGHT,
  PORT_FRAMES_PER_CHUNK,
  servePort,
  type ExecutionHostPortServer,
} from "./serve.js";
export { type ExecutionHostPort } from "./port.js";
