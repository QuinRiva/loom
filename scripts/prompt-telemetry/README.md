# Prompt telemetry

Four measurements of whether October 2026's prompt changes did anything. All are read-only.

- **Child delegation rate.** Of the child threads created since a date, the share that spawned a child of their own. Before the trimmed prompt deployed (release `20261022-230214-40ddbac`, 2026-10-22T23:04:44Z) it was 9 of 632 (1.4%) across roles. The report gives it cumulative since 2026-10-13 (when role-resident tool exposure landed) and since the deploy; the since-deploy figure is the one that tests the wording.
- **Skill-usage census.** For each skill in a session's catalogue, the share of sessions that read its `SKILL.md`, plus a missed-fire check: of the sessions that did a skill's work (wrote a `plans/*/plan.mdx`, edited an `AGENTS.md`, …), how many read the skill first. On 2026-10-23 the catalogue headers of `mdx-visual-plan`, `mdx-visual-recap`, `mdx-visual-explainer`, `skill-authoring`, `llm-instruction-change`, `platform-update` and `lesson-triage` were shortened; the census checks they are still read as often. What counts as a read, and which sessions are excluded (forks, `/tmp` dev instances, sessions authoring the skill, skill audits), is in `baselines/skill-usage-30d.md` under "Populations and method".
- **Capability census.** Sessions that substituted for something loom provides: hand-rolled a browser (`--headless`, `npm i playwright`, …) outside a loom checkout, and whether they called `tool_search` before the first such command; MDX lints run from the stale `~/loom` checkout; `tool_search` queries that found nothing. PR #450 (the per-role line naming what sits behind `tool_search`, the guards' browser and bounded-search notes, the MDX skills' `lint-doc.sh` wrapper) targets these; it counts only from the first release that carries it. Method and the reconciliation with `plans/deferred-capabilities` §1's figures are in `baselines/capabilities-2026-10-26.md`.
- **Testing-doc census.** PR #460 moves the test-writing conventions out of `AGENTS.md` into `docs/internals/testing.md`, behind one pointer. Of the sessions that `edit` or `write` a loom `*.test.ts(x)`, the share that read the doc before their first test edit, and the share that later hit one of the test lints (`t3code(no-wall-clock-in-tests)`, …) on a test they edited. `AGENTS.md` is read from the session's checkout, so each session is classed by the `AGENTS.md` in its own prompt (conventions inline, or the pointer), not by date. Method and its blind spots are in `baselines/testing-doc-2026-10-27.md`.

## Run

```bash
scripts/prompt-telemetry/run.sh            # ~30 s; options: --days 14 --sessions-root DIR --db PATH --out FILE
```

It prints the report path, by default `.artifacts/prompt-telemetry-<UTC timestamp>.md` at the checkout root. The report opens with the comparison against `baselines/`, then the raw delegation tables, the full census table, the missed-fire output, the capability census and the testing-doc census. It reads session files under `~/.pi/agent/sessions` modified in the last 14 days and the cockpit database at `$T3CODE_HOME/userdata/statev2.sqlite` (default `~/.t3/cockpit`), opened `mode=ro`.

A 14-day window counts only sessions with the cut headers from 2026-11-06 on; before that the report marks the skill table provisional.

## When to follow up

- **Delegation still near 1.5%.** The report says "Follow-up" when the since-deploy rate is under 3% over at least 200 children (fewer than that is "Inconclusive", re-run later). Wording alone did not move delegation: make the delegation toolset resident for the coder, researcher and planner roles.
- **A cut header read less than its baseline.** The skill table's last column says "**yes**" when a skill's read rate is below its baseline by more than noise (two-proportion z ≤ −2); "lower, within noise" is not a trigger. Restore that skill's previous description. The last row, `llm-instruction-change` read before an instruction edit, is the sharpest measure for that skill.
- **Threads still substitute for loom's capabilities.** The capabilities table's last column says "**yes**" unless a measure moved the right way by at least one standard error ("no" needs two; between is "re-run later"). Hand-rolled browsers not falling, or the share that searched first not rising (baseline 9 of 57), means the deferred-capabilities line is not read as a pointer: read a few of the sessions and revisit its wording. Any `~/loom` lint after the wrapper's release is promoted means the MDX skills' lint command is not reaching those threads.
- **Test writers do not follow the testing pointer.** Read 30 days after PR #460 merges, once the "pointer" column has at least 20 test writers. The testing table says "**yes**" when under half of them read `docs/internals/testing.md` before their first test edit (the conventions lint cannot see are not reaching them), or when over 5% hit a test lint on their own test, or more than the baseline by z ≥ 2 (the baseline is 0 of 16, too thin for z alone). Either way, put the conventions back inline in `AGENTS.md` and keep the doc as the long form.

## Files

- `run.sh`: the entrypoint. `compare.py` builds its comparison section.
- `skill-usage.py` (one record per session), `skill-usage-agg.py` (the table; `all|loom|terminal`), `skill-usage-triggers.py` (missed-fire check): the census, also runnable alone; usage is in each file's header.
- `delegation.sh SINCE [DB]`: the delegation table from the date given.
- `baselines/skill-usage-30d.md`: the 2026-10-23 census report (30 days from 2026-09-23), with its method and the pre-cut rates.
- `baselines/delegation-2026-10-22.txt`: the delegation table for children created 2026-10-13 to 2026-10-22T06:18Z.
- `capabilities.py [--days N] [--sessions-root DIR]`: the capability census, one markdown section.
- `baselines/capabilities-2026-10-26.md`: its 14-day output on 2026-10-26, before any release carried PR #450.
- `testing-doc.py [--days N] [--sessions-root DIR]`: the testing-doc census, one markdown section.
- `baselines/testing-doc-2026-10-27.md`: its 14-day output on 2026-10-27, before PR #460 merged; `compare.py` reads its "inline" column.
