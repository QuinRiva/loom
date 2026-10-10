---
manager_sessions:
  - id: 24c2c1a3-d576-439d-84a8-0faf8263a28c
    name: Platform-update runbook (pi bump + model rollover)
    role: plan
    authored_at: 2026-09-23T14:54:52.652Z
---

# Platform update: pi bump and model rollover

This is the **single runnable procedure** for moving loom's pi runtime to a new
version. Rolling the fleet's model defaults forward is the pi-craft
`platform-update` skill
(`~/pi-craft/plugins/pi-craft/skills/platform-update/SKILL.md`): it owns the
list of every place a model slug lives (`targets.yaml`), writes the new slugs,
and reports before → after per target. It runs the steps below and links here
for their mechanics.

It links out rather than repeating:

- patch mechanics for the bundled pi → [`infra/pi-patches/README.md`](../../infra/pi-patches/README.md)
- re-scoring the routing matrix → [`model-profiles.md`](model-profiles.md#re-scoring-routine-for-a-new-model)
- landing the PR → [`shipping.md`](shipping.md)
- deploying the cockpit → `~/loom-releases/RUNBOOK.md` (`deployctl`)
- rebuilding cli-proxy → `/home/Carl/cli-proxy/AGENTS.md`

A pi bump and a model rollover are separable, but they couple through the
catalogue: a model no pi on the machine knows cannot be rolled to. Read the
[order of operations](#3-order-of-operations) either way.

## 1. Preflight

**Pick the pi version.** `@earendil-works/*` publish in lockstep; the version of
`@earendil-works/pi-coding-agent` is the only one you choose.

```bash
npm view @earendil-works/pi-coding-agent version time --json | tail -5
```

Take the newest release, even one published today: loom sets
`minimumReleaseAge: 0` in `pnpm-workspace.yaml`, so pnpm 11's release-age gate
does not apply.

**Confirm the models you want are in that version's catalogue — before touching
anything.** The catalogue ships in `@earendil-works/pi-ai`, and the version that
matters is **the same number as pi-coding-agent**: pi's `bin.pi` is an esbuild
bundle with the catalogue **inlined at publish time**, so the `^`-ranged pi-ai
in `node_modules` governs only the readable `dist/` tree, never the binary loom
runs.

```bash
V=0.99.2
cd "$(mktemp -d)" && npm pack "@earendil-works/pi-ai@$V" --silent && tar xzf *.tgz
ls package/dist/providers/data/                      # one JSON per provider
python3 - <<'EOF'
import json
for f, api in (("anthropic", "anthropic-messages"), ("openai-codex", "openai-codex-responses")):
    d = json.load(open(f"package/dist/providers/data/{f}.json"))
    for k in d:                                       # keyed {"<api>": {"<model-id>": …}} (≥0.99: "chat:<model-id>"), not a `models` array
        for m in d[k]:
            if any(s in m for s in ("opus-5-5", "gpt-6")):
                e = d[k][m]; print(f, m, e["cost"], e["contextWindow"], e["maxTokens"], e.get("thinkingLevelMap"))
EOF
```

This catalogue is the whole of what that pi version can run: the skill resolves
each tier's new slug from it, and the custom providers derive their entries
from it (§2, row 4). A model missing here exists on no provider until a later
pi ships it.

**Check the Claude Code version pi will impersonate.** Anthropic gates new
models on the claimed Claude Code version, and there are _two_ independent
claimants: pi (direct `anthropic-*` providers) and cli-proxy (`cliproxy/*`).

```bash
grep -o "2\.1\.[0-9]*" package/dist/api/anthropic-messages.js | sort -u   # same pi-ai tarball as above
```

If a new Claude model is going through the pool, ask cli-proxy first — it is
the longest pole (§3, step 1).

## 2. Surface map

What a pi bump touches, and the two catalogues that decide which models exist.
"Effect" says when a change is visible: **live** = the next pi process / next
spawn picks it up with no restart; **restart** = a service restart;
**deploy** = only after the loom release is promoted.

The places a model **slug** lives — cockpit presets and defaults, failover
chains, the global pi defaults, `PI_DEFAULT_MODEL` — are not listed here. They
are the targets in the skill's `targets.yaml`, the single list; the skill
writes them and prints each one's before/after. Row numbers are kept from the
earlier map so the skill and its plan can cite them; the gaps are those
targets (5, 7, 13) and surfaces a rollover no longer edits (8, 9, 11).

Every surface here and every skill target is a **default** — a model chosen
with no explicit human pick or orchestrator opt-in — except the named presets
`coder-direct` and `reviewer-gpt` and the `openai-codex/…` failover keys, which
are **opt-in**. Default surfaces run Claude; putting an OpenAI model on one
needs Carl's yes first (the `platform-update` skill asks).

| #   | Surface                             | Path                                                                                                                                                                              | Kind          | Effect                | Why it matters                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Bundled pi version pin + pnpm patch | `apps/server/package.json` (exact pin), `pnpm-workspace.yaml` (`patchedDependencies` key), `patches/@earendil-works__pi-coding-agent@<v>.patch`                                   | repo          | deploy                | The cockpit's pi keeps the old builtin catalogue — and with it the old custom-provider catalogue (row 4). A mismatched patch key fails `pnpm install` loudly — the one failure that cannot be silent.                                                                                                                    |
| 2   | Global pi install                   | `/home/Carl/.n/lib/node_modules/@earendil-works/pi-coding-agent` (`which pi`)                                                                                                     | machine       | live                  | A stock global pi writes `~/.pi/agent/auth.json` non-atomically — and that file is shared by **every** pi on the machine, bundled ones included, so an unpatched terminal pi can hand a cockpit thread an empty credential store. Interactive `pi --session … --cwd …` also loses the flag.                              |
| 3   | Machine-wide builtin catalogue      | `~/.pi/agent/models-store.json` (refreshed by `pi update --models`)                                                                                                               | machine       | live                  | Nothing to edit. Builtin-provider models (`openai-codex/*`, `anthropic/*`, vertex, bedrock) come from here for every pi on the machine, **including a stale deployed bundle**. This is why GPT-6 ran on the deployed 0.86.0 cockpit with no deploy — and why a model probe passing proves nothing about the bundle (§7). |
| 4   | Custom-provider catalogues          | pi-craft `plugins/pi-craft/extensions/cliproxy.ts`, `anthropic-subs.ts`                                                                                                           | other project | with the loading pi   | Nothing to edit: both derive their models from pi's own bundled catalogue (`getBuiltinModels("anthropic")`) at extension load. A pi bump is what adds a model to `cliproxy/*` and `anthropic-<account>/*` — terminal pi at the global install (row 2), the cockpit at the deploy (row 15).                               |
| 6   | cli-proxy (Claude pool only)        | `/home/Carl/cli-proxy/docker-compose.yml` `image:` tag; upstream `internal/registry/models/models.json` + cloak pin in `internal/runtime/executor/helps/claude_device_profile.go` | other project | restart (~6 s outage) | Anthropic rejects the model with `Claude Code <old> does not support this model; version <floor> or newer is required` — even though `GET /v1/models` lists it.                                                                                                                                                          |
| 10  | Role prose                          | `roles/*.md`                                                                                                                                                                      | repo          | —                     | Nothing to edit: roles name model families and tiers (Opus = anthropic/medium, Sol = openai/medium), never versions.                                                                                                                                                                                                     |
| 12  | Tests that assert a default         | the fixtures asserting `PI_DEFAULT_MODEL`'s value                                                                                                                                 | repo          | —                     | The skill's loom PR updates them with the constant (the gate fails loudly otherwise); the ~100 fixtures that merely _use_ a slug stay as they are.                                                                                                                                                                       |
| 14  | Other patched pi extensions         | `~/.pi/agent/npm/node_modules/pi-total-recall/node_modules/@samfp/pi-memory/src/index.ts` (`grep -c "LOCAL PATCH (Carl)"` → 4)                                                    | machine       | live                  | Not touched by `npm install -g` of pi core; **is** wiped by `pi update --all`/`--extensions` on a version change. See `~/pi-craft/local-patches/README.md`.                                                                                                                                                              |
| 15  | Deploy                              | `~/loom-releases/RUNBOOK.md` → `deployctl deploy cockpit main`                                                                                                                    | machine       | —                     | Row 1 and the skill's loom PR stay on paper, and the cockpit cannot run a new `cliproxy/*` model.                                                                                                                                                                                                                        |
| 17  | Web search backend                  | `~/.pi/web-search.json` → `provider` (`exa`; absent means `auto`, which tries OpenAI first)                                                                                       | machine       | live                  | An unset provider sends every `web_search` through an OpenAI model on the Codex subscription.                                                                                                                                                                                                                            |
| 18  | Prompt-template provider preference | `pi-prompt-template-model` `PREFERRED_PROVIDERS` (`openai-codex` first)                                                                                                           | machine       | live                  | Note only: it breaks a tie only for a template naming a bare model id, and `~/.pi/agent/prompts/` is empty.                                                                                                                                                                                                              |

## 3. Order of operations

The machine-side steps (rows 2, 6, 14, and the skill's live targets) are
**live**: the moment you save, the next pi process or spawn uses them, and the
running cockpit re-reads its settings file within seconds. The repo steps
(row 1 and the skill's loom PR) do nothing until a deploy. The skill runs this
sequence and stops at its two human moments — the cli-proxy restart and the
deploy. Sequence so that nothing points at a model that nothing can serve:

1. **cli-proxy first, if a new Claude model is going through the pool.** Probe
   it with a real completion (§7). If rejected, the proxy needs a rebuild onto
   an upstream tag whose cloak pin ≥ the floor named in the error _and_ whose
   registry carries the model — two independent conditions; tags exist that
   satisfy one and not the other. **The deployed image is never stock**: it is
   the upstream tag plus a local fix branch (the model-scoped 429 failover that
   stops a loom session wedging on an exhausted account), so "upgrade" means
   _rebase that branch onto the new tag_, never _pull the tag_ — pulling
   silently reverts a live fix. Whether the patch can finally be dropped is
   decided by the absorption test, not by reading the changelog. Procedure,
   absorption test and restart approval are in `/home/Carl/cli-proxy/AGENTS.md`
   ("Hard rule", "Upgrading to a new upstream version"). Nothing downstream may point a default or
   preset at `cliproxy/<new model>` until this completion succeeds. Note the
   coupling: rolling the proxy image back later re-breaks every thread on the
   new model, so a proxy rollback and a preset rollback are one action.
2. **Bundled bump** (row 1, §4) on a feature branch, together with the skill's
   `PI_DEFAULT_MODEL` rollover and its fixtures (row 12) when a model moves.
   Gate, ship per `shipping.md`.
3. **Global pi** (row 2, §5) — after the bundled bump, so the re-derived diffs
   in `infra/pi-patches/` match the version you install. Check row 14 after.
   Terminal pi now derives the new custom-provider models (row 4); verify with
   `pi -p` per provider (§7).
4. **Model rollover** — the skill writes its live targets and probes each
   changed tier (§7). The preset flip needs neither deploy nor restart; it is
   the step that actually changes what tomorrow's threads run on. The
   exception is a `cliproxy/*` model only the new pi ships: the deployed
   cockpit derives that catalogue from its own, older pi (row 4), so the skill
   holds those targets until after step 5 (0.99.2's `claude-sonnet-5-5`).
5. **Deploy** (row 15) per `~/loom-releases/RUNBOOK.md`. Confirm the promoted
   release resolves the new pi:
   `grep '"version"' "$(readlink -f ~/loom-releases/current/apps/server/node_modules/@earendil-works/pi-coding-agent)/package.json"`.

Why builtin models can be rolled _before_ a pi bump: row 3. A Codex/OpenAI/
Vertex model that is already in `models-store.json` validates and runs on the
deployed cockpit today. Custom-provider models cannot — row 4 derives them from
the loading pi's bundled catalogue, so a new `cliproxy/*` model reaches the
cockpit only with the deploy that bumps its pi.

## 4. The bundled bump

Mechanics — retirement check, moving the pins, regenerating the pnpm patch,
re-deriving the stored diffs, the verification list — are in
[`infra/pi-patches/README.md`](../../infra/pi-patches/README.md). Follow it top
to bottom. Two things it cannot know about your situation:

- **A pi bump does not propagate to sibling worktrees.** A worktree that merged
  the bump commit still has the old pi in `node_modules` until `pnpm install`
  runs there. Any step that says "test the bundled pi" must start with
  `pnpm install` and then assert the version — otherwise the probe exercises
  the old binary and passes anyway (row 3 supplies builtin-provider models).
- The pnpm patch is version-scoped, so **model rollover and pi bump can ship
  as one PR or two, but the bump must not be split across branches**: pin,
  `patchedDependencies` key and patch file move together or `pnpm install`
  refuses.

## 5. The global install

```bash
V=0.99.2
npm install -g "@earendil-works/pi-coding-agent@$V"     # not `pi update`
pi --version                                             # → 0.99.2
<loom worktree>/infra/pi-patches/apply.sh                # readable dist, then the bundle
<loom worktree>/infra/pi-patches/apply.sh --check        # 0001: applied=yes  0002: applied=yes  chunk-…: already patched
grep -c "LOCAL PATCH (Carl)" ~/.pi/agent/npm/node_modules/pi-total-recall/node_modules/@samfp/pi-memory/src/index.ts   # → 4
```

`npm install -g` rather than `pi update` because it installs the **exact**
version the bundled pin and the re-derived diffs were made for; `pi update`
installs latest, which can be newer than the bundle, and `--all`/`--extensions`
also reinstalls extensions and wipes row 14. Either path replaces the stock
files, so the patches are re-applied afterwards regardless.

`apply.sh` leaves `*.orig` next to each patched file on this path. That is its
emergency-restore behaviour — keep them. (On the _bundled_ path they must be
deleted before `pnpm patch-commit`; the README says so.)

Running pi processes keep the old code; nothing needs killing.

## 6. Retirement check

Run once per bump, against the **pristine** tarball
(`npm pack @earendil-works/pi-coding-agent@$V`), before anything else. The bar
is proof, not plausibility — retiring a patch that is still needed fails
silently.

| Patch                        | Retire when                                                                                                                                                        | Proof standard                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 `--cwd` headless resume | `grep -n '"--cwd"' dist/cli/args.js` hits **and** `cwdOverride` reaches `dist/main.js`                                                                             | `apps/server/src/provider/Layers/Pi/PiCwdOverride.contract.test.ts` passes against **stock** — the README's bump order installs the new version unpatched before regenerating the pnpm patch; run the test at that moment. A native flag with different semantics still means keep. |
| 0002 atomic `auth.json`      | `grep -n "writeFileSync\|renameSync" dist/core/auth-storage.js` shows `renameSync` (or any write-then-rename) on **both** the `withLock` and `withLockAsync` paths | `atomic-window.mjs` (§7) reports all zeros against stock.                                                                                                                                                                                                                           |

Record the outcome in the README's patch section either way. So far: both kept
at 0.86.0, 0.87.1, 0.99.2, 1.0.2 and 1.1.0.

## 7. Verification

Commands and the output that means "good". Run them against **the binary in
question** — global `pi`, or the resolved bundle
`node "$(readlink -f apps/server/node_modules/@earendil-works/pi-coding-agent)/dist/bundle/cli.js"`
— never assume one stands in for the other.

**Contract test (bundle, `--cwd` patch)**

```bash
vp test run apps/server/src/provider/Layers/Pi/PiCwdOverride.contract.test.ts   # 6 passed, 0 skipped
```

It drives the resolved `bin.pi` over RPC, so a pass means the _bundle_ is
patched. A skip means it could not find the bundled pi — that is a failure.

**Atomic write (auth patch)** — readers must be **separate processes**;
in-process readers are serialised against the writer by Node's sync I/O and
report clean on stock.

```bash
cd /home/Carl/pi-craft/local-patches/authlock-repro && node atomic-window.mjs
# patched: zeroByte=0 unparseable=0 emptyObject=0 on all three readers; final file parses
# stock 0.87.1 (calibration): ~4–9 k zeroByte, ~600–800 unparseable per reader
# stock 0.99.2: ~2–3 M zeroByte, ~50–90 unparseable, ~300 good per reader, every run
```

The harness's import is hard-coded to the global install; for the bundled copy
point it at `<resolved package>/dist/core/auth-storage.js`. That proves the
readable tree; the bundle is proven by
`grep -c __loomWriteAuthAtomic dist/bundle/chunks/chunk-*.js` → 2 (one chunk) and no
remaining `writeFileSync(this.authPath,next,AUTH_FILE_WRITE_OPTIONS)`. A stock run
reporting _millions_ of zero-byte reads is usually a stalled writer, not a wider
window — rerun it. Stock 0.99.2 reports millions on every run, so there read the
unparseable count instead.

**`--cwd` parity in the bundle**

```bash
<binary> --session x --cwd '~/definitely-not-there'      # error names /home/Carl/definitely-not-there
<binary> --session x --cwd 'file:///nope-not-there'      # error names /nope-not-there
```

The expanded path proves the bundle still resolves through pi's own
`resolvePath`; a hand-rolled clone once dropped both forms silently.

**Model resolution per provider**

```bash
pi -p --model cliproxy/claude-opus-5-5 "Reply with exactly: OK"          # OK
pi -p --model anthropic-carl/claude-opus-5-5 "Reply with exactly: OK"    # OK  (direct, bypasses the proxy)
pi -p --model openai-codex/gpt-6-sol "Reply with exactly: OK"            # OK
pi -p --model openai-codex/gpt-6-nonesuch "Reply with exactly: OK"       # negative control
```

Read failures precisely. `Warning: Model "…" not found for provider "…"` is
a catalogue miss (rows 3/4). `Codex error: The usage limit has been reached` is
quota — the slug resolved and reached the backend, and the old slugs fail the
same way; the negative control fails _differently_, which is how you tell the
two apart. `Claude Code 2.1.x does not support this model; version 2.1.y or
newer is required` is the cloak pin (row 6 if via `cliproxy/`, pi's own if
direct) — the catalogue entry is fine.

**cli-proxy readiness** — only a completion counts; `GET /v1/models` has listed
a model the binary could not serve:

```bash
cd /home/Carl/cli-proxy && curl -s -m 300 -H "Authorization: Bearer $(cat .apikey)" -H "content-type: application/json" \
  -X POST http://127.0.0.1:8317/v1/messages \
  -d '{"model":"claude-opus-5-5","max_tokens":200,"messages":[{"role":"user","content":"Probe '"$(date +%s%N)"'. Reply with exactly: OK"}]}'
# accept iff "model":"claude-opus-5-5", "stop_reason":"end_turn"
```

Unique probe bodies matter — session affinity binds identical bodies to one
account, so repeats test a single credential, not the pool.

**The live cockpit picked up a settings edit** — zero-cost, no spawn. Point a
spare preset at the new slug, then read the preset block that
`mcp__t3-code__workstream_list` prints from any thread: the entry appears with **no
`[INVALID …]` marker** iff the running server's live catalogue accepts it.
Always run a bogus slug as a negative control (`cliproxy/claude-opus-9-9`) —
the check is skipped when an instance advertises an empty catalogue, so a clean
render without the control proves nothing. Revert the probe.

Editing the live file (mode-preserving, atomic; the server re-reads it within
seconds):

```bash
python3 - <<'EOF'
import json, os, tempfile, shutil, time
p = '/home/Carl/.t3/cockpit/userdata/settings.json'
shutil.copy2(p, f'/home/Carl/.t3/cockpit/userdata/backups/settings.json.bak-{time.strftime("%Y%m%d-%H%M")}')
d = json.load(open(p))
for r in ('coder', 'researcher'):
    d['workstreamModelPresets'][r]['model'] = 'cliproxy/claude-opus-5-5'
out = json.dumps(d, indent=2) + '\n'; st = os.stat(p)
fd, t = tempfile.mkstemp(dir=os.path.dirname(p), prefix='.settings.json.')
os.write(fd, out.encode()); os.fsync(fd); os.close(fd); os.chmod(t, st.st_mode & 0o7777); os.replace(t, p)
EOF
```

Never open `state.sqlite` and never restart the cockpit for this.

**Repo gate**: `vp check` (0 errors), `vp run typecheck` (exit 0),
`docs/upstream-sync/pull7-tools/unmarkedsweep.sh` clean, and
`rg -n "<old slug>|<Old Name>" --glob '!patches/**' --glob '!**/*.test.*'`
leaves only legacy catalogue entries, the Codex fallback chain and historical
docs.

## 8. Gotchas

Each of these cost real time in the last two rounds.

- **`bin.pi` is the bundle, not the readable `dist/`.** Patching `dist/` alone
  leaves the binary loom runs unpatched, with no error. Every check in §7 that
  matters targets `dist/bundle/`.
- **The catalogue is inlined into that bundle.** New builtin models arrive with
  the pi-coding-agent version, not with a `pi-ai` resolution; only
  `models-store.json` (row 3) can front-run a bump, and only for builtin
  providers. A `models.json` entry (§9) stands in when the overlay lags.
- **A probe that passes on a stale bundle.** Sibling worktrees keep the old pi
  until `pnpm install`; row 3 supplies builtin-provider models regardless; the probe
  goes green. Assert the version first.
- **Two cloak pins.** pi's (`pi-ai/dist/api/anthropic-messages.js`) and
  cli-proxy's (compiled into the Go binary). A correct catalogue entry is
  rejected until the relevant one clears the floor Anthropic names in the
  error. `claude update` on the host is irrelevant — it is not on the request
  path. Registry presence in cli-proxy ≠ servable; a rollback of the proxy
  image reverts the pin.
- **`/v1/models` lies.** The old proxy image advertised `claude-opus-5-5`
  while rejecting every request for it. Completion or nothing.
- **`pi update` wipes patches** — the core patches on `pi update`/reinstall,
  the total-recall patch on any extension version change. Re-run `apply.sh`
  and check the marker count after either.
- **`pnpm patch --ignore-existing` and a stale editable dir.** It silently
  reuses `/tmp/pi-patch-<v>` from a previous attempt, baking old edits into
  what you think is the pristine base. `rm -rf` it first and `diff -r` against
  the tarball before patching.
- **`pnpm patch` chicken-and-egg.** `pnpm patch pkg@<new>` refuses until that
  version is installed; `pnpm install` refuses while `patchedDependencies`
  names a patch file that does not exist, and so does `pnpm patch` itself.
  Remove the entry, install, patch, then `patch-commit`, which writes the
  entry back — in that order.
- **`patch` leaves `.orig` files on any offset.** Delete them before
  `patch-commit` on the bundled path; keep them on the global path.
- **In-process readers report clean.** The atomic-write harness only means
  anything with separate-process readers. A stock run showing millions of
  zero-byte reads is usually a stalled writer — rerun, don't record (stock
  0.99.2 is the exception, see §7).
- **The bundle chunk filename changes every release** (`chunk-7YM6BE7Y.js` →
  `chunk-OJP47DM6.js`), and from 0.99 the two patches land in different
  chunks. `patch-bundle.mjs` finds each by content; do not hard-code a chunk
  name anywhere else.
- **New pi packages need license notices.** `@earendil-works/*` packages ship
  no LICENSE file, so each one pi adds (0.99 added `pi-codemode` and
  `pi-mcp`) fails the web build's license generation until it has a
  `packageOverrides` entry in `third-party-licenses.config.json`. Neither
  `vp check` nor typecheck catches it; the README's verification list does.
- **Presets are settings, not code.** A shipped, deployed rollover changes
  nothing a child runs on until the skill writes the live cockpit settings. Conversely, the edit is live
  in seconds — there is no "deploy" to hide behind if it is wrong.
- **Codex quota reads like a rollover failure.** `usage limit has been reached`
  on the new slugs is the account, not the catalogue; the old slugs fail
  identically. Use the negative-control slug to prove resolution.

## 9. One new model between updates

The skill decides which tier and targets move ("One new model between
updates"). This section gets pi to serve the model and proves it.

**Check whether pi already serves it.** Builtin-provider models reach every pi
on the machine through the pi.dev overlay (row 3), often before any pi release
ships them: `gpt-6.1-sol` was in `models-store.json` on 2026-09-29, a day
before pi-ai 0.99.2 published it.

```bash
pi update --models                  # force the overlay refresh (pi otherwise re-checks at most every 4 h)
pi --list-models | grep <id>        # listed → skip to "Point and test"
```

If `pi update --models` fails for one provider (for example
`anthropic: … invalid_grant`), it still refreshes the others. `--list-models`
is the check that counts.

**If it is not listed, register it in `~/.pi/agent/models.json`.** Copy the
entry from a pi-ai catalogue that has it (§1's `npm pack`), minus `provider`
and `type`. The snippet appends to an existing file:

```bash
python3 - <<'EOF'
import json, os
F = os.path.expanduser("~/.pi/agent/models.json")
P, API, ID = "openai-codex", "openai-codex-responses", "gpt-6.1-sol"
e = json.load(open(f"package/dist/providers/data/{P}.json"))[API][f"chat:{ID}"]   # pre-0.99 keys are bare ids
for k in ("provider", "type"): e.pop(k, None)
m = json.load(open(F)) if os.path.exists(F) else {}
m.setdefault("providers", {}).setdefault(P, {}).setdefault("models", []).append(e)
json.dump(m, open(F, "w"), indent=2)
EOF
```

pi 0.87.1 accepts this entry as is (checked with `gpt-6.1-sol`), and it
overrides an overlay or bundled model with the same id.

**Point and test.** Write the targets with the skill's `--set`, then probe both
binaries and run the §7 `mcp__t3-code__workstream_list` check, using a bogus id of the same
family as the negative control:

```bash
B="node $(readlink -f ~/loom-releases/current/apps/server/node_modules/@earendil-works/pi-coding-agent)/dist/bundle/cli.js"
for bin in pi "$B"; do $bin -p --model openai-codex/gpt-6.1-sol --thinking high "Reply with exactly: OK"; done   # OK, OK
```

There is no restart or deploy. The cockpit re-reads its settings within
seconds and re-probes pi's catalogue every ~2 min, so right after a `models.json`
edit `mcp__t3-code__workstream_list` may show `[INVALID]` for up to 2 min.

**Once a pi bump ships the model,** delete its `models.json` entry, and check
that `pi --list-models` still lists the model. The targets need nothing: the
skill now resolves the tier to that id itself.
