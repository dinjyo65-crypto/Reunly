---
name: Reunly
description: Warm paper, one plum accent, and gold reserved for the single dated thing on a screen.
colors:
  bg-page: "#f7f3ec"
  bg-surface: "#fffdf9"
  bg-subtle: "#fffdf9"
  bg-muted: "#f1ebe0"
  border-default: "#e6ded0"
  border-strong: "#dbd1c0"
  fg-default: "#1c1a17"
  fg-muted: "#6e6761"
  fg-on-brand: "#ffffff"
  brand: "#a8185f"
  brand-ink: "#8e1250"
  brand-subtle: "#fbebf2"
  success: "#3f6b52"
  warning: "#8a5a12"
  danger: "#b3243c"
  highlight: "#fcd34d"
  hero-bg: "#120e1a"
  on-photo: "#fffdf9"
  on-photo-muted: "#d9cfc4"
  on-deadline: "#fff9eb"
typography:
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 300
    lineHeight: 1.1
    letterSpacing: "0.04em"
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 300
    lineHeight: 1.16
    letterSpacing: "0.015em"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 720
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.5
  eyebrow:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.22em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
  control: "12px"
  card: "16px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  12: "48px"
  16: "64px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.fg-on-brand}"
    rounded: "{rounded.control}"
    padding: "16px 16px"
    typography: "{typography.body}"
  button-secondary:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg-default}"
    rounded: "{rounded.control}"
    padding: "16px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.brand}"
    rounded: "{rounded.control}"
    padding: "16px 16px"
  button-sm:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.fg-on-brand}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "38px"
  nowbar-action:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.fg-on-brand}"
    rounded: "{rounded.lg}"
    height: "46px"
  card:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg-default}"
    rounded: "{rounded.card}"
    padding: "16px"
  input:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg-default}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.brand-subtle}"
    textColor: "{colors.brand}"
    rounded: "{rounded.full}"
    padding: "4px 8px"
    typography: "{typography.eyebrow}"
  chip-toggle:
    backgroundColor: "{colors.bg-muted}"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.full}"
    padding: "8px 12px"
  chip-toggle-on:
    backgroundColor: "{colors.brand-subtle}"
    textColor: "{colors.brand}"
    rounded: "{rounded.full}"
    padding: "8px 12px"
  phase-tab:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.lg}"
    padding: "8px 8px"
  phase-tab-active:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.fg-on-brand}"
    rounded: "{rounded.lg}"
    padding: "8px 8px"
  modal-card:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg-default}"
    rounded: "{rounded.2xl}"
    padding: "20px"
    width: "400px"
---

# Design System: Reunly

## Overview

**Creative North Star: "The Concierge's Folder"**

Reunly looks like something that was already handled. Not a tool you operate, but
a folder someone competent prepared and passed across a desk: warm paper stock,
ink-dark type, the details already arranged. Nothing in it is trying to get your
attention, because the work is done and the plan is the thing worth looking at.

