---
manager_sessions:
  - id: 50df8f88-e92b-42d6-97c3-593e9908c15c
    role: plan
    authored_at: 2026-06-27T13:41:26.326Z
  - id: 48d7345f-5894-4cfe-aaca-44d6cbaff137
    role: plan
    authored_at: 2026-06-27T14:48:54.959Z
  - id: 24389ccb-e89f-4d23-a172-8a19fe8f5c12
    role: plan
    authored_at: 2026-06-29T02:37:54.562Z
---

# Implementation Plan — Role-scoped prompting + the work-model prompt

**Status:** plan (ready for a coder)
**Contract:** `.plans/role-scoped-prompting-and-workstream-doctrine.md` (signed intent)
**Date:** 2026-06-28
**Scope:** fork-local (pi-frontend); base T3 has no workstream concept.

> **Revision 3 (2026-06-28).** This supersedes the earlier per-tool-mechanics
> framing. Net changes from interactive design review:
> - The shared system prompt is now a **conceptual "work model" prompt** (Goals →
>   Tasks → Workstream), not a tool-by-tool mechanics rehash. Constant renamed
>   `PI_WORKSTREAM_SYSTEM_PROMPT` → **`PI_WORK_MODEL_SYSTEM_PROMPT`**.
> - **Tool surface reduced 8 → 6.** `workstream_read_thread` is **removed**;
>   `workstream_ask_thread` is **merged into `consult_thread`**; `workstream_list`
>   is **enriched** (per-node `reportPath`, `sessionPath`, last-activity).
> - Inter-thread reads follow a **three-tier model**: report (curated) → list +
>   jsonl (full history, if needed) → consult (Q&A).
> - `error` doctrine is a **principle, not an absolute** (lean on system signals;
>   verify if a signal contradicts what you can plainly see).
> - Role overlays, child goal-context reframing, and the control-plane marker are
>   unchanged in intent. The **status/state-machine redesign is OUT of scope** here
>   (separate design doc); this plan only ships prompt/overlay/tool-surface work.

---

## 1. What changes, at a glance

1. **New role overlays** at `roles/<role>.md`, injected via the existing
   `appendSystemPrompt` seam, keyed by `thread.role` (root/un-roled →
   `orchestrator`). *(§2, §3, §6)*
2. **Rewrite the shared system prompt** → the conceptual work-model prompt;
   rename the constant; put it first in the driver join. *(§4, §5)*
3. **Child goal-context reframing**: a child sees the inherited goal as parent
   *background*, subordinate to its brief. *(§3A)*
4. **Control-plane message marker** on dispatcher wake/notice turns. *(§5A)*
5. **Tool-surface changes** (8 → 6): remove `workstream_read_thread`, merge
   `workstream_ask_thread` into `consult_thread`, enrich `workstream_list`; strip
   the duplicated tool-name prefix from every `promptSnippet`; trim guidelines.
   *(§7)*

Final tool set: `workstream_spawn`, `workstream_set_status`, `workstream_report`,
`workstream_set_dependencies`, `workstream_list` (enriched), `consult_thread`.

---

## 2. Decisions settled

| # | Question | Decision |
|---|---|---|
| 1 | Overlay location/format | **Committed markdown at `<projectRoot>/roles/<role>.md`**, one file per role, read at session start relative to the thread's effective cwd. Mirrors the committed `goals/<project>/…` convention. **Not** `.t3/roles/` (gitignored). |
| 2 | Root thread → `orchestrator` | Resolve role in the **loader** as `role ?? "orchestrator"`. A spawned child always has a `role`; the root/un-roled thread falls through. No schema change. |
| 3 | Reviewer overlay duplicates coder principles? | Neither duplicate nor build a shared-fragment include (YAGNI). Reviewer overlay carries review heuristics and *points to* the project's coding principles. |
| 4 | Overlay vs `workstreamChildPrompt` | Role **doctrine** lives in the overlay (system prompt, inject-once). `workstreamChildPrompt` stays as-is (the brief-carrying first-turn message). |
| 5 | Inter-thread reads | **Three tiers**: a thread's curated **report** (read `reportPath` from `list`) → full **session jsonl** via `sessionPath` (grep/jq, only if needed) → **`consult_thread`** (read-only Q&A). No bespoke `read_thread` tool. |
| 6 | `ask` vs `consult` | **One tool, `consult_thread`** (global; target by `threadId` / @-mention id / fuzzy `name`; returns an answer, or ranked candidates on ambiguity). Provenance (user-directed vs autonomous) is doctrine, not a separate tool. |

