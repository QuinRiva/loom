# Skill usage, last 30 days: declared vs read (a hand-run `/skill-doctor`)

Run 2026-10-23 over pi session files modified since 2026-09-23. Baseline for the re-count after the skill-header cuts shipped today (release 20261022-230214-40ddbac and the pi-fathom scoping).

## The answer in five lines

- **Catalogue skills are almost never pulled by their description.** Of 2,200 real sessions, the 14 skills declared in nearly every session were read in 0 to 4.7% of them. The one skill read most (`workstream-review-gate`, 79%) is read because the reviewer role tells it to, not because of its description.
- **Four skills were never read in 2,175 sessions:** `domain-modeling`, `prototype` (pi-craft), `librarian`, `pi-intercom` (npm). Five more were read in 1 to 4 sessions: `fix-codex-session`, `prompt-template-authoring`, `session-history`, `presentation-authoring`, `handoff`. Together about 4.9 kB (~1.2k tokens) of descriptions in every session's prompt.
- **When the work comes up, the MDX skills do fire:** of the sessions that wrote a `plans/*/plan.mdx`, 51 of 65 read `mdx-visual-plan` first; recaps 37 of 41; explainers 10 of 12. Low overall rates for these are correct.
- **`llm-instruction-change` misses most of its own trigger:** of 63 sessions that edited an instruction file (an `AGENTS.md`, a `SKILL.md`, a `roles/*.md`, loom's `prompt/*.ts`) with the skill declared, 24 read it first and 38 never did. This is the clearest under-firing skill.
- **pi-fathom skills were declared 17,127 times in non-fathom sessions and read 137 times there**; 79% of all pi-fathom reads came from fathom worktrees. Today's scoping change removes the bulk of that cost.

## Populations and method

| population                                                                                       | sessions | declared measured? | in the table                  |
| ------------------------------------------------------------------------------------------------ | -------: | ------------------ | ----------------------------- |
| loom threads (system prompt has the loom addendum)                                               |    2,158 | yes                | yes                           |
| terminal pi sessions                                                                             |       42 | yes                | yes                           |
| forks (header has `parentSession`: consult forks, continuations; they copy the parent's history) |      162 | yes                | no (would double-count reads) |
| dev/test instances (cwd under `/tmp`)                                                            |      798 | yes                | no (seeded test runs)         |

**Departure from the brief:** the brief expected the declared list only from prompt-debug sidecars, with terminal sessions unmeasurable. In fact every session jsonl in the window stores the assembled system prompt as a `role: "system"` message with `sections.skills`, so declared-vs-read is measured for every population, terminal included, from the session file alone. I used that rather than the sidecars, which would also overcount: their `- Skills (N):` line lists `grill-me` and `wayfinder`, which are `disable-model-invocation` and absent from the prompt the model sees.

- **Declared:** `<name>` entries in the session's `sections.skills` (union over agent starts).
- **Read:** a `read` or `read_full` call whose path ends `/SKILL.md`, or a `bash` call that runs `cat|sed|head|tail|less|more|bat|nl|awk` on a literal `…/<name>/SKILL.md` (globs and shell variables ignored), attributed by directory name, counted once per session. A read counts toward a skill's rate only if the session declared it.
- **Excluded from reads:** sessions that also edited or wrote that skill's `SKILL.md` (authoring, not use) and 7 "skill audit" sessions that read 8 or more distinct skills (one researcher read 28).
- **First-turn:** the first read came before the session's second user message (for a child thread: while still on its brief).
- **Role:** the `You are a <role> sub-thread` line in the addendum; loom threads without one are `root`; non-loom sessions are `terminal`.
- **Declared since:** first day 5 or more sessions declared it (an asterisk means it never reached 5 a day; date is the first sighting). Rates for skills added mid-window cover fewer sessions; read the declared column.

## The table (2,200 sessions: loom threads + terminal)

Sorted never-read first, then by read rate.

| skill                         | source       | declared since | declared | read |  rate | first-turn reads | top reading roles (read/declared)               |
| ----------------------------- | ------------ | -------------- | -------: | ---: | ----: | ---------------: | ----------------------------------------------- |
| domain-modeling               | pi-craft     | 2026-09-22     |     2175 |    0 |  0.0% |                0 | never                                           |
| librarian                     | npm/git      | 2026-09-22     |     2175 |    0 |  0.0% |                0 | never                                           |
| pi-intercom                   | npm/git      | 2026-09-22     |     2175 |    0 |  0.0% |                0 | never                                           |
| prototype                     | pi-craft     | 2026-09-22     |     2175 |    0 |  0.0% |                0 | never                                           |
| jira-git-workflow             | pi-fathom    | 2026-09-25     |      191 |    0 |  0.0% |                0 | never                                           |
| test-t3-app                   | loom         | 2026-09-28     |       16 |    0 |  0.0% |                0 | never                                           |
| test-t3-mobile                | loom         | 2026-09-28     |       16 |    0 |  0.0% |                0 | never                                           |
| gemini-on-vertex              | pi-craft     | 2026-10-23     |       12 |    0 |  0.0% |                0 | never                                           |
| contribution-triage           | loom         | 2026-10-12*    |        9 |    0 |  0.0% |                0 | never                                           |
| deploy-loom                   | slack-bridge | 2026-10-11*    |        6 |    0 |  0.0% |                0 | never                                           |
| find-loom-thread              | slack-bridge | 2026-10-11*    |        6 |    0 |  0.0% |                0 | never                                           |
| link-slack-thread             | slack-bridge | 2026-10-11*    |        6 |    0 |  0.0% |                0 | never                                           |
| ios-debugger-agent            | loom         | 2026-09-20*    |        2 |    0 |  0.0% |                0 | never                                           |
| ios-simulator-browser         | loom         | 2026-09-20*    |        2 |    0 |  0.0% |                0 | never                                           |
| fix-codex-session             | pi-craft     | 2026-09-22     |     2175 |    1 |  0.0% |                1 | root 1/329                                      |
| prompt-template-authoring     | npm/git      | 2026-09-22     |     2175 |    1 |  0.0% |                1 | reviewer 1/404                                  |
| session-history               | npm/git      | 2026-09-22     |     2175 |    1 |  0.0% |                0 | coder 1/496                                     |
| presentation-authoring        | pi-craft     | 2026-09-22     |     2175 |    2 |  0.1% |                2 | writer 1/2, planner 1/131                       |
| handoff                       | pi-craft     | 2026-09-22     |     2175 |    4 |  0.2% |                3 | root 2/329, coder 1/496, planner 1/131          |
| seek-manager-guidance         | pi-craft     | 2026-09-22     |     2175 |    5 |  0.2% |                4 | root 3/329, coder 2/496                         |
| authored-document             | pi-craft     | 2026-09-22     |     2175 |    9 |  0.4% |                8 | planner 5/131, coder 2/496, root 2/329          |
| convene-group                 | pi-fathom    | 2026-09-22     |     2129 |   12 |  0.6% |                5 | root 8/319, planner 1/131, coder 1/482          |
| evaluate-implementation       | pi-fathom    | 2026-09-22     |     2129 |   13 |  0.6% |               11 | researcher 6/502, reviewer 2/394, planner 2/131 |
| visual-explainer              | npm/git      | 2026-09-22     |     2175 |   14 |  0.6% |               10 | researcher 5/506, root 5/329, planner 2/131     |
| share-files                   | pi-fathom    | 2026-09-22     |     2129 |   14 |  0.7% |                6 | root 8/319, researcher 2/502, coder 2/482       |
| ensure-worktree-ready         | pi-fathom    | 2026-09-22     |     2129 |   16 |  0.8% |               14 | root 4/319, coder 4/482, researcher 4/502       |
| llm-instruction-change-fathom | pi-fathom    | 2026-10-12     |      839 |    8 |  1.0% |                7 | coder 5/209, reviewer 2/147, root 1/143         |
| prod-release                  | pi-fathom    | 2026-09-22     |     2125 |   21 |  1.0% |               16 | researcher 9/501, root 6/319, planner 3/131     |
| pr-review                     | pi-fathom    | 2026-09-22     |     2129 |   27 |  1.3% |               23 | root 11/319, coder 9/482, reviewer 4/394        |
| platform-update               | pi-craft     | 2026-09-25     |     1875 |   27 |  1.4% |               24 | root 11/296, coder 7/463, researcher 3/387      |
| start-tracked-work            | pi-fathom    | 2026-09-22     |     2129 |   31 |  1.5% |               28 | shipper 11/160, coder 8/482, root 8/319         |
| workbench                     | pi-fathom    | 2026-09-22     |     2129 |   31 |  1.5% |               30 | researcher 11/502, coder 9/482, planner 4/131   |
| lesson-triage                 | pi-craft     | 2026-10-20     |      193 |    3 |  1.6% |                3 | root 2/45, reviewer 1/34                        |
| report-loom-issue             | loom         | 2026-09-27     |     1864 |   31 |  1.7% |               10 | root 21/295, planner 3/125, terminal 2/25       |
| browse-frontend               | pi-fathom    | 2026-10-20     |      143 |    3 |  2.1% |                2 | researcher 1/28, coder 1/31, root 1/35          |
| finish-tracked-work           | pi-fathom    | 2026-09-22     |     2129 |   51 |  2.4% |               48 | shipper 29/160, root 7/319, planner 5/131       |
| work-hygiene-sweep            | pi-fathom    | 2026-10-19     |      280 |    7 |  2.5% |                5 | root 5/59, researcher 1/56, coder 1/63          |
| langfuse-trace                | pi-fathom    | 2026-09-22     |     2129 |   59 |  2.8% |               51 | coder 24/482, researcher 23/502, reviewer 6/394 |
| gcp-auth-gap                  | pi-fathom    | 2026-10-08     |     1019 |   33 |  3.2% |               20 | researcher 16/212, coder 7/247, root 6/185      |
| query-exlake                  | pi-fathom    | 2026-09-22     |     2129 |   69 |  3.2% |               61 | researcher 40/502, coder 13/482, root 7/319     |
| mdx-visual-explainer          | loom         | 2026-10-14     |      648 |   22 |  3.4% |               19 | researcher 8/160, reviewer 5/102, root 4/116    |
| jira                          | pi-fathom    | 2026-09-22     |     2129 |   75 |  3.5% |               59 | researcher 22/502, root 18/319, coder 13/482    |
| mdx-visual-recap              | loom         | 2026-09-22     |     2175 |   90 |  4.1% |               60 | researcher 29/506, root 29/329, planner 16/131  |
| skill-authoring               | pi-craft     | 2026-10-20     |      193 |    8 |  4.1% |                7 | root 4/45, coder 2/46, reviewer 2/34            |
| mdx-visual-plan               | loom         | 2026-09-22     |     2175 |  102 |  4.7% |               87 | planner 66/131, reviewer 13/404, root 12/329    |
| report-latent-issue           | pi-fathom    | 2026-09-22     |     2129 |  102 |  4.8% |               69 | researcher 40/502, coder 31/482, root 14/319    |
| llm-instruction-change        | pi-craft     | 2026-10-12     |      884 |   58 |  6.6% |               53 | coder 23/222, planner 15/74, root 11/153        |
| workstream-review-gate        | loom         | 2026-09-23     |      399 |  315 | 78.9% |              315 | reviewer 315/399                                |

Read without being in that session's catalogue (sessions, 2+ only): `author-synthetic-tenant-pack` 19, `browse-frontend` 17, `showme` 13, `finalise-synthetic-demo` 13, `ship` 11, `workstream-review-gate` 11, `t3code-dev-instance` 10, `mdx-doc-core` 8, `retro` 7, `author-synthetic-building` 6, `tenant-pre-audit` 6, `audit-patch` 5, `start-synthetic-demo` 4. These are reached by explicit pointers (a role, an AGENTS.md, a brief, another skill), never by a description.

## Did it fire when the work came up? (missed-fire check)

Sessions that did the work a skill covers, with the skill declared, and whether they read it before the first such action:

| skill                    | trigger action                                                         |        read first | read after |                                                                                     never read |
| ------------------------ | ---------------------------------------------------------------------- | ----------------: | ---------: | ---------------------------------------------------------------------------------------------: |
| `mdx-visual-plan`        | write/edit `plans/*/plan.mdx`                                          |                51 |          2 |                                                               12 (root 5, reviewer 4, coder 3) |
| `mdx-visual-recap`       | write/edit `recaps/*/recap.mdx`                                        |                37 |          1 |                                                                                              3 |
| `mdx-visual-explainer`   | write/edit `explainers/*/explainer.mdx`                                | 10 (3 undeclared) |          1 |                                                                                              1 |
| `llm-instruction-change` | edit `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `roles/*.md`, `prompt(s)/*` |                24 |          1 |                                                                     38 (root and coder mostly) |
| `report-loom-issue`      | `gh issue create` (any repo)                                           |                 8 |          0 |                                                                                              3 |
| `skill-authoring`        | write a new `SKILL.md`                                                 |                 2 |          0 | 0 declared misses; 17 more sessions wrote a `SKILL.md` before the skill was in their catalogue |

`llm-instruction-change` misses are not edge cases: coders editing `apps/server/src/loom/prompt/prose.ts` and `childPrompt.ts`, roots editing loom's and `cli-proxy`'s `AGENTS.md`, reviewers fixing `mdx-visual-*` and `skill-authoring` `SKILL.md` inline, all without loading it.

## Five most read, five least read

Most read (by rate, skills declared in 100+ sessions):

1. `workstream-review-gate` 79% (reviewer 315/399). Right, and pointer-driven: declared only to reviewers via role frontmatter and the role says to read it inside a gate. 83 of the 84 reviewers that skipped it were not in a gate (their kickoff lacks "You are inside a review gate"), so inside a gate it is read essentially every time.
2. `llm-instruction-change` 6.6% (coder 23/222, planner 15/74). Too low for what it is: the missed-fire check shows it read before only 24 of 63 instruction edits.
3. `report-latent-issue` 4.8% (pi-fathom; researcher 40, coder 31). Plausible for fathom work; 79% of pi-fathom reads are from fathom worktrees.
4. `mdx-visual-plan` 4.7%, planners 66/131 (50%). Right: planners that write a plan read it first in 44 of the cases; the other planners researched or revised without writing one.
5. `mdx-visual-recap` 4.1% (researcher 29, root 29) and `skill-authoring` 4.1% (only 193 sessions, declared from 2026-10-20). Recap is right (37 of 41 recap writers read it). `skill-authoring` is too new to judge; re-count.

Least read (declared in ~2,175 sessions each):

1. `domain-modeling` 0. Plausibly correct (nobody asked for a ubiquitous language), but it pays ~400 chars every session for that; a user-invoked candidate.
2. `prototype` 0. Same verdict; throwaway prototypes are rare here.
3. `librarian` 0 (researchers 0/506). Under-firing or redundant: researchers do library-internals work with `fetch_content` and web search without it. Either drop it from loom catalogues or accept it as dead weight.
4. `pi-intercom` 0. Correct to never read in loom: workstream tools replace session-to-session messaging, so its description is noise there (and arguably misleading).
5. `fix-codex-session` 1 (a root). Correct: a rare repair; but at 624 chars it is one of the dearer descriptions for one use a month.

Also near-zero and worth the same question: `prompt-template-authoring` 1, `session-history` 1 (its search index is frozen since 27 July anyway), `presentation-authoring` 2, `handoff` 4, `seek-manager-guidance` 5, `authored-document` 9.

Never read, small catalogue: `jira-git-workflow` 0/191 (pi-fathom); loom's `test-t3-app`, `test-t3-mobile`, `contribution-triage` 0/16, which are declared only when the cwd is the main checkout `/home/Carl/loom` (they live in its `.agents/skills`), so cockpit worktree threads never see them in their catalogue even though loom's `AGENTS.md` names `test-t3-mobile`.

## Baseline for today's header cuts

Read rates before the cut, for the re-count to compare (overall rate; role or trigger rate where it says more):

| skill                    | declared | read | rate | sharper measure                                |
| ------------------------ | -------: | ---: | ---: | ---------------------------------------------- |
| `mdx-visual-plan`        |     2175 |  102 | 4.7% | planners 66/131; plan writers 51/65 read first |
| `mdx-visual-recap`       |     2175 |   90 | 4.1% | recap writers 37/41 read first                 |
| `mdx-visual-explainer`   |      648 |   22 | 3.4% | researchers 8/160; explainer writers 10/12     |
| `skill-authoring`        |      193 |    8 | 4.1% | new SKILL.md writers 2/2 when declared         |
| `llm-instruction-change` |      884 |   58 | 6.6% | instruction editors 24/63 read first           |
| `platform-update`        |     1875 |   27 | 1.4% | root 11/296                                    |
| `lesson-triage`          |      193 |    3 | 1.6% | root 2/45                                      |

## How to re-run

```bash
A=/home/Carl/.t3/cockpit/worktrees/loom/t3-30ac1703/.artifacts
python3 $A/skill-usage-30d.py 30 > /tmp/skilldoc_30d.jsonl          # ~15 s, streams per line, one record per session
python3 $A/skill-usage-30d-agg.py /tmp/skilldoc_30d.jsonl all       # the table (or: loom | terminal)
python3 $A/skill-usage-30d-triggers.py                              # the missed-fire check
```

For a clean post-change re-count, pass a shorter window (`skill-usage-30d.py 14`) once two weeks of sessions with the cut headers exist, so pre-cut sessions do not dilute it. Scripts are read-only.

Caveats: a read in a parent thread does not count for its child (each session stands alone); `bash` reads via other commands (`python -c open(...)`, `rg` with context) are missed; the trigger patterns are heuristics (`gh issue create` includes non-loom repos).
