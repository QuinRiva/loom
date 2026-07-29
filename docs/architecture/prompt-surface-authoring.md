---
manager_sessions:
  - id: af6a5fd4-012d-4bb8-af91-3e88cc5aa13f
    role: architecture
    authored_at: 2026-07-29T10:50:49.411Z
---

# Prompt surface authoring — roles, skills, and the surface map

Companion to [`tool-def-authoring.md`](./tool-def-authoring.md), which covers
one surface (the provider tool definition) in depth. This document maps **all**
the text surfaces a workstream thread's context is composed from, states each
surface's cost model and binding moment, and gives the authoring principles for
the two surfaces the tool-def doc does not cover: **role overlays**
(`roles/*.md`) and **skills** (`skills/*/SKILL.md`).

The governing test is the same as for tool defs: every sentence is a
behavioural bet. What will the model _do_ after reading this, at the moment it
reads it — and what does keeping it ambiently present cost every turn that
never needed it?

## The surface map

A workstream thread's effective prompt is assembled from these surfaces. Each
lands at a different moment, binds at a different moment, and has a different
cost model. Place every rule at the surface read at its binding moment — and
priced for its actual applicability.

| Surface                 | Where it lives                                                           | Lands                                                  | Cost model                                                                       | Carries                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work-model prompt       | `PI_WORK_MODEL_SYSTEM_PROMPT` (driver-prepended, first in reading order) | System prompt, every workstream thread                 | Ambient × every thread                                                           | The shared mechanics all roles operate under (goals/tasks/workstream, lanes, liveness) — role-agnostic by design                                           |
| Role overlay            | `roles/<role>.md` body, injected via `appendSystemPrompt`                | System prompt, every turn of every such thread         | **Ambient × role population** — paid by every turn of every thread with the role | Role identity and doctrine that binds unconditionally for that role                                                                                        |
| Roles catalogue         | First body line of each `roles/*.md`, harvested by `listRoleOverlays`    | System prompt, **every** thread (any thread may spawn) | Ambient × every thread × role count                                              | One line per role: what a spawner gets by choosing it — the first body line is written for this reader too                                                 |
| Skill (header)          | `SKILL.md` frontmatter `name` + `description`                            | Ambient (the skill catalogue line)                     | Ambient, but ~2 lines                                                            | The trigger: when to open the body                                                                                                                         |
| Skill (body)            | `SKILL.md` body + references                                             | Only when the model opens it                           | **On demand** — free until triggered                                             | Conditional protocol: procedures, format contracts, edge-case matrices                                                                                     |
| Tool def                | `providerToolDefs.ts` (description, params, guidelines)                  | Per the tool-def decision-moment model                 | Selection/composition-time; guidelines ambient                                   | See [`tool-def-authoring.md`](./tool-def-authoring.md) — this doc does not restate it                                                                      |
| Kickoff (frame + brief) | `workstreamChildPrompt.ts` frame wrapping the spawn `brief`              | First turn, once                                       | One-shot, but anchors the whole thread                                           | The assignment: outcome owed, constraints, definition of done                                                                                              |
| Goal context            | `buildGoalSystemPrompt` (subordinated for children)                      | System prompt, once per session                        | Ambient                                                                          | Background objective — explicitly subordinate to the brief                                                                                                 |
| Control-plane notices   | Dispatcher wake/resume/steer messages                                    | Mid-thread, as events occur                            | One-shot, precisely timed                                                        | State the model cannot know (routing visibility, round numbers, who reads the next submit) — the **only** surface that can bind at an unpredictable moment |
| Shipping policy block   | `.t3code/ship.json` → system prompt                                      | System prompt                                          | Ambient                                                                          | Project-level authority boundaries                                                                                                                         |

Two consequences fall straight out of the map:

- **Price ambient text on two axes: per-turn weight and aggregate population.**
  A tool guideline reaches every thread that registers the tool (the largest
  population); a role overlay bullet reaches only threads of that role — a
  smaller population, but the overlay is typically the _bulkiest_ per-thread
  block, so its per-turn dilution cost is highest. The two axes argue in the
  same direction for different reasons: a guideline must justify its reach, an
  overlay bullet must justify its weight. The bar for an overlay bullet is
  "binds unconditionally for this role", not "true about this role".
- **Control-plane notices are the only just-in-time surface.** A rule that
  binds at a moment the author cannot predict (e.g. "your next submit routes
  to the reviewer, not to done" — true only mid-rework-round) belongs in the
  resume message that creates that moment, never in ambient text hedged with
  "when you are in a rework round…".

## Role overlay principles

1. **Identity first, doctrine in salience order.** The first body line is the
   role's identity sentence (it is also harvested by `listRoleOverlays` as the
   catalogue summary — keep it self-contained). After that, order bullets by
   load-bearing weight, not by the order incidents accreted them. A
   conditional format rule above the role's core judgement doctrine is the
   budget-inversion smell from the tool-def checklist, on a costlier surface.

2. **Unconditional doctrine only; conditional protocol goes to a skill.** If a
   bullet begins (or honestly should begin) with "when your brief asks…",
   "when you are inside a gate…", "from round 2…", it is conditional protocol
   masquerading as doctrine. Move the body to a skill and leave a two-line
   trigger in the overlay: the condition, and the instruction to read the
   skill **before** the first action the protocol governs. The `ship` skill is
   the pattern: `roles/shipper.md` carries the authority boundary
   (unconditional), the skill carries the procedure (read at shipping time).

