# Upstream sync

How Loom pulls from upstream T3 Code, and the record of every pull. Documents
are numbered in the order they were written.

- **01–15**: the first full merge onto upstream: history, fork deltas, drift,
  conflict surface, strategy (`05-strategy.md`), and the reviews that gated it.
- **16 onward**: one runbook per cadence pull, plus a few topic documents a
  pull spun off (`22-migration-lane-split-plan.md` for the two migration
  ledgers, `23-sidebar-v2-rehome.md` for the `// loom:` marking convention).
- **`pull7-tools/`, `pull9-tools/`**: the merge tooling each runbook's tooling
  section names (`hx.py`, `sideresolve.py`, `unmarkedsweep.sh`, `remeasure.sh`,
  `dangling.py`, …). `unmarkedsweep.sh` also gates `pnpm ship`.
- **`UPSTREAM_BASE`**: the upstream commit the last pull merged; the next pull
  diffs from here.

## A pull's runbook

From pull 12 (`37-…`) on, a runbook is a directory, not a file. The latest is
[`39-cadence-pull-14-20261101/`](39-cadence-pull-14-20261101/); a new pull's S0
starts from its shape:

```
NN-cadence-pull-<n>-<date>/
  README.md               status, layout, contents, and the sequencing section:
                          one row per session with the files it reads
  00-headline.md …        one file per numbered section, prefixed by its number
  a-….md, b-….md …        one file per appendix
  decision-log.md         the ledger: one table, a row per decision, cited as DL-nnnn
  s3-record.md, s4-record.md, deploy.md     session records and deploy notes
  clean-overlap-review.md, clean-overlap-zones.md   Gate 2's tables and zone lists
```

A session reads its row in the README and the files that row names, and greps
`decision-log.md` rather than reading it whole. Code and docs cite ledger rows
by number (`DL-1404`), never by path. Markdown here is excluded from `vp fmt`,
which would pad every table column to its widest cell; keep table cells
unpadded (`| a | b |`).

The history of a runbook from before it was split is under its old file name:
`git log -- docs/upstream-sync/39-cadence-pull-14-20261101.md`.
