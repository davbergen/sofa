# UI theming uses a CSS stylesheet with design tokens, not inline styles

The Sofa UI was originally styled entirely with React inline `style={{}}`
objects and no CSS file. To implement the "Cozy Workshop" visual direction we
adopted a single stylesheet (`src/ui/cozy.css`, imported from `main.tsx`) built
on CSS custom-property tokens (`--bg`, `--cush`, `--tan`, `--sage`, `--rose`,
…) and `.cz-*` classes, and converted the components from inline styles to
`className`. The deciding factor is technical, not just preference: the design's
signature details — stitched dashed-seam borders (`::before`), gradient fills,
and `:hover` states — **cannot be expressed with inline styles at all**, because
inline styles support neither pseudo-elements nor pseudo-classes. Tokens
additionally make the palette themeable and shared across every screen.

## Considered Options

- **Keep inline styles, extract a JS theme object** — smallest structural
  change, but physically cannot render the seams, gradients, or hover that
  define the look; the design would be approximate only.
- **Inject the mockup's `<style>` block verbatim** — fastest path to the exact
  pixels, but the styles live in a JS string instead of a real `.css` file and
  the class names stay mockup-specific.

## Consequences

The whole UI converts to `className`; reverting to inline styling would now be
real work. New UI is expected to use the existing tokens rather than hardcoding
colors inline.

## Note: the dashed-seam motif was retired (2026-06)

The "Inline Session Terminal" overhaul re-toned the token palette to a darker
set and **retired the signature stitched dashed-seam border** (`.cz-cush::before`)
in favour of solid `1px` borders plus gradient accent bars (`.cz-accent`). The
stylesheet-over-inline architecture decided here is **unchanged** — only the
token values and that one decorative motif changed. The dashed border survives
only where it is a functional affordance (the Field Notes drop zone and the
empty-state ring). Terminal-surface tokens (`--term-bg`, `--term-screen`,
`--statusline-bg`, tag colours, …) were added to the same single token set; no
parallel theme was introduced.
