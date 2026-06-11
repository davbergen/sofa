# Sofa Worker image (ADR 0001): a throwaway container that fresh-clones one
# repository, implements one Issue, opens one PR, and exits. Build from the
# repository root:
#
#   docker build -f worker/Dockerfile -t sofa-worker .

# --- Stage 1: compile the harness with the repo's own toolchain -------------
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.worker.json ./
RUN npm ci --ignore-scripts
COPY src/worker ./src/worker
RUN npx tsc -p tsconfig.worker.json

# --- Stage 2: runtime with the full Worker toolchain -------------------------
FROM node:22-bookworm-slim

# git + gh + common tools the agent relies on.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates jq ripgrep \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (the Worker authenticates via CLAUDE_CODE_OAUTH_TOKEN).
RUN npm install -g @anthropic-ai/claude-code

# Unprivileged user; skills are baked into its home, never host-mounted.
RUN useradd -m worker && mkdir -p /work && chown worker:worker /work
COPY --chown=worker:worker worker/skills /home/worker/.claude/skills
COPY --from=build /build/dist/worker /opt/sofa-worker
USER worker
ENV WORKER_WORKDIR=/work

# Contract (see docs/worker-setup.md):
#   WORKER_REPO, WORKER_ISSUE, GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
# Exits 0 with {"outcome":"succeeded",...} or nonzero with {"outcome":"failed","reason":...}.
ENTRYPOINT ["node", "/opt/sofa-worker/index.js"]