That reading drives every material decision. The ground is warm ivory (#f7f3ec)
rather than white, so photographs sit down on it instead of glowing off it and a
single accent reads as deliberate rather than lonely. Cards are flat paper with a
warm hairline and no shadow. Headlines are set in wide, light capitals — weight
300, open tracking — so the character comes from the typesetting rather than from
colour or weight. The one plum accent (#a8185f) is spent on about five things per
screen: the action, the active tab, the live dot, a link, an alert. Colour at
volume belongs to the destination photographs, which is the only place the app
has anything genuinely worth looking at.

The feel in one phrase is **warm and handled** — prepared by a person, not
generated by software. That rules out the admin-tool register (dense grey
chrome, aggressive dividers, utilitarian density) and equally rules out the
consumer-app register (bright gradients everywhere, bouncing confetti, emoji as
interface). The incumbent world this replaced — dark glassmorphism with an
indigo-to-pink gradient on every surface and an animated aurora behind the page
— is a confirmed anti-reference. Its tokens still exist under `data-look="deeper"`
as a parked exploration; it is not a second supported world and new work owes it
nothing.

**Key Characteristics:**

- Warm ivory paper, never white; ink type, never grey-on-grey.
- One accent, spent rarely. Photographs carry the colour.
- Gold means exactly one thing: a date you have to act on.
- Wide light capitals for names and headlines; small tracked capitals for labels.
- Flat surfaces with hairlines. Depth comes from the ground/surface step, not shadow.
- No emoji in the interface. One stroke icon set that takes the text colour.

## Colors

A warm paper palette with one plum voice, two reserved signal colours, and gold
held back for a single purpose.

### Primary

- **Plum** (#a8185f): the accent, and the only one. It carries the primary action,
  the active lifecycle tab, links, the notification dot and focus rings. At 6.4:1
  on the ground it is legible as text as well as as a fill, and white on it clears
  7.1:1. Its scarcity is the point — see The One Voice Rule.
- **Plum Ink** (#8e1250): plum darkened for text sitting on a plum tint, where the
  base accent would be too light to read.
- **Plum Tint** (#fbebf2): the fill behind a selected chip, an active badge, the
  hero eyebrow. Never used as a page or card ground.

### Neutral

- **Warm Paper** (#f7f3ec): the page ground. Warm rather than white so photographs
  recede into it and the hairlines read as edges rather than lines.
- **Card Ivory** (#fffdf9): every card, panel, modal and input. A single step up
  from the ground — that step, not a shadow, is what makes a card a card.
- **Pressed Linen** (#f1ebe0): pressed states, chips at rest, inset tiles.
- **Warm Hairline** (#e6ded0) and **Warm Rule** (#dbd1c0): the default border and
  its emphasised sibling. Both are warm, never neutral grey.
- **Ink** (#1c1a17): all body copy, headlines and numbers. Near-black with warmth
  in it, so it belongs to the paper rather than sitting on top of it.
- **Muted Ink** (#6e6761): secondary text, captions, label text. 5.0:1 on the
  ground — chosen to clear AA at small sizes, not by eye. It has little headroom:
  anything lighter fails.

### Feedback

- **Moss** (#3f6b52): a fare that was genuinely searched; a debt that is settled.
- **Ochre** (#8a5a12): an estimate; something running late; a figure not to trust
  as fact.
- **Claret** (#b3243c): a destructive action, a validation failure, someone who
  has not checked in.
- **Deadline Gold** (`linear-gradient(100deg, #44350f, #7d5c15 46%, #523f10)` with
  #fff9eb title and #f3e3c2 sub): the dated bar — book by, square up by.
  Burnished rather than bright, because the text sits directly on it: the ramp
  clears 5.9:1 and 4.9:1 at its lightest point.
- **Winner's Gold** (`--gradient-winner`, `linear-gradient(90deg, #f9dc5c,
  #e3b505)`, with `--color-winner-subtle` for the rank badge): the cap and badge
  on a first-placed recommendation. Bright where the deadline is burnished — the
  two are deliberately opposite ends of the same metal, so a first place never
  reads as a deadline. It sits at hue ~48 against the warning amber's 36–43, far
  enough that winning never reads as an estimate.

  *Dormant: nothing currently applies `.rec-card`, so this renders nowhere — the
  live winner is `#winnerHero` and the runners-up are compact rows. The token
  exists so a gold first-place mark can return without reintroducing a hardcoded
  amber.*

### On Photography

- **Hero Ink** (#120e1a) with **Paper White** (#fffdf9) and **Dimmed Paper**
  (#d9cfc4) over it. These are fixed across every look and theme, because a
  photograph's scrim cannot inherit the page's ground without going muddy.

### Named Rules

**The One Voice Rule.** Plum appears on roughly five elements per screen: the
primary action, the active tab, a link, the live dot, one badge. If a sixth wants
it, something else loses it. Spread thin, it stops reading as emphasis at all.

**The Two Golds Rule.** Gold has exactly two jobs: burnished gold marks the one
dated obligation on a screen, and bright gold marks first place in a ranking.
Nothing else is gold — not Pro, not a highlight, not a "premium" flourish. The two
never swap, and they must stay tellable apart from each other and from the warning
amber: the winner's ramp holds hue ~48 against warning's 36–43, and the deadline
ramp is dark enough that neither could be mistaken for it.

**The Reserved Signal Rule.** Moss and ochre mean searched and estimated, settled
and late. They are never borrowed for emphasis, category colour or mood. A user
who learns what green means must not then meet a green that means nothing.

**The Warm Neutral Rule.** No neutral in this system is actually neutral. Every
ground, border and ink carries warmth. A pure grey (#888, #e5e5e5) dropped into a
card reads as a bug, not a choice.

## Typography

**Family:** the system stack throughout — `system-ui, -apple-system, "Segoe UI",
Roboto, sans-serif`. No webfont is loaded, by choice: the project ships no build
step and a font request is a render-blocking dependency on a free host with cold
starts.

**Character:** the personality comes entirely from treatment, not from typeface.
Two signature styles carry it — wide light capitals for anything that names
something, and small heavily-tracked capitals for anything that labels something.
Between them sits ordinary system body text, deliberately plain.

### Hierarchy

- **Display** (300, 1.875rem, 1.1, +0.04em, uppercase): the welcome headline and
  destination names. Light weight at large size with open tracking — the single
  most identifying mark of the system.
- **Headline** (300, 1.5rem, 1.16, +0.015em, uppercase): the Now bar's one line
  saying what to do next. Same treatment as Display, tightened.
- **Title** (720, 1rem, 1.15, −0.02em): section headings. Heavy and tight — the
  deliberate counterweight to Display's light and wide.
- **Body** (400, 1rem, 1.5): everything read rather than scanned.
- **Label** (500, 0.75rem): form labels and captions, in Muted Ink.
- **Eyebrow** (700, 0.6875rem, +0.22em, uppercase): the phase name above a Now bar
  headline, section kickers, status chips. The widest tracking in the system.

### Named Rules

**The Light-and-Wide Rule.** Anything that names a thing — a city, an event, the
next move — is set light (300), uppercase and tracked. Anything that organises the
page is set heavy (720) and tight. The two never swap.

**The Tracked-Capitals Floor.** Eyebrow capitals never go below 0.6875rem (11px),
and never carry colour other than plum or Muted Ink. At that size, tracking is
what makes them legible, not weight.

## Layout

A single centred column, 720px at its widest (`--layout-max-w`), built mobile-first
on a 4px spacing base (`--space-1` 4px through `--space-16` 64px). Standard card
padding is 16px, section gaps 24px, and the gap between stacked cards 16px.

The shell is edge-to-edge and safe-area aware. The page uses
`viewport-fit=cover`, and gutters resolve as `max(16px, env(safe-area-inset-*))`,
so content clears a notch, a rounded corner and the home indicator without
hardcoded padding. The lifecycle tab bar is sticky at `env(safe-area-inset-top)`
and bleeds to the full width by negating those gutters, so it reads as chrome
rather than as content.

Responsive behaviour is modest because the column is narrow by design: two-column
form rows collapse to one at 380px, three-column rows at 460px. There is no desktop
layout — the 720px column simply centres. The real adaptation is to the usage
scene, not the breakpoint.

### Named Rules

**The One Column Rule.** Reunly is a phone app that also opens on a laptop. Width
is capped and centred; nothing earns a second column by virtue of there being room.

**The 44px Rule.** Every tap target clears 44px, including ones that look like
text. Where a utility class would shrink a control below it, the class is applied
to a wrapper instead — `.btn.nowbar-action`, never `.nowbar-action` alone.

## Elevation & Depth

This system is flat. `--shadow-card` is `none` in the default look, and the one
remaining shadow in the shell is a 1px hairline (`0 1px 2px` at 6% of the
foreground colour) that reads as a paper edge rather than as lift.

Depth comes from three things instead: the step between the warm ground (#f7f3ec)
and the card ivory (#fffdf9), the warm hairline that bounds every surface, and the
dark hero photograph, which is the only genuinely recessed plane in the app.

Shadows that do remain are reserved for things that genuinely float above the
page — the modal card (`--shadow-xl`) and the toast — plus the focus ring
(`--shadow-focus`, a 3px plum-mixed halo), which is a state, not a depth.

### Named Rules

**The Flat Paper Rule.** A surface at rest casts nothing. If a shadow appears, it
is because the element genuinely left the page: a modal, a toast, a drag. Hover
does not earn one.

## Shapes

Gently rounded throughout, on a six-step scale: 4px, 6px, 8px, 12px, 16px, and a
9999px pill. Two role tokens select from it — `--radius-card` (16px) for cards,
panels and modals, and `--radius-control` (12px) for buttons and inputs.

Pills (`--radius-full`) are reserved for things that are states rather than
surfaces: badges, chips, the progress strip segments, the hero eyebrow. The
distinction is readable — if it is round-ended, it describes something; if it is
12 or 16px, it holds something.

Borders are 1px and always warm. Dashed borders carry exactly one meaning: a
lifecycle tab that has not been earned yet, and the edit divider inside a
participant card. Nothing else dashes.

## Components

### Buttons

- **Shape:** 12px radius (`--radius-control`), full width by default, 16px padding.
- **Primary:** solid plum (#a8185f) with white text and **no shadow** — in the
  default look `.btn:not(.ghost):not(.secondary)` overrides the inherited gradient
  and drops the lift entirely.
- **Secondary:** card ivory with a Warm Rule border and ink text.
- **Ghost:** transparent with a border and plum text; the hover fill is Plum Tint.
- **Small (`.btn.sm`):** auto width, 38px min-height, eyebrow-sized text. Note the
  exception to The 44px Rule is deliberate and limited to inline secondary actions
  inside a card header.
- **States:** focus-visible shows `--shadow-focus` and no outline. Disabled is 50%
  opacity, desaturated, `not-allowed`. Loading is driven by `aria-busy="true"` —
  a spinner replaces the leading icon, pointer events pause.

### The Now Bar

The signature component. One strip above the tabs carrying the single next move,
and the clearest expression of the North Star: eyebrow, one light wide headline,
an optional progress strip or day count, one action.

- **Eyebrow:** tracked capitals in plum naming the phase.
- **Headline:** Headline role — light, wide, uppercase, ink.
- **Progress:** a row of 4px pills, filled ones taking the accent, unfilled at 12%
  of the foreground over the ground.
- **Day count:** a 1.875rem light numeral with a tracked-capital unit beneath,
  separated from the text by a hairline rule.
- **Action:** 46px tall, 8px radius, solid accent, no shadow.

### Cards

- **Corner:** 16px. **Background:** card ivory. **Border:** 1px warm hairline.
- **Shadow:** none (see Elevation). **Padding:** 16px, or 12px in `.tight`.
- A `.highlight` variant exists from the previous world and still paints a brand
  glow; it is a leftover, not a pattern to extend.

### Inputs

- Card ivory ground, warm hairline, 12px radius, 12px/16px padding, body type.
- **Focus:** border goes plum and the focus ring appears. One ring everywhere —
  keyboard focus on controls, any focus on fields.
- **Error:** `aria-invalid="true"` forces a claret border and a claret-tinted ring;
  the message is `role="alert"` and clears on typing.

### Lifecycle Tabs

Four tabs — the dashboard's rooms — in a sticky bar on the ground colour, no
container fill, no border. The active tab is a solid plum pill with white text;
the rest are Muted Ink on nothing. A tab the phase has not earned yet is rendered
dashed and disabled rather than hidden, so nobody wonders where it went.

### Badges and Chips

- **Badge:** eyebrow type in a pill. Plum tint by default; moss for `searched`,
  ochre for `estimated`, Pressed Linen for neutral. These carry the product's
  honesty rule, so their colours are not interchangeable.
- **Chip toggle:** Pressed Linen at rest, Plum Tint with a plum border when on.

### Deadline Bar

A full-width burnished-gold bar holding a bold title and a quieter sub, marked
`role="note"` — it informs rather than acts, so it is not a button. It carries the
one dated obligation on a screen and appears at most once: *Book travel by Thu 14
May*, or after the trip, *Square up by…*. When the date has already passed it
changes voice rather than disappearing, because that is the moment it matters
most.

The gradient and both text colours are fixed across every look and theme — it is
the only element in the system that never changes with the palette, which is
precisely how it stays recognisable. There is deliberately no per-look override;
it inherits the base token everywhere.

**The Readable Gold Rule.** The deadline ramp exists to be read, not to shine. Any
change to `--gradient-deadline` must keep `--color-on-deadline-muted` above 4.5:1
at every stop — the lightest stop is the constraint, and a brighter gold fails it.

### Icons

One stroke set defined as `ICONS` in app.js, rendered at 1.15em, 1.9 stroke width,
round caps and joins, inheriting `currentColor`. There are no emoji anywhere in
the interface. Destination emoji and itinerary suggestions are content, not
interface, and stay.

## Do's and Don'ts

### Do:

- **Do** take every value from `design-system/tokens.css`. Stylesheets consume
  tokens and never define them — that separation is the system's one structural
  rule.
- **Do** keep the ground warm (#f7f3ec) and the cards one warm step above it
  (#fffdf9). The step is what makes a surface read.
- **Do** set anything that names a thing in light wide capitals (300, +0.04em) and
  anything that organises the page in heavy tight type (720, −0.02em).
- **Do** let photographs carry the colour. A screen with a destination photo needs
  no other saturation.
- **Do** give every tap target 44px, and apply sizing utilities to the wrapper when
  a class would shrink one below it.
- **Do** use `--shadow-focus` for focus on everything. One ring, everywhere.
- **Do** render an unearned lifecycle tab dashed and disabled rather than removing
  it.

### Don't:

- **Don't** spend plum on a sixth element. If something new needs the accent,
  something existing gives it up.
- **Don't** use gold for anything but a date the user must act on or a first place.
  Not for Pro, not for a highlight, not for a "premium" feel — and never the same
  gold for both.
- **Don't** repurpose moss or ochre for emphasis, category or mood. They mean
  searched/settled and estimated/late, and nothing else.
- **Don't** introduce a true neutral grey. Every ground, border and ink in this
  system is warm.
- **Don't** add a shadow to a resting surface, or to a hover state. Depth is the
  ground/surface step and the hairline.
- **Don't** put an emoji in the interface. Use the stroke icon set; it takes the
  text colour by design.
- **Don't** reach for the dark glassmorphism world — gradient fills on every
  surface, backdrop blur as decoration, the animated aurora. It is the confirmed
  anti-reference, and its surviving `data-look="deeper"` tokens are a parked
  exploration, not a second contract.
- **Don't** add a webfont. The system stack is a deliberate performance decision on
  a free host with cold starts.
