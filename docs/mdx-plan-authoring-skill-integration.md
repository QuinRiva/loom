---
manager_sessions:
  - id: ea49aa3b-e54c-4948-b99e-b4e79dda0fd9
    role: plan
    authored_at: 2026-07-01T03:51:52.653Z
---

# MDX plan-authoring skill — integration proposal

How to surface the first-party **`mdx-visual-plan`** authoring skill
(`skills/mdx-visual-plan/SKILL.md`) to the coding agents that run inside T3 Code,
so that when an agent writes a plan it produces an annotatable MDX document
instead of chat-only prose.

**Status: the skill content is written and drop-in ready. Wiring is deferred**
— see the recommendation. This document is the decision surface for the wiring
step.

## How T3 Code surfaces skills today (the finding)

T3 Code does **not** own a skill registry. It surfaces whatever the underlying
provider discovers as a native skill:

- **Codex.** `apps/server/src/provider/Layers/CodexProvider.ts` calls the Codex
  app-server `skills/list` RPC and maps each result into a `ServerProviderSkill`
  (`packages/contracts/src/server.ts`: `name`, `description`, `path`, `scope`,
  `enabled`, `displayName`, `shortDescription`). Codex discovers those skills
  from its home dir — the shared Codex home's `skills/` and `plugins/`
  directories are first-class in `apps/server/src/provider/Drivers/CodexHomeLayout.ts`
  (`KNOWN_SHARED_DIRECTORIES`), i.e. `~/.codex/skills/<name>/SKILL.md`.
- **Claude.** `apps/server/src/provider/Layers/ClaudeAdapter.ts` has no skill
  listing; Claude Code discovers its own skills from `~/.claude/skills/` and a
  project `.claude/skills/`.
- **Presentation only.** `apps/web/src/providerSkillPresentation.ts` just formats
  a skill's display name and derives an install-source label (`App` for paths
  under `/.codex/plugins/` or `/.agents/plugins/`; otherwise `System` / `Project`
  / `Personal` from `scope`). There is no code path that installs or ships a
  skill from this repo into a provider skill directory.

The one place T3 Code injects its **own** first-party instructions into an agent
is `apps/server/src/provider/CodexDeveloperInstructions.ts`, which prepends a
`<collaboration_mode>` developer message (Plan / Default modes) plus a shared
browser-tool instructions block. That is the seam for guaranteed pickup, but it
edits the prompt every agent gets.

Consequence: there is **no existing, low-risk hook** that would make this repo's
`SKILL.md` automatically active. Activation requires either an install step into
a provider skill dir, or a prompt-injection change. That makes the wiring a
genuine decision rather than an obvious drop-in — so, per the brief, it is
proposed here rather than force-wired.

## Options

### A — Repo-owned skill, opt-in install _(recommended now)_

Keep `skills/mdx-visual-plan/SKILL.md` version-controlled in the repo. Activate
per environment by copying or symlinking it into a provider skill directory:

- Codex: `~/.codex/skills/mdx-visual-plan/` (the shared-home `skills/` dir the
  layout already manages) → surfaced automatically via `skills/list`.
- Claude Code: `~/.claude/skills/mdx-visual-plan/`, or a project `.claude/skills/`.

**Pros:** zero code change; uses the provider's native discovery; the skill is
reviewed and diffs like any other repo file; trivially reversible. **Cons:**
activation is a manual step, so it is opt-in rather than on by default.

### B — Ship + auto-install into the shared Codex home

Add a setup/build step that materialises the skill into the shared
`~/.codex/skills` directory (already a managed shared dir in `CodexHomeLayout`).

**Pros:** on by default for Codex with no user action. **Cons:** needs a real
install mechanism that does not exist yet; Codex-only (Claude still needs its own
path); writes into user home from a build step, which wants care.

### C — First-party developer-instructions injection

Reference or inline the authoring guidance from
`CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS` (and a Claude equivalent) so every agent
in plan mode picks it up with no install.

**Pros:** most reliable pickup; provider-agnostic if mirrored for Claude.
**Cons:** invasive — it changes the shared plan-mode prompt for _all_ work and
bloats the system prompt; and it is **premature**: the in-app MDX renderer/
annotator that consumes these plans is still being built, and today's plan mode
emits a `<proposed_plan>` markdown block, so instructing every agent to emit
`plan.mdx` now would degrade the current plan UX before anything can render it.

## Recommendation

**Adopt Option A now; revisit B or C once the renderer ships.** The skill is
complete and drop-in ready, provider-native discovery already surfaces skills
placed in the standard dirs, and A carries no risk to the current plan-mode
experience. Do **not** wire injection (C) yet — it is both invasive and
premature while the renderer is unshipped. When the renderer lands and MDX plans
are the intended default, promote pickup via C, whose exact seam is
`CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS` in
`apps/server/src/provider/CodexDeveloperInstructions.ts` (mirror it for Claude).

## Open questions for the orchestrator

- **Default-on vs. opt-in.** Should MDX plans become the default plan output
  (favouring C later), or stay an opt-in skill (A)? This depends on when the
  renderer ships and whether it fully replaces the `<proposed_plan>` flow.
- **Skill home.** Is `skills/<name>/SKILL.md` at the repo root the right
  convention for T3 Code's first-party skills, or should there be a dedicated
  packaged location? This is the first such skill in the repo.
