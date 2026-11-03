## 6. Specific checks the brief asked for

| Check | Finding |
| --- | --- |
| pi 1.3.0 (#404) vs upstream `packages/provider-pi` | Upstream does not depend on `@earendil-works/pi-coding-agent` (it resolves pi from PATH); the dependency, the catalog line and the patch are Loom-only. Upstream's provider-pi delta is 3 commits (−430 lines, mostly comments). No interaction; the lockfile regenerates with pi 1.3.0 from Loom's catalog line |
| Effect version | Loom 4.0.4 → upstream **4.0.5** (`effect`, `@effect/vitest` + patch). The Slack bridge runs the cockpit's `effect` (DL-1015): **check the bridge against 4.0.5 before promoting this cockpit**, as doc 36 §4 item 3 asked for 4.0.4 — confirm whether that check was done at pull 11's deploy and repeat for 4.0.5 |
| `apps/web/src/test` deleted | §5.4 — replaced by the browser project; no Loom dependency |
| New upstream dirs | §5.5 — all take-verbatim; none overlaps a Loom path |
| Modify/delete on 5 web tests | §5.4 |
| `docs/user/outside-agents.md` | Upstream changed two lines ("as an administrator" → "with permission to manage access"). Loom did not edit this file (Loom's positioning work in #395/#397 is in `README.md`); it auto-merges. No action |
| `Migrations.ts` byte-identical | Yes in the trial tree (`git diff --quiet 07d38b8d17 -- apps/server/src/persistence/Migrations.ts`); Loom carries no delta on it at the base either |
| Pull 11's "roles cannot reach `delegate_task`; shared worktree unchanged" | Still true (§4.2) |
| React Compiler vs Loom's `useMemo`/`useCallback` | §5.3: they must go (lint error), not merely may |
