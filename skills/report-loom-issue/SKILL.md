---
name: report-loom-issue
description: >-
  Park a bug in Loom itself (the T3 Code fork, its pi extensions/workstream
  tools, roles/skills, cockpit deploy, pi upstream), not your project, as a
  GitHub issue for triage. Use when you notice Loom is broken, verified or
  not, and it is not your task. Own diff: fix it. Requested Loom work: do it.
pi_global: true
---

# Report a Loom issue

Mid-task, something in Loom misbehaves — a `workstream_*` tool returns the
wrong thing, the sidebar shows a stale lane, a deploy left a skill unlinked.
Fixing it derails your task; describing it in your report buries it. The third
option: park it as a GitHub issue on `QuinRiva/loom` in under a minute and
carry on. The board is **public** and most reporters work on private client
data; that constraint shapes everything below.

## When this applies

| Situation                                                         | Action                                |
| ----------------------------------------------------------------- | ------------------------------------- |
| Loom is broken and that is not what you were asked to fix         | **File it**                           |
| Something in Loom looks wrong; you have not verified it           | **File it, `--confidence suspected`** |
| Bug in the project you are working on (fathom, anything non-loom) | `report-latent-issue`, not this       |
| You broke it / it is in the diff you are writing                  | Fix it now. No issue.                 |
| Loom work the user asked for                                      | Just do it                            |
| Style nit, "I'd have designed this differently"                   | Neither. Let it go.                   |

Pi upstream bugs are filed here too — never on pi's own tracker.

File it, report the issue URL to the user or your parent in one line, and
continue what you were doing. **Never start work on an issue you filed unless a
human asks.** The board is a parking lot, not a queue.

## Filing

```bash
bash scripts/report_issue.sh \
  --summary "workstream_submit with outcome=clean leaves the coder lane in_progress" \
  --confidence suspected \
  --surface workstream-tools \
  --description-file /tmp/loom-finding.md
```

(Resolve `scripts/…` and `references/…` against this skill's directory.)

| Flag                 | Required | Notes                                                                              |
| -------------------- | -------- | ---------------------------------------------------------------------------------- |
| `--summary`          | Yes      | The observable **symptom**, one line, not your theory of the cause                 |
| `--confidence`       | Yes      | `confirmed` or `suspected` — see below                                             |
| `--surface`          | Yes      | One of `web` `server` `workstream-tools` `roles-skills` `cockpit` `pi` — see below |
| `--description-file` | Yes*     | Markdown following `references/issue-template.md`. *Or `--description`             |
| `--description`      | Yes*     | Inline markdown; same template applies. Prefer the file form                       |
| `--force`            | No       | Skip the duplicate check (after it flagged candidates you judged different)        |
| `--template`         | No       | Print the template and exit                                                        |

| Exit | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| `0`  | Created; issue URL on stdout, everything else on stderr                            |
| `1`  | Missing/invalid flag, missing template section, or `gh` failed — message on stderr |
| `2`  | Leak guard tripped — pattern and offending line on stderr; nothing created         |
| `3`  | Strong duplicate — candidates on stderr; nothing created                           |

The script labels the issue `bug`, `needs-triage`, `agent-found`,
`confidence:<x>`, `surface:<x>` — you pass no labels. It also **appends a
footer** you never write: that an agent filed this under the human's account,
the Loom release id and commit permalink, the bundled pi version,
`$PI_PROVIDER/$PI_MODEL`, the thread id, and the confidence as filed. The
project line reads `QuinRiva/loom @ <branch> (<sha>)` only when the worktree's
origin is `QuinRiva/loom`; from anywhere else it reads "a non-loom project". Do
not repeat any of this in the body.

### `confirmed` vs `suspected`

- **`confirmed`** — you reproduced it, or read the path end-to-end and are
  certain. Your Evidence section shows it.
- **`suspected`** — it looks wrong but you have **not** verified it, and you may
  be misreading how Loom fits together. The honest default for anything found
  side-on.

Do not upgrade a guess to `confirmed` because it feels more useful. A wrong
`confirmed` costs a human a triage session; an honest `suspected` costs nothing.

### The template

The script **rejects** a body missing a heading for **Evidence**, **Not
verified**, or **Alternative explanations**:

- **Evidence** — only what you actually saw: repo-relative `file:line`, the
  command you ran and (paraphrased) what came back. "The code reads like it
  does X" is acceptable _if you say so and cite the lines_.
- **Not verified** — what you did **not** check. Be generous; this bounds the
  claim and stops a human chasing a phantom.
- **Alternative explanations** — at least one way this could be correct
  behaviour you misread. If you truly cannot think of one, say why not.

Full template: `--template`, or `references/issue-template.md`.

### `--surface` — where a triager starts

| Value              | Covers                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`              | What you see in the app: chat, sidebar, plan/task views, rendering, Electron shell                                                            |
| `server`           | Threads, turns, persistence, provider adapter, checkpoints, WebSocket, pairing                                                                |
| `workstream-tools` | The pi tools Loom injects (`workstream_*`, `goal_*`, `consult_thread`, `notify_thread`), their routing and gates, the prompt text they inject |
| `roles-skills`     | `roles/*.md`, Loom's `skills/`, the AGENTS overlay, the work-model doctrine                                                                   |
| `cockpit`          | Release/deploy: `~/loom-releases`, deployctl, the systemd unit, `pi_global` linking, worktree provisioning                                    |
| `pi`               | pi upstream (`@earendil-works/pi-coding-agent`): bash/read/edit tools, session replay, providers, TUI                                         |

_A triager starts here_, not _the bug is provably here_. Cause untraced → the
surface you hit it on, and say so.

## The board is public — redaction rule

The issue describes **Loom's behaviour only**. Never name the project, client,
tenant, building, person, host, branch, worktree path or thread title you were
working on. Cite Loom files as repo-relative paths or permalinks. Paraphrase
rather than paste logs, `env` output or tool results from non-loom work — the
environment holds a live bearer token and thread titles carry client names.

A **leak guard** runs over your summary and body and **refuses to file** (it
does not scrub) on: private org or client names, `.ts.net` and internal
hostnames, Jira keys (`PE-nnnn`, `AIT-nn`), anything shaped like a bearer or
pairing token, email addresses, any `/home/<user>/` path, any `worktrees/`
path. It names the pattern and the line. Rewrite the passage; there is no
override flag.

## The duplicate check

Threads run in parallel and trip over the same Loom bug, so before creating
anything the script lists open issues and scores their titles against keywords
from your summary. A **weak** match is printed as context and filing proceeds.
A **strong** match exits 3 with the candidates and creates nothing — a decision
point, not an error to route around:

- **Same issue** → add your sighting as a comment instead; a second independent
  sighting on one issue is worth more than a second issue:
  ```bash
  gh issue comment <n> -R QuinRiva/loom -F /tmp/loom-finding.md
  ```
  Comments get no footer, so end yours with your thread id (`$PI_SESSION_ID`).
  The redaction rule applies to comments too.
- **Genuinely different** → re-run with `--force` and say in the body how it
  differs from the issue(s) shown.
- **Unsure** → `gh issue view <n> -R QuinRiva/loom --comments` first.

## After filing

The inbox is `gh issue list -R QuinRiva/loom -l needs-triage -l agent-found`;
read it only when a human asks you to triage. `duplicate`, `invalid`,
`wontfix` and closing are the human's moves — an agent touches a filed issue
only when told to.
