# Plan: continue mid-turn threads across server restart/deploy — superseded

Superseded by upstream's restart continuation (#9167, `reconcileProviderSessions`
in `apps/server/src/serverRuntimeStartup.ts`), adopted in the post-pull-7 stack.
Loom's Option-1 resume in `apps/server/src/loom/startup.ts` and its tests were
deleted; the fork keeps two marked hunks in upstream's path — resume state may be
a `session-file` driver's on-disk session (pi has no cursor), and a thread
flagged for attention, cancelled, or parked on an open approval is never
continued. The plan's queued-steer rescue was not carried over: the session queue
is ephemeral live state that is never persisted, so it is always empty at boot.
