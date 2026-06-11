---
name: implement-issue
description: Implement exactly one GitHub Issue inside a Sofa Worker container. Use when asked to implement a numbered issue in a freshly cloned repository.
---

# Implement one Issue

You are running inside a throwaway Sofa Worker container on a fresh clone of
the repository, already checked out on a dedicated branch. The harness around
you handles pushing the branch and opening the pull request.

## Rules

1. Implement exactly the one Issue you were given — nothing else. No drive-by
   refactors, no unrelated fixes.
2. Read the surrounding code first and match its style and vocabulary
   (check CONTEXT.md and docs/adr/ if present).
3. If the project has lint/test/build scripts, run them and make them pass
   before you finish.
4. Commit your work with a clear message that references the Issue number
   (e.g. "Add X to Y (#12)").
5. Do NOT push and do NOT open a pull request — the harness does that after
   you exit.
6. If the Issue cannot be implemented as written, stop without committing and
   explain why in your final message.
