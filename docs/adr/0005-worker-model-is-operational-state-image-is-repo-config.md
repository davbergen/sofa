# Worker model is operational state; Worker image is repo config

A Worker's Claude model is chosen per Project and stored in Sofa's SQLite store
(a nullable `worker_model` on `open_projects`), edited from the dashboard UI. The
Worker container image, by contrast, stays in the Project's committed `sofa.json`
(`workerImage`). Two settings that both shape a Worker dispatch, deliberately
kept in two different homes.

The split is along the line of *what the setting belongs to*. The image is part
of the repo's build identity: it declares the toolchain a Project needs, is the
same for everyone who dispatches Workers against that repo, and is meaningfully
versioned alongside the code — so it belongs in the repo, committed and shared
(cf. ADR 0002, GitHub as the source of truth for the Project). The model is
David's private operational dial: which Claude runs the implementation is a
moment-to-moment cost/quality preference, specific to his machine and his quota,
with no claim to be shared with collaborators or pinned in git history. That is
the same class of operational state as Field Notes progress and Worker run
records (cf. ADR 0004), and SQLite is its established home.

Keeping the model out of `sofa.json` also avoids handing Sofa a writer for a
committed repo file: a UI dropdown that mutated tracked content on every change
would generate git noise and blur the boundary the image deliberately sits on.

## Considered Options

- **Both in `sofa.json`, with a new Sofa writer** — one home, single source of
  truth, but it makes Sofa mutate committed files from a UI control and drags an
  operational preference into the repo's shared, versioned config.
- **Both in the SQLite store** — one home and uniformly UI-editable, but it
  migrates the image out of the repo, where its toolchain-identity role and its
  value to collaborators genuinely belong. We would be moving the wrong setting
  to match the new one.

## Consequences

- New columns on `open_projects` — `worker_model` and `session_model`. Both are
  per-machine operational preferences, so by the rule above both land in the
  store, not `sofa.json`; Sessions have no repo-config analog (there is no
  "session image"), so the boundary tension is unique to the Worker side. Per
  the repo convention, migrations are positional/count-based — append the new
  entry at the end of the list in `src/server/db.ts`, never reorder.
- Worker and Session models are kept as separate dials, not one shared value:
  an autonomous Worker grinding through Issues and an interactive grilling
  Session are different workloads with different cost/quality sweet spots.
- Two config homes for Worker dispatch settings, and a rule for which is which:
  anything that is part of the repo's shared build identity goes in `sofa.json`;
  anything that is David's per-machine operational preference goes in the store.
  Future Worker settings get sorted by that test.
- Each model rides its own dispatch path. The Worker model reads `worker_model`,
  passes through `StartWorkerOptions.model` and a `WORKER_MODEL` container env
  var, and the Worker entrypoint appends `--model <value>` to its `claude`
  invocation. The Session model reads `session_model`, passes through
  `AgentRunInput.model`, and is spread into the Agent SDK's `query()` options —
  no container, so two hops instead of five. A NULL/unset model omits the flag
  in both cases, so the default model stands. Changing a setting affects only
  future dispatches; in-flight Workers and running Sessions keep the model they
  launched with.
- An invalid `sofa.json` is still a hard dispatch error (no silent fallback);
  the model, constrained to a curated alias dropdown in the UI, cannot reach the
  store as a malformed value in the first place.
