# Sofa frames host Sessions with a house posture and owns Issue labelling

Sofa injects a short *house-posture* system prompt (`appendSystemPrompt`) into
every host Session at `src/server/sdk-agent.ts`, so a Session's default job is to
**grill, refine, and file well-specified Issues — not implement**; it writes code
only on an explicit, deliberate instruction. Implementation stays the Worker's
job. Separately, Sofa **owns Issue-label application** via a structured
`FileIssue` tool (intercepted in `canUseTool`, mirroring `PrdDraft`) rather than
leaving `gh issue create --label` to the agent's memory.

## Why

Today a host Session gets *no* system prompt beyond the optional skill, so a
skill-less Session is bone-stock Claude — an eager implementer. And label
application rode on the agent remembering a `--label` flag, which it forgot,
filing an unlabelled (thus undispatchable) Issue. Both are the same gap: Sofa
injected no house-level steering into the agent. A local Claude Code session, by
contrast, carries the user's `~/.claude` setup plus the repo's `CLAUDE.md`; a
Sofa Session had neither layer.

## Considered Options

- **Hard `canUseTool` wall** — deny `Edit`/`Write` for host Sessions so
  implementation is impossible by construction. Rejected: too blunt — it fights
  legitimate doc edits, and the grilling workflow itself writes `CONTEXT.md` and
  ADRs. The posture is a *default*, not a capability removal; the wall stays
  soft and prompt-level.
- **Instruct-only labelling** — the house prompt tells the agent to pass
  `--label ready-for-agent`. Rejected: relies on the exact model compliance that
  already failed. Moving label ownership into Sofa makes the label impossible to
  forget.

## Consequences

- House posture is Sofa-level (it applies to every Project Sofa opens), distinct
  from per-repo `CLAUDE.md`, which carries project conventions and is read by
  both host Sessions and containerized Workers. The Sofa repo currently has **no
  `CLAUDE.md`** — one must be created to carry the Cozy Workshop design-system
  conventions (ADR-0003) so Workers stop hand-rolling off-theme UI.
- A new `FileIssue` tool surfaces a draft for human confirmation (like
  `PrdDraft`); Sofa applies `ready-for-agent`. Its own UI surface (the draft
  card) is undecided, so by the rule below it is not itself `ready-for-agent`
  until that design is grilled.
- The house posture encodes a **self-containment bar**: a Session may cut to
  `ready-for-agent` only when a Worker could finish with no further design
  decisions from David — any unresolved UI/visual design makes it not
  self-contained, and it must be grilled (or filed as a PRD) instead. See
  `CONTEXT.md` (Session, Issue).
- The Worker prompt (`src/worker/harness.ts`) gains one line pointing at repo
  conventions, as belt-and-suspenders over the auto-loaded `CLAUDE.md`.
