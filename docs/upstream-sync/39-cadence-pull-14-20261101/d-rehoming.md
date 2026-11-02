## Appendix D: where a Loom hunk moves this week

`rehome.py` (Appendix A) over the 49 conflicted web files finds every Loom hunk
"stays" in its file except the five below. There is no module split to map;
Rule D is in-file everywhere else (§6.4).

| Source (Loom's `origin/main` file and hunk) | Moves to | Why |
| --- | --- | --- |
| `apps/web/src/components/settings/providerDriverMeta.ts`: `piClient, // loom: Pi-first fork, pi leads the driver list.` | `packages/client-runtime/src/providerClients.ts`: `piClient` first in `makeProviderClientRegistry([...])`, marked | Upstream made the web file a one-line re-export and deleted mobile's copy; both clients now read the client-runtime registry |
| `apps/web/src/components/chat/ComposerActivityStatus.tsx` (UD): the `useThreadSyncError(threadRef)` diagnostic beside "Loading messages…" | `apps/web/src/components/chat/ThreadNow.tsx`, whose `ThreadSyncLine` renders `threadSyncLabel(phase)` at the end of the timeline (#25401): `useThreadSyncError(threadRef)` beside the label, marked | Upstream deleted the composer activity row; the failure a sync error reports still has to show somewhere other than an indefinite spinner |
| `apps/web/src/composer-logic.ts`: `ComposerTriggerKind` `"thread"` and `ComposerSlashCommand` `"handoff" \| "retro"` | Same file (upstream moved the trigger types toward `packages/shared/src/composerTrigger.ts`; if the type now lives there, Loom's members go with it) | S1 checks where `ComposerTriggerKind` is declared at `fa31b66bbb` and adds Loom's members there, marked |
| `apps/web/src/components/ChatView.tsx`: one `useComposerSend`-adjacent hunk (the reply-in-chat ref) | `apps/web/src/components/chat/useComposerSend.ts` (already Loom-marked there since pull 13; the ChatView side is the ref hand-off) | `rehome.py` votes the hook file; S1 confirms the ref is still passed |
| `apps/web/src/routes/_chat.tsx`: `useThreadTabKeyboard()` and its import | Same file, inside upstream's `ChatRouteLayout` | Upstream cut 192 lines including the function Loom's hook sat in |
