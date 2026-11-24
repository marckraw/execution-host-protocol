---
"@mrck-labs/execution-host-protocol": minor
---

A session holds its checkout until it is quiescent, and a settle frees nothing (MAR-5673's daemon review, round 4).

- **The rule:** a session in a person's own checkout holds it from its start until it is deleted or fully quiescent. Quiescent means no turn running, nothing queued for it (the host's queue or its provider's), no task of its running, and no turn of the provider's own still possible after one ended.
  - A host takes the hold once and drops it once.
  - A session that let go of its checkout takes it again before any work of its begins, or is refused `checkout-taken` while another session holds it.
  - A session that finished, failed or stopped leaves the checkout to the next start.
- **A settle (`settled: true`) is the person's word, kept and echoed.** It never frees a checkout the session still works in: in 0.40 a host let go of a settled session's running turn. Taking a settle back is never refused for the checkout. The patch refusal code `checkout-taken` stays readable for 0.40 hosts.
- **The conformance suite's settle case** now settles a session at work twice and reads `settled` in its snapshot and the list. A checkout start beside the session is refused all the same. It then takes the settle back twice, and once the session's work is done, a new start gets the checkout.
