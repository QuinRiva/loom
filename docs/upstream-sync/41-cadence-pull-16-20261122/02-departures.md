## 2. Departures from pull 15's shape

### 2.1 S1 is one merge resolved by a lead and six lanes, not one coder

Pull 15's S1 was one coder, the whole tree, one sitting. That does not hold
at this size, and the alternative chosen keeps what mattered about it (one
merge, one merge commit, one doctrine).

**The evidence.** The largest merge one coder has resolved is pull 13: 173
paths, 418 markers of which 130 were mechanical (Rule A and Loom-side-only
hunks `sideresolve.py` handles), 1,091 `loom:` lines; Gate 1 found one
dropped Loom line. This pull is 193 paths and 513 markers of which 56 are
the lockfile and almost none are mechanical: about 416 hunks need a read of
both sides, against pull 13's 281, with 1,530 `loom:` lines, 98 hunks with a
side of 20 lines or more, and resolutions that depend on six rulings and
three re-homings into files that do not conflict. The doctrine for it is
thirteen zone files, about 280 KB. One session cannot hold that and the
files it is editing; it would work from compacted summaries of rules by the
second hundred hunks, which is where a dropped line comes from.

**The options.**

| Shape | For | Against |
| --- | --- | --- |
| One coder, whole tree (pull 15) | Proven up to pull 13's size; nothing concurrent | About 1.5 times pull 13's hand-resolved hunks with far more doctrine; the session loses the rules to compaction; serial, while upstream adds about 240 commits a day |
| Sequenced sessions on the same uncommitted merge, one zone group after another | Each session starts fresh with its own zone files; nothing concurrent | The same wall-clock as one coder (about four pull-15 S1s end to end); the uncommitted tree sits for days |
| **A lead and six lanes in parallel on the same uncommitted merge (chosen)** | Each lane is at most one pull-15-sized S1 with fresh context for its zone files; wall-clock is the longest lane | Several writers in one worktree; an uncommitted tree shared by seven threads |
| Split the pull in two (merge an intermediate upstream commit first) | Two ordinary pulls | Every seam is resolved twice against a moving middle; the features that collide (#33131, #27866, #37893, #35925) landed across the whole fortnight |

**Why parallel lanes are safe here.** Appendix B partitions the 193 paths
into zones with no file in two, so no two lanes edit one file. Textual
resolution is per file; the cross-file agreements are few and are written
down (§7.3). The hazards of a shared uncommitted merge are a git command
that rewrites the tree or the index, and two threads editing one shared
file. §7.2 removes both: only the lead runs index-writing git commands; lanes
resolve by editing files and read stages with `git show :N:`; each lane
writes its decision-log rows to its own file; each finished file is copied
aside, so a lost tree is recoverable per lane.

**The lanes** (sizes from Appendix B; "units" are pull 15's whole S1 = 121
non-lockfile markers and 701 `loom:` lines, by the larger of the two ratios):

| Thread | Zones | Paths | Markers | `loom:` lines | Size |
| --- | --- | ---: | ---: | ---: | --- |
| S1 lead: open and close | B.1 config, lockfile, docs | 15 | 83 (27 without the lockfile) | 26 | 0.25, plus the open and close steps |
| Lane 1 server core | B.2 orchestration, B.3 store and search, B.4 server entry, B.5 MCP | 41 | 94 | 340 | 0.8 |
| Lane 2 providers and usage | B.6 providers, B.7 usage | 31 | 88 | 261 | 0.7 |
| Lane 3 VCS and projects | B.8 | 23 | 53 | 152 | 0.45 |
| Lane 4 web chat | B.9 | 23 | 57 | 210 | 0.5 |
| Lane 5 web panels and sidebar | B.10, B.11 | 34 | 97 | 388 | 0.8 |
| Lane 6 client | B.12 contracts and settings, B.13 mobile | 26 | 41 | 153 | 0.35 |
| **total** | | **193** | **513** | **1,530** | **about 3.9 in sequence; about 1 in parallel after the lead opens** |

Two adjacent lanes may be given to one coder to run in sequence (3 after 2;
6 after 4); a lane is not split further, because its zone files cross-refer.
If the orchestrator would rather not run concurrent writers at all, the same
seven briefs run in sequence in the order lead-open, 6, 1, 2, 3, 4, 5,
lead-close, with nothing else changed.

### 2.2 The other departures

- **§8.1 is not empty.** Fifteen rows for Carl, against none in pull 15,
  because this fortnight's upstream features land on ground Loom occupies.
  Each has a recommended answer that S1 works under.
- **Gate 1 is two reviewers** (server; client), reading the zone files' marked
  rows and §7.5's list. One reviewer cannot read about 140 flagged hunks.
- **S2b is the heavier integration track this time.** The server track has no
  toolchain sweep (no new Effect diagnostics); the web track carries the i18n
  exclusion and wraps, the context meter's re-home, three markdown ports, the
  right-panel store version, the diff patch hunk and a `/preview` screenshot
  pass. S2b may be split into web and mobile-plus-client-runtime if the
  orchestrator wants them in parallel.
- **A screenshot pass is a definition of done, not a nicety.** The markdown
  rewrite and the i18n wrapping put every Loom surface that renders text at
  risk without a type error. S2b's `/preview` pass and S4's dev-verify pass
  are listed fixture by fixture in §9.
- **Unmarked files are assigned.** Seven compile breaks and three behavioural
  defects sit in files with no conflict marker (§6.14, §7.3). S1 edits the
  ones a wrong merge would otherwise bake in; S2 owns the rest by name.
- **S3 puts its database copy on `/mnt/fast`.** The root disk is at 97 to
  98 % and its free space moved between 53 GB and 32 GB within an hour during
  S0. The cockpit database is 4.73 GB, not "over 10 GB" (pull 15's pruning
  shrank it), so the copy is small; the install is what needs room (§12).
- **Tools are committed.** `hunks.py`, `peek.py`, `imports.py`, `overlap.py`,
  `composition.py` and `prdigest.sh` are in this runbook's
  [`tools/`](tools/); pulls 13 to 15 rewrote them each time because they
  lived in `/tmp`.
- **A premise of pull 15's runbook is retired, not carried:** the event-prune
  guard (§5.5).
