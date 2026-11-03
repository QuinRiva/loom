## For deploy

1. **First cockpit boot.** The live database is at 69 / 1066. The first boot runs upstream 070–076 in about a second (S3: 072 0.26 s, 073 0.66 s, the rest ≤ 0.01 s; S4: all seven stamped in the same second on a copy) and **no Loom migration**. Everything is additive (two tables, one column set, three partial indexes; 074 returns early because Loom's 1065 already dropped the message-search table). Nothing is irreversible beyond what a pre-promotion snapshot covers. The bundle reached Listening in 10.7 s (S3) to 19.9 s (S4, on a freshly written copy that also paid a WAL switch the live WAL database does not).
2. **The build needs DL-1713.** Without the two vendored SPDX templates `pnpm build` fails, so the deploy would stop at build with the live cockpit untouched. They are on the branch.
3. **Compaction.** The online history pass runs at a 10 % duty cycle, next due 6 h after the last pass; reads are unaffected (DL-1507). On S4's copy a pass started with the server and deleted 164,035 events in about an hour while the UI stayed responsive; S3's pass ran past 116 min. Loom's V1 history rows survive it (DL-1300).
4. **Cold-connect read.** A browser that connects cold reads the trimmed shell: 2.0 MB / 325 threads in 5.2 s on the first read and 2.0–2.5 s after, against the 16.4 MB / 3,784-thread full shell (S3, DL-1697). Badges on active roots are complete on that first read (§10 `cold-shell`).
5. **What Carl will notice** (§0's list, confirmed live, plus S4's findings):
   - The new design is the only design; settings are regrouped by concern into a modal.
   - Side chats: `/side` and `/btw`, **+ → Side chat** in the right panel, Bring back. Loom's Query, Promote, `/handoff` and `/retro` are unchanged and sit beside them.
   - Stop completes (1.5 s on a pi root), and Force stop exists for a stuck agent; a healthy pi turn never needed it.
   - Long threads open on their latest page and load older turns from "Load earlier turns"; thread state ("Settled 11d ago", "Run interrupted") sits at the end of the timeline.
   - Projects can be pinned and archived in Settings → Projects.
   - Linked environments is a Labs toggle, off.
   - In an open thread the permission control (Full access / Supervised) sits in the model picker's footer.
   - **A child's question** shows on its root only as the chat banner "Subagent needs input", not as the sidebar pill (DL-1715). Approvals still light the pill.
   - **A draft's model pick can go stale** when the thread's model changes from another client or a failover: the composer keeps the old pick and the next send switches back (DL-1717). Re-pick the model to clear it.
   - A workstream root with no branch, PR or diff shows no sub-thread badge (DL-1714); cockpit roots all have worktrees.
   - Upstream's one-time **"Enjoying T3 Code? Star on GitHub"** toast appears after the fifth prompt in each browser (DL-1718). Carl's call: keep it, or hide it in Loom with one marked line.
6. **Untrusted-folder warning (Gate 2b B1, Carl's to decide).** Every Loom-project thread shows a yellow "untrusted folder" warning on the first turn of each pi process, because the checkouts contain `.agents/skills/` and `~/.pi/agent/trust.json` trusts only `/home/Carl/loom`. Options: (a) accept it; (b) add one trust entry for `/home/Carl/.t3/cockpit/worktrees/loom` (the three repo skills then load into every Loom thread); (c) a Loom change that suppresses it for cockpit worktrees. It does not reach the model. S4 did not see it (no Loom-project thread was run).
7. **Restarted turns resume.** A pi turn cut by the promotion resumes, and a steer stashed at shutdown is delivered (§10 `boot`).
