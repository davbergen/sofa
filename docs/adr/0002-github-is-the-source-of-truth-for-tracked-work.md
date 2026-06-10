# GitHub is the source of truth for tracked work

Sofa does not own an issue tracker. PRDs and Issues are published to the
Project's GitHub repository, and Workers deliver results as GitHub pull
requests. The existing skills (/to-prd, /to-issues, /work-work) already target
GitHub, issues link to PRs naturally, and work remains reviewable without Sofa
running. The accepted constraint: a Project using the full pipeline must be a
GitHub repository. Sofa's own SQLite store holds only operational state
(session history, Worker run records, usage stats) — never tracked work.

## Considered Options

- **Local markdown files in the repo** — works offline and for non-GitHub
  projects, but loses PR↔issue linkage and requires rewriting the skills.
- **Sofa-native tracker (SQLite)** — maximum UI flexibility, but Sofa would
  own a whole tracker and all skills would need rewiring.
