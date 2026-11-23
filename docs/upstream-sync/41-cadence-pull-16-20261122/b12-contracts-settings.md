## Appendix B.12: contracts, settings, the two files upstream deleted (15 files, 20 markers, 100 `loom:` lines) · lane 6 client

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D1" is §8.1 "The composer context meter" (option B there = the meter kept as a Loom-owned component, the same answer as web chat's "(a)").

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/web/src/components/chat/ContextWindowMeter.tsx` · 0m · 4L · UD (deleted upstream) · 
- `apps/web/src/components/settings/ProviderModelsSection.tsx` · 4m · 6L · [6/2c] [15/15c] [10/4c] [1/1c]
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` · 1m · 5L · [3/12c]
- `apps/web/src/components/settings/SettingsPanels.tsx` · 3m · 6L · [2/1c] [2/1c] [2/31c]
- `apps/web/src/components/settings/settingsSearch.ts` · 2m · 4L · [1/6c] [1/5c]
- `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts` · 2m · 4L · [1/2c] [1/5c]
- `apps/web/src/editorPreferences.ts` · 1m · 2L · [4/2c]
- `apps/web/src/keybindings.ts` · 1m · 1L · [13/10c]
- `apps/web/src/modelSelection.test.ts` · 1m · 10L · [30/20c]
- `apps/web/src/modelSelection.ts` · 1m · 6L · [2/1c]
- `packages/contracts/src/index.ts` · 1m · 4L · [1/1c]
- `packages/contracts/src/orchestrationV2.ts` · 1m · 26L · [5/9c]
- `packages/contracts/src/settings.test.ts` · 1m · 8L · [37/3c]
- `packages/contracts/src/settings.ts` · 1m · 13L · [6/0o]
- `patches/@pierre%2Fdiffs@1.6.1.patch` · 0m · 1L · UD (deleted upstream) · 

### Per-hunk doctrine

