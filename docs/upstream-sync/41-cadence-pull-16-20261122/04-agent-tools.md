## 4. Upstream's new agent tools and prompt text reach Loom threads unless withheld

This is the seam with the most at stake, because it changes what Loom's agents
can do rather than what a screen looks like. Upstream added 23 agent tools in
the fortnight and three pieces of text that are injected into an agent's
prompt or messages. Loom's tool exposure is shaped so that **anything new
upstream registers is offered to Loom threads unless someone withholds it**,
and one of the new tools merges pull requests. The decisions are Carl's (§8.1:
four tool rows and the sender-note row); this section is the evidence and the
work under the recommended answers. Per-hunk doctrine is in
[B.5](b05-mcp-tools.md) and [B.6](b06-providers.md).

### 4.1 What upstream added

No tool was removed or renamed (every `Tool.make` name at the base still
exists at the target); about 34 existing tools were re-described (upstream's
prose, taken as written).

| Toolkit | New tools | What a call needs on the server | PRs |
| --- | --- | --- | --- |
| `PullRequestsToolkit` (existing; Loom's `PULL_REQUESTS` family) | `pull_request_read`, `pull_request_list`, `ci_logs` (reads); `pull_request_create`, `pull_request_update`, `pull_request_respond`, `pull_request_review`, `pull_request_merge`, `ci_rerun` (writes) | the `pull-requests` capability, which every Loom thread holds; writes also need a live run owned by the caller; hidden only where the project has no forge | #26751, #26752, #38973 |
| `IssuesToolkit` (new) | `list_issues`, `read_issue`, `create_issue`, `comment_on_issue`, `set_issue_state`, `link_issue`, `unlink_issue`, `list_thread_issues` | the new `issues` capability, which Loom threads do not hold: listed, every call refused | #19270 |
| `ThemeToolkit` (new) | `t3_theme_read`, `t3_theme_set` | read: nothing; set: `orchestration` plus full access, which Loom threads do not hold | #35247 |
| `FeedbackToolkit` (new) | `t3_feedback` | hidden while `agentFeedback.mode` is `off` (the default); `orchestration` otherwise | #35871 |
| `MessageToolkit` (new) | `send_to_user` | nothing | #36384 |
| `ThreadToolkit` (existing, already withheld) | `t3_submit_output` | withheld from Loom agents by construction | #38874 |
| `ToolSearchToolkit` (new) | `tool_search` (upstream's own) | listed only to sessions that ask for deferred exposure, which pi never does | |

`pull_request_merge` refuses only if the PR's head moved from the
`expectedHeadSha` the agent passed. It can enable auto-merge and land a whole
GitHub stack. No setting, feature flag or project policy gates it; pi shows an
approval prompt only outside full-access mode, and 1,574 of the 1,577 Loom
threads created since 1 Nov run full-access.

### 4.2 Why they reach Loom threads, and what the withholding is

Two layers decide what a Loom agent is offered:

- **Server side**, a handler is allowed or refused by the capability set on
  the thread's credential. Loom threads hold `workstream`, `pull-requests`,
  `preview` and `device`. That is why the PR and CI tools work and the issue
  tools are refused.
- **On the pi side**, every tool the server lists is registered as reachable
  by pi's own `tool_search`, unless the role's profile loads it from the start
  or `UPSTREAM_WITHHELD_TOOLS` in
  `apps/server/src/mcp/toolkits/workstream/families.ts` hides it. It is a deny
  list.

`families.ts` defines `PULL_REQUESTS = namesOf(PullRequestsToolkit)`, so the
nine new tools join the family that root, orchestrator, shipper and
free-text-role threads load from their first turn (about 340 of the 1,560
threads since 1 Nov). `families.test.ts` asserts that the lists partition the
registered catalogue, so the five new toolkits fail that test until each is
classified: the leak cannot ship silently, but the obvious fix (put the
toolkit in a capability entry) exposes it.

Under the §8.1 recommendations S2a edits `families.ts` (a Loom-only file, so
not S1's) as follows, and nothing else in Loom's tool prose changes:

- `PULL_REQUESTS` is pinned to its nine base names, written out, with a marked
  comment naming this section; the nine new names join
  `UPSTREAM_WITHHELD_TOOLS`.
- `IssuesToolkit`, `FeedbackToolkit`, `ThemeToolkit`, `MessageToolkit` and
  `ToolSearchToolkit` join the withheld list (one line each; the last for
  classification only).
- `families.test.ts`: "withholds exactly upstream's six" becomes eleven
  toolkits; "PULL_REQUESTS is upstream's PR toolkit" becomes the pinned nine.

A thread launched before the deploy keeps its recorded tool list, so only new
threads pick up a loaded-from-the-start change; under the recommendations
there is none to pick up.

`agentContextBudget.json` (the byte count of the tool list an agent is sent)
grows from 48,202 to about 60,460 for upstream's full catalogue. A Loom turn
pays only for loaded tools: nothing more under "withhold all", about 1.5 KB
for PR-role turns under "read-only three", about 4.7 KB under "all nine". S1
takes upstream's three values; S2a re-runs `AgentContextBudget.test.ts` and
records Loom's measured figure (DL-1654's method).

### 4.3 Three pieces of upstream text that would reach a pi agent

The standing rule is that nothing an agent reads changes inside a pull.

| Text | Where it enters | What a Loom agent would read | Resolution |
| --- | --- | --- | --- |
| **Sender note** (#39306): `[T3 Code: the agent in T3 thread "…" sent this message, not the user.]`, with scheduled-task and MCP variants | `withMessageSenderNote` in `packages/contracts/src/orchestrationV2.ts`, called from `ProviderTurnStartService.ts` (trial l.1021) and `ProviderTurnControlService.ts` (trial l.467); both merged **silently** | Two author lines on every message from another thread, a scheduled task or an MCP tool: Loom's own label (`provenance.loom.ts` `labelledForModel`, which the addendum is written around) above upstream's note | §8.1 row; recommended: two marked call sites pass the text through unchanged, plus one Loom test that a scheduled fire carries one label. **S1 lane 2 writes the two lines** (one file is in its zone, the other merged silently); Gate 1 reads them |
| **Pull request linking rules** (#31727): a `<pull_request_linking>` block ("When pull_request_* tools are listed, use them, not gh … merge PRs"; "Delegated children never watch, even if the brief says babysit") | `packages/provider-pi/src/server/mcpExtensionSource.ts` hunk 7, shaped as an upstream-only insertion; it re-adds the orchestration instructions Loom strips (DL-905) and appends the new block to pi's system prompt | A second set of rules about PR tools Loom withholds, and a line that contradicts Loom's shipper children watching their own PR | Pre-ruled (§8.2): drop the hunk, DL-905 extended. S2a adds an assertion to `mcpExtensionSource.loom.test.ts` on the prompt-sections path pi 1.5.1 actually takes (today's test covers only the fallback path) |
| **Reply projection** (#33124): `Read it in full: t3_thread_read({"threadId":…,"itemId":…})` | `packages/shared/src/composerContextReferences.ts`, when the user sends a reply made with the new Reply hover action | A hint to call a tool pi does not have; the response is usually already in pi's context | Taken as shipped (§8.2); a Loom projection is a follow-up with evals (§8.3) |

A fourth path is an exposure trap rather than text. Upstream turns the
`mcp__t3_code__<name>` alias of each tool from hidden into model-only and
activates the alias of every tool pi can search for (#26845). A Loom-withheld
tool is registered hidden but still counts as searchable, so its alias would
become callable. In `mcpExtensionSource.ts` hunk 6 the check for Loom's hidden
tools goes **before** the alias logic, and the "follows its public tool" test
returns false for them (B.6). S2a asserts in `mcpExtensionSource.test.ts` that
`mcp__t3_code__preview_snapshot` stays hidden when the tool is in
`T3_LOOM_HIDDEN_TOOLS`.

### 4.4 A Loom capability that breaks without a re-home: children watching their own PR

Upstream moved the watch code out of `mcp/toolkits/pullRequests/handlers.ts`
into a new service, `apps/server/src/pullRequest/PullRequestWatchService.ts`
(#33389, #38926). The refusal now reads, at trial line 120:

```ts
if (watching && thread.lineage.relationshipToParent === "subagent") {
  return yield* new PullRequestWatchFromSubagentError();
}
```

Every Loom child has `subagent` lineage (DL-1510). Loom's exemption that lets
a shipper child watch its own PR (DL-471) sits in the 32-line Loom-only hunk
of `handlers.ts`, which is now dead code: the hunk's kind is `o` (upstream's
side empty) because upstream deleted the block, so the naive resolution keeps
it and it never runs. **Resolution:** drop Loom's whole side in `handlers.ts`
and write the exemption at the new home:

```ts
if (watching && thread.lineage.relationshipToParent === "subagent" && thread.workstream === undefined /* loom: DL-471 a Loom child watches its own PR */) {
```

`engine.getThreadShell` there returns the Loom-joined shell, so `workstream`
is present. `PullRequestWatchService.ts` is a new upstream file, so the line
is a marked Loom hunk in an upstream file from now on. S1 (lane 1) writes it;
Gate 1 reads it; S2a adds a Loom test that a Loom child may `setWatching`
through the service and an upstream subagent may not (the line moved silently
once, and `prToolkit.test.ts` covers only the orchestrator path).

`PullRequestWatchReactor.ts` (one hunk, 94 upstream lines) is Rule D with
Loom's DL-474 `loomChild` parameter on upstream's new `endsWithoutRead`
(B.5). Upstream's #38926 does not replace Loom's #527 (§6.5).

### 4.5 Who does what

| Session | Work |
| --- | --- |
| S1 lane 1 | `handlers.ts` and the DL-471 re-home; `McpSessionRegistry.ts` keeps Loom's exact-set issue (not upstream's capability union); `OrchestratorMcpService.ts` seven hunks; `PullRequestWatchReactor.ts`; takes upstream's `agentContextBudget.json` |
| S1 lane 2 | `mcpExtensionSource.ts` hunks 6 and 7; `ProviderSessionManager.ts` keeps `["workstream", "pull-requests"]`; the two sender-note call sites (`ProviderTurnStartService.ts` is in its zone, and it takes the silently merged `ProviderTurnControlService.ts` line with it) |
| Gate 1 | reads all of the above against this section |
| S2a | `families.ts` and `families.test.ts` per the rulings; the DL-471 service test; the two `mcpExtensionSource` assertions; the one-label test; `capabilities.test.ts` (upstream's link path now calls `projects.listShells()`, which the test does not mock); re-measures the budget |
| S4 | a shipper child watches its PR; a root's tool list shows no `pull_request_*` or `ci_*` name beyond the nine base ones; a scheduled-task fire on a pi root carries one author line |
