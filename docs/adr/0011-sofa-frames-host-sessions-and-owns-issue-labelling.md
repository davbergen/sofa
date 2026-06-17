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

## How it is actually wired (corrects the original intent)

The first cut of this ADR described the `FileIssue`/`PrdDraft` tools as if they
existed, but only the *receiving* half shipped — the `canUseTool` interceptor,
the SSE draft events, the UI draft cards, and the `/file-issue` endpoint. The
tools themselves were never registered and never named in any prompt, so a real
Session had no `FileIssue`/`PrdDraft` tool to call: it fell back to
`gh issue create` and forgot `--label`, filing an unlabelled (undispatchable)
Issue while its narration claimed otherwise. Both tools shared this gap; PRD
just hid it because the field-notes→Issue path files server-side, not via the
agent. The realized mechanism closes it:

- **SDK-registered tools.** Sofa registers an in-process MCP server
  (`createSdkMcpServer({ name: 'sofa', … })`) exposing `FileIssue` (`{title,
  body}`) and `PrdDraft` (`{title, markdown}`), passed via the `query()`
  `mcpServers` option with `alwaysLoad: true` so the tools are never deferred
  behind tool-search. They surface to the model as `mcp__sofa__*`, which the
  existing interceptor's `__FileIssue` / `__PrdDraft` suffix match already
  catches. On `allow`, the tool handler returns a *steering* result — the draft
  was surfaced to David for review, Sofa will file/publish and apply the label
  on his confirmation, so do not `gh issue create`, do not re-call the tool, and
  do not claim it is filed (no fabricated issue number).
- **Posture names the tools.** `HOUSE_POSTURE` (loaded on every Session) now
  names both tools as the only path to file an Issue or surface a PRD, and
  forbids creating Issues/PRDs or editing labels directly.
- **Narrow deny guard (defence-in-depth).** This ADR rejected a *blunt*
  Edit/Write wall as too coarse, and that still holds. But the tool alone did
  not remove the `gh` bypass, so the posture is backed by a *narrow*
  `canUseTool` guard that denies `Bash` commands creating Issues
  (`gh issue create`, `gh api … POST …/issues`) and redirects the agent to
  `FileIssue`. It is pattern-matching a shell string, so it is defeatable
  (aliases, `sh -c`, the GitHub MCP) — it turns the common mislabel case from a
  silent failure into a visible redirect, not an airtight wall.
- **Regression coverage.** The original bug survived a green suite because every
  test drove the draft synthetically. Tests now assert the preconditions that
  make a real call possible: the `sofa` server registers both tools with
  `alwaysLoad`, the posture names them, the guard denies `gh issue create` while
  allowing `gh issue list`, and the handlers return the steering text.

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
