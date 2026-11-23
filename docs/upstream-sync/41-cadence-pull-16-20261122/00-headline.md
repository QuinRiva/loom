## 0. Headline

Pull 16 is **the largest cadence pull so far: a fortnight of upstream instead
of a week, at more than twice pull 15's weekly pace.** Upstream has shipped **3,335 commits**
since pull 15's target `3fa57b92a2` (8 Nov), against 725 in pull 15: 2,860
fixes, 168 features, 152 performance changes. Outside the vendored `.repos/`
tree that is 5,273 files, +994k/−216k, but the real app change is about
**295k lines of source and 284k of tests**; the rest is translation
catalogues (182k), one regenerated vendored C file (151k) and a generated
Linear GraphQL schema (54k). The trial merge gives **193 conflicted paths /
513 conflict markers** (191 content conflicts, 2 files upstream deleted that
Loom had modified; 56 of the markers are the lockfile), **1,530 `loom:`
lines** in conflicted files, and **170** both-modified files that merged
silently. Pull 15 was 74 paths, 138 markers, 701 lines. Loom's `origin/main`
moved 28 PRs (#538 to #591) since pull 15 landed, 18 of which touch 32 of the
conflicted paths, and two of them (#590, #591) are not yet on the cockpit.

The silent merge lost no Loom line as text (all 3,749 lines Loom added to
those 170 files are present). What makes this pull more than a big routine
one, in order of what rides on it:

1. **Upstream gave agents 23 new tools, one of which merges pull requests,
   and Loom's tool lists are shaped so that new upstream tools reach Loom
   threads unless withheld (§4).** With no action, every root, orchestrator
   and shipper thread starts with nine new PR and CI tools loaded, including
   `pull_request_merge`, which nothing on the server holds to `pnpm ship`'s
   gates or a project's merge policy. Upstream also now injects a sender note
   into agent-sent messages (on top of Loom's own author labels) and PR-linking
   rules into Pi's system prompt. And upstream moved the code that refuses a
   subagent's PR watch into a new file, leaving Loom's exemption for its own
   shipper children behind in dead code. All of it is cheap to close and is
   listed for Carl in §8.1.
2. **Upstream translated the whole app, and a new lint rule at error rejects
   plain English UI strings (§5.1).** Carl sees no language change. Loom's
   own surfaces fail the rule 1,096 times, and `vp check` runs it, so nothing
   commits or ships after the merge until Loom's files are excluded (one
   config block, recommended) or wrapped (days).
3. **Upstream deleted or replaced things Loom builds on.** The composer's
   context meter, which Loom defaults on and hangs its spend breakdown in, is
   deleted (§6.1). The chat's markdown renderer is replaced, so two Loom
   extensions that were renderer plugins need porting and four dependencies
   Loom's MDX renderer imports vanish, two of them without a conflict marker
   (§6.2, §5.4). The diff viewer library moved a major version under Loom's
   days-old inline diff editing, and the patch Loom edited is deleted
   (§6.1, §6.9).
4. **The merge is too big for one coder in one sitting, so S1 is cut (§2).**
   It stays one merge and one commit, resolved by a lead and six lane coders
   working in parallel on disjoint files, each from its own zone file with a
   resolution for every hunk (Appendix B).
5. **First boot runs 28 upstream migrations (081 to 108)**, an estimated 20
   to 90 seconds of extra downtime, none touching anything Loom's own
   migrations created (§5.5). The host needs Node 26.13.1 (one command), the
   launcher protocol moves 3 → 4 (an ordinary deploy still works), and the
   phone app needs a full native rebuild (§6.7, §6.11, For deploy).

What is not a problem this time: the toolchain (Effect 4.1.2 → 4.1.5, no new
diagnostics, no Loom exposure), device approval and the relay changes (they
cover only T3 Connect, which the cockpit has never used: nobody has to
re-pair), multi-repository projects (no cockpit project qualifies), client
commands as Effects (Loom never calls the changed entry point), and pull 15's
event-prune guard (Loom retired it itself on 10 Nov by moving workstream
history into its own table).

**Upstream features that overlap a Loom one** (each a row in §8.1): agent PR
and CI tools against `pnpm ship`; the sender note against Loom's author
labels; the deleted context meter against Loom's default-on meter and spend
popover; upstream's last-good-reading rule against Loom's hub carry-forward;
upstream's fork-into-folder resume against Loom's pi patch; subagents opening
beside their parent against how a Loom child opens; upstream's faint
changed-word tint against Loom's solid one; upstream's phone file-path lookup
against Loom's.

**What Carl will see change on deploy** (under the recommended rulings):

- **Long threads open 2 to 10 times faster**, the thread list shows while the
  connection opens, and a reconnect resumes without re-downloading the list.
- **Sidebar rows show the machine name** on their second line instead of the
  git branch (the branch moves to the hover card), and gain linked-issue
  chips.
- **An Issues page** for the project's GitHub repository, with issues linked
  to threads; an Issues tab on the phone.
- **Plan mode is gone** (the Build/Plan toggle, `/plan`, `/default`). Loom's
  plans, plan lanes and `/handoff`, `/retro` are unaffected.
- **Tool-call visibility moved** from Labs to Settings → Chat → Activity
  (still Show all).
- **A Loom child clicked inside a thread opens beside its parent**, as a tab
  in the right panel; ⌘-click or one setting navigates instead.
- **Reply** on an assistant message; **@-mention a model** in the composer;
  quotes in sent messages show as inset cards.
- **Chat markdown renders through a new engine**: smoother scroll and
  streaming, one shared tooltip. Loom's file chips, thread mentions, ticket
  links and path links behave as before once S2b's ports land.
- **Cmd+F in the Diff panel** uses the viewer's own find; **a PR link in
  chat** opens the PR panel at the comment, line, checks or commits it names;
  HTML previews keep their scroll during agent commands.
- **No more "copied" toasts**; snoozed threads stop sending completion
  notifications.
- **A stopped pi run no longer offers Resume**; pi resumes are faster; a pi
  agent's dev servers show under its thread; pi-subagents members show as
  subagents.
- **Loom children settle when their parent settles**, not after five idle
  days (mostly invisible; about five settle on the first sweep).
- **One-time scheduled tasks remove themselves** after they run. The
  cockpit's "Deploy redesign: readings…" task is due 24 Nov 23:00 UTC.
- **Settings gains** a Language picker (English), Text generators (empty),
  Repositories per project (empty), keep-awake (on: the server holds a sleep
  inhibitor while agents work), terminal close confirmation and shell,
  "Open subagents and side chats in", the preview-tunnel switch (on, as
  before), and a database Reclaim button that does nothing on the cockpit.
- **Usage history reads 92 days back** by default; hub accounts whose read
  failed get their own line, which will show for the one-year token seat when
  it is idle.
- **On the phone**, after installing the rebuilt APK: the Issues tab,
  localhost links opening through the environment, selecting and citing
  assistant text, long messages collapsing, many Android fixes.
- **Unchanged because of the recommended rulings:** the context ring and its
  spend popover in the composer; Loom's solid changed-word highlight in
  diffs; agents' tool lists; the author line agents read on a message.
- **On the host:** Node 26.13.1; 28 migrations on first boot; the database
  grows about 200 MB (4.73 → about 4.95 GB); the launcher becomes protocol 4
  at the next service restart; the Slack bridge restarts on Effect 4.1.5 by
  itself.

**Carl's decisions are the fifteen rows of §8.1**, each with a recommended
answer. S1 can start under those answers; the first that would cost real
rework if reversed late is the context meter, and S1 starts on the cheaper
side of it.
