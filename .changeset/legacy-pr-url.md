---
"@mrck-labs/execution-host-protocol": patch
---

`session.patch` reads an older host's `prUrl` again (MAR-5698): kept, deprecated, while it is a pull request's address on github.com (or null), and dropped with a `dropped-invalid-field` warning otherwise. 0.43 dropped it along with every other unknown field, so a reader whose hosts send no `pullRequests` yet lost the one word they had on a session's pull request. The decoder makes no `pullRequests` of it; the reader decides.
