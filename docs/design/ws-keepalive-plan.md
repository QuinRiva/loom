---
manager_sessions:
  - id: 019ef9e0-16f9-7848-a20b-1744775e3b57
    role: plan
    authored_at: 2026-06-24T14:23:04.669Z
---

# Plan: WebSocket keepalive (heartbeat) to survive idle-timeout proxies

## Problem

The app's primary transport is a long-lived WebSocket RPC connection
(`apps/server/src/ws.ts` → `GET /ws`). During idle periods (no live
events flowing), the socket carries **zero bytes**. Proxies and tunnels
that sit between the browser and the server — notably VS Code Remote SSH
port forwarding — reap a WebSocket that has been idle for ~30s.

Observed symptoms (diagnosed on `main`):

- Connection lifetime ≈ 30s, then a `close` event; reconnect ≈ 3s later
  (the reconnect backoff). Server traces showed ~8 connect/disconnect
  cycles over ~4 min — one drop per ~30s.
- The server never initiates the close (`/ws` handler holds the socket
  open via the RPC effect; no idle timeout, no version-close).
- The client never initiates it either (reconnect is driven purely by
  the raw socket `close` event + effect-rpc retry).
- **No keepalive traffic exists in either direction.** There is
  heartbeat _scaffolding_ but no implementation:
  - `packages/client-runtime/src/wsRpcProtocol.ts` listens for an
    incoming raw `{ "_tag": "Pong" }` message and calls
    `onHeartbeatPong` (line ~239); it also exposes
    `onHeartbeatPing` / `onHeartbeatTimeout` hooks that are currently
    no-ops.
  - `packages/client-runtime/src/wsTransport.ts` records
    `lastHeartbeatPongAt` and exposes `isHeartbeatFresh(maxAgeMs = 15_000)`.
  - **Nothing ever sends a ping**, there is no `Ping`/`Pong` schema in
    `packages/contracts`, and the server has no keepalive responder or
    interval.

Consequence: live data pushed over the WS (e.g. the provider/model
snapshot) never stays connected, so "No models found" and "have to
refresh to see changes". HTTP-fed data still appears because HTTP is
proxied over the stable forwarded vite port.

This also explains "it sometimes worked": while the user was actively
interacting, app traffic kept the socket warm; the moment it went idle,
it was reaped.

## Goal

Keep the WebSocket warm with a lightweight, periodic application-level
heartbeat so it survives idle-timeout proxies/tunnels, and make the
existing `isHeartbeatFresh` / browser-resume-reconnect logic actually
functional. The fix must benefit **all** connections (local, remote,
relay) — it is additive and correct everywhere, not a tunnel-specific
hack.

## Design decision (the load-bearing choice)

**Decision (settled after a GPT-5.5 plan review against the vendored
Effect source): implement option 2 — a client-driven application-level
heartbeat RPC.** Options 1 and 3 were evaluated and rejected; rationale
below so the implementer does not re-litigate. Still read
`.repos/effect-smol/LLMS.md` and the relevant RPC/socket sources before
writing Effect code.

1. **Server-driven WebSocket protocol ping frames — REJECTED, not
   cleanly feasible.** `.repos/effect-smol/packages/platform-node/src/NodeHttpServer.ts`
   constructs the WS server internally as
   `new NodeWS.WebSocketServer({ noServer: true })` and exposes only
   listen/shutdown options — no `ws.ServerOptions` / ping controls.
   `RpcServer.toHttpEffectWebsocket` options cover only tracing/defect
   behavior. (`NodeSocketServer.makeWebSocket` _does_ take
   `ws.ServerOptions`, but that is the separate `SocketServer` API, not
   the route-mounted `GET /ws` path this app uses.) Separately, even if
   it were reachable, **browser JS cannot observe protocol-level pong
   frames**, so it could not update `lastHeartbeatPongAt` / satisfy the
   `isHeartbeatFresh()` goal. Protocol ping alone is therefore both
   infeasible here and insufficient.

2. **Client-driven application-level heartbeat RPC — CHOSEN.** Add a
   tiny heartbeat RPC to `WsRpcGroup`; the client transport calls it on
   an interval; the server handler returns immediately. Wholly within
   the RPC abstraction; no dependence on `ws` option plumbing; keeps
   bytes flowing both directions; and the RPC's own success is the
   freshness signal (see Contract).

3. **Raw `{_tag:"Ping"}` / `{_tag:"Pong"}` frames outside the RPC
   envelope — REJECTED.** Matches the _existing_ client listener
   literally, but `RpcServer` owns the socket message stream, so
   injecting/reading out-of-band frames is fragile.

If, while implementing option 2, the RPC layer fights an internal
heartbeat loop (e.g. the generated client is not reachable before the
socket opens), **escalate rather than falling back to option 3.**

## Contract (the parts a wrong guess silently corrupts)

These constraints hold for the chosen mechanism (option 2):

