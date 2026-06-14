# Sofa

Sofa ("software factory") is a one-stop-shop for David's software development
workflow: grill → PRD → issues → autonomous implementation, wrapped in a UI.

## Language

**Sofa**:
The product itself: a local web app (server process + browser UI) that wraps
Claude Agent SDK sessions and presents the workflow as first-class UI.
_Avoid_: software factory (the concept, not the name)

**Project**:
A directory Sofa has opened, like an editor's "open folder". Sofa keeps no
central registry; multiple Projects can be open at once, but only one is the
Active Project shown in the main pane at any time. A Project using the full
pipeline must be a GitHub repository.
_Avoid_: workspace, repo (a Project is identified by its directory, not its remote)

**Active Project**:
The single open Project currently rendered in the main pane. Multiple Projects
stay open, but exactly one is Active and visible — Sofa never shows two Project
dashboards at once. Switching the Active Project never disturbs a live Session
in another Project: it keeps running on the host and is re-attached when its
Project is made Active again.
_Avoid_: selected/current project (use Active), focused (overloaded with DOM focus)

**Project Rail**:
The vertical list of open Projects down the left of the app. It marks which
Project is Active and shows a live indicator on any Project holding a running
Session, and is where Projects are opened and switched. It is chrome around the
Active Project, not a dashboard itself.
_Avoid_: sidebar, project list, nav

**Session**:
A single Claude conversation driven through the Claude Agent SDK, usually with
one skill loaded. Interactive (supervised) Sessions run on the host against
the real working copy; only Workers are containerized.
_Avoid_: chat, conversation

**Grilling Session**:
An interactive Session that interrogates David about a planned feature until
shared understanding is reached. The entry point of the workflow.
_Avoid_: interview, planning session

**PRD**:
The document produced from a Grilling Session, describing a feature to be
built. Published to the Project's GitHub issue tracker. Although it is filed
there, a PRD is not an Issue: it occupies a GitHub issue carrying the `prd`
label and never the `ready-for-agent` label, so it is never dispatchable to a
Worker.
_Avoid_: spec, plan

**Issue**:
A unit of implementable work, derived from a PRD or cut directly from a
self-contained Field Note Item. Lives on GitHub — GitHub is the source of truth
for all tracked work. Both PRDs and Issues physically live as GitHub issues;
the label is the boundary — an Issue carries `ready-for-agent`, a PRD carries
`prd`. A PRD is never an Issue.
_Avoid_: ticket, task

**Dispatchable Issue**:
An Issue eligible for a Worker to pick up *right now*: **open**, carrying
**`ready-for-agent`**, and with **no open PR** linked via the `issue-<n>-*`
branch convention (and the Project has no active Worker holding its single
slot). An Issue with an open PR stays visible in Ready Issues but is shown
with Dispatch disabled and a link to the live PR — never hidden — so it can't
be silently re-dispatched while review is in flight.
_Avoid_: ready (overloaded: the label name, not the live eligibility)

**Worker**:
An autonomous, containerized Session that implements exactly one Issue and
opens one pull request, then dies. Authenticates to Anthropic with a
subscription OAuth token and to GitHub with a repo-scoped token. Output leaves
the Worker only as pushed branches and pull requests.
_Avoid_: agent (overloaded), bot

**Ralph Loop**:
Sofa's dispatch cycle: launch a Worker while ready Issues exist and main is
clean, wait for the resulting PR to be reviewed and merged, repeat. The loop
lives in Sofa, not in the Worker.
_Avoid_: work loop, autopilot

**Field Notes**:
A plain-text note David captures in Sofa while testing a Project — by dragging
in a `.txt` or typing Items directly into the tool — listing changes he wants
made. The capture mechanism (drag or type) is incidental; what matters is that
it is unstructured raw input that *feeds* the pipeline,
upstream of the Grilling Session — the entry ramp to the workflow. Sofa
persists the parsed note and David's progress through it as operational state,
so he can act on one Item, leave, and return to the next. It is never tracked
work and never lives in GitHub (cf. ADR 0002).
_Avoid_: backlog, todo list, spec, PRD

**Field Note Item**:
A single actionable change in Field Notes — parsed from a dragged note or
appended one-at-a-time by typing into the tool. David acts on one Item
at a time, either escalating an unclear one into a Grilling Session or cutting
a self-contained one directly into an Issue; the Item then carries an acted
status and a link to whatever it spawned — the Grilling Session, or the Issue
it became — so returning later shows what is left to do.
_Avoid_: issue (an Item only becomes an Issue once cut), task

**Process Notes**:
An advisory, one-shot triage run over a Project's unacted Field Note Items. It
classifies each Item and attaches a Recommendation, then ends — it files
nothing, spawns no Grilling Session, and produces no tracked work. Its only
output is annotations on Items, so David sees at a glance which existing per-Item
action to take. It runs Claude on the host headlessly (no Session Terminal) and
shares the single host-run slot with interactive Sessions: only one host agent
runs at a time. Re-running re-classifies the currently-unacted Items.
_Avoid_: triage (the skill/role, not this action), processing (vague), notes-to-issues (that skill files; Process Notes never does)

**Recommendation**:
The verdict Process Notes attaches to a Field Note Item: either **Grill** (the
Item hides unresolved design and should be escalated to a Grilling Session) or
**Cut** (the Item is self-contained and can be filed directly as an Issue), with
a one-line rationale. It mirrors the Item's two existing actions rather than
introducing a parallel vocabulary, and is purely advisory — David may take
either action regardless, and acting on an Item supersedes its Recommendation.
Defaults to Grill when the call is uncertain.
_Avoid_: verdict, classification, label (overloaded with GitHub labels), refine/implement (say Grill/Cut)
