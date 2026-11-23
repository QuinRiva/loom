## 5. Translation, toolchain, Node and migrations

The toolchain itself barely moves this fortnight: Effect goes 4.1.2 → 4.1.5
(patch releases, no Loom exposure), `@effect/tsgo` stays 0.67.1 and
`tsconfig.effect.json` is byte-identical at base and target, so there are **no
new Effect diagnostics**. What costs work is one new lint rule that arrives
with upstream's translation of the app (§5.1), four dependencies the merge
drops without a marker (§5.4), a Node patch release with one SQLite behaviour
change (§5.3) and 28 migrations on first boot (§5.5).

### 5.1 Upstream translated the whole app; a lint rule now rejects plain English UI strings

**What changes for the user:** nothing visible. Web, mobile and the desktop
main process are translated into nine languages (de, es, fr, ja, ko, pt-BR,
ru, sv, zh; #37893, 1,408 files, plus follow-ups). The new `language` setting
defaults to `"en"` (`packages/contracts/src/settings.ts:595` at the target). A
string with no translation renders its English source text, never a key.
Catalogues ship inside the bundle as lazy JSON chunks: no network call, no
General Translation project, no API key. Settings gains a Language picker.

**What bites is the gate.** Upstream added the oxlint rule
`t3code/no-untranslated-copy` at `"error"` over `apps/web/src/**`,
`apps/mobile/src/**` and `packages/client-runtime/src/**` (root
`vite.config.ts` l.588–600 at the target; tests excluded). It covers
`apps/web/src/loom/**` and `*.loom.tsx`. `vp check` runs lint, so the rule
gates `pnpm ship`, and the pre-commit hook lints staged files. Run with the
target's rule sources over Loom's tree (an exact run, not a grep; Appendix A):

| Where | Errors | Files |
| --- | ---: | ---: |
| Loom-only files: `apps/web/src/loom/` | 530 | 67 |
| Loom-only files: `apps/web/src/preview/` (dev-only fixtures) | 275 | 9 |
| Loom-only files: other web (`files/mdx-plan/`, `Workstream*.tsx`, `GoalTasksPanel.tsx`, `chat/Staged*.tsx`, `lib/`) | 242 | 34 |
| Loom-only files: mobile `*.loom.*` | 25 | 6 |
| Loom-only files: `packages/client-runtime/src/state/loom/` | 24 | 5 |
| **Loom-only total** | **1,096** | **121** |
| Loom-added lines inside upstream files | 42 to 44 | 19 |
| Upstream's own 2,893 files, same harness | 0 | |

Until this is settled, every agent's commit or ship that touches a Loom
surface fails after the merge. The ruling is Carl's (§8.1, "Translation lint
on Loom's own surfaces"); the recommended answer, which S1 and S2b work under,
is: **Loom's own files stay English and are excluded from the rule; a Loom
string inside an upstream component is wrapped like its neighbours.**

**The translation is a small share of the conflicts.** 66 of the 193
conflicted paths were touched by the translation commit; of their 173 code
hunks, 38 carry translation code on upstream's side and about 22 exist only
because of the wrapping. 47 of the 170 silently merged files were touched by
it; three carry Loom strings that now fail the rule.

**How upstream writes a string** (`docs/internals/i18n.md` at the target):

| Where | Form | Import |
| --- | --- | --- |
| JSX text, including `<code>`, `<strong>` and links inside it | `<T>Discard draft</T>`; values in `<Var>{x}</Var>`; plurals via `<Plural n={n} one={…} other={…} />` | `gt-react` (web), `gt-react-native` (mobile), imported **directly**: a local re-export hides strings from the scanner |
| Prop or string in a component or hook | `const gt = useGT();` then `title={gt("Discard draft")}`; variables `gt("{name} (guest)", { name })`; short ambiguous words take `{ $context: "verb" }` | same |
| Constant table (menus, settings index) | `label: msg("Diagnostics")` in the table; `const m = useMessages(); m(entry.label)` where it renders | same |
| Outside React (toasts, stores, callbacks) | `m(msg("An error occurred."))`, with `m` from `~/i18n/messages` (mobile: `src/i18n/messages`) | |
| `packages/client-runtime`, `packages/shared` | `msg()` from `gt-i18n`; helpers take `resolve: MFunctionType = mFallback` | `gt-i18n` |
| Desktop main process | `m(msg("T3 Code failed to start"))` with its own `apps/desktop/src/i18n/messages.ts` (e.g. `apps/desktop/src/app/DesktopApp.ts:153`) | `gt-i18n` |
| Server-imported shared modules | stay English; translatable copy moves to a `*Copy.ts` sibling that only clients import (e.g. `usageLimits.ts` / `usageLimitsCopy.ts`) | |

Never call `m()` during render: the React Compiler caches it and a language
switch would not update the text. Use `useGT()` / `useMessages()` in render.

**Rule I18N, for every lane that resolves a web, mobile or client-runtime
file:**

| Case | Resolved line | Runtime, non-English locale | Check time |
| --- | --- | --- | --- |
| I18N-1. Upstream wrapped lines next to a Loom edit; Loom did not change the English (e.g. `ThreadNotificationCoordinator.tsx`: upstream `m(msg("Input needed"))`, Loom added the `header` lines below) | Take upstream's wrapped lines verbatim, then re-apply Loom's delta (Rule U or D) | Upstream text translated | passes |
| I18N-2. Upstream wrapped a string whose English Loom changed (e.g. `ThreadNavigationSidebar.tsx`: base `"Searching thread messages…"`, Loom `"Searching threads…" // loom: more than messages`, upstream `gt("Searching thread messages…")`) | `gt("Searching threads…") // loom: more than messages`: Loom's English inside upstream's wrapper | English (Loom's text hashes to a key the catalogue lacks; the fallback is the source text) | lint passes; `i18n:check` (CI only, not run by Loom) would list the key as missing |
| I18N-3. A Loom line adds a new user-visible string inside an upstream component (e.g. `ComposerCommandMenu.tsx` `thread: "Threads", // loom: …` beside upstream's `skill: msg("Skills")`) | Wrap it in the same form as its neighbours: `thread: msg("Threads"), // loom: the ! thread menu (DL-750)`. For JSX text use `<T>…</T>`; for a prop, `gt("…")` using the component's `const gt = useGT()` (add that line if absent). Use ICU variables, never a template literal: `` `Sub-thread: ${t}` `` becomes `gt("Sub-thread: {title}", { title: t })` | English | A plain literal **fails `vp check` and pre-commit** wherever the rule recognises copy (JSX text, `title`/`label`/`aria-label`/`placeholder`/`description`/`message`/`*Label`/`*Title`… props and object keys, returned capitalised strings, `set*Error`/`show*Error` arguments) |
| I18N-4. A Loom string that is not UI copy (sent to an agent, an id, a log label) but the rule flags it | `// oxlint-disable-next-line t3code/no-untranslated-copy -- loom: <why>` | n/a | passes |
| I18N-5. Loom-only files | Leave plain; covered by the exclusion block below (the §8.1 ruling) | English | passes once the hunk lands |
| I18N-6. Catalogue JSON files | `theirs`, always (none conflicts in this pull) | | |

**The exclusion block** (S2b adds it to the `no-untranslated-copy` rule
block's `excludeFiles` in the root `vite.config.ts`, as one marked hunk):

```ts
// loom: Loom's own surfaces are English-only (runbook 41 §5.1); upstream's strings stay gated.
"apps/web/src/loom/**",
"apps/web/src/preview/**",
"apps/web/src/components/files/mdx-plan/**",
"apps/web/src/components/files/AbsoluteDirectoryPanel.tsx",
"apps/web/src/components/Workstream*.tsx",
"apps/web/src/components/GoalTasksPanel.tsx",
"apps/web/src/components/chat/Staged*.tsx",
"apps/web/src/lib/workstreamPresentation.ts",
"apps/web/src/threadRouteLineage.ts",
"packages/client-runtime/src/state/loom/**",
"**/*.loom.{ts,tsx}",
```

Every one of these paths is absent from the upstream target, so the globs
never exempt an upstream file, and together they cover all 121 Loom-only
files the rule flags. S2b confirms with `vp check` that the count on Loom-only
files is 0 afterwards and that the remaining errors are the wraps below.

**Conflicted files where Loom's side adds a string the rule flags** (cases
I18N-2 and I18N-3; the zone file's row decides the rest of the hunk):

| File | Loom flagged lines | Zone |
| --- | --- | --- |
| `apps/web/src/components/RightPanelTabs.tsx` | 7 (Loom's `return "Workstream"` / `"Context"` cases: upstream now returns `resolve(msg("Linked items"))`, so write `resolve(msg("Workstream"))`) | B.10 |
| `apps/web/src/components/settings/ProviderModelsSection.tsx` | 4 | B.12 |
| `apps/mobile/src/features/files/WorkspaceFilePreviewError.tsx` | 3 | B.13 |
| `apps/web/src/components/sidebar/SidebarThreadRow.tsx` | 2 | B.11 |
| `apps/web/src/components/CommandPalette.tsx` | 2 | B.11 |
| `apps/web/src/components/ChatView.tsx` | 2 | B.9 |
| `apps/web/src/components/chat/TimelineUserMessageRow.tsx` | 2 (Loom's `loomBubble?.label ??` wraps upstream's new `gt("You", { $context: … })` / `gt("{name} (guest)", …)`) | B.9 |
| `apps/mobile/src/features/keyboard/CommandPalette.tsx` | 2 | B.13 |
| `packages/client-runtime/src/connection/presentation.ts` | 1 (`"Sign in required."` becomes `resolve(msg("Sign in required."))`, matching upstream's `resolve(msg("Connection failed"))`) | B.4 |
| `apps/web/src/components/ThreadSearchMatch.tsx` | 1 (`Sub-thread: {subThreadTitle}` becomes `<T>Sub-thread: <Var>{subThreadTitle}</Var></T>`) | B.11 |
| `apps/web/src/components/settings/settingsSearch.ts` | 1 | B.12 |
| `apps/web/src/components/CommandPaletteThreadItems.tsx` | 1 | B.11 |
| `apps/mobile/src/features/threads/thread-search-match.tsx` | 1 | B.13 |
| `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` | 1 | B.13 |
| `apps/mobile/src/features/threads/PendingUserInputCard.tsx` | 1 | B.13 |
| `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` | 1 | B.13 |

**Conflict hunks that exist only because of the translation** (upstream's side is base plus wrapping; resolve with I18N-1 or I18N-2: Loom's side re-wrapped in upstream's form). Found by classifying all 173 code hunks with `git merge-file --diff3` on the index stages, then reading 11 hunks across 8 files by hand: `ThreadFilesRouteScreen.tsx`, `WorkspaceFilePreviewError.tsx`, mobile `thread-search-match.tsx` (2), mobile `UsageLimitsPooled.tsx`, `ChatView.tsx` (1 of 7), `NoProjectsHero.tsx` (Loom's `header` prop on top of upstream's `const gt = useGT(); … gt("Home")`), `ThreadNotificationCoordinator.tsx`, `ThreadSearchMatch.tsx`, `ComposerCommandMenu.tsx`, `MarkdownThreadLink.tsx` (hunk with `gt("Thread")`), `ThreadNow.tsx`, `UserMessageContextChips.tsx`, `FileBrowserPanel.tsx` (1 of 8), `SettingsPanels.tsx` (2 of 3), `SidebarThreadRow.tsx` (1 of 8), `TimelineUserMessageRow.tsx`, `presentation.ts` (hunk 3). Files whose **every** hunk is translation-only: `WorkspaceFilePreviewError.tsx`, `thread-search-match.tsx`, `NoProjectsHero.tsx`, `ThreadNotificationCoordinator.tsx`, `ComposerCommandMenu.tsx`, `ThreadSearchMatch.tsx`, `TimelineUserMessageRow.tsx`, `ThreadFilesRouteScreen.tsx`. These are easy resolutions; none needs Gate 1.

**Silently merged files with a surviving Loom string that fails the rule**
(S2b): `apps/mobile/src/components/ComposerContextSheet.tsx` l.283–295 (the
`mdxAnchor` branch's "Document", "Section", "Answer", "Verdict", "Comment",
"Quoted" labels: `label={gt("Document")}` and so on);
`apps/web/src/components/ui/toast.tsx` l.752 and 764 (the dismiss-all footer:
`gt("Dismiss all {count} notifications", { count: liveToastCount })` and
`<T>Clear all</T>`); `apps/web/src/reviewCommentContext.ts` l.163 and 194
(`sectionTitle … || "Review"` is text for an agent's context, so case I18N-4:
a reasoned disable, not a wrap).

**A crash that only shows in production.** Loom's separate document-viewer
page (`apps/web/document-viewer.html` →
`apps/web/src/loom/documentViewer/main.tsx`) never starts the translation
library. Its `<Image>` block renders upstream's `ChatMarkdownAssetImage`,
which now calls `useGT()`, and that throws before the library is started.
Browser tests cannot catch it, because `apps/web/test/browserSetup.ts` starts
the library for every test. **S2b adds `initializeI18n(() => {});`** (from
`~/i18n/initializeI18n`) before `createRoot` in that file, and S4 opens a
document with an `<Image>` block in the document viewer. The main app's
`/preview` harness, the in-app MDX renderer and Loom's mobile screens all
render under upstream's `<I18nProvider>` and need nothing.

**A moved helper.** The translation commit moved `limitsNotice` and
`formatDuration` out of `packages/shared/src/usageLimits.ts` into the
client-only `usageLimitsCopy.ts` (server-imported modules stay English).
Loom's hub-login lines in `usageLimits.ts` call both: B.7 gives the
resolution (a marked private copy of `formatDuration`; importing it back
would be a cycle).

**Catalogues and checks.** Take
`apps/{web,mobile,desktop}/src/i18n/translations/*.json` from upstream at
every pull (none conflicts this time) and never run `i18n:generate` in Loom.
A Loom-edited wrapped string then has no catalogue entry and renders English
in every locale. `vp run i18n:check` would list it, but only upstream's
`ci.yml` runs that check, the workflow is not active on the fork, and the
check is in neither `vp check`, `check:changed` nor `pnpm ship`.

**`AGENTS.md`.** An upstream "Languages" bullet auto-merged into Loom's
`AGENTS.md` (trial l.128), telling every agent to translate new keys into
every locale and run `i18n:check`. It is model-read policy the merge itself
would introduce, and it contradicts the recommended ruling, so **S1's lead
deletes it** (a DL row). The Loom sentence that should replace it ("Loom's
own UI text stays English: new Loom UI goes in the paths the lint rule
excludes, and a Loom string added inside an upstream component is wrapped
like the strings around it") is a change to text agents read, so it is a
follow-up PR under the `llm-instruction-change` rules, not part of this pull
(§8.3). Until it lands, an agent that adds a Loom string to an upstream
component meets the lint error, whose message names the wrap.

### 5.2 Version table

| Item | Base → target | Consequence for Loom |
| --- | --- | --- |
| `effect`, `@effect/*` (9 packages) | 4.1.2 → **4.1.5** (catalog) | `vp i`; API exposure 0 (§5.6). `@effect/vitest` patch re-cut (only the `effect` peer range changed); new `@effect/platform-node-shared@4.1.5` patch |
| `@effect/tsgo` | 0.67.1 → 0.67.1 | `tsconfig.effect.json` unchanged: no new diagnostics. `apps/web/tsconfig.json` gains `ES2024.Promise` lib and `gt.config.json` include |
| Node | `engines.node` 26.12.1 → **26.13.1** (#34576); `apps/server` `engines` unchanged | Read by CI (`setup-ci-deps` via `jq .engines.node`, every workflow's `node-version-file: package.json`) and the SEA build. Not enforced locally (no `engine-strict`). §5.3 |
| pnpm | 12.14.0 → same | none |
| Vite+ (`vite-plus`, `vp`, oxlint, oxfmt) | 1.4.0 → same | none; lint changes are plugin rules (§5.6) |
| React / React Compiler (`oxc-transform-react`) | 19.3.0 / ~0.152.0 → same | none |
| Electron | 44.10.1 → same (`electron-updater` pinned 6.8.9 + patch) | desktop only |
| Expo / React Native | expo 58.0.14 → 58.0.23, RN 0.88.0 → 0.88.1, screens t3.48 → t3.61, enriched-markdown t3.16 → t3.18, gesture-handler 3.5.0, pdf-jsi 6.1.0 | §6.11; new native fingerprint means `vp run mobile:install` rebuilds once |
| `@pierre/diffs` / `@pierre/highlights` | 1.6.1 → **1.7.0-beta.4** / 0.2.0 → 0.5.0 (#33627, #36974) | Loom's patch hunk to re-cut; 12 Loom files' imports to typecheck |
| `@legendapp/list` | 3.3.5 → 3.7.3 (patch re-cut) | Loom imports `@legendapp/list/react` in 3 files + 1 line; `useSyncLayout` still exported |
| i18n | new: `gt` 2.27.0, `gt-react` 11.4.18, `gt-i18n` 1.0.40, `gt-react-native` 11.4.18 | §5.1 |
| Markdown | web drops react-markdown/remark/unified (#27866) for `@pierre/words` (file tgz in `apps/web/deps/`); client-runtime and shared gain remark/hast deps | Loom's MDX renderer keeps its own (§5.4) |
| `katex` | 0.16.47 → 0.18.2 | Loom-only files do not import katex |
| `alchemy`, `@alchemy.run/*` | beta.85 → same | none |
| TanStack | router 1.160.2, router-plugin 1.161.0 → same | none |
| Clerk, `@anthropic-ai/claude-agent-sdk`, `@cursor/sdk` | bumps; `@cursor/sdk` 1.4.2 override + patch | not Loom's |
| Playwright | 1.60.0 → 1.64.1 | browser revision check (§5.6) |
| pi (`@earendil-works/pi-coding-agent`) | Loom 1.5.1 catalog + patch; upstream none | unions in `pnpm-workspace.yaml` h1/h2. Upstream's `providers-pi.md` now says "T3 Code supports Pi 0.84.3 or newer" (was 0.80.5): Loom's bundled 1.5.1 satisfies it |
| `patches/` | see B.1 | Loom's pi patch survives; `@pierre%2Fdiffs@1.6.1.patch` is a modify/delete owned elsewhere |

New root scripts: `i18n:check`, `i18n:untranslated`, `mobile:audit` (a
touch-target audit that needs a running device), `scenarios`,
`scenarios:prove` (needs the `e2e` runner and a built app). `pnpm ship` runs
none of them; its gates are `vp check` (which picks up the two new lint
rules), `vp run typecheck`, the unmarked sweep and the agent-context test.
New workspace packages: `packages/issue-tracker-linear`,
`packages/source-control-cursor-origin`,
`packages/source-control-tanstack-source` (picked up by the `packages/*` glob
and both knip configs). Playwright moves 1.60.0 → 1.64.1: if it pins a
Chromium revision other than the two on this host
(`~/.cache/ms-playwright/chromium-1223`, `-1228`), the browser tests and the
server's headless browser need `playwright install chromium` after `vp i`,
here before S2b and on the cockpit at deploy.

### 5.3 Node 26.12.1 → 26.13.1

`package.json` `engines.node` moves to 26.13.1 (#34576). Nothing enforces it
locally (no `engine-strict`; `vp i` does not refuse 26.12.1); CI reads it
through `node-version-file: package.json`. Upstream moved because 26.13.1's
SQLite no longer carries the JSON subtype through a subquery, so
`json_set(x, path, (SELECT json_group_array(…)))` stores a string; upstream
wrapped its own migration 026 in `json((…))`.

**Loom's migration 1066 has exactly that pattern, twice**
(`apps/server/src/persistence/Migrations/1066_DropHumanMessageDigestItems.ts`
l.12 and l.25). It has already run on the cockpit (`loom_sql_migrations` row
1066, 27 Oct), so the live database is unaffected; fresh and dev databases
and the migration's test are. **S2a wraps both subqueries in `json((…))`.** A
wide grep found no other Loom SQL passing a subquery into `json_set` or
`json_object`.

This host is the cockpit machine. Node is managed by `n` (prefix `~/.n`,
active 26.12.1); the deploy config, the cockpit unit and the bridge unit all
put `~/.n/bin` first, so `n 26.13.1` moves S3's tests, the deploy build, and
the live cockpit and the Slack bridge at their next restart. The ruling is
Carl's (§8.1, "Node 26.13.1 on this host"); the recommended answer is one
command before S3, reversible with `n 26.12.1`. No release pins or downloads
its own runtime.

### 5.4 Dependencies the merge drops without a conflict marker

Upstream's markdown rewrite (#27866, §6.2) removed remark and friends from
`apps/web/package.json`. Loom's MDX plan, recap and explainer renderer still
runs its own remark pipeline, and under pnpm's isolated `node_modules` a
package must be declared by the workspace that imports it. The conflicted
hunks in that manifest look Loom-only but are mostly upstream deletions, and
two packages are removed **outside any marker**. The reconciled list, which
S1's lead applies before the first `vp i` (it overrides B.1 and B.9 where
they differ on `react-markdown`):

| Package | Loom importers | State in the trial tree | S1 |
| --- | --- | --- | --- |
| `unified` | 5 files (`mdx-plan/inlineMarkdown.tsx`, `mdxAttrs.ts`, `proseDensity.ts`, `loom/pendingUserInputLoom.tsx`, `loom/remarkReferenceLinks.test.ts`) | **silently dropped** | re-add `"unified": "catalog:"` |
| `@types/mdast` (dev) | 2 files | **silently dropped** | re-add `"@types/mdast": "^4.0.4"` |
| `remark-gfm`, `remark-parse` | 5 files each | Loom's side of hunk 2 | keep |
| `remark-frontmatter`, `remark-mdx`, `@mdx-js/mdx` | 2, 2, 1 | present | keep |
| `react-markdown` | 1 (`mdx-plan/blocks/code.tsx`, `defaultUrlTransform`) | Loom's side of hunk 2 | **keep in S1**; S2b ports `code.tsx` to upstream's new renderer API (about 15 lines, B.9) and then removes the line and re-runs `vp i` (a DL row) |
| `zod`, `jsdom`, `@tabler/icons-react` | 33 files; the 12 jsdom tests and `scripts/lint-plan.mjs`; icons | Loom lines | keep |
| `remark-math`, `remark-rehype`, `vfile`, `micromark-util-types` | none in Loom code once `ChatMarkdown.tsx` is re-homed | Loom's side of hunks 2 to 4 | drop |

`apps/server/package.json` keeps Loom's `@huggingface/transformers` and
`google-auth-library`. A full import-to-manifest check over every Loom-only
file and Loom-added line found nothing else missing
(`tools/imports.py`). `strictPeerDependencies` and `minimumReleaseAge: 0`
will not make `vp i` refuse a Loom-only dependency. Loom's pi catalog line
(1.5.1) and its patch survive as unions in `pnpm-workspace.yaml`; upstream's
adapter supports pi `>=0.84.3`, so no pi bump is needed.

### 5.5 Migrations 081 to 108 against the fork lane and the cockpit database

Upstream adds **28** migrations (081 to 108; 106 to 108 landed on 22 Nov) and
edits five in place. The cockpit's ledgers stand at upstream **80** and Loom
**1072** (= `origin/main`'s head), so the first boot runs all 28 and no Loom
migration. All cockpit numbers were read on 23 Nov, read-only and in place.

**DL-1251's check is clean.** No upstream migration drops, renames or rebuilds
a table, column, index or trigger that a fork migration (1001 to 1072)
created or that Loom runtime code reads. Three drop an index: 083 drops
`…context_transfers_source_thread_idx` (created by upstream's 055; nothing in
Loom names it; its replacement is a superset), and 092 and 107 drop and
re-create indexes upstream itself created in 086 and 100.

Kind: A = additive, D = drops something, B = backfill over existing rows.

| # | PR | What it does (verbs quoted) | Kind | Tables touched and cockpit rows | First-boot cost on the cockpit and why | DL-1251 |
| --- | --- | --- | --- | --- | --- | --- |
| 081 `ProjectionMessageSearchText` | #22553 thread search finds phrases inside quotes | `ALTER TABLE …_messages ADD COLUMN search_text TEXT`; `recreateMessageSearchTriggers` (a no-op unless `orchestration_v2_message_search` exists); paged `SELECT … WHERE payload_json LIKE '%t3-citation://%'`, then `UPDATE … SET search_text` per match | A + B | messages 165,442; **546 rows match** | **Seconds.** The column add is O(1). The loop makes one primary-key-order pass over 165k rows (172 MB of payload), then 546 single-row updates | Clean. On the cockpit, 1065 already dropped the FTS table and triggers, so the guard skips them. Loom's `loom_ts_messages_au` fires on `UPDATE OF payload_json, streaming`, so the `search_text` backfill does not fire it. Fresh home: 069 → 074 → 081 (triggers re-created) → 1065 drops them again. Consistent |
| 082 `TurnItemConversationIndex` | #34490 long threads open 10x faster | `CREATE INDEX IF NOT EXISTS …turn_items_conversation_idx (thread_id, ordinal, type, run_id) WHERE type NOT IN (6 tool types)` | A | turn_items 511,221; 176,530 entries (≈ 20 MB) | **Seconds.** A scan of the table's leaf pages; the key has no JSON | Clean |
| 083 `CommandReadIndexes` | #35130 sending to a long thread reads 5x less | `CREATE INDEX …nodes_settled_leaf_idx (thread_id, (kind IN …AND status IN …AND run_id IS NOT NULL))`; **`DROP INDEX IF EXISTS …context_transfers_source_thread_idx`**; `CREATE INDEX …source_thread_status_idx (source_thread_id, status)` | A + D | nodes 365,422 (≈ 50 MB index); context_transfers 198 | **Seconds** (nodes scan) | The dropped index (created by 055) exists on the cockpit. Nothing in Loom names it: `rg source_thread_idx apps/server/src` finds only 055. Its replacement is a superset. Harmless |
| 084 `LastExecutedRunIndex` | #35167 thread list reads stop scanning runs | `CREATE INDEX IF NOT EXISTS …runs_last_executed_idx (thread_id, (completed_at IS NULL) DESC, …) WHERE status <> 'queued' AND NOT (cancelled AND json_extract(startedAt) IS NULL)` | A | runs 10,609 | Instant | Clean |
| 085 `TurnItemCounts` | #35167 | `CREATE TABLE …turn_item_counts (thread_id, run_key, item_count) WITHOUT ROWID`; `INSERT … SELECT thread_id, COALESCE(run_id,''), COUNT(*) FROM turn_items GROUP BY thread_id, run_id`; three `AFTER INSERT/UPDATE OF thread_id, run_id/DELETE` triggers on turn_items | A + B | turn_items 511,221 → **14,701 count rows** | **About 1 s.** The `GROUP BY` is served by the covering `…turn_items_thread_run_idx` (67 MB) | Clean. Loom writers to turn_items: `ToolOutputImageReclaim.loom.ts` updates only `payload_json`, so the update trigger does not fire. 1054 inserts and 1066 deletes run on empty tables on a fresh home and keep counts exact. `migrate-dev-db`'s generic `DELETE … WHERE thread_id NOT IN kept_threads` also deletes from the counts table, which stays consistent in either order |
| 086 `QueuedTurnInputIndex` | #23420 requeued steers no longer look delivered | `CREATE INDEX …turn_items_queued_input_idx (run_id) WHERE type='user_message' AND json_valid AND inputIntent='queued_turn'` | A | turn_items; JSON parsed for 25,797 user_message rows (76 MB); **125 entries** | **Seconds** | Clean |
| 087 `ProjectionProjectsCustomTitle` | #25244 preserve grouped renames | `ALTER TABLE projection_projects ADD COLUMN has_custom_title … DEFAULT 0` (guarded); `UPDATE … SET has_custom_title = 1 WHERE project_id IN (SELECT stream_id FROM orchestration_events WHERE project.meta-updated AND $.title is text)` | A + B | projection_projects 40; **0 rows flagged** (10 `project.meta-updated` events, none carries a title) | Instant | Clean. This is about **project** titles. The flag only changes the label of a project group whose title equals its repository name. `LoomStore` reads thread titles only. Every cockpit project title is its folder basename except the scratch project "No project", so nothing changes |
| 088 `TurnItemTypeStatusIndex` | #29521 send/edit/steer stop reading whole history | `CREATE INDEX IF NOT EXISTS …turn_items_thread_type_idx (thread_id, type, status)` | A | turn_items 511,221 (≈ 70 MB, the largest new index) | **Seconds** | Clean. It makes Loom's `loom_turn_items_tool_calls_idx` (1053, 25 MB) mostly redundant (follow-up, §8.3) |
| 089 `ShellThreadReadIndexes` | #36146 | three expression indexes: threads `$.worktreePath`, threads `$.lineage.rootThreadId`, runs `(run_id, status)` | A | threads 7,626; runs 10,609 | Instant | Clean |
| 090 `AuthConnectDevices` | #36419 require approval for new T3 Connect devices | guarded `ALTER TABLE auth_pairing_links ADD COLUMN requires_connect_approval DEFAULT 0, requested_client_json`; `ALTER TABLE auth_sessions ADD COLUMN proof_key_thumbprint`; `CREATE TABLE IF NOT EXISTS auth_connect_devices` | A | auth_pairing_links 387; auth_sessions 197 | Instant | Clean. Existing links default to "no approval needed" |
| 091 `AuthConnectDeniedRequests` | #36419 | guarded `ALTER TABLE auth_pairing_links ADD COLUMN connect_denied DEFAULT 0` | A | 387 | Instant | Clean |
| 092 `QueuedTurnInputIndexJsonValid` | #36898 | `DROP INDEX IF EXISTS …queued_input_idx`; re-`CREATE` with the same predicate | D + A (its own index) | as 086 | **Seconds** (086's scan again) | Clean (the index is upstream's own, created one migration earlier) |
| 093 `ProviderTurnAttemptIndex` | #34551 | `CREATE INDEX …provider_turns_attempt_idx (run_attempt_id)` | A | provider_turns 10,501 | Instant | Clean |
| 094 `TurnItemMessageOrdinalIndex` | #30873 | `CREATE INDEX IF NOT EXISTS …message_ordinal_idx (thread_id, json_extract($.messageId), ordinal) WHERE type IN (user_message, assistant_message) AND json_valid` | A | turn_items; 165,353 entries; JSON parsed over 201 MB (≈ 27 MB index) | **Seconds** (the heaviest JSON index build) | Clean. 0 invalid-JSON message items |
| 095 `TurnItemInlineWorkOutput` | #34014 long threads open 2.5x faster | `ALTER TABLE turn_items ADD COLUMN inline_work_output INTEGER NOT NULL DEFAULT 0`; `UPDATE … SET inline_work_output = 1 WHERE type='dynamic_tool' AND (payload LIKE '%htmlRender%' OR … 6 patterns)` | A + B | turn_items; scans 58,490 dynamic_tool payloads (362 MB); **rewrites 49 rows** (2 MB) | **Seconds.** The column add is O(1), not a table rewrite | Clean. See the overlaps below |
| 096 `RepairStaleTitleRegeneration` | #37364 | `UPDATE …threads SET payload_json = json_set(…'$.titleRegeneration', null) WHERE titleRegeneration is an object AND NOT EXISTS (pending title job)` | B | threads 7,626; **0 rows match** | Instant | Clean. Loom's `loom_ts_threads_au` fires only on `UPDATE OF title, deleted_at` |
| 097 `IssueTrackerBindings` | #19274 Linear as a standalone issue tracker | `CREATE TABLE IF NOT EXISTS issue_tracker_bindings` | A | new, empty | Instant | Clean |
| 098 `ActiveShellIndexIndexes` | #37966 | `CREATE INDEX …threads_active_shell_idx (updated_at, thread_id, project_id, 11 json_extract lineage/settle/pin/snooze fields) WHERE deleted_at IS NULL AND archived_at IS NULL`; `…provider_threads_pending_tasks_idx WHERE json_array_length(pendingBackgroundTasks) > 0` | A | threads: 5,270 active rows; provider_threads 7,350 (0 match) | Instant to about 1 s | Clean. The expressions read `lineage.*`, which Loom's 6,527 subagent-lineage threads carry. They are only indexed, nothing is rewritten |
| 099 `BackgroundRecoveryIndexes` | #27896 | `CREATE INDEX IF NOT EXISTS …turn_items_usage_limit_idx (thread_id) WHERE type='error' AND status='failed' AND json_extract($.failure.class)='usage_limit'` | A | turn_items; JSON parsed for 80 error rows; **24 entries** | **Seconds** (a leaf scan for the type filter) | Clean. The predicate does not key on lineage, so Loom's child threads match only through their own usage-limit errors |
| 100 `TurnStartReadIndexes` | #39103 | `CREATE INDEX …messages_deferred_command_idx (thread_id, created_at, message_id) WHERE role='user' AND trim($.text) GLOB '/*'`; `…subagents_routable_idx`; `…context_transfers_fork_idx WHERE type='fork'` | A | messages: 25,907 user rows parsed, **6** entries; subagents 0; 197 fork transfers | **Seconds** | Clean |
| 101 `DelegatedTaskReadIndexes` | #39325 | `CREATE INDEX …runs_delegated_task_idx (thread_id, json_extract($.delegatedTaskId)) WHERE … IS NOT NULL`; `…messages_delegated_task_idx WHERE role='user' AND (notification.source.kind='monitor' OR delegatedCompletion IS NOT NULL)` | A | runs 10,609, **0** with `delegatedTaskId` (Loom children are not upstream delegations); messages **49** | Instant to seconds | Clean |
| 102 `ThreadItemCounts` | #39391 | `CREATE TABLE …thread_item_counts WITHOUT ROWID`; `INSERT … SELECT SUM(item_count) FROM turn_item_counts WHERE run_key='' OR EXISTS run`; `…runs_hidden_items_idx WHERE status IN (rolled_back, queued, cancelled)`; five triggers on turn_item_counts and runs | A + B | 14,701 count rows → ≤ 7,626 thread rows; 164 hidden runs | Instant | Clean. New per-run-insert and per-run-delete triggers run subqueries on turn_items by `run_id` (indexed) |
| 103 `IssueTrackerAdditionalScopes` | #40023 | `ALTER TABLE issue_tracker_bindings ADD COLUMN additional_scopes DEFAULT '[]'` | A | empty | Instant | Clean |
| 104 `ProjectionProjectsTrackedFolders` | #35925 a project covers several repositories | guarded `ALTER TABLE projection_projects ADD COLUMN tracked_folders_json DEFAULT '[]'` | A | 40 | Instant. **It does not rewrite the projects or threads projection** | Clean. Loom's 1018 unique active `workspace_root` index is untouched |
| 105 `TaskFolders` | #35925 | `CREATE TABLE IF NOT EXISTS task_folders (root PK, real_root, project_id, …)`; `idx_task_folders_real_root` | A | new, empty | Instant | Clean (§6.6) |
| 106 `WorktreePathKeyIndex` | #36802 | `CREATE INDEX IF NOT EXISTS …threads_worktree_path_key_idx (lower(rtrim(replace(trim($.worktreePath)…))))` | A | threads 7,626 | Instant | Clean |
| 107 `DeferredSlashCommandIndex` | #30261 | `DROP INDEX IF EXISTS …messages_deferred_command_idx`; re-`CREATE` with the widened condition | D + A (its own index) | messages, as 100 | **Seconds** | Clean (the index is upstream's own, from 100) |
| 108 `AgentFeedback` | #35871 agents report T3 Code problems when feedback is on | `CREATE TABLE agent_feedback`; `agent_feedback_run_idx` | A | new, empty | Instant | Clean |

**First-boot cost: tens of seconds, estimated 20 to 90 s warm**, added to the
boot before the server listens (clients show "reconnecting"; there is no
window of partial service). The work is about eight passes over the 2 GB
`turn_items` table, three over `messages` and one over `nodes`. New index
pages add roughly 200 MB (4.73 GB → about 4.95 GB). New in this range
(#35486): one transaction per migration and a progress log line per migration
(`progress: <n> of 28`), which gives S3 its per-migration timings. The deploy
rolls back if the server is not up within `startTimeoutSeconds: 240`
(`~/loom-releases/deploy.json`); the estimate fits, and **S3 turns it into a
measurement** (§10 `ledger`): each `progress` line's timestamp, total
boot-to-listen time, file and WAL size before and after, the count checks in
§10, and that the **previous release still boots on the migrated copy** (the
rollback case; the old migrator skips ids at or below the highest recorded,
and the new count triggers only maintain counts).

**The five in-place edits change no schema.** 026, 064, 071, 072 and 075 gain
re-run guards and (026) the `json((…))` wrap for Node 26.13.1. The cockpit ran
all five and holds 0 rows any edit would treat differently, so a fresh home
and the cockpit end with the same schema.

**Specific overlaps, settled:**

- **081 against Loom's search index (1065).** 081 adds a `search_text` column
  to messages and re-creates upstream's search triggers only where upstream's
  index table exists; 1065 dropped that table on the cockpit, so the guard
  skips them. On a fresh home 069 → 074 → 081 → 1065 still ends with no
  `orchestration_v2_message_search*` object. Upstream's `ThreadSearch.ts`
  checks for the table before using it and otherwise scans
  `COALESCE(search_text, json_extract(payload_json,'$.text'))`, so search
  cannot throw on the cockpit. The backfill touches the 546 of 165,442
  messages that hold a `t3-citation://` link.
- **095 against Loom's tool-output image reclaim.** They do not collide: 095
  writes only its new `inline_work_output` column (49 rows); the reclaim is a
  manual `t3 doctor` command that rewrites `payload_json` and keeps the fields
  095's predicate reads.
- **099 and 101** match 24 rows and 0 runs / 49 messages; neither keys on
  lineage, so Loom's 6,527 subagent-lineage threads are only indexed.
- **087, 090/091, 097/103, 104/105, 108** are additive: one flag column on the
  40-row projects table (0 rows flagged), auth columns that default to "no
  approval needed" on 387 pairing links and 197 sessions, and new empty
  tables for issue trackers, task folders and agent feedback.
- **Pull 15's event-prune guard is gone, by Loom's own hand.** Loom commit
  `2e76814b9e` (10 Nov, PR #564) moved workstream history into
  `loom_thread_history` (fork migration 1070; 46,920 rows) and deleted both
  guard clauses. `ProjectionMaintenance.ts` is upstream-verbatim on Loom and
  upstream did not change it in range. The event log holds 102,956 rows (it
  was 1.46 M at pull 15) and the database file is 4.73 GB with 0 free pages
  (it was 6.78 GB).

**A trap beside the migrations (`Sqlite.ts`, B.3).** Upstream's new CLI path
(`runMigrationsAsOwner`, #26763) lets a CLI migrate only when no server owns
the database, but decides whether anything is pending from upstream's ledger
alone. Loom passes its two-ledger `runAllMigrations()` into both setup paths,
and the pending test also counts Loom's lane through a small marked helper in
`LoomMigrations.ts` (§8.2). And in `DatabaseMaintenance.ts` Loom's
`rebuildThreadSearchIndex` stays after upstream's new rebuild-search step,
because `VACUUM` renumbers the rowids Loom's index encodes.

**`migrate-dev-db` and the dev seed.** Migration 105's `task_folders` holds
absolute paths on this machine. S1 lane 3 adds `"task_folders"` to
`PER_INSTANCE_TABLES` in `apps/server/src/persistence/threadTreeSlice.loom.ts`,
or a dev server on a copied database could recursively delete real folders
through a path the foreign-home guard does not cover (B.8; latent, the
cockpit has no task folders).

### 5.6 Lint rules, diagnostics and the `Effect.scoped` refactor

- **Effect diagnostics:** none new (`tsconfig.effect.json` unchanged). Effect
  4.1.3 to 4.1.5's soft breaks have 0 exposures in 763 Loom-only files and
  14,324 Loom-added lines (`Tool.dynamic`, `RpcGroup.accessHandler`,
  `isAnyOf`, `Order.Struct`, `remoteParentSpan`, `Queue.sliding(0)` and the
  rest; B.1). The likelier source of type errors is `@pierre/diffs`
  1.7.0-beta.4, whose types 12 Loom-only files import.
- **Lint rules newly at `error`:** `t3code/no-untranslated-copy` (§5.1) and
  `t3code/no-sparkles-icon` (0 Loom hits), plus mobile `FlatList` /
  `RefreshControl` import restrictions (0 Loom hits). Every test rule
  `AGENTS.md` names was already at the base with the same configuration: 0
  new sites. Pull 14's sweep was 56 + 22 sites; this pull's is one config
  block and about 42 wraps.
- **#35993 "drop Effect.scoped wrappers that @effect/vitest already applies"
  (171 files) is cosmetic.** `it.effect` wrapped the test in `Effect.scoped`
  at the base and still does; no rule flags a leftover wrapper. Its 11
  conflicted test files are mostly re-indentation
  (`ThreadSettlementService.test.ts` changed by 2,129 lines, 67 ignoring
  whitespace): resolve them with a whitespace-blind view (`git diff -w`),
  take upstream's dedented shape and re-apply Loom's cases. A Loom case that
  keeps `.pipe(Effect.scoped)` still compiles and passes. The 11 are named in
  B.1.

### 5.7 Feature flags and Labs: what is on without anyone asking

Upstream now reads feature flags from one environment variable,
`T3CODE_FEATURE_FLAGS` (#40594). There are exactly three, all off by default,
the cockpit sets none, and no Loom code reads the variables they replaced:

| Flag | Gates | Default | Replaced |
| --- | --- | --- | --- |
| `secret_providers` | Settings → Secrets page, secret sources in cloud voice config, secret request card (web `SecretRequestCard.tsx:83`, `SecretSourceInput.tsx:45`, `CloudVoiceConfiguration.tsx:197`, mobile `CloudVoiceSection.tsx:202`) | off | build-time `T3CODE_FEATURE_SECRETS` (`apps/web/src/env.ts` `isSecretsFeatureEnabled`, mobile `app.config.ts` `extra.secretsFeatureEnabled`) |
| `tanstack_source` | TanStack Source forge and issue tracker driver (`apps/server/src/sourceControl/builtInDrivers.ts:31`) | off | `T3CODE_TANSTACK_SOURCE` (added in #40207 and replaced the same day; Loom never had it) |
| `github_app_client_id=<id>` | "T3 Code for GitHub" app sign-in (`GitHubAppSignIn.ts:105`); unset turns it off | unset (off) | `T3CODE_GITHUB_APP_CLIENT_ID` |

Labs (Settings → Labs → Beta), all off by default:

| Row | Setting | Default |
| --- | --- | --- |
| Boring sidebar (group by project) | `boringSidebarEnabled` | false |
| Two-line folder rows (shown under it) | `boringSidebarMultilineRows` | false |
| Guest links | `guestSharingEnabled` | false |
| Linked environments | `linkedEnvironmentsEnabled` | false |
| Suggest next prompt | `promptSuggestionsEnabled` | false |
| Simlock device hosts | `simlockDeviceHostsEnabled` | false |
| Fast worktree checkout (macOS) | `fastWorktreeCheckout` | false |
| Agent feedback | `agentFeedback.mode` | `"off"` |

Everything else upstream shipped this fortnight is on with no flag: the
Issues page, the agent PR and CI tools (§4), agent theming, multi-repository
projects (inert until a project has more than one repository), the Reply
action, keep-awake, the preview tunnel.
