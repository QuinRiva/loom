# Plan: continue mid-turn threads across server restart/deploy — superseded

Superseded by upstream's restart continuation (#9167, `reconcileProviderSessions`
in `apps/server/src/serverRuntimeStartup.ts`), adopted in the post-pull-7 stack.
Loom's Option-1 resume in `apps/server/src/loom/startup.ts` was deleted; the fork
keeps only two marked hunks in upstream's path — resume state may be a
`session-file` driver's on-disk session rather than a cursor (pi has no cursor),
and a thread flagged for attention or cancelled is never continued.
