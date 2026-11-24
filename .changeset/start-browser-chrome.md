---
"@mrck-labs/execution-host-protocol": minor
---

Add a session that drives the person's own Chrome: a start's `config.browser: "chrome"`, behind `start.browser.chrome.v1` (MAR-5726). Additive.

- `EXECUTION_START_BROWSERS` (`["chrome"]`), `isExecutionStartBrowser`. A host advertising the capability runs the session's Claude Code with Claude in Chrome on (the CLI's `--chrome`) for its whole life, every resume included. Only a host on a person's own machine, with its setting on, advertises it. A value outside the list is refused as `invalid-payload`.
- A host that knows `browser` never starts without it. It refuses with a 400 coded `browser-unavailable-on-host` whenever it doesn't offer Chrome, whether or not it advertises the capability, and with `browser-unsupported-provider` or `browser-unsupported-with-skills` (`EXECUTION_START_BROWSER_REFUSAL_CODES`). Only a legacy host ignores the field.
- Over a `MessagePort`, which has no `/health`, the port client sends a browser start only for a provider whose `providers()` entry has a `chrome` that reads whole (`readExecutionProviderChrome`). Otherwise it refuses unsent: `browser-unsupported`, or `browser-unsupported-provider` where another provider has one. A catalogue that isn't a list, an empty `chrome` or one it can't read count as `browser-unsupported`. A cancel keeps the caller's own abort reason, and a port that closes meanwhile is the port's `network` error.
- The client refuses `browser`, unsent, on a host without the capability: `ExecutionStartBrowserError` coded `browser-unsupported` (`hostTakesChrome`). A capable host's coded 400 is the same error with that code and status 400, in the client's own words. The error crosses a `MessagePort` as its class, and only with a code this build knows.
- A provider in `GET /v0/providers` can carry `chrome: { nativeHost, extension }` (`ExecutionProviderChrome`, `readExecutionProviderChrome`): whether Chrome's native-messaging host for Claude Code and the Claude extension are installed. Absent is unknown; one this build can't read is left out with a warning.
