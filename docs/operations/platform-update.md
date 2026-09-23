---
manager_sessions:
  - id: 24c2c1a3-d576-439d-84a8-0faf8263a28c
    name: Platform-update runbook (pi bump + model rollover)
    role: plan
    authored_at: 2026-09-23T14:54:52.652Z
---

# Platform update: pi bump and model rollover

This is the **single runnable procedure** for moving loom's pi runtime to a new
version and rolling the fleet's model defaults forward. It exists because model
identity and the pi version live in nine places across three repos and the
machine, and only one of them (`infra/pi-patches/`) was written down before.

It links out rather than repeating:

- patch mechanics for the bundled pi → [`infra/pi-patches/README.md`](../../infra/pi-patches/README.md)
- re-scoring the routing matrix → [`model-profiles.md`](model-profiles.md#re-scoring-routine-for-a-new-model)
- landing the PR → [`shipping.md`](shipping.md)
- deploying the cockpit → `~/loom-releases/RUNBOOK.md` (`deployctl`)
- rebuilding cli-proxy → `/home/Carl/cli-proxy/AGENTS.md`

A pi bump and a model rollover are separable. Do only the parts that apply, but
read the [order of operations](#3-order-of-operations) either way — the two
couple through the catalogue.

## 1. Preflight

**Pick the pi version.** `@earendil-works/*` publish in lockstep; the version of
`@earendil-works/pi-coding-agent` is the only one you choose.

```bash
npm view @earendil-works/pi-coding-agent version time --json | tail -5
```

pnpm 11 refuses packages younger than 24 h unless they are in
`pnpm-workspace.yaml` → `minimumReleaseAgeExclude`; a same-day pi needs all six
`@earendil-works/*` entries there moved to the new version (the README covers
it). Prefer a release older than a day.

**Confirm the models you want are in that version's catalogue — before touching
anything.** The catalogue ships in `@earendil-works/pi-ai`, and the version that
matters is **the same number as pi-coding-agent**: pi's `bin.pi` is an esbuild
bundle with the catalogue **inlined at publish time**, so the `^`-ranged pi-ai
in `node_modules` governs only the readable `dist/` tree, never the binary loom
runs.

```bash
V=0.87.1
cd "$(mktemp -d)" && npm pack "@earendil-works/pi-ai@$V" --silent && tar xzf *.tgz
ls package/dist/providers/data/                      # one JSON per provider
python3 - <<'EOF'
import json
for f, api in (("anthropic", "anthropic-messages"), ("openai-codex", "openai-codex-responses")):
    d = json.load(open(f"package/dist/providers/data/{f}.json"))
    for k in d:                                       # keyed {"<api>": {"<model-id>": …}}, not a `models` array
        for m in d[k]:
            if any(s in m for s in ("opus-5-5", "gpt-6")):
                e = d[k][m]; print(f, m, e["cost"], e["contextWindow"], e["maxTokens"], e.get("thinkingLevelMap"))
EOF
```

Write down `cost`, `contextWindow`, `maxTokens` and `thinkingLevelMap` for each
new model. You will copy them into the hand-maintained extension catalogues
(§2, row 4), and they are **not** "the previous model with a new name" — Opus 5.5
was cheaper than Opus 5 and dropped two thinking levels.

**Check the Claude Code version pi will impersonate.** Anthropic gates new
models on the claimed Claude Code version, and there are _two_ independent
claimants: pi (direct `anthropic-*` providers) and cli-proxy (`cliproxy/*`).

```bash
grep -o "2\.1\.[0-9]*" package/dist/api/anthropic-messages.js | sort -u   # same pi-ai tarball as above
```

If a new Claude model is going through the pool, ask cli-proxy first — it is
the longest pole (§3, step 1).

## 2. Surface map

Every place a model id or the pi version lives. "Effect" says when a change is
visible: **live** = the next pi process / next spawn picks it up with no
restart; **restart** = a service restart; **deploy** = only after the loom
release is promoted.

| #   | Surface                             | Path                                                                                                                                                                                                                                                | Kind           | Effect                     | If missed                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bundled pi version pin + pnpm patch | `apps/server/package.json` (exact pin), `pnpm-workspace.yaml` (`patchedDependencies` key, six `minimumReleaseAgeExclude` entries), `patches/@earendil-works__pi-coding-agent@<v>.patch`                                                             | repo           | deploy                     | The cockpit's pi keeps the old builtin catalogue. A mismatched patch key fails `pnpm install` loudly — the one failure that cannot be silent.                                                                                                                                                                                                                                               |
| 2   | Global pi install                   | `/home/Carl/.n/lib/node_modules/@earendil-works/pi-coding-agent` (`which pi`)                                                                                                                                                                       | machine        | live                       | A stock global pi writes `~/.pi/agent/auth.json` non-atomically — and that file is shared by **every** pi on the machine, bundled ones included, so an unpatched terminal pi can hand a cockpit thread an empty credential store. Interactive `pi --session … --cwd …` also loses the flag.                                                                                                 |
| 3   | Machine-wide builtin catalogue      | `~/.pi/agent/models-store.json` (refreshed by `pi update --models`)                                                                                                                                                                                 | machine        | live                       | Builtin-provider models (`openai-codex/*`, `anthropic/*`, vertex, bedrock) come from here for every pi on the machine, **including a stale deployed bundle**. This is why GPT-6 ran on the deployed 0.86.0 cockpit with no deploy — and why a model probe passing proves nothing about the bundle (§7).                                                                                     |
| 4   | Custom-provider catalogues          | `/home/Carl/.pi/agent/extensions/cliproxy.ts`, `/home/Carl/.pi/agent/extensions/anthropic-subs.ts`                                                                                                                                                  | machine        | live                       | `cliproxy/<model>` and `anthropic-<account>/<model>` **do not exist** until an entry is added by hand; presets pointing at them render `[INVALID]`. No pi bump helps — these never come from the builtin catalogue.                                                                                                                                                                         |
| 5   | Global pi defaults                  | `~/.pi/agent/settings.json` → `defaultProvider`, `defaultModel`, `memory.consolidationModel`                                                                                                                                                        | machine        | live                       | Terminal pi and memory consolidation keep running the old model.                                                                                                                                                                                                                                                                                                                            |
| 6   | cli-proxy (Claude pool only)        | `/home/Carl/cli-proxy/docker-compose.yml` `image:` tag; upstream `internal/registry/models/models.json` + cloak pin in `internal/runtime/executor/helps/claude_device_profile.go`                                                                   | other project  | restart (~6 s outage)      | Anthropic rejects the model with `Claude Code <old> does not support this model; version <floor> or newer is required` — even though `GET /v1/models` lists it.                                                                                                                                                                                                                             |
| 7   | Loom defaults                       | `packages/contracts/src/model.ts` → `PI_DEFAULT_MODEL`, `DEFAULT_TEXT_GENERATION_MODEL`, `PREFERRED_DEFAULT_CODEX_MODELS`                                                                                                                           | repo           | deploy                     | New projects, auto-bootstrap and pi text-gen keep the old default.                                                                                                                                                                                                                                                                                                                          |
| 8   | Pi picker shortlist                 | `apps/server/src/provider/Drivers/PiDriver.ts` → `CURATED_PI_MODELS`                                                                                                                                                                                | repo           | deploy                     | The slug follows `PI_DEFAULT_MODEL` but the **display name is a literal**. Missed by two consecutive rollovers because a slug grep does not find it: the picker labels the new default with the old generation's name until the live catalogue arrives. Grep for `"Claude Opus` too.                                                                                                        |
| 9   | Claude/Codex adapter surfaces       | `apps/server/src/provider/model-manifest.json` (current models, `minVersion`, aliases, legacy demotion), `apps/server/src/provider/Layers/ClaudeProvider.ts` (`CURRENT_CLAUDE_MODELS`, catalogue entry, `normalizeClaudeCliEffort` xhigh allowlist) | repo           | deploy                     | Inert in loom (`builtInDrivers.ts` ships pi only, and the manifest is re-fetched from upstream after boot), but a self-inconsistent tree misleads the next reader. Take `minVersion` from the Claude Code `CHANGELOG.md` entry that introduced the model, never from the previous model. `usagePricing.ts` and mobile `modelOptions.ts` have **no** per-model tables — nothing to do there. |
| 10  | Role prose                          | `roles/*.md` (`rg -n "Opus                                                                                                                                                                                                                          | Sol            | Luna                       | Fable" roles/`)                                                                                                                                                                                                                                                                                                                                                                             | repo | deploy | Every orchestrator reads "a coder defaults to <model>" and reasons from it. |
| 11  | Routing matrix                      | `docs/operations/model-profiles.md` (+ `workstreamModelProfiles` in cockpit settings, if present)                                                                                                                                                   | repo + machine | deploy / live              | `taskShape` spawns keep routing to the old generation. Follow the doc's re-scoring routine.                                                                                                                                                                                                                                                                                                 |
| 12  | Tests that assert a default         | `ProviderRegistry.test.ts`, `ClaudeCapabilitiesProbe.test.ts`, `PiDriver.test.ts`, `client-runtime/…/projects.test.ts`, `contracts/…/settings.test.ts`                                                                                              | repo           | —                          | Gate fails. Leave the ~100 fixtures that merely _use_ a slug alone.                                                                                                                                                                                                                                                                                                                         |
| 13  | Live cockpit settings               | `/home/Carl/.t3/cockpit/userdata/settings.json` → `workstreamModelPresets.<role>.model`, `defaultModelSelection`, `projectSettingsOverrides[*].defaultModelSelection`, `providerFailover.chains`, `textGenerationModelSelection`                    | machine        | live (seconds, no restart) | **Every spawned child keeps the old model** regardless of what shipped — presets have no code seed (`settings.loom.ts` defaults them empty). `defaultModelSelection` is what a manually created thread gets.                                                                                                                                                                                |
| 14  | Other patched pi extensions         | `~/.pi/agent/npm/node_modules/pi-total-recall/node_modules/@samfp/pi-memory/src/index.ts` (`grep -c "LOCAL PATCH (Carl)"` → 4)                                                                                                                      | machine        | live                       | Not touched by `npm install -g` of pi core; **is** wiped by `pi update --all`/`--extensions` on a version change. See `~/pi-craft/local-patches/README.md`.                                                                                                                                                                                                                                 |
| 15  | Deploy                              | `~/loom-releases/RUNBOOK.md` → `deployctl deploy cockpit main`                                                                                                                                                                                      | machine        | —                          | Rows 1, 7–12 stay on paper.                                                                                                                                                                                                                                                                                                                                                                 |

## 3. Order of operations

The machine-side steps are **live** (rows 2–6, 13–14): the moment you save,
the next pi process or spawn uses them, and the running cockpit re-reads its
settings file within seconds. The repo steps (rows 1, 7–12) do nothing until a
deploy. Sequence so that nothing points at a model that nothing can serve:

1. **cli-proxy first, if a new Claude model is going through the pool.** Probe
   it with a real completion (§7). If rejected, the proxy needs a rebuild onto
   an upstream tag whose cloak pin ≥ the floor named in the error _and_ whose
   registry carries the model — two independent conditions; tags exist that
   satisfy one and not the other. Procedure and restart approval are in
   `/home/Carl/cli-proxy/AGENTS.md`. Nothing downstream may point a default or
   preset at `cliproxy/<new model>` until this completion succeeds. Note the
   coupling: rolling the proxy image back later re-breaks every thread on the
   new model, so a proxy rollback and a preset rollback are one action.
2. **Extension catalogues** (row 4) — add the new entries with the numbers from
   preflight. Verify with `pi -p` per provider (§7). Live immediately.
3. **Bundled bump** (row 1, §4) and **loom source rollover** (rows 7–12) on a
   feature branch. Gate, ship per `shipping.md`.
4. **Global pi** (row 2, §5) — after the bundled bump, so the re-derived diffs
   in `infra/pi-patches/` match the version you install. Check row 14 after.
5. **Global pi defaults** (row 5) and **cockpit settings** (row 13). The preset
   flip needs neither deploy nor restart; it is the step that actually changes
   what tomorrow's threads run on.
6. **Deploy** (row 15) per `~/loom-releases/RUNBOOK.md`. Confirm the promoted
   release resolves the new pi:
   `grep '"version"' "$(readlink -f ~/loom-releases/current/apps/server/node_modules/@earendil-works/pi-coding-agent)/package.json"`.

Why builtin models can be rolled _before_ a pi bump: row 3. A Codex/OpenAI/
Vertex model that is already in `models-store.json` validates and runs on the
deployed cockpit today. Custom-provider models cannot — row 4 is the only place
they exist.

## 4. The bundled bump

Mechanics — retirement check, moving the pins, regenerating the pnpm patch,
re-deriving the stored diffs, the verification list — are in
[`infra/pi-patches/README.md`](../../infra/pi-patches/README.md). Follow it top
to bottom. Two things it cannot know about your situation:

- **A pi bump does not propagate to sibling worktrees.** A worktree that merged
  the bump commit still has the old pi in `node_modules` until `pnpm install`
  runs there. Any step that says "test the bundled pi" must start with
  `pnpm install` and then assert the version — otherwise the probe exercises
  the old binary and passes anyway (rows 3 and 4 supply the models).
- The pnpm patch is version-scoped, so **model rollover and pi bump can ship
  as one PR or two, but the bump must not be split across branches**: pin,
  `patchedDependencies` key and patch file move together or `pnpm install`
  refuses.

## 5. The global install

```bash
V=0.87.1
npm install -g "@earendil-works/pi-coding-agent@$V"     # not `pi update`
pi --version                                             # → 0.87.1
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
at 0.86.0 and 0.87.1.

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
```

The harness's import is hard-coded to the global install; for the bundled copy
point it at `<resolved package>/dist/core/auth-storage.js`. That proves the
readable tree; the bundle is proven by
`grep -c __loomWriteAuthAtomic dist/bundle/chunks/chunk-*.js` → 2 and no
remaining raw `this.authPath,next,AUTH_FILE_WRITE_OPTIONS` write. A stock run
reporting _millions_ of zero-byte reads is a stalled writer, not a wider window
— rerun it.

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
`workstream_list` prints from any thread: the entry appears with **no
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
  providers.
- **A probe that passes on a stale bundle.** Sibling worktrees keep the old pi
  until `pnpm install`; rows 3 and 4 supply the models regardless; the probe
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
  names a patch file that does not exist. Comment the entry out, install,
  restore, patch, commit — in that order.
- **`patch` leaves `.orig` files on any offset.** Delete them before
  `patch-commit` on the bundled path; keep them on the global path.
- **In-process readers report clean.** The atomic-write harness only means
  anything with separate-process readers. A stock run showing millions of
  zero-byte reads is a stalled writer — rerun, don't record.
- **The bundle chunk filename changes every release** (`chunk-7YM6BE7Y.js` →
  `chunk-OJP47DM6.js`). `patch-bundle.mjs` finds it by content; do not
  hard-code it anywhere else.
- **`CURATED_PI_MODELS` hardcodes a display name** next to an auto-rolling
  slug. Grep for the _name_.
- **Presets are settings, not code.** A shipped, deployed rollover changes
  nothing a child runs on until row 13 is edited. Conversely, the edit is live
  in seconds — there is no "deploy" to hide behind if it is wrong.
- **Codex quota reads like a rollover failure.** `usage limit has been reached`
  on the new slugs is the account, not the catalogue; the old slugs fail
  identically. Use the negative-control slug to prove resolution.