**Injection point & composition order.** Overlays inject through the existing
`appendSystemPrompt` seam, mirroring `activeGoalContextInstruction`. The reactor
builds `[roleOverlay, goalContext]`; the driver prepends the work-model prompt.
Final reading order, inject-once at session start (never per-turn):

```
PI_WORK_MODEL_SYSTEM_PROMPT   ← the operating model (every thread)
<role overlay>                ← how THIS role behaves
<active goal context>         ← the specific goal + task tree
```

Reactor-side because the driver has no read-model access (`thread.role`,
`thread.parentThreadId`); the reactor already owns `thread`/`effectiveCwd` and an
inject-once append (`buildGoalSystemPrompt`). The overlay is provider-agnostic
doctrine, so no `mcpSession` gate; missing file → no overlay (permissive). Add a
code comment at the injection site: if a non-workstream pi mode is ever added,
the `orchestrator` overlay must not ship without the workstream tools behind it.

---

## 2A. The overlay loader (new module)

**New file:** `apps/server/src/orchestration/roleOverlay.ts`

```ts
// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROLE_OVERLAY_DIR = "roles";
const DEFAULT_ROLE = "orchestrator";

/**
 * Resolve a thread role to its system-prompt overlay, read fresh from
 * `<projectRoot>/roles/<role>.md` at session start (no cache — editable without a
 * rebuild). null/empty role → the root orchestrator. A free-string/unknown role
 * whose file is absent yields `undefined` (permissive spawning). Role is
 * slugified to `[a-z0-9-]`, which also blocks path traversal.
 */
export const loadRoleOverlay = (input: {
  readonly role: string | null;
  readonly projectRoot: string;
}): string | undefined => {
  const slug = (input.role ?? DEFAULT_ROLE).trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (slug.length === 0) return undefined;
  try {
    const text = readFileSync(join(input.projectRoot, ROLE_OVERLAY_DIR, `${slug}.md`), "utf8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined; // ENOENT / unreadable → no overlay (permissive)
  }
};
```

## 3. Wire the overlay into the reactor

**File:** `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`

In `startProviderSession`, compose the overlay ahead of the goal context:

```ts
import { loadRoleOverlay } from "../roleOverlay.ts";
// …
const goalSystemPrompt = yield* buildGoalSystemPrompt(thread);
const roleSystemPrompt = yield* Effect.sync(() =>
  loadRoleOverlay({ role: thread.role, projectRoot: effectiveCwd ?? process.cwd() }),
);
const appendSystemPrompt = [roleSystemPrompt, goalSystemPrompt]
  .filter((part): part is string => !!part && part.trim().length > 0)
  .join("\n\n");
return yield* providerService.startSession(threadId, {
  // …
  ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
  // …
});
```

- `thread.role` carries the role (`packages/contracts/src/orchestration.ts:385`);
  the loader owns the `?? "orchestrator"` default (one place).
- Use `effectiveCwd ?? process.cwd()` — there is no `input.serverConfig` in
  `startProviderSession`; `effectiveCwd` resolves for any real thread, so the
  fallback is essentially dead.

## 3A. Child goal-context reframing (`buildGoalSystemPrompt`)

*(Intent requirement #6. In scope by the intent exception clause; touches neither
the sweep nor UI.)*

A child inherits the parent's `goalId` (`WorkstreamSpawnHttp.ts:306`) and
`buildGoalSystemPrompt` (L428) injects the goal's `Objective:` verbatim, as if it
were the child's own task — which derailed children in the authoring session. Fix:
keep inheritance, but **reframe + subordinate** it for children. Branch on
`parentThreadId`:

```ts
const buildGoalSystemPrompt = Effect.fn("buildGoalSystemPrompt")(function* (thread: {
  readonly projectId: ProjectId;
  readonly goalId: string | null;
  readonly parentThreadId: ThreadId | null;   // ← added
}) {
  if (!thread.goalId) return undefined;
  const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
  const goal = readModel.goals.find((g) => g.id === thread.goalId && g.deletedAt === null);
  return goal
    ? activeGoalContextInstruction(goal, { asChildBackground: thread.parentThreadId !== null })
    : undefined;
});
```

The call site (`startProviderSession`, L567) needs no change. `OrchestrationGoal`
is already imported at reactor L110 — no new import for the `opts` param.

In `activeGoalContextInstruction`, add the `asChildBackground` branch. **Root**
(`false`) keeps today's text exactly (`Active goal … / Objective: … / Current
tasks: …` + the `t3 goal task` CLI block). **Child** (`true`) gets the background
framing and **omits the CLI block** (driving the tree is the orchestrator's job;
the child gets the tree as read-only orientation):

```ts
if (opts?.asChildBackground) {
  return [
    `Background context — your parent orchestrator is working toward this overall goal \`${goal.id}\` (${goal.slug}): ${goal.title}`,
    goal.description.trim().length > 0
      ? `\nParent's objective (background only, NOT your task): ${goal.description.trim()}`
      : "",
    `\n\nYour authoritative task is the spawn brief in your first message. This goal is provided only so your work aligns with the wider effort — do not execute it directly or treat its objective as your own assignment. If the brief and this goal appear to conflict, follow the brief.`,
    `\n\nParent's current task tree (for orientation only; you do not manage it):\n${tasks}`,
  ].join("");
}
```

## 4. Reorder the driver join (work-model prompt first)

**File:** `apps/server/src/provider/Drivers/PiDriver.ts` (`startSession`)

```ts
const appendSystemPrompt = appendSystemPrompts(
  mcpSession ? PI_WORK_MODEL_SYSTEM_PROMPT : undefined,
  startInput.appendSystemPrompt,
);
```

`appendSystemPrompts` already filters empties and joins with `\n\n`; only the
order changes (work-model first, then the reactor's role+goal append). The
work-model prompt still gates on `mcpSession`.

## 5. The work-model system prompt

**File:** `apps/server/src/provider/Drivers/PiDriver.ts`

Replace the `PI_WORKSTREAM_SYSTEM_PROMPT` constant with
**`PI_WORK_MODEL_SYSTEM_PROMPT`**, a conceptual prompt given to **every** thread.
It describes the operating model and how the tools serve it; it does **not**
re-narrate per-tool mechanics (those live in each tool's `description`). Final
text:

```
You operate inside T3 Code's work model: Goals → Tasks → Workstream. This is how every thread here is organised, whatever its role.

A GOAL is a single durable objective that outlives any one session and spans many — the north star for all work under it. Orient to it; if work drifts from the goal, refocus or update it. A goal is decomposed into a TASK TREE: the living, shared record of what is done and what remains — for the agents working it and for the human who glances at it to re-orient. It is kept current as work progresses.

Work happens in a WORKSTREAM: a tree of durable threads. You are one thread in it, and your role overlay says how you act within it. A ROOT thread ORCHESTRATES — it plans, delegates, and reviews rather than doing the work by hand. A CHILD thread EXECUTES a single self-contained brief and hands a result back. A child is a real, persistent thread a human can open and talk to, not a throwaway: spawning one is deliberate, and a child starts fresh — it inherits none of the parent's conversation, only the brief it is given. Work flows down as briefs and back up as reports; dependencies order it, so dependent work waits while independent work runs in parallel.

Getting information from another thread, cheapest first: a thread's REPORT is its curated hand-back — read that first. The workstream GRAPH lets you see every thread and find any of them without searching (`workstream_list`). To resolve an ambiguity, CONSULT the thread that holds the context. The full thread history can be accessed via the Pi session jsonl file if necessary.

