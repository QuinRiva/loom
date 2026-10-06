# Pi extensions that can start a run outside a T3 turn

Loom runs pi in RPC mode, and every agent run must belong to a T3 turn. Upstream's
`PiAdapterV2` enforces that: an `agent_start` with no active T3 turn sets the provider
session to `error` with `PI_UNSOLICITED_ACTIVITY_ERROR` ("Pi started agent work outside an
active T3 turn. The session was stopped to prevent invisible tool execution.") and terminates
the pi process (`PiAdapterV2.ts`, the `agent_start` case of the event pump and the exit
handler). Loom keeps that guard unchanged: it is the backstop, and nothing the unsolicited run
would have done executes. The thread's next turn opens a fresh pi process on the same session
file. Whatever the extension injected before `agent_start` stays in that file.

The guard costs the thread its live process. Run-starting extensions should therefore be
**passive** under Loom: they may add context, but they must never start a run. Loom sets one
variable on every pi provider instance for this:

```
PI_PASSIVE_EXTENSIONS=1
```

It is a marked default in `PiAdapterV2Driver.create`
(`apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts`), merged under the instance's own
environment. To override it for one instance, set `PI_PASSIVE_EXTENSIONS` in Settings →
Providers → (the pi instance) → Environment. That field is the instance's `environment` list,
which `mergeProviderInstanceEnvironment` applies on top of the default. The value is static per
instance, so no per-thread carrier is needed.

**No installed extension honours the variable yet.** The changes below add it. They are listed
for Carl to make in his own copies or as local patches; Loom does not edit `~/.pi` or
pi-craft.

## Audited installs

Audited on 2026-10-06:

- the `packages` in `~/.pi/agent/settings.json`;
- `~/.pi/agent/extensions/`: `consult-manager`, `pi-browser`, `read-full.ts`, and
  `subagent`, which holds only a `config.json`;
- pi-craft (`~/pi-craft/package.json`): `consult-manager`, `read-full.ts`, `cliproxy.ts` and
  `anthropic-subs.ts`;
- pi-fathom, which ships skills only.

The search covered `pi.sendUserMessage`, `pi.sendMessage(…, { triggerTurn: true })`, timers,
sockets, HTTP/WebSocket servers and file watchers.

`pi.sendMessage` without `triggerTurn` never starts a run. When pi is idle it only appends to
the session. `pi.sendUserMessage` starts a run whenever pi is idle.

### Can start a run outside a turn

| Extension (version)                | What it does                                                                 | Trigger                                                                                                                                                                                                                                                                                                                                       | Opt-out today                                                                                                                             | Under `PI_PASSIVE_EXTENSIONS=1`                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pi-intercom` 0.6.0                | Session-to-session messaging over a local broker socket (`broker/broker.ts`) | An inbound message while pi is idle: `handleIncomingMessage` → `sendIncomingMessage(entry, "trigger")` → `pi.sendMessage(…, { triggerTurn: true })`. `flushIdleMessages` does the same for queued messages after `agent_end` / `turn_end`                                                                                                     | `enabled: false` in `~/.pi/agent/intercom/config.json` only. That file is global, not per instance, and it disables outgoing messages too | Inbound messages are delivered without starting a run, so the next T3 turn sees them. Sending still works          |
| `pi-web-access` 0.13.0             | `web_search` / `fetch_content`, with a background full-content fetch         | `web_search` with `includeContent: true` → `startBackgroundFetch` → `pi.sendMessage(…, { triggerTurn: true })` when the fetch completes. It completes after the turn whenever the agent ends the turn first. Also `/websearch`, where the browser curator's result → `sendFollowUpFromReturn` (`triggerTurn: true`) after the command returns | None. Setting `workflow: "none"` in `~/.pi/web-search.json` only avoids the curator                                                       | The content-ready notice is appended without a run. The stored content stays retrievable with `get_search_content` |
| `@plannotator/pi-extension` 0.22.0 | Plan and code review in a browser                                            | (a) After a plan is approved, `agent_end` → `continueWhenIdle` → `pi.sendUserMessage("Continue with the approved plan.")`. (b) `/plannotator-review`, `/plannotator-annotate` and `/plannotator-last` → `session.waitForDecision().then(…)` → `sendUserMessage`. Both happen only after a user-run `/plannotator…` command or `--plan`        | None                                                                                                                                      | (a) Skipped. (b) The feedback is sent with `pi.sendMessage(…, { deliverAs: "followUp" })`, without a trigger       |
| `pi-studio` 0.9.34                 | Browser studio over a local HTTP and WebSocket server, started by `/studio…` | A browser request → `pi.sendUserMessage(prompt)` (`index.ts` ~12364–12459), at any time after the command returned                                                                                                                                                                                                                            | None                                                                                                                                      | Browser prompts are refused with a studio error ("not available while pi is hosted by T3")                         |
| `pi-prompt-template-model` 0.10.0  | Prompt templates with delegated chains, loops and compare                    | A multi-step command (`[Delegated chain complete …]`, loops, compare apply) calls `pi.sendUserMessage` again after the first run has settled. T3 finalises its turn at that settle, so each later step starts an unsolicited run                                                                                                              | None                                                                                                                                      | Multi-step delegated commands refuse to start: they `ctx.ui.notify` an error. Single-step templates are unaffected |

### Checked and safe

These add context or act inside a turn only:

- **`pi-total-recall`**: the `pi-memory`, `pi-session-search` and `pi-knowledge-search` hooks use
  `pi.sendMessage` without `triggerTurn`, and `pi-session-search`'s `setInterval` only syncs the
  index.
- **`pi-btw` 0.4.1**: answers use `pi.sendMessage` without a trigger. `sendThreadToMain` runs
  inside the `/btw` command handler, so it is part of that command's turn.
- **`pi-image-tools`** uses `triggerTurn: false`.
- **Inert here**: `pi-diffloop`, `visual-explainer`, `pi-anthropic-messages`,
  `my-pi-setup/file-search`, `pi-vertex-claude` (its `setInterval` is a stream idle-abort
  timer), the `~/.pi/agent/extensions` and pi-craft extensions, and pi-fathom (skills only).
- **Not loaded**: `pi-subagents`'s extension (`-src/extension/index.ts` in `settings.json`).

## The changes to add the opt-out (not made by Loom)

Each change reads `process.env.PI_PASSIVE_EXTENSIONS === "1"` once at load as `PASSIVE`.

1. **`pi-intercom`, `index.ts` `sendIncomingMessage`.** Change the options argument from
   `delivery === "trigger" ? { triggerTurn: true } : { deliverAs: "followUp" }` to
   `delivery === "trigger" && !PASSIVE ? { triggerTurn: true } : { deliverAs: "followUp" }`.
   In `handleIncomingMessage`, the idle path then appends rather than triggering. The busy path
   already queues.
2. **`pi-web-access`, `index.ts` `startBackgroundFetch`.** Change the `.then` callback's
   `{ triggerTurn: true }` to `{ triggerTurn: !PASSIVE }`. In the `websearch` command,
   `sendFollowUpFromReturn` changes its options to
   `{ triggerTurn: !PASSIVE, deliverAs: "followUp" }`.
3. **`@plannotator/pi-extension`, `index.ts`.**
   - In the `agent_end` handler, return before scheduling `continueWhenIdle` when `PASSIVE`.
   - In `sendUserMessageWithCurrentSessionFallback`, when `PASSIVE`, call
     `pi.sendMessage({ customType: "plannotator-feedback", content, display: true }, { deliverAs: "followUp" })`
     instead of `pi.sendUserMessage`.
4. **`pi-studio`, `index.ts`.** Where the WebSocket handler calls `pi.sendUserMessage` (the
   critique, run, steer and send handlers, ~12364–12459), when `PASSIVE` reply with
   `sendToClient(client, { type: "error", requestId: msg.requestId, message: "Not available while pi is hosted by T3." })`
   and return.
5. **`pi-prompt-template-model`, `index.ts`.** At the start of the delegated chain, loop and
   compare runners (before their first `pi.sendUserMessage`), when `PASSIVE`, call
   `ctx.ui.notify("Delegated multi-step templates are not available while pi is hosted by T3.", "error")`
   and return. Single-step templates are unaffected.

`pi-intercom` and `pi-web-access` matter in practice. An idle child receiving an intercom
message, and a `web_search` with `includeContent` finishing after its turn, are both ordinary
in a Loom workstream. The other three need a human to run one of their slash commands from the
Loom composer first.
