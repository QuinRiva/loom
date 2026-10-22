---
manager_sessions:
  - id: 6871d411-1ff8-4f6b-a7a0-69f8591f0d53
    role: architecture
    authored_at: 2026-07-19T01:15:54.617Z
---

# Tool definition authoring

How to write (and audit) the text surfaces of a Loom agent tool. A tool def is
not documentation. It is a distributed prompt whose fragments are read at
different decision moments with different salience. Documentation optimises for
a reader seeking understanding; a tool def must optimise for a generator making
choices. The test for every sentence is behavioural: what will a model _do_
after reading this, at the moment it reads it?

## Where the text lives and how it travels

The prose and the schema are separate files with separate authors.

- **`apps/server/src/mcp/toolkits/workstream/prose.ts`** holds every text a
  model reads: `LOOM_TOOL_PROSE`, a typed record keyed by the tool's bare MCP
  name with `description`, `promptSnippet` and `promptGuidelines`. It covers
  the 22 MCP tools, the one tool Loom's pi extension registers itself
  (`mcp__t3-code__ask_user_question`) and the two background-job tools. Loom
  supplies pi's preamble (`LOOM_PREAMBLE` in `loom/prompt/prose.ts`, set by the
  extension on every agent start), so pi renders no tools, rules or docs
  sections: `promptSnippet` is inert and `promptGuidelines` is kept empty,
  because a guideline would land in a section that is never rendered. The
  description is the only model-read surface a tool has.
- **`defs.ts`** (same directory) imports that record for its prose fields and
  adds what is mechanical — JSON-schema parameters with their per-field
  descriptions, `errorMode`, idempotency hints. Parameter descriptions are
  prose too and follow this doctrine; they live beside the schema because they
  are read field by field.
- **The carrier.** Loom registers each tool by hand on the server's MCP
  endpoint. The description is the MCP tool description, sent in the tools
  array of every request that declares the tool. The snippet and (empty)
  guidelines travel in the tool's `_meta` (`loom/promptSnippet`,
  `loom/promptGuidelines`), MCP's reserved extension slot; upstream's bridge
  extension reads those two keys when it registers the tool in pi and falls
  back to its generic text for any tool without them. Every other MCP client
  ignores `_meta`.
- **The name.** The server registers each tool without a prefix; upstream's
  bridge adds `mcp__t3-code__` when it registers the tool in pi, so the model
  sees and calls `mcp__t3-code__workstream_submit`. Every tool named _inside_ any text a
  model reads — a description, a snippet, a guideline, a role overlay, a
  skill, the work-model addendum, a control-plane message — uses the prefixed
  form, because that is the only name the model can act on. Bare names
  survive only as record keys and in historical documents. The gate is
  `docs/upstream-sync/pull9-tools/barenames.sh`, which fails on a bare Loom
  tool name anywhere outside `docs/upstream-sync/` and `plans/`.
- **Prompt-side texts** that are not tool defs — the work-model addendum, the
  child readership clause, the identity and relocation clauses, the kickoff
  wrapper, the refusal texts — live in
  `apps/server/src/loom/prompt/prose.ts` under the companion doctrine in
  [`prompt-surface-authoring.md`](./prompt-surface-authoring.md).

