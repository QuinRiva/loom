---
manager_sessions:
  - id: b2be7361-1db1-4eea-a48d-95f90d280f04
    role: intent
    authored_at: 2026-09-25T13:17:51.152Z
---

# Usage meter — intent brief

Outcome of a grill-me interview with the human on 24–25 Sep 2026, after three mockup options (A/B/C in `plan.mdx`) were rejected for "showing too much" without an information hierarchy. This brief is the specification the next mockup must be built from. It records *what the meter must let the human decide and in what order*; it deliberately does not draw the UI.

## Business objective

The human runs many concurrent agent threads through a cli-proxy hub that round-robins each new thread onto one of five Claude subscriptions (carl@, caaarl@, carl3@, carl4@, jacob@) and keeps it there (conversation-prefix affinity, namespaced by model). Each sub has its own 5-hour and weekly clocks, and Fable has a separate weekly carve-out (~50% of the sub's Anthropic limit). Budget is the binding constraint on daily throughput; the meter exists so that budget is spent deliberately rather than discovered exhausted.

## The decisions the meter serves, in priority order

**Tier 1 — pool-level, always visible, read several times a day**

1. **Will I have to stop?** — 5-hour budget across the pool: remaining, and *time-to-empty at the current burn* against the reset time and the remaining working day. "70% left at 4:30 pm, well over pace" is fine; "50% left at 10 am, slightly over pace" is not. Percentage alone cannot express this; time can.
2. **Can I afford a discretionary task now, or should it wait for spare budget?** — the same quantity one step on: budget beyond what planned work will consume before reset.
3. **Fable or Opus for this new orchestrator?** — pooled Fable-weekly pace (fill vs elapsed share). Under pace → Fable; over pace → compromise to Opus. Read at every orchestrator start, so this is routine, not exceptional, and it is genuinely about *pace*.

**Tier 2 — per-sub, always present but compact; exists to show divergence, not to repeat the pool five times**

4. **Each sub's 5-hour position and reset.** Round-robin is only roughly even: the five 5-hour clocks reset up to ~90 min apart, one orchestrator thread can draw ~$200 while siblings draw ~$20, so subs diverge over short periods. The 5-hour window is the most important per-sub figure.
5. **Weekly and Fable-weekly as two-sided exception marks per sub.** *Risk*: near max or projected to hit max before its reset ("this sub stops and won't return for N days"). *Opportunity*: plenty left and resetting soon ("this expires unused — spend it here"). Silent otherwise; detail on hover. Never a permanent column.
6. **The week has two reading modes.** Early in the week the human reads at pool level; in the last ~36 hours, when some subs reset in hours and others in 1.5 days (weeklies reset up to ~36 h apart), attention moves to individual subs. The per-sub rows should therefore gain visual weight as their resets approach and as they diverge from the pool, rather than being equally loud all week.

**Tier 3 — occasional**

7. **Which sub a thread is actually drawing from** — knowable per response from the hub's `X-Cpa-Trace-Id` header (researcher report `322ce596`), as "last served by carl3@ · N min ago", never "pinned to". Belongs on the thread (near the context meter / header), with a live-thread count per sub in the meter so a heavy goal's draw on one sub is visible. Task `c61fa90a`.
8. **Overall (non-Fable) weekly** — exception only, near max.
9. **Override** — rare. loom cannot move a thread within the pool; the real levers are switching the thread to a direct `anthropic-<tag>` provider (cache-bust, no failover) or taking a sub offline. At most a popover action; the model picker already does it.

## Required system capability

- Time-to-empty needs a burn rate. The wire today carries `usedPercent`, `resetsAt`, `windowDurationMins` per window (poll every 5 min); rate must be derived from successive readings (client or server) — the mockup must say which and how much history.
- Per-sub identity for hub accounts is the email; label by local part + `@` (matches the human's existing labels), colour by the existing `accountHue`.
- No new state tier; no burn chart (ruling D-1 stands).

## Key constraints

- **Vertical space is precious.** All three rejected options (150–200 px) were "too much vertical space, too cluttered". The footer slot is ~248 px wide in a 16 rem sidebar.
- Pace must be *visual* (tick/marker), never words (ruling B).
- `% used` convention everywhere (ruling Q1). Codex red-at-zero is accepted as design: an exhausted weekly may colour a row.
- Prototype posture; roughly 150–250 lines of web code is the expected size.
- The human must approve a mockup before any implementation.

## Non-goals

- Rebuilding the retired `/usage` dashboard. "I don't need the old dashboard back — I want the panel meter to show each of my meters."
- Upstream's Usage → Limits page ("useless as currently designed") — secondary; C-2 deferred behind the meter.
- Automating sub selection.

## Resolved terminology

- **pool** — the five Claude subs the hub round-robins across; pool figures are means unless the mockup argues otherwise.
- **sub** — one Claude subscription/account.
- **window** — one quota clock: 5-hour, weekly, Fable-weekly (per-model carve-out).
- **pace** — fill vs elapsed share of the window. **over pace** = fill ahead of elapsed time.
- **time-to-empty** — projected clock time the window hits 100% at the current burn.
- **last served by** — the sub that served the thread's most recent response (observation, not binding).

## Open questions for the mockup to answer visually, not ask

- How time-to-empty and reset time are shown so that "70% at 4:30 pm" and "50% at 10 am" read differently at a glance.
- How per-sub rows stay compact all week yet become legible in the last 36 hours.
- What the collapsed-sidebar header chip carries (tier 1 only, presumably).
