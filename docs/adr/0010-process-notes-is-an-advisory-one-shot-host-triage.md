# Process Notes is an advisory one-shot host triage that classifies, never files

The "Process Notes" action runs a report-only triage over a Project's unacted
Field Note Items and attaches a Recommendation to each — **Grill** (escalate) or
**Cut** (file directly) — but it files nothing and reaches no tracked work. We
deliberately did *not* run the `notes-to-issues`/`triage-notes` skills here, even
though they already make this exact call, because those skills publish to GitHub:
self-contained notes become `ready-for-agent` issues and thorny ones become
`needs-refinement` issues, in one pass. That collides with Sofa's Field Notes
model — Items are pre-pipeline operational state that never reach GitHub until
escalated (ADR 0002, ADR 0004), there is no Item→`needs-refinement` outcome, and
every GitHub write goes through the per-Item confirm/edit flow. So Process Notes
only *recommends* which of the two existing per-Item actions (Grill / Create
Issue) to take; David still pulls the trigger.

## Considered Options

- **Run `notes-to-issues` verbatim (file both buckets)** — maximum reuse, but
  pushes Field Note Items straight to GitHub, bypasses the confirm/edit step and
  the SQLite Item-status linkage, and invents an Item→`needs-refinement`
  outcome the model doesn't have. Rejected.
- **Auto-file only the self-contained Items** — still bypasses the per-Item
  confirm/edit flow for the filed ones, for marginal benefit. Rejected.
- **A general human-readable triage report Sofa scrapes** — brittle; wording
  drift breaks parsing and mapping verdicts back to specific Items by id is
  error-prone. We chose a strict machine contract instead.

## Consequences

- A new run shape: a **single-shot run on the host**. ADR 0006 split the world
  into multi-turn interactive Sessions (host) and single-shot Workers
  (containerized); Process Notes is the new combination — single-shot but
  host-side — driven by an `SdkAgent` that reads the Items, returns one strict
  JSON object (`id → {recommendation, rationale}`), and ends. It renders no
  Session Terminal and appears in no session history.
- It is headless but still a host agent run, so it **shares the global single
  host-run slot** with interactive Sessions (cf. the "one Session at a time"
  lock): it cannot start while a Session is live and it locks launches while it
  runs. Never two host agents at once.
- A dedicated report-only triage skill owns the ready-vs-refinement *criteria*
  (the same test as `notes-to-issues`) so the rules have a single source of
  truth and don't drift into an inline Sofa prompt.
- The Recommendation is operational state, stored on the Field Note Item
  (ADR 0004); it is advisory and superseded the moment David acts on the Item.
