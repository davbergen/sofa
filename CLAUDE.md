# Sofa — project conventions

Short, convention-only guide for agents working in this repo. Deep context lives elsewhere:

- Domain glossary: `CONTEXT.md`
- Decisions: `docs/adr/`

## UI styling — Cozy Workshop

All UI uses the **Cozy Workshop** design tokens defined in `src/ui/cozy.css` (CSS
custom properties — `--cush`, `--cush2`, `--tan`, `--tx`, `--line`, `--term-bg`, etc.).
See ADR-0003 for why these are tokens in a stylesheet rather than inline styles.

- Never hand-roll raw hex colors in components. Pull from the tokens.
- Don't invent new styling where a token or an existing component pattern already covers it.
  Match the look and structure of the existing components in `src/ui/` (e.g. `ProjectDashboard.tsx`).
- New surfaces extend the token set in `cozy.css` rather than forking a parallel theme.

## Gates

This repo has **no CI**. The gate is local — all three must pass before opening a PR:

```sh
npm run lint     # eslint + tsc --noEmit
npm test         # Vitest unit suite
npm run build
```

A red gate blocks the PR. The `automerge` workflow re-runs the same checks on merge.
