# Interactive Sessions render in an inline Session Terminal that takes over the launching Project card

A live interactive Session no longer renders as a single global `<section>` at
the bottom of the page. Instead, **Starting a Session morphs the launching
`ProjectCard` in place** into a two-column layout — a **Session Terminal**
(`flex: 1.62`) beside the Project's dashboard, now docked to a fixed-width rail
(`344px`). Three decisions travel together:

1. **The Session moves into the card.** Session state and rendering relocate
   from the global bottom section into the `ProjectCard` that launched it; the
   composer "grows in place" into the terminal and the dashboard recedes to the
   rail. Other open Project cards stay stacked but visually recede.
2. **The Session Terminal is the surface for *every* interactive Session**, not
   only Grilling Sessions. The statusline badge reflects the actual skill; the
   PRD tab in the rail only materialises when a `prd_draft` event actually
   arrives (i.e. grills). There is one transcript UI, not a grill-specific one
   plus a second-class generic one.
3. **One interactive Session at a time.** The single global Session model is
   kept: while one card is live, every other card's launch controls lock with a
   hint. Workers and Dispatch stay fully available everywhere — dispatching is
   independent of the Session, so the rail keeps the Ralph Loop running during a
   grill.

## Why

The dashboard is the per-Project workbench, and the value the redesign unlocks
is keeping it reachable *while* a Session runs — dispatching Issues to Workers
from the rail without leaving the grill. A global bottom section cannot express
"this Session belongs to this Project's card"; binding the Session to its card
is what makes the docked rail, and the keep-working payoff, coherent.

Hosting all interactive Sessions on one surface follows from the merged
Composer: once the front door launches both grills and arbitrary-skill Sessions,
splitting their output into two render paths would leave the generic path
second-class for no benefit — both stream the same SSE contract.

One-at-a-time is the cheap, honest match to the existing architecture: the UI
holds a single `session` and a single `EventSource`. Concurrent per-Project
Sessions would mean re-keying both by Project and visually tracking several live
terminals at once — a real architectural change with no demand behind it, since
the thing users actually want to do in parallel (dispatch Workers) is already
concurrent.

## Considered Options

- **Full-page focus mode** — collapse the whole page to the grilling Project's
  `[terminal | rail]` until End session. Closest to the single-Project mockup and
  the simplest layout, but it hides the other open Projects and the open-Project
  bar exactly when a user might want to glance at them. Rejected: the multi-
  Project page is load-bearing, and the rail already supplies focus.
- **Keep the global bottom section, restyle only** — leave the architecture
  untouched and only skin the existing transcript as a terminal. Cheapest, but
  it forfeits the "composer grows in place + dashboard docks to a rail"
  interaction, which is the specific idea the redesign was adopted for.
- **One live Session per Project** — re-key Session/SSE state by Project so each
  open Project can hold its own terminal. More powerful for juggling Projects,
  but a genuine architectural change with no current need; deferred rather than
  refused, behind the single-Session lock.
- **A grill-only terminal** — give only Grilling Sessions the takeover and leave
  generic Sessions in the plain transcript. Lets the terminal lean into grill-
  specific affordances, but maintains two transcript UIs and keeps the generic
  path second-class.

## Consequences

- `App.tsx`'s single `session` / `sourceRef` survive, but the live Session is
  rendered *inside* `ProjectCard` rather than the page-level bottom section. The
  card has an idle phase (Composer + dashboard grid) and a live phase
  (`terminal | rail`).
- The rail is tabbed `Dashboard | PRD`; `prd_draft` auto-focuses the PRD tab.
  The PRD panel keeps its current revise-then-Approve flow, just relocated.
- The structured `QuestionForm` (options + recommended + Other) is retained and
  restyled as the terminal's `ASK` block; the free-text input row carries only
  unstructured replies. The terminal is a skin over the real interaction, not a
  new free-text interaction model.
- Phase 1 sources terminal lines from events already on the stream
  (`assistant_text`, `file_write`, `question`, `user_message`, `done`); the
  `READ/GREP/EXEC` tool-call firehose is a separate later phase (it would extend
  the interactive-Session event contract the way ADR 0007 did for Workers).
- "End session" must both close the input queue (true terminate, per ADR 0006)
  and collapse the card. Issue #93 (End Session does not terminate a Session
  awaiting a question) is therefore a prerequisite, as is #92 (Start Grilling
  loads the `grill-with-docs` skill).
- Other cards' launch buttons gain a disabled-while-live state; nothing else
  about Dispatch or Workers changes.
