# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the organiser.** The one person in a group who always ends up herding
everyone. They open Reunly to stop chasing people across a WhatsApp thread. They
hold every decision — invite, read the ranking, open the vote, lock the plan,
chase the money — and they are the person Pro is sold to.

**Secondary: the guests.** Invited by a link, usually on their own phone, often in
another country. Their path is deliberately light: answer a few questions about
dates, budget and where they'd go, send the answers back, then look at the plan.
A guest should never need to understand the app to be useful to it.

The guest path being small is a design target, not a reduced version of the
organiser's. Guests are the majority of people who ever touch Reunly, and the
organiser's success depends entirely on how many of them bother to reply.

**Reach is international from the start.** Groups scattered across any countries,
meeting anywhere. The UK defaults throughout the current code — sterling, UK
spelling, UK rail assumptions, 15 mapped currencies with everything else falling
back to USD — are an accident of who built it, not a position. Future work should
treat them as a gap to close rather than a constraint to preserve.

## Product Purpose

Decide when, where and how a group meets — and then carry the whole thing through.

Reunly takes each person's real constraints (when they're free, what they can
spend, where they'd like to go, where they're travelling from) and ranks the
possible date-and-destination combinations for the group as a whole. The group
votes, the organiser locks it, and the app keeps going: travel costs in each
person's own currency, what needs booking and by when, the night itself, settling
up afterwards, and a place to put the photos.

Success is a real group planning, voting, locking, costing, settling and
remembering a trip end to end, on separate devices, with every estimate honestly
labelled.

## Positioning

Three things a neighbouring product could not truthfully copy as a set:

1. **It decides, and shows its reasoning.** Most group tools collect availability
   and stop. Reunly scores date-and-place combinations against everyone's
   constraints at once and explains why one won — including the cost trade-off,
   which carries roughly 40% of the score by design.
2. **Nothing to install, no account to make.** A guest's first interaction is
   answering a question, not signing up. Answers live on their own device and
   travel back as a share link.
3. **It does not stop at the decision.** Booking deadlines, per-person costs in
   local currency, the evening itself, settle-up and the memory wall are all one
   product, not four.

## Operating Context

- The organiser works on a laptop or a phone; guests are almost always on a phone,
  frequently abroad, across both iOS and Android, usually in the default browser.
- Distribution is WhatsApp, SMS or email — one link, plus an invite code.
- Answers travel back to the organiser as URL-hash links that merge into their
  copy of the plan. Nothing passes through a shared server.
- Installable as a PWA from the live HTTPS URL, which is how phone testers use it.
- The night of the event is a genuinely different scene: standing up, in a pub, one
  hand, poor light, possibly drunk, caring about who is still out and when the last
  train goes. The v0.9 "evening mode" work exists for that scene.

## Capabilities and Constraints

**Stack (fixed, and part of the product's character):**

- Vanilla HTML/CSS/JS. No framework, no build step. Modules loaded as plain
  scripts: `data.js` (static data), `engine.js` (pure scoring, UI-free),
  `fares.js`, `globe-land.js`, `app.js` (UI controller), `styles.css`,
  `index.html`.
- `server.py`: Python standard library only, zero third-party dependencies. Serves
  the static files and a same-origin JSON API. Reads `PORT`, binds `0.0.0.0`.
  Deployed to Render's free plan as a single Blueprint (`render.yaml`).
- PWA: `manifest.json`, `icon.svg`, network-first `service-worker.js` that never
  caches `/api/*`.
- Engine maths is pure and tested with Node's built-in runner (`npm test`,
  currently 127 tests). Every maths bug found gets a test that pins it.

**Hard product rules:**

- **No paid APIs anywhere.** Everything external is free or public: Photon
  (geocoding), Nominatim (places), Open-Meteo (weather), Transitous (journey
  planning), Wikipedia (destination photos).
- **Never present an estimate as fact.** No fare, forecast or travel time is
  labelled live or guaranteed unless it genuinely came from a live source. Every
  figure carries its provenance — `searched` versus `estimated` — and the UI says
  so plainly.
