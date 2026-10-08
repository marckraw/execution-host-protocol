---
"@mrck-labs/execution-host-protocol": patch
---

A turn from a host that sends no `origin` reads again (MAR-3823). 0.19 made
`origin` required, so every turn from a host that predates it was dropped as
`invalid-payload`: agents-daemon (on 0.17) sends none, and a client past 0.18
followed its sessions with no turns and read snapshots without them.

- **A turn without `origin` reads as `origin: "user"`**, on `turn.add`, in
  `decodeExecutionTurn`, and in the client's session snapshot. Before 0.19 a
  person's message opened every turn, so that is what its absence means.
- **An `origin` this build does not know is still refused**, as is `null`: a
  newer host said something this build cannot place, not nothing. A `harness`
  turn stays `harness`.
- Every other field 0.19 to 0.21 added to something an older host already sent
  was checked and already read without it; tests now hold that, against a
  session recorded from agents-daemon.

What a host or client sends is unchanged, and the protocol version stays 1.
A host built on 0.19 or later still sends `origin` on every turn.
