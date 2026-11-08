## Appendix D: where a Loom hunk moves this week

No Loom-edited file was split or renamed by upstream this week; Rule D is
in-file everywhere (§7.1). Two Loom hunks sit on code upstream moved and are
re-applied at the new home; everything else "stays".

| Source (Loom's `origin/main` file and hunk) | Moves to | Why |
| --- | --- | --- |
| `apps/web/src/composer-logic.ts`: `ComposerSlashCommand` `"handoff" \| "retro"` and the `parseStandaloneComposerSlashCommand` comment | Same file, on upstream's new literal list (`"model" \| "plan" \| "default" \| "side" \| "btw" \| "clear"` + Loom's two) and upstream's `Exclude<ComposerSlashCommand, "model" \| "side" \| "btw" \| "clear">` return type (Loom's two intercepts are already excluded by their own recognisers, so the type needs no Loom member) | Upstream re-typed the function around `/clear`; `packages/shared/src/composerTrigger.ts` (+5) still does not hold the slash-command type, so Loom's members stay in the web file |
| `apps/server/src/orchestration-v2/ProjectionMaintenance.ts`: the DL-1300 guard (`if (!loomHistoryEventTypes.has(row.event_type)) obsolete.push(…)` inside the deleted compaction loop) | The same file's two new SQL passes (§4.3): a `WHEN` in `pruneEvents`'s `prunable` CASE and a `NOT IN` in `pruneImportedLegacyHistory`'s `imported` expression | Upstream deleted the TypeScript loop the guard lived in and moved the keep/delete decision into SQL |
| `apps/server/src/ws.ts`: Loom's `providerHealthRegistry` read and the `Stream.scan` over marks | Same file: the read stays at the service-resolution block (hunk 2, the two neighbouring upstream locals are gone); the scan wraps upstream's new `currentCatalogsPerCwd` pipeline (hunk 3) | Upstream restructured the provider-status stream around per-cwd catalogs; Loom's exhaustion overlay is re-applied around it, not inside |