A few principles keep this coherent:
- Your assignment is your task. For a child that is its spawn brief; at the root it is the user's direction. An inherited goal is background - align to it, but where it and your assignment differ, follow the assignment.
- Work at your level. If you orchestrate, delegate substantial work to children rather than absorbing it inline. If you execute a brief, do the work directly.
- Status describes the plan; runtime is the truth. A thread's status is where it sits in the workflow; whether its agent is actually working is a separate, system-tracked fact. Lean on the system's signals for a child's state rather than inferring from a single quiet look — and if a signal looks wrong for what you can plainly see, verify rather than act blindly.
- System notices are not the human. Automated workstream notices (a child finished, needs attention, recovered) are control-plane signals for you to act on, not messages from the user.
```

## 5A. Control-plane message attribution (`WorkstreamDispatcher.ts`)

*(Intent requirement #5. In scope by the exception clause; the sweep is untouched
— only the human-facing text of dispatcher-built turns changes.)*

The dispatcher injects wake/notice texts as `role:"user"` turns, so a parent
can't tell an automated notice from a real human message. Keep `role:"user"`
(pi has no separate channel); prepend a control-plane marker.

- **Single exported constant** in the dispatcher module, e.g.
  `WORKSTREAM_CONTROL_PLANE_MARKER = "[T3 Workstream control plane — automated notice, not from the user]"`,
  reused by both builders so they can't drift; the §5 prompt references the same
  literal (byte-identical, em-dash included).
- Prepend it (and a blank line) as the leading line of:
  - `buildParentWakeMessage` (~L140) — the "spawn generation finished" notice;
  - `buildChildWakeMessage` (~L299) — covers all child kinds (`error`, `idle`/
    went-quiet at ~L313, `recovered`) in one place.
- Delivery sites (~L407/L455/L607) keep `role:"user"` — only the text now
  self-identifies. The prompt half is the last principle in §5.

## 6. Role overlays (`roles/<role>.md`)

Four committed files at repo root `roles/`. Unknown/free-string roles get no file
→ no overlay → still spawn (permissive).

### `roles/orchestrator.md`
```markdown
You are the orchestrator: the root thread of this workstream. Your job is plan → delegate → review, not hands-on implementation.

- Delegate substantial work. Hand any non-trivial implementation, investigation, or review to a child thread via `workstream_spawn` with a self-contained `brief`. Don't write the feature, run the analysis, or do the review inline — your value is decomposition, dispatch, and judging the results.
- Keep the goal's task tree current. It is how the human re-orients at a glance and what drives your next move. Add/close/rename tasks as the work evolves; don't edit goal files by hand.
- Write purposes that explain why. Each spawned thread's `purpose` is its sidebar card — state the capability/fix/decision it delivers so the human can tell why it exists and how to judge it.
- Don't babysit children. They run autonomously and you are woken when one finishes or needs you. Use `workstream_list` to see status and activity; lean on those signals rather than re-checking a running child. If a signal looks wrong for what you can plainly see, verify (read its report, or its session jsonl if needed) before acting.
- Fold results back. When a child reports, review it, integrate it, update the task tree, and move on. Escalate to the human only when human judgment is genuinely needed.
- You are the human's single point of contact. Assume the human has NOT read any child's report, analysis, or plan unless they say so. When you speak to the human, be self-contained: explain what you're referring to rather than citing it — not "to address Section 5" or "per the reviewer's third point", but what it actually is.
- Only do work directly when it is trivially small or is itself orchestration (planning, wiring dependencies, composing briefs).
```

### `roles/coder.md`
```markdown
You are a coder sub-thread. Execute your brief and produce working, verified code.

