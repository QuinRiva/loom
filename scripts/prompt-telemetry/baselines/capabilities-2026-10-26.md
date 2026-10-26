# Capability census, 14 days to 2026-10-26: the baseline

`capabilities.py --days 14` (run.sh's default window), run 2026-10-26 12:24Z, before any release carried PR #450 (the per-role deferred-capabilities line, the command and search guard notes, the `lint-doc.sh` wrapper); the current release then was `20261026-004852-7935f6a`. `compare.py` reads this file's table rows by label.

**Why 14 days and not plan §1's 30-day figures.** `plans/deferred-capabilities/plan.mdx` §1 gave, over 30 days, 35 hand-rolled browsers (about 1.2 a day; 5 of the 35 called `tool_search`), 71 threads that found a browser by searching, and 63 MDX lints from `~/loom`. Its hand scan counted differently from this script: by session the `~/loom` lints were 11, not 63 (63 was probably commands). Over the same 30 days this script finds 58 sessions that hand-rolled a browser outside a loom checkout (1.9 a day, 2.8% of 2,082 sessions; 9 searched first), 205 of 298 that needed a browser used a browser tool, and 11 lints from `~/loom`. But 57 of those 58 hand-rolled sessions fall in the last 14 days, so a 30-day baseline would understate the rate just before the change and read a post-change fall as a rise. The re-count compares this script with itself over the window it runs by default.

1052 sessions (1049 loom threads) modified in the last 14 days; 765 forks and /tmp dev instances dropped.

### Browser

| Sessions                                                                                     | Count        |
| -------------------------------------------------------------------------------------------- | ------------ |
| needed a browser (used a browser tool or hand-rolled one)                                    | 174          |
| used a browser tool (`preview_*`, `html_preview`, pi-browser `browser_*`)                    | 87           |
| hand-rolled one (`--headless`, `playwright install`, `page.goto`, ...)                       | 91           |
| of those, outside a loom checkout (where a loom install is not the project's own test setup) | 57 (4.1/day) |
| of those, never called `tool_search`                                                         | 44           |
| of those, called `tool_search` before the first hand-rolled command                          | 9            |
| got the command guard's browser note                                                         | 6            |

### MDX linter outside a loom checkout

Sessions outside a loom checkout that wrote a `.mdx` or ran the linter, by the path the linter ran from (a session can use more than one). Target: the wrapper only, `~/loom` at 0.

| Sessions                                     | Count        |
| -------------------------------------------- | ------------ |
| authored MDX                                 | 62           |
| linted via lint-doc.sh wrapper               | 1            |
| linted via ~/loom                            | 11 (0.8/day) |
| linted via release path                      | 46           |
| linted via checkout-relative                 | 0            |
| linted via other path                        | 3            |
| hunted for the linter (`find`/`fd`/`locate`) | 17           |
| never linted                                 | 5            |

### Capability searches

| Measure                                    | Count               |
| ------------------------------------------ | ------------------- |
| `tool_search` calls                        | 208 in 121 sessions |
| found nothing (`No matching tools`)        | 4 in 4 sessions     |
| `find /` or `find ~` hunts                 | 12 sessions         |
| got the search guard's bounded-search note | 5 sessions          |

Most frequent queries that found nothing (a family that does not exist yet, or a phrasing that misses):

| Query                        | Times |
| ---------------------------- | ----- |
| schedule_task recurring task | 1     |
| wayfinder                    | 1     |
| schedule_task                | 1     |
| bash shell execute command   | 1     |
