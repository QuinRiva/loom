## 5. Tool surface: renames, linked environments, side chats

### 5.1 #25423 and later: what upstream renamed, and the one Loom list that names a dead tool

Toolkit by toolkit, base `b76a110aa4` → target `fa31b66bbb` (`Tool.make` names
in `apps/server/src/mcp/toolkits/*/tools.ts`):

| Toolkit | Removed | Added | Loom reference |
| --- | --- | --- | --- |
| orchestrator | `update_scheduled_task` (#28104 folded it into `schedule_task`: "With `scheduledTaskId`, update that task") | `t3_environment_links`, `t3_environment_link`, `t3_environment_unlink` (#17129) | **`families.ts` `SCHEDULING` names `update_scheduled_task`**; `families.test.ts` l.114 asserts every SCHEDULING name is in the toolkit (fails); `registration.test.ts` l.345 calls it; orchestrator `handlers.ts` conflict (§7.2) |
| thread | `t3_pending_request_{list,read,respond}`, `t3_queue_{cancel,edit,list,promote_to_steer,read,reorder}`, `t3_thread_configuration`, `t3_thread_fork`, `t3_thread_merge_back`, `t3_thread_transfers` (17 → 7) | `t3_pending_request`, `t3_queue`, `t3_thread_transfer` (action tools) | none (Loom's own `thread_fork` is a workstream tool with a different name) |
| preview | `preview_{click,drag,hover,press,scroll,select,type,upload}` (19 → 12) | `preview_act` | the addendum's `preview_*` phrase in `families.ts` CAPABILITIES is a wildcard, still true |
| pullRequests | none | `link_pull_requests`, `unlink_pull_requests` (plural) | `PULL_REQUESTS = namesOf(PullRequestsToolkit)`: resident for orchestrator and shipper by construction |
| attachment, device, environment, html, previewControls, project, worktree | none | none | |

Findings:

- **Hard break (test-level, not a leak):** `families.test.ts` "SCHEDULING is
  carved out of the withheld OrchestratorToolkit" fails because
  `update_scheduled_task` is no longer in the toolkit. S2a removes the name
  from `SCHEDULING`; `registration.test.ts`'s capability-denied call becomes
  `schedule_task` with `scheduledTaskId`.
- **Loom's #446 hunk moves.** Loom made `update_scheduled_task` and
  `delete_scheduled_task` `McpToolAccess.writesWithCapability` so a Loom
  credential (`workstream`, not `orchestration`) may manage scheduled tasks,
  with `SCHEDULING_CAPABILITIES` in `OrchestratorMcpService.ts`. Upstream's
  `schedule_task` is now `McpToolAccess.either(create → startsThreads, update →
  writes)`; Loom's `writesWithCapability` goes on the update arm and on
  `delete_scheduled_task` (orchestrator `handlers.ts` conflict, §7.2). The
  service's `loadCaller(scope, SCHEDULING_CAPABILITIES)` lines auto-merged.
- **Nothing leaks.** `UPSTREAM_WITHHELD_TOOLS = namesOf(OrchestratorToolkit,
  ThreadToolkit, ProjectToolkit, AttachmentToolkit, EnvironmentToolkit,
  WorktreeToolkit)` is built from exports, so every added or renamed tool in
  those toolkits is withheld. `families.test.ts`'s "every registered tool is
  in exactly one list" test walks `<toolkit>/tools.ts` and will pass with the
  new names.
- **No model-read text names an old tool.** `roles/*.md`, `skills/**`,
  `apps/server/src/loom/**`, the workstream toolkit's prose and the Pi
  extension sources were grepped for all 22 removed names: the only hits are
  `families.ts`, `registration.test.ts` and upstream's own
  `t3McpToolPresentation.ts` (upstream updates it). Roles name the family
  (`toolsets: [... scheduling]`), not the tool. Nothing for the model-read
  rule to defer.

### 5.2 Linked environments and cross-machine delegation (#16719, #17129, #17130, #16684, #16695; migrations 070–072)

What upstream built: an environment signs in to another as an **outside MCP
agent** (`peer_environment_links`, 070; the session token in the secret store),
behind the **Linked environments** Labs beta (`linkedEnvironmentsEnabled`,
default `false`, `packages/contracts/src/settings.ts` l.1263). `delegate_task`
may target a linked environment; the remote work carries `linkOrigin` and
`delegatedFrom` on `thread.create` (the `orchestrationV2.ts` conflict beside
Loom's `role`), `RemoteDelegation` follows it after a restart (`server.ts`
conflict), and an agent can `@`-mention a machine in the composer (the
`docs/user/composer.md` conflict).

What reaches Loom:

- **A linked caller is an `McpClientCaller`** (`McpInvocationContext.ts`:
  `client.linked`, `narrowedTo`, `webOrigin`), i.e. `scope.thread ===
  undefined`. Loom's `requireWorkstreamCaller` (`workstream/authorisation.ts`
  l.46–52) refuses it twice over: first the `workstream` capability check,
  which an OAuth client lacks, then the thread check ("Loom's workstream tools
  act as the calling T3 thread, so they need an agent running inside T3
  Code"). Loom's tools bypass
  `McpToolAccess`, so upstream's new `startsThreads(… { refused: … })` link
  forwarding never touches them. Pull 10's `hosted` gate (`registration.test.ts`
  "thread-less scope") is the proof, unchanged.
- **The reactor stays inert for Loom children.** `DelegatedTaskQuestionReactor.ts`
  changed two lines; delegation is still keyed on `app_owned` task records and
  `delegatedTaskId`, which `workstream_spawn` never creates. `families.ts`,
  the subagent thread kind and `UPSTREAM_WITHHELD_TOOLS` are untouched by the
  linked-environment work except for the three withheld tools above.
- **`McpThreadCaller.subagent`** (pull 13 DL-1510: false for a thread with a
  Loom workstream row) is unchanged; `ProviderSessionManager.ts`'s Loom lines
  at 455–520 silently merged. Gate 2a re-reads them against #16695's
  `linkOrigin` credential fields.
- **Settings UI:** Settings → Labs shows the beta toggle; the cockpit has one
  environment, so turning it on changes nothing until a second environment
  links. Finding, not a ruling.

### 5.3 Side chats (#26901) vs Loom's side-thread class (#501): different features, three shared files

| Aspect | Upstream side chat | Loom side thread (`plans/side-thread-class/plan.mdx`, glossary "Loom side threads") |
| --- | --- | --- |
| Storage | `lineage.sideChat: true` on a `thread.fork` with `sideChat: true` (`orchestrationV2.ts`); `isListedThreadLineage(lineage)` hides it from every thread list; `thread.delete` cascades to `sideChatIds`; `onlyIfUnused` delete | No new storage: derived from the workstream sidecar (`sideThreadOf(workstream)`: `role` in `SIDE_THREAD_ROLES` = `document-query` (attended) or `handoff-drafter` (unattended) with `forkFromThreadId` as the anchor) |
| Entry | `/side` or `/btw` in the composer, **+ → Side chat** in the right panel; mobile lists a thread's side chats above the composer | "Query" on a plan or recap block (document query), `/handoff` and `/retro` intercepts |
| Shown | `SideChatPane.tsx` as a right-panel tab with its own composer; "Side chats" in thread details; never in the sidebar | A sidebar sub-row under its anchor (`isSubRow`/`isTopLevelRow`, `Sidebar.logic.loom.ts`, `SideThreadRows.tsx`), tabs and the workstream graph hang it from the anchor; a flagged one takes a top-level row |
| Return path | **Bring back**: the parent gets the side chat's context with the next message (a context handoff, `ContextHandoffService.ts`) | **Promote**: the answer becomes a comment on the document (`document_query_promote`) |
| Search | Excluded by `ThreadSearch.ts` (`lineage.sideChat IS NOT 1`, the 13 lines that silently merged) | Indexed like any thread by `loom_thread_search` |
| Cold shell | `shellSubscriberThreadIds` treats `lineage.sideChat` entries like subagents for ancestor walks | A side thread is a root (`relationshipToParent` not `subagent`), so §4 does not change it |

Same concept at arm's length (a conversation beside a thread whose result
comes back), different anchor (a thread vs a document), different storage and
different surfaces. The three conflicted files are unions: `Sidebar.logic.ts`
(upstream's `isShownUnderParent(…, delegatedUnderParent)` filter, Loom's
`isTopLevelRow(thread.source, hosted)` clause and `source` in the generic),
`CommandPalette.logic.ts` (upstream's `isSidebarHiddenThread`, Loom's
`isListedThread(thread.source)`), `useComposerMenuItems.ts` (upstream's
`/side`,`/btw` items beside Loom's `LOOM_DRAFT_SLASH_ITEMS`). Upstream renamed
`isSidebarSubagentThread` → `isSidebarHiddenThread` (it now also hides side
chats); the rename reaches only the two conflicted callers (`Sidebar.logic.ts`,
`CommandPalette.logic.ts`), since Loom's `Sidebar.logic.loom.ts` and
`sideThread.ts` test `lineage.relationshipToParent` directly. Not this pull's
§4 and not a §8.1 row; the convergence question is a follow-up (§8.3).
