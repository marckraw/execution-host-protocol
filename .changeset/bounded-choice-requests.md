---
"@mrck-labs/execution-host-protocol": minor
---

A choice request on an `input-request` is read within bounds (MAR-4002): at most 8 questions of 16 options, and bounded text (`EXECUTION_INTERACTION_*`). What is past them, or cannot be read, is dropped with a warning, and the rest of the request is kept; one bad option no longer drops the whole `request`. The client refuses, unsent, a `send-message` carrying `options.interactionResponse` to a host that does not advertise `interactions.structured` (`ExecutionInteractionResponseError`, `hostTakesStructuredInteractions`). Items within bounds, and commands without `interactionResponse`, are unchanged on the wire.