**Who writes it.** Text a model will read is authored on the `planner` preset
(Carl's rule, in the orchestrator overlay: lower tiers write prescriptive
do-and-don't lists that constrain a capable reader) or by Carl, in a dedicated
authoring pass; the coder who ports or extends a tool reviews that text for
schema fit only — does the prose name the parameters the schema has, with the
semantics the handler enforces — and never rewrites it in passing. A wording
change to a commonly injected surface gets a cross-family review before it
ships.

**What a description is.** It says three things and stops: what the tool does,
in its first sentence; the consequences the caller must act on; and when
another tool is the better choice, by name, one clause each. The test for every
sentence is whether it changes what the caller does or writes. A mechanism
whose consequence the result will report, or that the control plane handles
either way, is not written; nor is narration of the result ("the result says
whether…"), a capitalised prohibition or a list of what the tool is NOT for,
a timing or an internal, doctrine (the addendum's and the overlay's job), or a
numeric threshold invented to make a rule concrete. A rule lives once: about a
value, on that parameter; about the call, in the description.
`mcp__t3-code__workstream_prompt` and `mcp__t3-code__workstream_request_attention`
are the register's worked examples.

## The decision-moment model

Each text surface lands in a different place in the model's context and is
salient at a different moment. Place every rule at the surface read at its
binding moment.

| Surface                | Lands in                       | Binding moment                                    | Carries                                                                                                                                                                                    |
| ---------------------- | ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `description`          | Tool schema in the tools array | Selection ("should I call this?")                 | What it does; the consequences the caller must act on; the better tool, by name, where one exists.                                                                                         |
| Parameter descriptions | Tool schema, per field         | Composition (while generating that field's value) | Format, register, and content rules for that field.                                                                                                                                        |
| `promptSnippet`        | Nowhere                        | —                                                 | Inert: pi lists snippets only in the tools section its own preamble renders, which Loom's preamble replaces. Kept for the bridge contract.                                                 |
| `promptGuidelines`     | Nowhere                        | —                                                 | Kept empty: a guideline lands in pi's rules section, which Loom's preamble removes. Text added here is dead; a duty after the call goes in the description, a field rule in the parameter. |

Ambient cost: for a tool a role keeps resident, the description is sent with
every request too, so it is ambient as well as selection-time, and every
sentence in it is paid overwhelmingly by turns that never call the tool. The
bar is "changes what the caller does or writes", not "useful information about
this tool". A control-plane notice is the cheaper surface for anything that
binds at a moment the control plane creates (a child waiting on a brief, a
gate resolving, a rework round's recovery).

## Principles

1. **Characterise the recipient.** Any parameter whose value becomes another
   agent's prompt (a brief, a kickoff, a steer, a report) must say who reads it
   and what that reader does with it. The author's model of the reader
   determines everything else they write; with no stated reader, the author
   defaults to the most familiar register, which is usually wrong. The
   recipient is characterised once, on the parameter (the text read at
   composition time); the description does not repeat it. The recipient of a
   child's brief is an agent, told the brief is its parent's writing and that
   it may depart from it with reasons, and usually with no human reader — a
   child's questions come back to the parent, not to a person — and the brief
   contract, on `mcp__t3-code__workstream_brief`'s `markdown`, says so; the
   spawn's `brief` points there.

2. **Schema over prose.** Anything mechanically expressible (required fields,
   enums, defaults) goes in the schema and is enforced server-side. Prose
   restating the schema ("Required.", "Optional.") is noise. Prose exhortation
   where a schema constraint is possible is a known-weak mechanism: we have
   direct evidence that guidance bullets do not hold under pressure.
   Carve-out: handler-enforced conditional requirements that JSON schema
   cannot express (e.g. "omit role when forkFrom is set") are correctly
   stated in prose; that is not a smell.

3. **Spend the guidance budget by consequence, not by ease.** Format rules are
   easy to write and cosmetic; register and content rules are hard to write
   and load-bearing. Guidance drifts toward the easy (Parkinson's law of
   triviality): audit words-per-field against the blast radius of getting that
   field wrong.

4. **Guard both tails.** For every rule, name the symmetric error and check
   something guards it. "Write it complete and self-contained" guards
   under-specification only; its unguarded twin (complete, imperative
   over-prescription) is what turned a handoff orchestrator into an inline
   doer. Accreting bullets against observed failures only ratchets toward
   failures already paid for.

5. **Differentiate shared vocabulary.** Words like "brief" carry the register
   of the tool that taught the model to write them
   (`mcp__t3-code__workstream_spawn`: an executable assignment for a doer). A
   tool reusing the word under a different contract (a goal charter for an
   orchestrator) must explicitly break the import, or the old register arrives
   wholesale.

6. **Trace the artefact across boundaries.** The worst defects are emergent:
   each component correct, the composition broken (tool text shapes a brief;
   the brief lands as a first message; a precedence rule elsewhere decides
   what wins). When auditing a tool, follow its arguments to where they land
   and read the rules in force _there_.

7. **Own or reference, never paraphrase, a shared contract.** When two tools
   carry the same field (spawn and scaffold nodes) or one defines itself
   relative to another ("Like `mcp__t3-code__goal_handoff`, but…"), a
   paraphrase silently inherits the other def's future edits and drifts.
   Either reference explicitly (a scaffold node's field is "As
   `mcp__t3-code__workstream_spawn`'s `role`.") or own the full text. Any
   rewrite of a shared field must land on every def that carries it, in the
   same change.

8. **Price the ambient block as a whole.** Each sentence in a resident
   tool's description competes with every other ambient sentence for salience
   on every turn; the marginal sentence dilutes the load-bearing ones. When
   adding one, ask which existing sentence it outranks; if the honest answer
   is none, it belongs on a lower-cost surface (a parameter, a control-plane
   notice) or nowhere.

9. **Say what is gone, nowhere.** When a capability is removed (per-child
   worktree isolation, staging and release of a graph, the plan lane), every
   sentence about it is deleted, not renamed or hedged. A model reading "no
   longer supported" spends attention on a thing that does not exist; a model
   reading nothing does not.

## Audit checklist (static smells)

- Text in `promptGuidelines` (dead) or a composition rule for one parameter
  carried in the description rather than that parameter, or the same rule in
  both.
- Description explaining plumbing the caller cannot act on, narrating what
  the result will say, or listing what the tool is NOT for.
- "Required"/"Optional" (or any schema fact) restated in prose.
- Budget inversion: worked examples on cosmetic fields, one-liners on
  artefact-carrying fields.
- Prompt-carrying parameter with no recipient characterisation.
- Cross-surface contradiction or register drift between description and
  parameters.
- Accretion strata: bullets that each patch one historical incident with no
  unifying contract.
- Only one tail guarded (usually under-specification).
- A bare tool name (the sweep gate catches it; the smell is that the author
  was reading the server's registration, not the model's prompt).
- A sentence about a removed capability.

## Validation

Wording changes ship on evidence, not intuition. Two probes:

- **Corpus mining**: real calls from session logs; rejection and retry rates;
  for prompt-carrying parameters, sample the authored artefacts and judge them
  against intent. The prompt-debug sidecar (written by Loom's extension on
  every agent start when enabled) shows the assembled prompt a thread actually
  received and, after it, the declared tools array with each description and
  parameter text as sent and a word count per tool — read it before concluding
  a rule was present.
- **Generative probing**: give a fresh model the tool def plus a realistic
  scenario and judge what it authors. Run the same scenarios before and after
  a rewrite; the rewrite is accepted only if the authored artefact improves.
  The pull-9 smoke's first step is this probe for the names: a fresh child
  reads its tool list and calls `mcp__t3-code__workstream_submit` unprompted.

## Provenance

Distilled from the `mcp__t3-code__goal_handoff` incident and rewrite
(2026-07-17): a handoff-created orchestrator root worked inline for 20+ minutes
because the tool's guidance induced a doer-framed brief, and the work-model
rule that assignment beats overlay let that brief silently override the
orchestrator role. PR #113 carries the rewrite; the session behind it holds
the full analysis. Re-based on the MCP carrier and the prefixed names in pull
9 (Phase 3, track 3a), when the pi extension that served these tools over REST
was replaced by upstream's MCP bridge.
