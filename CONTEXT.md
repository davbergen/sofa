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
central registry; multiple Projects can be open at once. A Project using the
full pipeline must be a GitHub repository.
_Avoid_: workspace, repo (a Project is identified by its directory, not its remote)

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
A plain-text note David drags into Sofa while testing a Project, listing
changes he wants made. Unstructured raw input that *feeds* the pipeline,
upstream of the Grilling Session — the entry ramp to the workflow. Sofa
persists the parsed note and David's progress through it as operational state,
so he can act on one Item, leave, and return to the next. It is never tracked
work and never lives in GitHub (cf. ADR 0002).
_Avoid_: backlog, todo list, spec, PRD

**Field Note Item**:
A single actionable change parsed out of Field Notes. David acts on one Item
at a time, either escalating an unclear one into a Grilling Session or cutting
a self-contained one directly into an Issue; the Item then carries an acted
status and a link to whatever it spawned — the Grilling Session, or the Issue
it became — so returning later shows what is left to do.
_Avoid_: issue (an Item only becomes an Issue once cut), task