- **The app opens directly into the experience.** No marketing landing page.
- Cost carries roughly 40% of the ranking weight, so a cheaper, less popular
  destination can legitimately win. This is intended behaviour, not a bug.

**Data model, and where the paid line falls:**

- The free tier is local-only: each person's answers live in their own browser's
  `localStorage`, and share links merge them. There is no shared server state.
- **Pro is intended to be the synced tier** — a live shared plan with no sending
  links back, server-backed and persistent. The local/synced split is the
  monetisation boundary. None of the server side is built yet.
- Today's Pro is a demo: unlocking is free, applies only on that device, and
  charges nothing. Current entitlements are a printable Trip Pack and a larger
  memory wall.
- The notification store is in-memory on the server and resets on every redeploy.

**Terminology used in the product:** organiser, guest, invite code, lock the plan,
send my answers, evening mode, Trip Pack, memory wall.

**Explicitly undecided:**

- **Price and pricing model.** The £7.99-per-event figure in the code is a
  placeholder, and even per-event versus subscription versus per-group is open.
  Future work must not present any price as settled.
- Whether and when server sync ships, and therefore when Pro becomes real.

## Brand Commitments

- Name: **Reunly**.
- Tagline, shipped in the product: **"Reconnect. We'll handle the rest."**
- Brand promise: **"Making reunions effortless."**
- Not only reunions. The supported event types are Friends meetup, Family
  gathering, School reunion, University / alumni, Office / work, Wedding,
  Holiday / group trip, Sports club, Birthday, Other.
- Voice: plain, warm, not corporate. Honest about what it doesn't know. Explains
  its reasoning rather than asserting.

## Evidence on Hand

- **Live deployment:** https://reunly.onrender.com — deploys from the `v0.7-dev`
  branch. Cold start after idle is roughly 20–60 seconds on the free plan.
- **Friends test, running from 2026-10-26:** `testing/FRIENDS-TEST-PLAN.md` and
  `testing/message-to-friends.txt`. Five to eight friends, mixed iPhone and
  Android, some abroad, over one week: invite → replies → vote → lock.
- **Full specification:** `REBUILD_PROMPT.md` — product, stack, every feature, the
  gotchas, in the order they were built.
- **Session ledger:** `PROGRESS.md` — what is done, in progress, and next.
- **v0.9 prototype:** `prototypes/pub-crawl/` — the evening-mode work, passing its
  own suite, not yet integrated into the main app.
- **Tests:** 127 engine tests plus git-ignored QA walkthrough suites in `.qa/`.

**Absences that must not be invented:** there are no customers, no testimonials, no
revenue, no usage or analytics data, no press, and no third-party validation of any
kind. The friends test has not reported back yet.

## Product Principles

1. **Honesty outranks confidence.** An estimate labelled as an estimate is worth
   more than a number that looks authoritative and is wrong. Provenance travels
   with every figure.
2. **The guest's effort is the scarce resource.** The organiser's success depends
   on replies. Anything that makes a guest hesitate — an account, an install, a
   long form, an unclear ask — costs more than the feature it enables.
3. **Show the reasoning.** The group should be able to see why a date and place
   won, disagree with it, and override it by voting.
4. **The plan has a life, not a deadline.** Deciding is the first phase, not the
   product. What the app owes the group changes between gathering replies, the
   night itself, and the week after.
5. **Earn the money by being useful, not by withholding.** The free tier has to be
   genuinely complete for a group that never pays.

## Accessibility & Inclusion

No formal standard has been set, and nobody audits against one. The working
practice is to do it properly: real contrast (light-mode warning, success and
danger colours were already darkened because amber on near-white failed badly),
touch targets at 44px and up, keyboard-navigable tabs, and labelled icon-only
controls.

Two product facts make this more than housekeeping. Guests skew toward people who
did not choose the tool and may not be comfortable with apps — older relatives at a
family gathering, for instance. And the audience is international, so currency,
date formats, place names and non-UK travel assumptions are inclusion concerns, not
just correctness ones.
