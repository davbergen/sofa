# One Active Project is shown at a time, switched via a left Project Rail

Sofa no longer stacks every open Project's card down a single scrolling column.
Instead, open Projects are listed in a **Project Rail** down the left edge, and
the main pane renders **exactly one Active Project** at a time. The hard rule:
**Sofa never shows two Project dashboards on screen at once.** Three decisions
travel together:

1. **Multiple Projects stay open; one is Active.** The open-set is unchanged
   (Sofa still keeps no central registry and a Project is still its directory).
   What changes is presentation: the Project Rail marks the Active Project and
   routes switching, and only the Active Project's workbench (idle dashboard or
   live terminal) occupies the main pane.
2. **Switching is free and never disturbs a running Session.** A live
   interactive Session belongs to its Project and runs on the host (ADR 0006);
   making another Project Active just changes what is rendered. The Session keeps
   running and is re-attached to its stream when its Project is made Active
   again. The Project Rail shows a live pulse on whichever Project is busy.
3. **The one-Session-at-a-time lock (ADR 0008) is preserved and made legible.**
   While one Project holds a live Session, launching from another stays blocked
   with a hint; the rail's live pulse tells you which Project to return to. This
   removes the need to "visually recede" other cards, because they are no longer
   on screen at all.

## Why

ADR 0008 bound the live Session to its launching `ProjectCard` and kept all
other cards **stacked but receded**, explicitly rejecting a full-page focus mode
on the grounds that "the multi-Project page is load-bearing." Lived experience
inverted that judgement: with several Projects open — each carrying a Field
Notes list, a Ready Issues queue, and a Worker Runs history that all grow
unbounded — the stacked page became the dominant source of scrolling, and it was
no longer obvious *which* Project a given dashboard belonged to. The thing that
was supposed to be load-bearing was the thing in the way.

Showing one Active Project at a time collapses N stacked dashboards to one,
which is the single largest reduction in page height available, and it makes
"which Project am I working in" unambiguous — the rail names it and the main pane
proves it. The multi-Project value ADR 0008 wanted to protect (glancing at and
acting on other Projects) is preserved by the rail, which keeps every open
Project one click away; it is cheaper to switch than it was to scroll past.

This **supersedes ADR 0008's stacked/receded card model and its rejection of a
focus layout.** ADR 0008's other decisions stand: the Session Terminal is still
the surface for every interactive Session, the rail is still tabbed
`Dashboard | PRD`, and one Session runs at a time.

## Considered Options

- **One Active Project via a left rail (chosen).** Multiple open, one shown,
  switching free, background Sessions survive. Zero-scroll across Projects and
  unambiguous "where am I", at the cost of not seeing two Projects side by side.
- **Only one Project open at all** — opening a new Project closes the prior one.
  Simplest possible layout, but it discards the open-folder model and the
  glossary's "multiple can be open", and makes comparing or hopping between
  Projects a re-open round-trip. Rejected as needlessly destructive.
- **All Projects open and listed, only one expanded** — keep the stacked column
  but collapse inactive cards to a one-line header. Preserves the single-column
  page, but keeps the page itself as the switching surface (still a scroll to
  reach a lower card) and keeps two competing affordances (a header strip and a
  rail). Rejected in favour of dedicated chrome.
- **Status quo + per-card compaction only** — leave cards stacked and just
  shrink their contents. Helps, but does nothing for the N-dashboards-stacked
  axis or the which-Project ambiguity, which were the actual complaints.

## Consequences

- `App.tsx` gains a Project Rail component and an Active-Project selector;
  Projects are rendered one at a time rather than mapped into a stacked list.
  "Open Project" and the directory picker move into the rail.
- `App.tsx`'s single `session` / `sourceRef` model still fits: a backgrounded
  Session is simply one whose Project is not Active. Returning to that Project
  re-attaches the existing stream; the Session is never torn down by a switch.
- The Active Project's idle view is **dashboard-first** with a terminal-styled
  launcher strip; an "Open terminal" control expands into the live terminal
  layout *empty*, where the terminal input itself is the launcher. Ending a
  Session collapses back to dashboard-first. (The empty-terminal/launcher
  behaviour extends ADR 0008's terminal but is a UI detail, not a separate ADR.)
- Per-card "receded" styling from ADR 0008 is retired; the lock it expressed is
  now carried by the rail's live pulse plus the blocked launcher on non-busy
  Projects.
- The glossary gains **Active Project** and **Project Rail**; **Project** is
  amended to note only one is Active at a time.
