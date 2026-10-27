---
manager_sessions:
  - id: 687bc03d-a443-499b-868a-9f23872d4ec0
    role: plan
    authored_at: 2026-06-25T07:52:54.319Z
---

# Bug: idle workstream threads lose their session + credential (reaper + credential idle-timeout)

**Status:** confirmed, root-caused, not yet fixed. Recorded from a live session in
which an orchestrator thread repeatedly hit
`401 "A valid provider-scoped Workstream credential is required."` on
`workstream_spawn` / `workstream_set_status` after stretches of conversation, and
only recovered after a server restart. **A spawned coder child also finished its work
but was then reaped before it could file its `workstream_report` / set its status to
`done`** — stranding the gated reviewer that depended on it. Console confirmed both
the orchestrator and the coder were reaped by `provider.session.reaper` for
`inactivity_threshold` (~33 and ~39 min idle).

## Symptom
A long-lived orchestrator (parent) thread that has been spawning/managing
sub-threads starts getting `401` from every workstream tool
(`workstream_spawn`, `workstream_set_status`, and the rest). It recovers after the
server is restarted (which respawns the thread's pi process), then lapses again
after another idle stretch. A provider **re-auth alone does not fix it.**

## Root cause — two compounding 30-minute idle mechanisms (evidence-backed)
There are **two independent idle timers**, both defaulting to 30 minutes, that
together kill an idle-but-alive workstream thread.

### Mechanism 1 (primary, the one logged): the provider session reaper
`apps/server/src/provider/Layers/ProviderSessionReaper.ts` sweeps every
`DEFAULT_SWEEP_INTERVAL_MS = 5 min` and **stops** (`providerService.stopSession`) any
provider session idle longer than `DEFAULT_INACTIVITY_THRESHOLD_MS = 30 min`
(it skips sessions mid-turn). This tears down the whole pi process — which also
destroys its in-memory credential. Logged as `provider.session.reaped` /
`reason: "inactivity_threshold"` (exactly what the console showed for both the
orchestrator `687bc03d` and the coder `add01efd`).

**Why this is destructive for workstreams specifically:** a thread that is *part of
an active workstream* but momentarily idle — an orchestrator waiting between human
turns, or a child that has **finished its work and is waiting to be marked done** —
gets reaped even though the workstream is not complete. The coder finished + committed
its 2 commits, went idle, and was reaped ~33 min later before it could call
`workstream_report` / `set_status(done)`. Because its status never became `done`, the
reviewer gated on it (`blockedBy`) could never auto-start.

### Mechanism 2: the MCP credential idle-timeout
Independently, the workstream credential is a per-thread bearer token with **two
expiry gates**, enforced in `apps/server/src/mcp/McpSessionRegistry.ts`:

```ts
// pruneExpired(): a record stays valid only while BOTH hold
timestamp <= record.scope.expiresAt &&               // absolute lifetime
timestamp - record.lastUsedAt <= idleTimeoutMs        // idle since last use
```
with defaults (`McpSessionRegistry.ts`):
```ts
const DEFAULT_IDLE_TIMEOUT_MS    = 30 * 60 * 1_000;       // 30 minutes idle
const DEFAULT_MAXIMUM_LIFETIME_MS = 8 * 60 * 60 * 1_000;  // 8 hours absolute
```
`resolve(rawToken)` bumps `lastUsedAt` **only when a workstream tool is actually
called**. There is no proactive keep-alive. So:

1. An orchestrator that spends >30 min **reasoning/conversing without calling a
   workstream tool** (exactly the human-in-the-loop design-and-discuss pattern)
   idles past `idleTimeoutMs`; `pruneExpired` drops the record → next call `401`.
2. The token is **baked into the pi process env at spawn**
   (`PiDriver.ts:668` — `T3_WORKSTREAM_AUTHORIZATION: mcpSession.authorizationHeader`,
   read by `WorkstreamSpawnExtension.ts:9`). It is an env var on an already-running
   process, so it **cannot be refreshed in place.**
3. `issue` mints a **fresh random token** each time
   (`crypto.randomBytes(32)`), and `issueActiveMcpCredential` does
   `revokeThread` → `issue`. A re-issue therefore produces a *different* token than
   the one baked in the live process's env — so re-issuing does nothing for that
   process unless the process is **respawned** with the new env (what a server
   restart does). This is why "restart the server" works and "re-auth" / a restart
   that merely reattaches does not.

### Why we thought a keep-alive existed
The `lastUsedAt`-bump-on-use + idle-timeout *is* a keep-alive-on-use mechanism — but
nothing **proactively** bumps it for a live, attached thread, and the 30-minute
window is short relative to how long an orchestrator can legitimately go between
workstream calls while still actively driving the work in conversation. The
mechanism is present; the *proactive* half is missing.

## Fix directions (for a future implementing thread to choose)
0. **Exempt active-workstream threads from the reaper (mechanism 1):** do not reap a
   thread that is participating in an unfinished workstream — i.e. a parent with any
   non-terminal descendant, or a non-terminal child itself. Reaping a session whose
   workstream isn't done is the most damaging failure (it strands committed work and
   gated dependents). At minimum, a child that has reached a terminal-but-unreported
   state, or whose parent is alive, should not be reaped out from under the pipeline.
   Alternatively/also raise `DEFAULT_INACTIVITY_THRESHOLD_MS` for workstream threads.
