---
"@mrck-labs/execution-host-protocol": minor
---

A choice request on an `input-request` is read within bounds (MAR-4002): at most 8 questions of 16 options, and bounded text (`EXECUTION_INTERACTION_*`). An option past them, or unreadable, is dropped with a warning and the rest kept. Any question the host asked that cannot be shown means no request: more than 8 questions, or a question past its bounds, unreadable, or left with no option, drops the whole `request`, so an answer never leaves out a question. A question's `id` may be as long as its text, which is what agents-daemon uses for a Claude question. The client refuses, unsent, a `send-message` carrying `options.interactionResponse` to a host that does not advertise `interactions.structured` (`ExecutionInteractionResponseError`, `hostTakesStructuredInteractions`). Items within bounds, and commands without `interactionResponse`, are unchanged on the wire.
