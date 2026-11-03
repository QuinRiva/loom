## 2. Departures from pull 10's shape

- No tool-exposure prototype (pull 10's node P): nothing in this pull changes
  how tools reach pi.
- No structural relocation: upstream moved nothing Loom carries. Two upstream
  module moves touch Loom imports (`isNativeMaintenanceCommand` →
  `CommandPolicy.ts`; `apps/web/src/test/*` deleted) and are repointed in S1.
- Gate 2 gets a **fourth reviewer for the orchestration seams** (§8), because
  Carl asked for it to be looked at and the silently merged server-core zone
  carries 103 `loom:` lines across 28 files.
- S2b owns a **React Compiler sweep over Loom's web files** (§5.3), which is
  new work, not merge fallout. Its size is Carl's call (§7.1 row 2).
