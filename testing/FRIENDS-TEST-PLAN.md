# Reunly v8 — friends test plan

_Live app: https://reunly.onrender.com · version shown in the footer: **v8** · checked working 2026-10-26_

## Goal
Find out whether a real group can get from "invite" to "locked plan" without help, on their own phones — and collect what confuses or breaks along the way.

## Who
- **You** = organiser (on your own phone).
- **5–8 friends** = guests. Aim for a mix:
  - at least one **iPhone** and one **Android**
  - at least one person **abroad or in another country's city** (tests flights, currency and the "Before you go" border steps)
  - at least one person who will **say no** or **pick different dates** (tests declines and alternatives)
  - one person who isn't techy (the real test of the wording)

## Before you send anything (10 min)
1. **Wake the server**: open the link yourself first. On Render's free tier the first open after ~15 min idle takes 20–60 s.
2. **Optional but recommended for the test week**: a free uptime pinger (e.g. UptimeRobot → HTTP monitor on `https://reunly.onrender.com/api/health` every 10 min). Keeps it awake, so friends never wait and the 🔔 bell doesn't reset.
3. **Set up a real-ish event** on your phone: register → *Set up a get-together* → name it → add your own dates and two or three places.
4. Create a WhatsApp group for the test (feedback goes there — see the message below).

## The week
| Day | You (organiser) | Friends |
|---|---|---|
| 1 | Send the invite link + the message from `message-to-friends.txt` | Open link, sign up, answer "Does this work for you?", **Send your answers back** |
| 2–3 | Open every return link you receive (that's how their answers reach you). Watch the 🔔 bell | Anyone who hasn't sent answers back: nudge |
| 4 | *Open a vote*, send the updated link to the group | Vote, send the link back |
| 5 | Close the vote → **Lock this plan** → send the link once more | See the locked plan: Costs, Before you go, the globe |
| 6–7 | Try Costs → Expenses (add a pretend deposit, "Money in") and the Trip Pack | Post feedback |

## What to watch for (your own notes)
- Did anyone **not send their answers back**? Where did they stop?
- Did any return link **not update your roster**? (Note the phone + how they opened it.)
- iPhone: did anyone add it to the **home screen**? Did their link then open in a different copy? (Known risk — the message asks iPhone users to stay in Safari.)
- Were the **costs / travel times believable** for each person's city?
- Anything that looked broken, or wording people didn't understand.

## Collecting feedback
Ask everyone to post in the WhatsApp group using the template in the message (phone · what you tried · what happened · what you expected · screenshot). At the end of the week, paste the messages (or screenshots) here in a session and I'll turn them into a fix list in `PROGRESS.md`.

## Known limits (already told to friends)
- Answers live on each phone until they're sent back — there's no shared account yet.
- The 🔔 bell resets if the server restarts or sleeps.
- Prices are estimates, labelled as such. Pro "unlock" is a free test, nothing is charged.
