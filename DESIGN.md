# GMRec design system

Register: **product**. The user is mid-call; the interface serves the task and gets out of the way.
Rationale for the palette is in [PRODUCT.md](PRODUCT.md); this file is the reference for building.

## Tokens

Defined in `src/styles.css` on `:root`, overridden under `:root[data-theme="dark"]`. The injected
overlays keep their own copy of the dark set in `OVERLAY_CSS` (`src/content.ts`), because a shadow
root cannot inherit the popup stylesheet.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `oklch(0.995 0.002 245)` | `oklch(0.165 0.013 245)` | Page ground |
| `--surface` | `oklch(0.965 0.005 245)` | `oklch(0.215 0.015 245)` | Panels, disabled buttons |
| `--raised` | `oklch(1 0 0)` | `oklch(0.265 0.017 245)` | Inputs, buttons, thumbs |
| `--line` | `oklch(0.9 0.008 245)` | `oklch(0.33 0.018 245)` | Borders, separators |
| `--ink` | `oklch(0.24 0.022 245)` | `oklch(0.97 0.004 245)` | Body text |
| `--ink-muted` | `oklch(0.5 0.02 245)` | `oklch(0.76 0.013 245)` | Secondary text, meta |
| `--accent` | `oklch(0.53 0.09 200)` | `oklch(0.8 0.125 195)` | Interaction, focus, selection |
| `--accent-ink` | `oklch(1 0 0)` | `oklch(0.2 0.035 220)` | Text on accent |
| `--tally` | `oklch(0.54 0.205 25)` | `oklch(0.64 0.215 25)` | **Live recording only** |
| `--danger` | `oklch(0.54 0.205 25)` | `oklch(0.57 0.2 25)` | Stop, destructive |
| `--paused` | `oklch(0.545 0.1 70)` | `oklch(0.8 0.145 75)` | Paused state |

Neutrals are tinted `0.013–0.022` chroma toward the accent's own hue (245), not toward warmth.

### Colour rules

1. **Red is reserved** for the recording tally and stop. Never a non-stop button, never decoration.
   Meet's hang-up control is a red pill at the bottom of the same screen.
2. **Blue is unavailable.** It reads as Meet's own UI.
3. Accent carries every interactive affordance, focus ring, and selected state — not decoration.

### Verified contrast

Every pair was computed (OKLCH → sRGB → WCAG) before shipping; all 22 meet AA. Tightest margins:

| Pair | Ratio | Needs |
|---|---|---|
| light: accent text on surface | 4.58 | 4.5 |
| light: paused text on surface | 4.57 | 4.5 |
| light: white on accent button | 5.06 | 4.5 |
| dark: white on danger button | 4.53 | 4.5 |
| dark: tally dot on raised (graphic) | 4.10 | 3.0 |

A red tally dot on the cyan accent measures **2.10:1**, so the idle Record button is a neutral pill
with an accent border and a red dot, not an accent fill. Re-verify if any of these values move.

## Type

One family: `system-ui` stack. No web font — an extension should not fetch one, and the product
register does not need display/body pairing. Fixed rem scale, ratio ≈1.15:
`--step--2` 11px · `--step--1` 12px · `--step-0` 13px · `--step-1` 15px · `--step-3` 24px.
Timers and file sizes use `font-variant-numeric: tabular-nums` so digits do not jitter.

## Motion

`--fast` 140ms, `--base` 200ms, `--ease` `cubic-bezier(0.22, 0.61, 0.36, 1)`. Motion conveys state
only: hover, focus, check, switch, disclosure, and the 2s tally pulse. Every animation is disabled
under `prefers-reduced-motion`. Transitions are suppressed for the first paint (`.no-transitions`)
so opening the popup in dark mode does not animate up from the light palette.

## Components

- Buttons expose default, hover, active, disabled, and focus. **Disabled drops its colour fill**
  and goes neutral, rather than fading accent or danger to a muddy version of a live control.
- Focus is a 2px accent outline at 2px offset, on every interactive element including the custom
  select, checkbox, and switch (the native control stays for semantics and keyboard).
- Icons are inline SVG, one family, 1.75 stroke. No emoji and no text glyphs as icons.
- Empty states teach ("No videos detected yet. Open the Meet tab and make sure at least one
  person's camera is on."), rather than saying nothing is here.
- Rows that carry a control are ≥44px tall.

## Layout

Single continuous panels separated by hairlines, not stacked cards. Numbered step badges and the
uppercase section eyebrow were removed: the popup is three settings groups, not a sequence.
`z-index` comes from the semantic scale (`--z-dropdown`, `--z-sticky`), never a raw value.

### Popup shell

Fixed `560px` height so switching tabs never resizes the popup under the pointer. Three regions:

1. **Persistent head** — app bar, status, live recording state, warnings.
2. **Tabs + scroll region** — Record / Setup / Files. Only this middle band scrolls.
3. **Persistent footer** — Start / Stop.

The live state and Start/Stop sit *outside* the tabs deliberately: stop must never be hidden
behind a tab while a recording is running. Tabs follow the ARIA tablist pattern (roving
`tabindex`, Arrow Left/Right) and the chosen tab is remembered across opens.

### Scrollbars

Styled with the `-webkit-scrollbar` pseudo-elements and **not** `scrollbar-color`. Two reasons,
both verified rather than assumed: setting the standard property makes Chrome ignore the
pseudo-element rules entirely, and `scrollbar-color` only shipped in Chrome 121 while the manifest
supports 120. The pseudo-elements also allow a rounded thumb inset by a transparent border, which
`scrollbar-color` cannot express. The thumb uses its own `--scroll-thumb` token because `--line`
is too faint to read as grabbable on near-white.

Note that Chrome builds using *overlay* scrollbars ignore these rules and draw their own; that is
a platform choice, not a bug, and the layout does not depend on the scrollbar reserving width.

## Injected surfaces

Dark only, by intent: they sit on a dark call and a light panel glares mid-conversation.

| Surface | Anchor | Why |
|---|---|---|
| Control bar | bottom-right | Meet's own toolbar owns bottom-centre |
| Preview stack | top-right | Out of the way of both |
| Share prompt | top-left | Cannot collide with the preview stack on a narrow window |

Both the bar and the preview stack are draggable by their grip and remember their position.