| Path | Hunk | Upstream change | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/contracts/src/settings.ts` | [6/0o] | #33131 deletes `planModeEnabled` and `contextWindowMeterEnabled` | Loom's `true` re-default of the meter plus its comment; `planModeEnabled` is upstream's own line | A (trap: upstream deletion) | Take upstream's empty side. Both fields are gone upstream. Under D1=B the meter field is re-added in `settings.loom.ts`, never here. The other 12 `loom` lines merged silently and are intact (`autoResumeLimitedThreads: true` at trial :1503, pi default text generation at :1576, pi out of `DEFAULT_DISABLED_PROVIDER_DRIVERS` at :1659, pi in `DEFAULT_ENABLED_DEFAULT_INSTANCES` at :1666, the five sidecar spreads). | yes |
| `packages/contracts/src/settings.test.ts` | [37/3c] | #35305 terminal-close confirmation test | three Loom describes (restart continuation, auto-resume, quiescence graces) | U / T | Keep all three Loom blocks and add upstream's `ClientSettings terminal close confirmation` describe. Outside the hunk, Loom's `ClientSettings context window meter` test (trial :392) stays under D1=B and is deleted under A. | no |
| `packages/contracts/src/index.ts` | [1/1c] | #35925 `workspaceFolders.ts` export | `export * from "./plan.ts"; // loom` | U | Keep both lines. No export-name collision between `plan.ts`, `contextUsage.loom.ts`, `rpc.loom.ts`, `orchestrationV2.loom.ts`, `settings.loom.ts` and upstream's contracts (checked by name). | no |
| `packages/contracts/src/orchestrationV2.ts` | [5/9c] | #33214 `thread.pull-request-watch.checks-reopen` internal command | `...makeLoomInternalCommandMembers(...)` | U | Keep Loom's spread and upstream's new struct, both inside `OrchestrationV2InternalCommand`. The 25 silently merged `loom` lines are all present and in the same struct (`anchor.py` run in §9 prints `ok` for each). `OrchestrationV2CreationFields` and `OrchestrationV2UserInputQuestion`, which the spread takes, still exist upstream. | no |
| `apps/web/src/components/chat/ContextWindowMeter.tsx` | UD | #33131 deletes it; context moves to `ThreadDetailsContext` (`ThreadDetailsUsage.tsx:109`), compaction helpers to `compaction.logic.ts` | `loomSpend` slot (4 lines) | per D1 | `git rm` at this path in every option. Under B, recreate it as `apps/web/src/loom/ContextWindowMeter.tsx` (§2). The `dangling-imports.json` entry is this file importing the deleted `./ContextWindowMeter.logic`. | yes |
| `patches/@pierre%2Fdiffs@1.6.1.patch` | UD | #33627 then #36974 move to `@pierre/diffs` 1.7.0-beta.4; upstream ships `patches/@pierre__diffs@1.7.0-beta.4.patch` (editor, textMeasure, parsePatchFiles) | one hunk in `dist/components/VirtualizedFileDiff.js` `invalidateEditSessionLayout()`: `this.getAdvancedVirtualizer()?.capturePendingLayoutAnchor();` (commit `4c0654a3de`, typing in the whole-file comparison) | port | `git rm` the 1.6.1 patch. Add Loom's hunk to upstream's 1.7.0-beta.4 patch file (pnpm takes one patch per package version, so Loom cannot ship a separate file): `pnpm patch @pierre/diffs@1.7.0-beta.4`, insert the two-line `// loom:` comment and the call as the first statement of `invalidateEditSessionLayout()` (1.7 dist line 563, before `this.getSimpleVirtualizer()?.markDOMDirty();`), then `pnpm patch-commit`. `pnpm-lock.yaml`'s patch hash changes with it. Why it is still needed: in 1.7, `applyChange` captures the anchor only when `changeMovesLines(change)`, but `FileDiff.applyChange` escalates on `hunksChanged` too (`renderChange(rowsMoved \|\| hunksChanged)`), and that path calls `invalidateEditSessionLayout()`, which clears checkpoints and estimated heights with no anchor. That is the first keystroke on an unchanged line of a wrapped file. Verify live (dev-verify recipe): type into a long wrapped line of the whole-file comparison; the view must not jump. | yes |
| `apps/web/src/components/settings/SettingsPanels.tsx` | 1 [2/1c] | #37893 i18n (`gt("Diff layout")`), **string wrapping only** | `...loomAutoOpenChangedLabels(settings), // loom: 3d-4` | U | Upstream's wrapped line, then Loom's line. | no |
| same | 2 [2/1c] | #37893 i18n (`title={gt("Updates")}`), **string wrapping only** | `<LoomDeployRows …/>` | U | Upstream's section opening, then Loom's deploy row. | no |
| same | 3 [2/31c] | #34128 "Keep awake while agents work" row | `<LoomAutoOpenSettingsRows …/>` | U | Upstream's row, then Loom's rows, both in Background activity. The upstream-deleted `LegacyFeaturesSection` (plan mode and meter switches) merged away silently; do not restore it. | no |
| `apps/web/src/components/settings/settingsSearch.ts` | 1 [1/6c] | #32927, #35871, #33147, #33209, #40594 availability flags | `canDeployLoom` | U | Keep all seven fields. | no |
| same | 2 [1/5c] | same commits | `(!item.loomDeployOnly \|\| availability.canDeployLoom === true), // loom` | U | Upstream's four conditions, with `&&` replacing the trailing `),` on upstream's last one, then Loom's line, which closes the expression. | no |
| `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts` | 1 [1/2c] | #37893 (`useMessages`) and #40594 (`hasFeatureFlag`) imports | `useAtomValue` import | U | All three imports. | no |
| same | 2 [1/5c] | same as settingsSearch | `canDeployLoom` | U | All six fields. | no |
| `apps/web/src/components/settings/ProviderModelsSection.tsx` | 1 [6/2c] | #35176 `onChange` returns `Promise<boolean>` | allow-list props (DL-913) | U | Loom's two prop lines with comments, then upstream's `onChange` signature. | yes |
| same | 2 [15/15c] | #23479 (`listedModels` keeps unreported favourites) and #31637 (`heldPlacements`, so a toggled row does not jump) | allow-list `pickerHiddenSet` | D | Take upstream's shape and compute Loom's mode-aware set over `listedModels`: `const pickerHiddenSet = showOnlySelectedModels ? new Set(listedModels.filter((m) => !m.isCustom && !selectedModelSet.has(m.slug)).map((m) => m.slug)) : hiddenModelSet;`, then `placedHiddenSet` filters on `heldPlacements.get(slug) ?? pickerHiddenSet.has(slug)`, and `groupModelsForDisplay(listedModels, { hiddenModels: placedHiddenSet, … })`. Keep Loom's 4-line comment. | yes |
| same | 3 [10/4c] | #31637 records a held placement before toggling | allow-list toggles `selectedModels` | D | `if (!canWritePreferences) return;`, then the held-placement update keyed on `pickerHiddenSet.has(slug)` (upstream's `setHeldPlacements` line with `hiddenModelSet` replaced), then Loom's allow-list branch, then upstream's deny-list path guarded by `hidden === hiddenModelSet.has(slug)`. | yes |
| same | 4 [1/1c] | #31637 | `pickerHiddenSet` | D | Use `placedHiddenSet`, which now folds in Loom's set. Outside the hunks, trial :211 and :392 keep `pickerHiddenSet` (correct: count and switch state must follow the mode, not the held placement). | yes |
| `apps/web/src/components/settings/ProviderSettingsPanel.tsx` | [3/12c] | #33147 Text generators section, and #37893 `gt("Advanced")` (wrapping) | DT-92 failover comment | U | Loom's comment, upstream's `TextGeneratorsSettings` block, upstream's wrapped `Advanced` section. Loom's other nine allow-list lines merged silently and are intact. | no |
| `apps/web/src/editorPreferences.ts` | [4/2c] | #37201 parses `file://` targets into path and position | remote-host Zed launch over SSH | U | Loom's early return first, then upstream's two `uri`, `line`, `column` lines. | no |
| `apps/web/src/keybindings.ts` | [13/10c] | #26433 `isThreadNavigationShortcut` | centre-panel tab helpers | U | Upstream's function, its closing `}`, a blank line, then Loom's comment and two functions (the shared closing `}` after the hunk ends Loom's second function). | no |
| `apps/web/src/modelSelection.ts` | [2/1c] | #37528 removes the last uses of `ANTIGRAVITY_DEFAULT_MODEL` (preserve-unavailable now keys on `hasRuntimeModelCatalog`, which covers pi) | `PI_DEFAULT_MODEL` import | U with drops | Import `PI_DEFAULT_MODEL` and upstream's remaining names. Drop `ANTIGRAVITY_DEFAULT_MODEL` (no use left in the trial file) and `DEFAULT_TEXT_GENERATION_MODEL` (its one use is Loom's `model: PI_DEFAULT_MODEL` at trial :446). `planModeEnabled` → `includePlanAgent` (#33131) merged silently. Not #31207: the @-mention commit does not touch this file. | no |
| `apps/web/src/modelSelection.test.ts` | [30/20c] | #37528 turns the antigravity marker test into an `it.each` over antigravity and `acpRegistry` | DL-913: hiding the only catalogue model still resolves to it | D / T | Take upstream's `it.each`. In its `hiddenSettings` add `selectedModels: [], showOnlySelectedModels: false` (required by Loom's preference fields) and replace upstream's `.toBeNull()` with Loom's `.toBe(nativeModel)` plus the two-line `// loom:` comment. S2 must run it: under DL-913's fallback chain the `acpRegistry` case should also resolve to `nativeModel`; if not, keep Loom's assertion for antigravity only and log a DL row. | yes |

