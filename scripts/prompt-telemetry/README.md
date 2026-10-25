# Prompt telemetry

Two measurements of whether October 2026's prompt changes did anything. Both are read-only.

- **Child delegation rate.** Of the child threads created since a date, the share that spawned a child of their own. Before the trimmed prompt deployed (release `20261022-230214-40ddbac`, 2026-10-22T23:04:44Z) it was 9 of 632 (1.4%) across roles. The report gives it cumulative since 2026-10-13 (when role-resident tool exposure landed) and since the deploy; the since-deploy figure is the one that tests the wording.
- **Skill-usage census.** For each skill in a session's catalogue, the share of sessions that read its `SKILL.md`, plus a missed-fire check: of the sessions that did a skill's work (wrote a `plans/*/plan.mdx`, edited an `AGENTS.md`, …), how many read the skill first. On 2026-10-23 the catalogue headers of `mdx-visual-plan`, `mdx-visual-recap`, `mdx-visual-explainer`, `skill-authoring`, `llm-instruction-change`, `platform-update` and `lesson-triage` were shortened; the census checks they are still read as often. What counts as a read, and which sessions are excluded (forks, `/tmp` dev instances, sessions authoring the skill, skill audits), is in `baselines/skill-usage-30d.md` under "Populations and method".

## Run

```bash
scripts/prompt-telemetry/run.sh            # ~15 s; options: --days 14 --sessions-root DIR --db PATH --out FILE
```

It prints the report path, by default `.artifacts/prompt-telemetry-<UTC timestamp>.md` at the checkout root. The report opens with the comparison against `baselines/`, then the raw delegation tables, the full census table and the missed-fire output. It reads session files under `~/.pi/agent/sessions` modified in the last 14 days and the cockpit database at `$T3CODE_HOME/userdata/statev2.sqlite` (default `~/.t3/cockpit`), opened `mode=ro`.

A 14-day window counts only sessions with the cut headers from 2026-11-06 on; before that the report marks the skill table provisional.

## When to follow up

- **Delegation still near 1.5%.** The report says "Follow-up" when the since-deploy rate is under 3% over at least 200 children (fewer than that is "Inconclusive", re-run later). Wording alone did not move delegation: make the delegation toolset resident for the coder, researcher and planner roles.
- **A cut header read less than its baseline.** The skill table's last column says "**yes**" when a skill's read rate is below its baseline by more than noise (two-proportion z ≤ −2); "lower, within noise" is not a trigger. Restore that skill's previous description. The last row, `llm-instruction-change` read before an instruction edit, is the sharpest measure for that skill.

## Files

- `run.sh`: the entrypoint. `compare.py` builds its comparison section.
- `skill-usage.py` (one record per session), `skill-usage-agg.py` (the table; `all|loom|terminal`), `skill-usage-triggers.py` (missed-fire check): the census, also runnable alone; usage is in each file's header.
- `delegation.sh SINCE [DB]`: the delegation table from the date given.
- `baselines/skill-usage-30d.md`: the 2026-10-23 census report (30 days from 2026-09-23), with its method and the pre-cut rates.
- `baselines/delegation-2026-10-22.txt`: the delegation table for children created 2026-10-13 to 2026-10-22T06:18Z.
