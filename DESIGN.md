# Design

> Maintained with frontend-god-mode. Source of truth for the docs site's typography, color,
> motion, layout and component tokens (`site/`). Read before touching the UI.

## Aesthetic direction

Editorial technical manual: warm flour-paper Stone neutrals, a single crust-terracotta accent,
serif display headings over a precise grotesk and mono, graph-paper texture in the hero, restrained
motion.

## Dials

- DESIGN_VARIANCE: 8 / 10 (asymmetric hero, rotated backdrop behind the code window, bento)
- MOTION_INTENSITY: 6 / 10 (staggered rises, scroll-spy, one perpetual pipeline sweep)
- VISUAL_DENSITY: 4 / 10 (docs body at 68ch, generous section spacing)

## Type stack

- Display: Instrument Serif 400 (+ italic) for h1 and section h2 on the landing page and page titles
- Text: Geist Variable (headings inside prose are Geist 620, tracking -0.018em)
- Mono: Geist Mono Variable (code, eyebrows, kickers, nav section labels, package names)
- Loaded via self-hosted @fontsource packages imported in `site/src/app.css` (no third-party
  requests)
- Body 16px / 1.7; prose paragraphs capped at 68ch

Banned: Inter, Roboto, Arial, system-ui as primary; gradient text; serif in body copy.

## Color tokens (OKLCH, `site/src/app.css`)

Light: `--bg 0.985 0.006 75`, `--fg 0.21 0.012 55`, `--fg-soft 0.37`, `--fg-muted 0.5`,
`--border 0.9 0.008 65`, `--accent 0.53 0.135 38` (terracotta; button text on it is AA), `--accent-ink 0.47 0.13 36` (links,
AA on bg), `--accent-soft 0.94 0.032 52`.
Dark: `--bg 0.17 0.008 55`, `--fg 0.94 0.008 75`, `--accent 0.7 0.135 42`, `--accent-ink 0.77 0.12 46`.
Status (callouts only): note 245, tip 155, important = accent, warning 72, caution 18.
Theme: system preference, overridable by the header toggle (`data-theme`, localStorage
`knead-theme`, applied pre-paint in `app.html`).

Banned: pure #000/#fff, purple-blue gradients, more than one accent, side-tab borders on callouts.

## Shadows

`--shadow-lift` and `--shadow-pop`, tinted toward hue 45. Never untinted black.

## Radii

8px (controls), 12px (code, tables, callouts), 22px (cards, windows, pager), 999px (buttons, chips).

## Motion

- Easing: `--ease-out` cubic-bezier(0.16, 1, 0.3, 1) for everything interactive; no bounce.
- Page enter: 10px rise + fade, 0.5s. Hero children staggered 60ms. Search rows staggered 22ms.
- Theme switch: View Transitions crossfade, 0.35s, skipped under reduced motion.
- Skeleton shimmer: a translating highlight (transform), never `background-position`.
- Perpetual: one accent sweep along the pipeline strip (linear, 6s), hidden on narrow screens.
- Only transform/opacity animate. `prefers-reduced-motion` collapses all durations.

## Layout

- Header 3.75rem, sticky, blurred. Docs: 17rem sidebar | content max 48rem | 13.5rem TOC
  (hidden < 1240px, replaced by a collapsible "On this page" panel under the page header).
  Sidebar becomes a modal drawer < 960px: focus moves to the current page link, the page behind
  is `inert`, Esc returns focus to the menu button.
- Landing content edges align: the hero grid is 77rem, the same as a band's 80rem minus its padding.
- Landing: 5/6 split hero with a tabbed code window (real snippets) on a rotated accent backdrop;
  numbered bands (01 pipeline, 02 defaults bento 4+2 / 2+4, 03 packages as divide-y lists in three
  groups); sunken footer CTA.

## Components

- `Icon.svelte`: renders a Font Awesome Free `IconDefinition` (decorative, aria-hidden).
  Build-time HTML uses `src/lib/server/icons.ts`. Attribution (CC BY 4.0) in the landing footer.
- Code blocks: header bar (file title or language label) + copy button with icon swap.
- Callouts: tinted panel, icon + uppercase label, no left bar.
- Search: dialog with skeleton loading, empty, error-with-retry states; ⌘/Ctrl+K and `/`. The
  input draws no outline; the field shows keyboard focus with an accent underline.
- Touch (coarse pointer): every control reaches 44px (icon buttons, copy, chips, Esc, retry).
- TOC: IntersectionObserver scroll spy, active marker scales in.

## Last updated

2026-10-17: initial design system for the docs site.
2026-10-17: polish pass: hero/band alignment, inline contents panel on narrow screens, modal
drawer focus handling, theme crossfade, transform-only skeleton shimmer, touch targets.