1. **Proactive keep-alive for live/attached threads** (the missing half): a
   lightweight periodic touch that bumps `lastUsedAt` while a thread's pi process is
   alive and attached, so an actively-driven orchestrator never idles out. Scope it
   to attached/live sessions so it doesn't defeat idle-timeout's purpose for
   abandoned ones.
2. **In-place credential refresh (the structural fix):** decouple the credential
   from a spawn-time env var. Have the pi workstream extension obtain/refresh its
   token from a stable per-thread source (e.g. authenticate the workstream HTTP
   endpoint with a stable per-thread secret, or let the extension re-fetch a current
   token on `401`), so a re-issue propagates to the running process without a
   respawn. This is the only option that fully removes the "must restart the server"
   recovery.
3. **Lengthen / make-configurable `idleTimeoutMs`** for orchestrator threads —
   cheapest mitigation, does not fix the env-baked-token recovery problem (still
   needs a respawn once it does lapse), so at best a partial band-aid.

Recommended: **(1) + (2)** — proactive keep-alive removes the day-to-day lapses, and
in-place refresh removes the respawn-only recovery. (3) alone is insufficient.

## Verification for any fix
- Drive an orchestrator that idles past the (then-current) idle window without
  workstream calls, then call `workstream_spawn` — it must succeed without a server
  restart.
- Confirm a genuinely abandoned/detached thread still expires (idle-timeout's
  security intent preserved).

## Related control-surface gaps (separate follow-ups, same durability theme)
1. **No agent-facing cancel/delete** for a sub-thread (only `set_status`), so a
   mis-spawned or redundant child can't be retracted by the orchestrator.
2. **`set_status: done` does not halt a *running* child** — it updates status but the
   live turn continues to completion. Combined with (1), an orchestrator cannot stop
   a child it no longer wants.
3. **Manual `done` on a *blocked* (not-yet-started) child does not prevent the
   dispatcher from later starting it** when its `blockedBy` dependency reaches
   `done`. Observed live: a stranded gated reviewer was set to `done`, then started
   anyway the moment its dependency completed — producing a duplicate run. Releasing a
   generation should skip dependents already in a terminal status.

## Key references
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` — `sweep`,
  `DEFAULT_INACTIVITY_THRESHOLD_MS` (30m), `DEFAULT_SWEEP_INTERVAL_MS` (5m),
  `providerService.stopSession`, `provider.session.reaped` log (mechanism 1).
- `apps/server/src/mcp/McpSessionRegistry.ts` — `pruneExpired`, `issue`, `resolve`,
  `DEFAULT_IDLE_TIMEOUT_MS` (30m), `DEFAULT_MAXIMUM_LIFETIME_MS` (8h),
  `issueActiveMcpCredential` (revoke+issue), `resolveActiveMcpCredential`.
- `apps/server/src/mcp/WorkstreamSpawnHttp.ts:57-64` — `resolveWorkstreamScope` →
  `resolveActiveMcpCredential`, the `401` source.
- `apps/server/src/mcp/McpProviderSession.ts` — in-memory per-thread session/token store.
- `apps/server/src/provider/Drivers/PiDriver.ts:631,668` — token baked into the pi
  process env at spawn; `WorkstreamSpawnExtension.ts:9` reads it.
