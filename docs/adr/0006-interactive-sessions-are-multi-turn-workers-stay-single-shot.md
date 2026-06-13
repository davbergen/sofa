# Interactive Sessions are multi-turn; Workers stay single-shot

Interactive (supervised) Sessions — the host-side `SdkAgent` path that drives
Grilling Sessions and any other conversation David has with the agent — start
the Claude Agent SDK `query` in **streaming-input mode**: the `prompt` is a
long-lived `AsyncIterable<SDKUserMessage>` that yields the opening prompt and
then stays open, fed by an input queue. Follow-up turns are pushed onto that
queue (replacing the previous one-shot `streamInput(oneUserMessage(...))`
call), and the Session ends only when something explicitly closes the queue.

Workers — the autonomous, containerized path — keep their single-shot string
prompt: a Worker implements one Issue, opens one PR, and dies, so it has no
conversation to hold open.

## Why

The SDK treats a **string** `prompt` as a single user turn: it calls
`setIsSingleUserTurn(true)`, and once the first `result` arrives it ends stdin
and the message iterator completes. A Grilling Session is inherently a
back-and-forth interview, so under a string prompt it produced its opening turn
and then ended — there was nothing left to talk to. The conversational
`/message` path appeared to work only because the test suite exercises
`fake-agent.ts`, not the real SDK. Holding the channel open is the only way the
interview can actually happen.

## Considered Options

- **Keep string prompts, lean on `streamInput` for follow-ups** — minimal
  change, but the SDK's `streamInput` calls `endInput()` after draining the
  iterable it is given, so it closes the channel after a single follow-up. It
  cannot sustain an open-ended conversation; this is the behaviour we are
  moving away from.
- **One streaming-input mode for every Session, Workers included** — uniform
  code path, but a Worker has no second turn and now needs an explicit end
  signal it would otherwise never receive, plus the risk of an autonomous run
  hanging on an open channel. The interactive/Worker split is cheap and removes
  that hazard.

## Consequences

- The Session lifecycle gains an explicit end: closing the input queue
  completes the `query` and marks the Session `done`. A new "End session"
  action drives this; without it a streaming-input Session never terminates on
  its own.
- An abandoned open Session holds a live subprocess, so an idle-timeout safety
  net becomes worth having (tracked separately, not part of the core change).
- Turn boundaries are now meaningful to the UI: the SDK's per-turn `result`
  message (already observed for usage metering) can surface an `awaiting` state
  so the composer knows when it is David's turn.
- The two paths diverge at Session start, so the interactive/Worker distinction
  in the domain model now has a concrete technical correlate.