- **Cadence vs. thresholds.** The keepalive interval must be comfortably
  below the observed ~30s idle-reap threshold, and below the client's
  heartbeat-freshness window so `isHeartbeatFresh` stays true between
  beats. Recommended interval ≈ **10s** (freshness window stays 15s). If
  the worker changes the freshness window, keep `interval < window`.
- **Liveness only when connected.** The heartbeat must run only while a
  socket session is active; it must **not** fire during reconnect/backoff
  or after `dispose`, and must be torn down cleanly on every
  disconnect/session swap (no leaked intervals/fibers across the
  reconnect chain in `wsTransport.ts`). Use a **self-rescheduling loop
  that awaits each beat** (not a bare `setInterval`), scoped to the
  active session id, with a modest per-beat timeout — so a stalled beat
  cannot overlap the next one or survive a reconnect.
- **Freshness wiring (corrected).** Update `lastHeartbeatPongAt` when the
  heartbeat **RPC resolves successfully** — do NOT rely on the existing
  raw `{_tag:"Pong"}` message listener, which only catches out-of-band
  frames and will _not_ fire for an RPC reply (that arrives as an effect
  RPC `Exit`/`Chunk` envelope). Route the success into the existing
  `onHeartbeatPong` path so `isHeartbeatFresh()` and the browser-resume
  reconnect in `apps/web/src/environments/runtime/service.ts` become
  meaningful. If the raw `{_tag:"Pong"}` listener is left with no
  producer, remove it (no dead scaffolding — prototype).
- **Auth/scope (decided).** Every WS method must have an entry in the
  server's required-scope map or the upgrade throws. Add an explicit
  **authenticated-session-only** path for the heartbeat (least
  privilege; carries no data) rather than reusing
  `AuthOrchestrationReadScope` — the goal is "all authenticated
  connections", and relay/access-scoped credentials may lack
  `orchestration:read`. If an authenticated-only bypass is awkward to
  express in the existing scope machinery, **escalate** rather than
  silently narrowing the heartbeat to orchestration clients.
- **Telemetry hygiene.** The heartbeat must not pollute request-latency
  tracking / diagnostics. Exclude its tag from the
  `requestTelemetry`/web request-latency path (or otherwise label it so
  it is filtered) — ~6 beats/min/client should not show up as user
  requests.
- **No new failure surface.** A missed/failed beat must not throw into
  app code or trigger spurious user-visible errors; at most it lets the
  existing reconnect path handle a genuinely dead socket.

## Scope (anchors; let the worker structure the implementation)

- `packages/contracts/src/rpc.ts` — if option 2: add the heartbeat to
  `WS_METHODS`, a `Rpc.make(...)` with empty payload/success, and include
  it in the `WsRpcGroup` assembly (`RpcGroup.make(...)`, ~line 661).
  Schema-only, per package rules.
- `apps/server/src/ws.ts` — if option 2: add the handler in
  `WsRpcGroup.of({ ... })` (~line 815) following the `observeRpcEffect`
  pattern, and an auth-scope entry (~lines 150–161) at least privilege.
  If option 1: configure ws ping at the server/transport construction
  point.
- `packages/client-runtime/src/wsTransport.ts` and
  `wsRpcProtocol.ts` — schedule the beat for the active session, wire
  the reply into `onHeartbeatPong`/`lastHeartbeatPongAt`, and ensure
  teardown on disconnect/dispose. Remove now-dead scaffolding if the
  chosen mechanism makes the raw `{_tag:"Pong"}` listener redundant
  (no "kept for compatibility" leftovers — this is a prototype).

## Non-goals

- Do **not** change the WS URL/port wiring or vite proxy config (port
  13773 is confirmed forwarded; this plan is orthogonal to that).
- Do not add reconnect/backoff changes beyond what keepalive needs.
- Heartbeat lifecycle is the risky part, so tests here are **required**
  (an explicit exception to the usual "tests optional" default).
  Extend `packages/client-runtime/src/wsTransport.test.ts` with targeted
  behavioral cases: (a) a beat is sent only once a session is
  active/open; (b) a successful beat makes `isHeartbeatFresh()` true;
  (c) reconnect clears freshness and does not leave a duplicate beat
  loop running; (d) `dispose` stops the beat; (e) no overlapping
  in-flight beat if a tick stalls. Keep them behavioral and lightweight.

## Verification

- `./node_modules/.bin/vp run typecheck` and `./node_modules/.bin/vp check`
  must pass **in this worktree** (run the worktree-local `vp` after
  `pnpm install`; the bare `vp` on PATH resolves to the main checkout and
  misbehaves).
- Manual/behavioral confirmation that an idle connection now stays up
  past ~30s (the previous reap point) and that `isHeartbeatFresh()`
  returns true on an idle-but-live socket.
- Confirm no leaked interval/fiber after forced reconnects.