- Your spawn brief is your authoritative task. The brief in your first message is your assignment. Any goal/objective shown in your system prompt is your parent's background context, not your task — if the two appear to conflict, follow the brief.
- Do the work directly. Only sub-delegate if the task genuinely decomposes into independent pieces; otherwise implement it yourself.
- Aim for the smallest correct change: minimal surface area, no speculative abstraction, no backward-compat shims in this prototype.
- Verify before declaring done — run the project's checks/entrypoint where applicable, not just a mental trace.
- Report a concise handoff (what changed, how you verified, residual risks) with `workstream_report` before setting `done`.
```
*(Seed lean: the human migrates fuller coding principles from `~/.pi/agent/AGENTS.md` into this overlay later — out of scope here.)*

### `roles/reviewer.md`
```markdown
You are a reviewer sub-thread. Assess the work against its intent and report findings ranked by severity.

- Your spawn brief is your authoritative task. The brief in your first message defines what to review. Any goal/objective in your system prompt is your parent's background context, not your task — if they conflict, follow the brief.
- Verify, don't rubber-stamp. Check claims against the actual diff/code; an automated or upstream suggestion is a claim, not a verdict.
- Judge against the project's coding principles and the change's stated intent (don't re-derive them here — apply them).
- Be specific: cite files/lines, separate must-fix from nice-to-have, and say plainly when something is fine.
- Only sub-delegate if the review genuinely decomposes. Report findings with `workstream_report` before setting `done` (or `review` if your verdict itself needs human sign-off).
```

### `roles/researcher.md`
```markdown
You are a researcher sub-thread. Investigate the question and return the answer, not the path you took.

- Your spawn brief is your authoritative task. The question in your first message is what to answer. Any goal/objective in your system prompt is your parent's background context, not your task — if they conflict, follow the brief.
- Pin the question, gather evidence, and report a concise, sourced answer — the nugget, not your whole exploration.
- Do not implement changes; your deliverable is findings and a recommendation.
- Only sub-delegate if the investigation genuinely splits into independent strands.
- Report with `workstream_report` (lead with the answer, then the evidence) before setting `done`.
```

## 7. Tool-surface changes

**Files:** `apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts`
(tool registrations + snippets/guidelines), `apps/server/src/mcp/WorkstreamSpawnHttp.ts`
(HTTP handlers), `packages/shared/src/workstreamGraph.ts` (graph node shape),
`apps/server/src/provider/Drivers/PiDriver.ts` (env URL wiring).

**(a) Remove `workstream_read_thread`.** Delete its `registerTool` block, its HTTP
handler/route (`handleWorkstreamReadThread`), and its env URL wiring. Its job is
now covered by enriched `list` + file reads.

**(b) Merge `workstream_ask_thread` into `consult_thread`.** Delete the
`ask_thread` `registerTool` block, its route, and its env URL. **Keep the shared
core `askWorkstreamThread`** — `consult_thread` already uses it. `consult_thread`
remains: global scope, target by `threadId` | @-mention id | fuzzy `name`,
returns an answer or ranked candidates on ambiguity. (No code change to consult
beyond being the sole survivor.) Doctrine handles provenance: if the user pointed
you at the thread, report back to them; if consulting autonomously, just use it.

**(c) Enrich `workstream_list`.** Add to each graph node (`GraphViewNode` in
`workstreamGraph.ts`, populated in `graphViewFor` and the list handler):
- `reportPath: string | null` — already on the source thread (`reportPath`);
  surface it instead of collapsing to `hasReport` (keep `hasReport` too if cheap).
- `sessionPath: string` — the absolute jsonl path, derived via
  `resolveSessionFilePath(piSessionIdForThread(id))`.
- `lastActivityAt: string | null` (+ optional `lastActivitySummary`) — a
  lightweight liveness signal from the projection's activity freshness. Full
  activity detail stays in the jsonl, not in `list`.

**(d) Strip the duplicated tool-name prefix** from every remaining
`promptSnippet` (the harness already prefixes `- <toolname>: `, so today's text
doubles it), and trim `promptGuidelines` to only non-obvious mechanics not
already in the tool's `description` or the work-model prompt. Leave each
`description` and `parameters` intact. Proposed de-prefixed snippets:
- spawn → `launch a durable child thread for delegated work: role + purpose + optional brief, blockedBy (waits-on ids), and an optional model override.`
- set_status → `set the workflow status label of your own thread or a child you spawned.`
- report → `hand a concise markdown result back to your parent before you finish.`
- set_dependencies → `adjust the blockedBy set of a not-yet-started thread (re-planning only; does not gate an already-started thread).`
- list → `see your whole workstream graph — ids, roles, statuses, last-activity, report/session paths — to find any thread without searching.`
- consult_thread → `ask another thread a read-only question (answered from a frozen fork) by id, @-mention, or name; never mutates it.`

> Tool `description`s themselves are still being refined separately; this plan
> covers the structural surface (which tools exist) and the snippet/guideline
> trim, not the final description wording.

## 8. Sequencing & file-by-file

1. **Add** `apps/server/src/orchestration/roleOverlay.ts`. *(§3)*
2. **Add** `roles/{orchestrator,coder,reviewer,researcher}.md`. *(§6)*
3. **Edit** `ProviderCommandReactor.ts`: load + compose the overlay *(§3)*; reframe
   child goal-context (`parentThreadId` branch + `asChildBackground`). *(§3A)*
4. **Edit** `PiDriver.ts`: rename + rewrite the constant to
   `PI_WORK_MODEL_SYSTEM_PROMPT` *(§5)*; flip the join order *(§4)*; drop the
   removed tools' env URL wiring (read_thread, ask_thread). *(§7a/b)*
5. **Edit** `WorkstreamDispatcher.ts`: control-plane marker constant + prepend in
   both builders. *(§5A)*
6. **Edit** `WorkstreamSpawnExtension.ts`: remove read_thread + ask_thread tools;
   strip snippet prefixes; trim guidelines. *(§7a/b/d)*
7. **Edit** `WorkstreamSpawnHttp.ts`: remove read_thread + ask_thread routes (keep
   `askWorkstreamThread` core for consult); enrich the list handler. *(§7a/b/c)*
8. **Edit** `packages/shared/src/workstreamGraph.ts`: extend `GraphViewNode` with
   `reportPath`/`sessionPath`/`lastActivityAt`. *(§7c)*

No change to `workstreamChildPrompt.ts` or `WorkstreamLivenessSweep.ts` (the sweep
is off-limits; its false-positive fix is a separate handoff).

## 9. Verification

- `vp run typecheck` and `vp check` pass (repo gates).
- **Canonical run:** start the dev server, spawn a `coder` child, and confirm its
  effective system prompt is `PI_WORK_MODEL_SYSTEM_PROMPT` → coder overlay → goal
  context (as background, no bare `Objective:`/CLI), in that order; confirm the
  **root** thread gets the `orchestrator` overlay and today's goal framing; confirm
  an **unknown role** still spawns with no overlay.
- **Tool surface:** confirm `read_thread`/`ask_thread` are gone, `consult_thread`
  resolves by id and by name (with candidates on ambiguity), and `workstream_list`
  returns `reportPath`/`sessionPath`/`lastActivityAt` per node.
- **Control-plane:** a real wake notice arrives with the marker first line.
- **Tests (optional):** `loadRoleOverlay` (default→orchestrator, missing→undefined,
  slug rejects traversal) is the only piece worth a focused unit test.

## 10. Open risks for the reviewer

- **Marker byte-identity** across the dispatcher constant and the §5 prompt
  (em-dash). Use the shared constant; don't paraphrase either side.
- **`asChildBackground` keys off `parentThreadId !== null`** — only the true root
  owns the goal; intended.
- **Children lose the `t3 goal task` CLI block** — intended (orchestrator drives
  the tree).
- **`list` enrichment cost:** per-node `lastActivityAt` means a projection lookup
  per node; keep it lightweight (timestamp + short summary), full detail via jsonl.
- **Composition-order change** affects every pi session's system prompt; harmless
  reorder, but grep for golden-prompt snapshot tests first (none found).
- **Removed env URLs / routes:** ensure no dangling references to the deleted
  read_thread / ask_thread URL helpers after removal.
