# Reunly design system

`tokens.css` holds every design value: colours, scales and the looks. The
stylesheets (`styles.css`, `prototypes/pub-crawl/crawl.css`) only use tokens,
and never define them. Load it first:

```html
<link rel="stylesheet" href="design-system/tokens.css" />
<link rel="stylesheet" href="styles.css" />
```

## Looks: attributes on `<html>`

| Attribute | Values | Set by |
|---|---|---|
| `data-theme` | `light` · `dark` | the person's toggle (light by default) |
| `data-look` | `ember` (default) · `deeper` | the visual direction |
| `data-lifecycle` | `gathering` · `deciding` · `locked` · `evening` · `after` | `applyPhase()` in app.js, from the event's state |

`evening` is for a one-day event, on the day. A trip that's under way uses the
`locked` palette, with "Day N of M" in the Now bar. In Ember, `evening` turns
the paper to warm ink in both themes. The pub crawl sets
`data-look="ember" data-lifecycle="evening"` permanently.

## Colour tokens (semantic, so always use these)

| Family | Tokens |
|---|---|
| Background | `--color-bg-page`, `-surface` (cards), `-subtle`, `-muted` (pressed, chips), `-glass` (dark look's translucent cards) |
| Text | `--color-fg-default`, `-muted`, `--color-fg-on-brand` |
| Border | `--color-border-default`, `-strong` |
| Brand | `--color-brand` (plum in Ember), `-subtle` (tinted fills), `-ink` (text on a tint), `--gradient-brand` |
| Feedback | `--color-success` / `-warning` / `-danger`, plus `--color-warning-bg`, `--color-danger-bg` |
| Deadline | `--gradient-deadline`, `--color-on-deadline`, `-muted`: the gold bar, the one dated thing on a screen |
| Phase (Deeper) | `--phase-a`, `--phase-b`, `--phase-ink`, `--phase-action`, `--phase-band` |

Green and amber keep their meanings: searched/settled and late/estimate. They
are never used for decoration.

## Scales

These are defined now and adopted component by component; see
"Next" below. They are `--space-1`…`--space-16` (4px base),
`--text-xs`…`--text-5xl`, `--font-regular`…`--font-bold`,
`--radius-sm`…`--radius-full`, `--duration-*`, `--transition-colors` /
`--transition-base`, and `--z-base`…`--z-tooltip`.

Role tokens name what a value is for, and will point at the scale:
`--radius-card`, `--radius-control`, `--shadow-card`, `--layout-max-w`,
`--layout-gap`. Layout also uses `--safe-*` (env() insets) and `--gutter-l/-r`.

Ember's two type styles are the eyebrow (`--eyebrow-size`,
`--eyebrow-tracking`: small tracked capitals) and the display headline
(`--display-weight` 300, `--display-tracking`: wide light capitals).

## Next (audit priorities 2–3)

1. Collapse the scales in the stylesheets: 47 font sizes become 9, 19 radii become 6, 19 shadows become 5, plus
   motion and z-index tokens.
2. Finish component states: disabled and loading buttons, field errors with
   `aria-invalid`, focus styles, and reduced motion everywhere. Replace the
   emoji labels with one icon set.
