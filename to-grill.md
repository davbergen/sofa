# To grill

Run `grill-with-docs` on each of these — they carry unresolved design that needs a session before they can become issues.

## Browse button to select a Project directory

> 1. need a button for selecting the project in file explorer

**Unresolved:** A browser UI cannot obtain a native host filesystem path. How does the "Browse" button get an absolute directory path to the local server — a server-side directory-browser endpoint, or a native folder-picker bridge? This bumps the browser↔host boundary and is ADR-worthy.

## Quick "Start a new Session" entry point that initiates grilling

> 3. I want to have quick options "Start a new Session" --> initiates grilling.

**Unresolved:** A Grilling Session needs a prompt (Start Session is disabled without one), so "initiate grilling" with one click isn't fully defined. What exactly does the quick action do — preselect the grill skill and focus the prompt, or a distinct grilling entry flow — and which grilling skill (`grill-with-docs` vs `grill-me`)?

## Filter PRDs out of Ready Issues

> 4. PRDs can't be dispatched, should be filtered out from the Ready Issues

**Unresolved:** Ready Issues lists open issues carrying the `ready-for-agent` label. There is no defined signal distinguishing a PRD-issue from a dispatchable Issue. Does `to-prd` apply/omit a label, and is the fix to exclude a `prd`-style label or to stop labelling PRDs as ready? Decision in disguise about the PRD↔Issue boundary on GitHub.

## Fancy progress bar + richer Worker status

> 6. A distinct and fancy-looking progress bar when the worker runs would be nice. More reports of current status.

**Unresolved:** Vague visual design plus an unclear data source. Which discrete stages should the progress bar show (the existing `cloning`/`working`/`pushing`/`pr_open` phases, or finer-grained), and do the richer status reports come from the existing phase events or from new Worker instrumentation?

## An Issue already on a PR should not be dispatchable

> 8. When an Issue is on PR after a worker has worked on it, it shouldn't be "dispatchable"

**Unresolved:** How is "this Issue already has an open PR" detected — from the local Worker run record, or by querying GitHub for PRs linked to the Issue — and should such an Issue be hidden from Ready Issues or shown disabled? Shares its root with note 11 (Sofa never re-syncs GitHub PR state after dispatch).

## Grilling Sessions with container + full tool access, cloning the repo on project load

> 10. In grill-mode the session does not have access to tool usage, should also run in a container with full access - should probably clone the repo when loading the project (for the session worker)

**Unresolved:** Directly contradicts ADR 0001 (only Workers are containerized) and ADR 0006 (interactive Sessions run on the host against the real working copy). This is an ADR reversal, not a fix: should interactive Sessions gain tool access on the host, or move into containers with fresh clones — and what happens to the no-host-volume isolation guarantee?

## Worker run status goes stale after the PR merges

> 11. Worker runs status is stale, shows PR is open even though it is already merged

**Unresolved:** `pr_open` is a terminal run state that is never re-synced with GitHub. How and when does Sofa learn a PR has merged — polling, an on-demand refresh control, or a webhook — to advance the run record past `pr_open`? Shares its root with note 8.
