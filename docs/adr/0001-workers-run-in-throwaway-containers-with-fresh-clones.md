# Workers run in throwaway containers with fresh clones

Ralph Loops run unsupervised, so a Worker must not be able to damage the host.
Each Worker is a Docker container holding Node, the Claude Agent SDK, git, and
two injected secrets (a Claude subscription OAuth token and a repo-scoped
GitHub token). It clones the Project's repository fresh from GitHub, works,
and its output leaves only as pushed branches and pull requests — no host
volumes are mounted.

## Considered Options

- **Mount the host working copy into the container** — results would appear
  locally instantly, but the agent could trash the working copy, defeating the
  point of isolation.
- **Run the SDK on the host and sandbox only tool execution** — finer-grained,
  but requires Windows↔Linux path mapping and file writes still land on the
  host.

## Consequences

- Results never appear in the local working copy directly; they arrive as PRs
  to review and pull.
- A Worker is fully disposable — kill the container and nothing is lost except
  in-flight work.
- Workers consume subscription quota (OAuth token), not metered API spend.