3. **Never demote a terminal contract.** Anything that must hold even if the
   model never opens the skill — the submit-outcome contract, "never set your
   own lane", an authority boundary like human-only merge — must live on a
   surface that is guaranteed present: the overlay, the tool def, or the
   control-plane message that creates the moment. The test: _what happens on
   the turn where the model skipped the skill?_ If the answer is a silently
   wrong routing decision rather than a degraded artefact, it cannot live
   only in the skill.

4. **Own or reference across surfaces — the tool-def rule, extended.** The
   overlay, the kickoff frame, and the tool defs are separately edited files
   that describe the same contracts. A paraphrase in the overlay of what
   `workstream_submit`'s description already says is drift waiting to happen:
   three surfaces asserting "never set your own lane at completion" in
   different words means a semantics change must land in all three or they
   silently diverge. The overlay should carry only what is _role-specific_
   about a shared contract (e.g. which outcome tokens this role uses and what
   each means _for its judgement_), and reference the tool for the mechanics.

5. **State deliberate asymmetries.** When a role's rules deliberately press
   harder on one failure tail (e.g. six rules against reviewer over-flagging,
   one against rubber-stamping — correct for a prototype posture), say so in
   one line. An unstated asymmetry reads as accident, and the next editor
   "balances" it back. This is the both-tails rule from tool-def authoring
   applied at file scope: guard both tails, and when you intentionally don't,
   write down why.

6. **Shared fragments are a drift surface.** The boilerplate every role
   carries (task-tree contribution, self-rename, full-path citation, the
   submit closing bullet) is copy-pasted per file. Until a shared-fragment
   mechanism exists, treat these as one logical text: any edit to a shared
   bullet lands on every role file that carries it, in the same change —
   exactly the tool-def rule for shared parameters.

7. **Coding philosophy lives in the project's role files, not global config.**
   Role overlays are loaded from each project's own `roles/` directory
   (`roleOverlay.ts`), and that is deliberate: posture is per-project (a
   reliability-first control plane and a throwaway-analytics prototype need
   opposite defaults for tests, defensive code, and compat), so each project's
   `roles/coder.md` / `roles/reviewer.md` owns its philosophy fully, tuned to
   that project. Global ambient config (`~/.pi/agent/AGENTS.md`) is the wrong
   home for posture rules — it cannot vary by project and silently fights the
   projects it doesn't fit. The cost is accepted duplication across projects;
   an edit to shared doctrine lands per-project, consciously.

8. **The overlay loses to the assignment.** Work-model precedence means a
   doer-framed brief can override role framing (the `goal_handoff` incident).
   An overlay cannot defend against a mis-framed kickoff; do not add
   overlay text to fight upstream surfaces — fix the surface that authors the
   brief (the spawn/handoff tool def).

## Skill principles

1. **The header is the whole ambient budget.** `name` + `description` are what
   every turn sees; they must carry the complete trigger (when to open it) and
   nothing else. A skill whose description under-triggers is dead weight; one
   whose body leaks into its description is paying ambient cost for on-demand
   content.

2. **Bodies are procedures, not identity.** A skill body may assume it is
   being read at the moment it applies. It can therefore be imperative,
   stepwise, and long — the properties that make text wrong for an overlay
   make it right for a skill body.

3. **Skills compose across roles.** A protocol shared by both sides of an
   interaction (e.g. a review gate's reviewer and coder legs) can live in one
   skill with per-role sections, keeping the two sides' contracts from
   drifting apart — or in sibling skills if the trigger conditions differ.
   Either way the pairing is explicit, not incidental.

## Audit checklist (role files)

- Conditional protocol ("when…", "from round N…", "if your brief…") living
  ambiently in the overlay instead of a skill.
- Terminal contract living _only_ in a skill body.
- Overlay paraphrasing a tool def or the kickoff frame instead of referencing
  it.
- Salience inversion: cosmetic/conditional rules above core doctrine.
- Multi-rule mega-bullets (one bold header, five load-bearing rules inside).
- Unstated asymmetry between failure tails.
- Shared boilerplate edited in one role file but not its siblings.
- A role variant (e.g. the ungated integration reviewer) paying ambient cost
  for another variant's protocol.
- First body line unusable as the catalogue summary.
- A rule premised on state the thread never receives (e.g. "if your scope has
  sharpened beyond your spawn title" — the kickoff never tells a child its
  title). Check the surfaces the thread actually gets before writing a
  condition on one.
- A capability re-advertised in the overlay when its own tool def already
  carries the trigger at selection time (the tool description is the cheaper,
  always-in-sync surface).

## Validation

Same evidence bar as tool defs: corpus mining (real reviewer/coder transcripts
— did the rule bind at the moment it was needed?) and generative probing (give
a fresh model the assembled surfaces plus a scenario; judge what it does).
For a skill demotion specifically, probe the skipped-skill case: run the
scenario with the skill body withheld and verify the failure is degraded
quality, never a wrong terminal/routing action.

## Provenance

Distilled from the 2026-07-29 review of `roles/reviewer.md`: gate protocol
(~half the file) was ambient for every reviewer including the designed ungated
integration-reviewer case; the submit contract was paraphrased across three
surfaces; salience order was accretion order; and the deliberate
anti-over-flagging asymmetry was unstated. The tool-def decision-moment model
(from the `goal_handoff` incident) generalised cleanly and is extended here
rather than duplicated.
