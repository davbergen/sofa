# Worker setup

A Worker is a throwaway Docker container (ADR 0001) that fresh-clones one
GitHub repository, implements exactly one Issue with Claude Code, pushes a
branch, opens a pull request, and exits. No host volumes are ever mounted;
output leaves the container only as pushed branches and PRs.

## One-time token setup

The Worker needs two secrets, injected as environment variables at `docker run`.

### 1. Claude subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`)

Workers consume subscription quota, not metered API spend. On the host (any
machine where Claude Code is installed and logged in):

```
claude setup-token
```

Follow the browser flow and copy the long-lived OAuth token it prints
(`sk-ant-oat01-...`). Store it somewhere private; treat it like a password.

### 2. Repo-scoped GitHub token (`GITHUB_TOKEN`)

Create a fine-grained personal access token at
<https://github.com/settings/personal-access-tokens/new>:

- **Resource owner**: the owner of the target repository.
- **Repository access**: "Only select repositories" → the one Project repo.
- **Permissions** (Repository):
  - Contents: **Read and write** (clone + push)
  - Issues: **Read-only** (read the one Issue)
  - Pull requests: **Read and write** (open the PR)
  - Metadata: Read-only (added automatically)

Never use a classic PAT or a token with access to other repositories — the
whole point is that a misbehaving Worker can only touch one repo.

## Building the image

From the repository root (the Dockerfile compiles the harness from
`src/worker/` in a build stage):

```
docker build -f worker/Dockerfile -t sofa-worker .
```

## Running a Worker manually

```
docker run --rm \
  -e WORKER_REPO=owner/repo \
  -e WORKER_ISSUE=12 \
  -e GITHUB_TOKEN=github_pat_... \
  -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... \
  sofa-worker
```

Optional: `-e WORKER_BASE_BRANCH=develop` to target a non-default base branch.

The container works in `/work` (inside the container — no volume mounts),
implements Issue #12, pushes branch `issue-12-worker`, opens a PR titled after
the Issue, and exits. The last line on stdout is always one machine-readable
JSON object:

- success (exit code 0):
  `{"outcome":"succeeded","repo":"owner/repo","issue":12,"branch":"issue-12-worker","prUrl":"https://github.com/owner/repo/pull/34"}`
- failure (exit code 1):
  `{"outcome":"failed","reason":"git clone failed (exit 128): ..."}`

The GitHub token is redacted from all logs and failure reasons.

## Per-Project image override (`sofa.json`)

The generic `sofa-worker` image (Node toolchain) is the default for every
Project — typical Projects need zero configuration. A Project whose toolchain
the generic image cannot serve may place a `sofa.json` at its repo root:

```json
{
  "workerImage": "sofa-worker-rust"
}
```

When present, Sofa launches Workers for that Project with the named image
instead of the generic one. The image must follow the same contract as
`worker/Dockerfile` (env-var inputs, `[worker] ...` stderr phases, final JSON
outcome line) — typically it is built `FROM` the generic image with extra
toolchains layered on.

An invalid `sofa.json` — malformed JSON, a non-object document, or a
`workerImage` that is not a non-empty string — rejects dispatch with a clear
error rather than silently falling back to the generic image. A `workerImage`
naming an image that does not exist locally fails at `docker run` and surfaces
through the normal run-failure path.

## Tests

Harness logic is unit-tested with fakes in `tests/worker-harness.test.ts`
(part of `npm test`). An opt-in end-to-end run against a real scratch repo
lives in `tests/worker-e2e.test.ts` and is skipped by default:

```
$env:SOFA_WORKER_E2E = '1'
$env:WORKER_E2E_REPO = 'you/scratch-repo'   # a throwaway repo you own
$env:WORKER_E2E_ISSUE = '1'                 # an open issue in it
$env:GITHUB_TOKEN = 'github_pat_...'        # fine-grained PAT for that repo
npm test
```

It uses a scripted agent (no Claude quota) to exercise the real
clone → branch → push → PR pipeline, and leaves the branch and PR behind for
inspection. Delete the `issue-N-worker` branch in the scratch repo before
re-running.
