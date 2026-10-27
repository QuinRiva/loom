# Testing-doc census, 14 days to 2026-10-27: the baseline

`testing-doc.py --days 14` (run.sh's default window), run 2026-10-27 06:46Z, before PR #460 merged; `origin/main` was `f0af4f1c97`. PR #460 moves the test-writing conventions out of `AGENTS.md` into `docs/internals/testing.md` and leaves one pointer: "read it before writing a server or browser test". `compare.py` reads this file's "inline" column by row label.

**Classed by prompt, not by date.** `AGENTS.md` is read from the session's own checkout, so the change reaches a thread when its worktree is made from a `main` that carries #460, not at a release, and an older worktree keeps the old text for its whole life. Each session is classed by the `AGENTS.md` in its stored system prompt (`sections.project_context`): **pointer** if it names `docs/internals/testing.md`, **inline** if it carries "Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`", else **neither**.

**The baseline is thin, and why.** The inline conventions and the six test lints entered loom together, in #445 (upstream pull 13), merged to `main` 2026-10-26 09:18Z. The 44 earlier test writers had neither the conventions nor the lints, could not trip a rule that did not exist, and are not a baseline. That leaves 16 inline test writers: 0 read the doc (it is not on `main`, so 0 by construction; the measure only means something in the pointer column) and 0 hit a test lint on a test they edited, though all 16 ran lint after their first test edit. Thirteen of the 16 come from one workstream (`t3-192a6b50`). A 0 of 16 baseline cannot make a two-proportion z fire on any plausible later share (10 of 130 gives z ≈ 1.1), so `compare.py` also flags a lint-hit share over 5% outright. The inline population grows until #460 merges; re-running this file then, with the same command, gives a stronger baseline.

## Method

- **Test writer:** an `edit` or `write` call on a `*.test.ts` or `*.test.tsx` under `apps/` or `packages/` of a loom checkout (an absolute path matching the census's loom-checkout pattern, or a relative path from a loom cwd; `.repos/` and `node_modules` ignored).
- **Read first:** a `read` or `read_full` of `docs/internals/testing.md`, or a bash `cat|sed|head|tail|less|more|bat|nl|awk` naming it, before the session's first test edit (tool calls in order).
- **Lint hit:** after the first test edit, a `bash` or `bg_wait` result carrying an oxlint diagnostic for one of the six test rules, in either reporter form (`path:line:col: error t3code(<rule>)`, or `t3code(<rule>): …` with `,-[path:line:col]` on the next line), whose path is a test file the session edited. The `t3code/<rule>` form is `AGENTS.md` text, docs and disable comments, never a diagnostic, so it is not matched. The "any file" row drops the own-file condition: its 2 inline sessions, both on worktree `t3-b895412c` before #445 merged, linted existing loom tests the new rules flagged.
- **Excluded:** forks, `/tmp` dev instances, and sessions that edited `docs/internals/testing.md` or `oxlint-plugin-t3code/` (authoring, not use): the census's population rules, in `skill-usage-30d.md` under "Populations and method".
- **Role:** the `You are a <role> sub-thread` line in the addendum; loom threads without one are `root`.

## Blind spots

- **Edits through bash are not seen.** About 20 sessions in the window changed a test file only by `sed -i` or a shell redirect: mostly one-line fixups and throwaway `zz-*-probe.test.ts` files.
- **A hit hidden by truncation is missed.** Some agents run `vp check 2>&1 | tail -25`, and a `bg_wait` shows only a job's last lines; with 400+ existing warnings in the repo, an error on the agent's own test can scroll out of view while "Found 1 error" stays. A re-run that shows the diagnostic is then caught.
- **A hit in another session is missed.** A lint that first fails in a shipper or reviewer child, which did not edit the test, is not attributed to the writer.

## Spot checks

- `2026-10-26T12-49-16-214Z_01a17842…` (coder, inline): `write` of `apps/web/src/components/files/mdx-plan/blocks/mermaid.test.ts`, then `vp check 2>&1 | tail -25` reporting "Found 0 errors and 422 warnings": counted as a test writer that linted, no hit. Correct.
- `2026-10-26T15-37-03-554Z_01a178db…` (reviewer, inline): `edit` of `apps/web/src/hooks/useThreadActionMenu.test.ts`, then a targeted lint, "Found no warnings or lint errors in 1 file". Correct.
- `2026-10-26T02-46-34-428Z_01a1761a…` (coder, inline): wrote `ComposerPendingUserInputPanel.loom.browser.test.tsx`; its lint output carried `require-disposable-render`, `no-frame-waits-in-browser-tests` and `no-real-time-wait-in-tests` diagnostics on `verifiedFileChips.browser.test.tsx` and other files it did not edit. Correctly not an own-test hit.
- A synthetic session (read the doc, `write` a browser test, a default-reporter diagnostic on it) counts in every row, so the positive path works; no real session in the window had an own-test hit to check it against.

## The output

1088 sessions modified in the last 14 days; 158 forks, /tmp dev instances and sessions editing `docs/internals/testing.md` or `oxlint-plugin-t3code/` dropped. Columns: the session's AGENTS.md carries the test conventions inline, the pointer to the doc (PR #460), or neither (before the test lints).

| Sessions                                                                                               | inline | pointer | neither |
| ------------------------------------------------------------------------------------------------------ | -----: | ------: | ------: |
| wrote a loom test (`edit`/`write` on `apps/` or `packages/` `*.test.ts(x)`)                            |     16 |       0 |      44 |
| of those, read `docs/internals/testing.md` before the first test edit                                  |      0 |       0 |       0 |
| of those, read it only after                                                                           |      0 |       0 |       0 |
| of those, ran lint after the first test edit (`vp check`, `oxlint`, `check:changed`, `pnpm ship`, ...) |     16 |       0 |      41 |
| of those, a later test-lint diagnostic on a test file they edited                                      |      0 |       0 |       0 |
| of those, a later test-lint diagnostic on any file (pre-existing code included)                        |      2 |       0 |       0 |

| role     | AGENTS.md | wrote a test | read the doc first | lint hit on own test |
| -------- | --------- | -----------: | -----------------: | -------------------: |
| coder    | inline    |           15 |                  0 |                    0 |
| reviewer | inline    |            1 |                  0 |                    0 |

Rules hit on own tests (sessions): none.
