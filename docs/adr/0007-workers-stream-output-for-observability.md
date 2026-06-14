# Workers stream their output for observability — and stay single-shot

The Worker harness invokes the Claude CLI with `--output-format stream-json
--verbose` and parses each NDJSON line as it arrives. The harness translates
the stream into the activity feed's existing one-line-per-event protocol
(tool calls become verbs, assistant prose is condensed to its first sentence,
`tool_result` bodies are dropped except errors) and reads the token usage
off the stream's final `result` event. **This is an observability change, not
a change to the agent's execution model**: the Worker remains a single-shot
non-interactive run that implements one Issue, opens one PR, and dies.

This is deliberately distinct from ADR 0006: interactive Sessions hold the
SDK channel open across multiple turns; a Worker is still one turn. Reading
`stream-json` parsing as multi-turn behaviour would misread the change.

## Why

Before this ADR the harness ran the agent with `--output-format json` through
a runner that buffered all stdout, so during the entire `working` phase the
container emitted nothing — then dumped the full transcript at once on close.
The "live" activity feed wasn't live during the phase that mattered, and a
hung or killed Worker showed zero of what it had been doing. A current-activity
headline therefore could not be distilled from the existing events; switching
to streaming output is a precondition, not a nice-to-have.

The cost is essentially free: output format is a local serialisation concern,
not a generation concern. Same single `claude -p` invocation, same model, same
tool runs — **zero extra tokens, zero agent slowdown**. The only new cost is
trivial local JSONL parsing and slightly more bytes spread over time. The
activity feed already carried the full transcript; it just used to arrive in
one end-of-run spike.

## Considered Options

- **Buffer the output and tail it from outside the container** — wouldn't
  help: the runner's buffering happens inside the harness, and the docker
  adapter already line-parses stderr; the bottleneck is the agent process
  itself withholding output until close. Only `stream-json` gets events out
  as they happen.
- **Add a second `--output-format json` call at the end just for usage** —
  one agent invocation per Issue is load-bearing (cost, idempotency); we read
  usage off the same stream we're already parsing.
- **Push policy formatting into the docker adapter or the UI** — the harness
  owns the agent contract (it owned `parseAgentUsage` for the same reason),
  so it owns the stream→activity-line translation too. Downstream (adapter,
  SSE, UI) keeps handling plain `activity` strings exactly as it did before.

## Consequences

- The runner gains an optional `onStdoutLine` hook used only by the agent
  call; git and gh keep buffering.
- Token-usage accounting moves from `parseAgentUsage(stdout)` to the stream
  formatter's captured `result` event. Accuracy is unchanged — same fields,
  same source.
- The emit policy curates tool verbs (`Editing harness.ts`, `Bash: npm test`,
  `Searching for "applyEvent"`, etc.) and drops `tool_result` bodies — except
  `is_error` results, which surface as `⚠ <tool> failed`. Unknown future
  tools fall back to `Working…` so the feed never leaks raw JSON.
- Token redaction (`harness.ts` / `worker/index.ts`) still runs on every
  formatted line before it reaches stderr, so the activity SSE can never
  carry the GitHub token.
- A killed mid-run Worker leaves the feed showing what it was last doing
  instead of going blank.
- The UI derives a single **current-activity headline** from the latest
  activity entry — pure UI derivation, no new event type. The raw feed
  lives behind a "show detail" toggle so the default view is the headline.
