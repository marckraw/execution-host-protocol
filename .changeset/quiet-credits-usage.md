---
"@mrck-labs/execution-host-protocol": minor
---

Add optional provider usage credits under `providers.usage.v1`, with required
`hasCredits` and `unlimited` flags, an exact decimal string balance bounded at
128 characters, and an optional separate observation timestamp. Readers clean
the balance and drop malformed credits without losing usage or its windows.
Credits are for display only and do not change limit enforcement.