### Silently merged files Gate 2 reads in this zone

| File | Why |
| --- | --- |
| `apps/web/src/modelSelection.ts` (region around trial :299-320) | #37528 extends preserve-unavailable to pi (`hasRuntimeModelCatalog`). Loom's DL-913 fallback (`!option.excluded`) sits right after it, intact. Check that a pi selection missing from a catalogue gap is kept and that an allow-listed-out model is not resurrected: `hiddenModels.includes` does not see `selectedModels`. It only fires for slugs missing from `entry.models`, so the risk is low. |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts` | Upstream dropped the `contextWindowMeterEnabled: false` fixture line. Under D1=B it comes back, marked, beside Loom's `autoOpenWorkstreamPanel` line (:25). |
| `packages/shared/src/model.ts` | DL-1720's `draftModelPickMatchesThread` line (:132) is intact. DL-1720 lives here, not in `modelSelection.ts`. |
| `apps/web/src/components/settings/ProviderInstanceCard.tsx`, `ProviderSettingsPanel.environment.browser.test.tsx` | Both-modified; every `loom` line is present. Read with the allow-list hunks above. |

No Loom line was found lost in the trial tree across the 15 owned files and these five.

### Left for the integration tracks (S2)

- **Typecheck: `apps/web/src/loom/review/FileChangeView.tsx:682`** passes `onRevealSearchMatch={() => undefined}` to `AnnotatableCodeView`. Upstream removed that prop with the 1.7 built-in find (0 hits in upstream's `AnnotatableCodeView.tsx`). Delete the line. It is a Loom-only file with no conflict, so nothing flags it before typecheck.
- **Meter importers on Loom's side** (6): `ComposerFooterControls.tsx` (meter, placeholder, `LoomContextSpend`), `ChatComposer.tsx` (`shouldReserveContextWindowMeter`, `settings.contextWindowMeterEnabled` at trial :4112-4115), `ChatView.tsx` (`hasAvailableCompactionProvider`, already repointed to `compaction.logic` in the trial), `ThreadDetailsUsage.tsx` and `lib/contextWindow.test.ts` (repointed), `ContextWindowMeter.logic.test.ts` (renamed upstream to `compaction.logic.test.ts`). Upstream's side has none. `markdown-chat` owns the two composer files: under A they take upstream; under B they keep Loom's marked lines, pointed at `~/loom/ContextWindowMeter`.
- **Docs (owned by `toolchain-config`):** Loom's DL-1712 sentences in `docs/user/composer.md`, `providers-pi.md`, `providers-acp.md`, `providers-claude.md` point at "Settings → Labs → Legacy", which no longer exists. Under A, take upstream's paragraphs; under B, name the new switch location.
- **Tests:** `modelSelection.test.ts` (one case, §3); `settings.test.ts` meter case (keep or delete per D1).
- **Lockfile:** the `@pierre/diffs` patch hash changes once Loom's hunk is in the 1.7 patch.
