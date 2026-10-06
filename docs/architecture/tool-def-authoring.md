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
  name with `description`, `promptSnippet` and `promptGuidelines` (one rule per
  line, or empty). It covers the 21 MCP tools and the two tools Loom's pi
  extension registers itself (`mcp__t3-code__enable_toolset`,
  `mcp__t3-code__ask_user_question`).
- **`defs.ts`** (same directory) imports that record for its prose fields and
  adds what is mechanical — JSON-schema parameters with their per-field
  descriptions, `errorMode`, idempotency hints. Parameter descriptions are
  prose too and follow this doctrine; they live beside the schema because they
  are read field by field.
- **The carrier.** Loom registers each tool by hand on the server's MCP
  endpoint. The description is the MCP tool description — what pi's tool list
  shows at selection time. The snippet and guidelines travel in the tool's
  `_meta` (`loom/promptSnippet`, `loom/promptGuidelines`), MCP's reserved
  extension slot; upstream's bridge extension reads those two keys when it
  registers the tool in pi and falls back to its generic text for any tool
  without them. Every other MCP client ignores `_meta`.
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
  wrapper, the delegation digest, the refusal texts — live in
  `apps/server/src/loom/prompt/prose.ts` under the companion doctrine in
  [`prompt-surface-authoring.md`](./prompt-surface-authoring.md).

**Who writes it.** Text a model will read is authored by a top-tier model (or
Carl), in a dedicated authoring pass; the coder who ports or extends a tool
reviews that text for schema fit only — does the prose name the parameters the
schema has, with the semantics the handler enforces — and never rewrites it in
passing. A wording change to a commonly injected surface gets a cross-family
review before it ships.

## The decision-moment model

Each text surface lands in a different place in the model's context and is
salient at a different moment. Place every rule at the surface read at its
binding moment.

| Surface                | Lands in                              | Binding moment                                    | Carries                                                                                                                   |
| ---------------------- | ------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `promptSnippet`        | System prompt, "Available tools" line | Discovery                                         | One line: this capability exists. Nothing else.                                                                           |
| `description`          | Tool schema in the tools array        | Selection ("should I call this?")                 | What it does, when to use it, when NOT to (name the alternative tool for the rejected branch).                            |
| Parameter descriptions | Tool schema, per field                | Composition (while generating that field's value) | Format, register, and content rules for that field.                                                                       |
| `promptGuidelines`     | System prompt, "Guidelines" bullets   | Ambient, every turn                               | Only rules that bind _outside_ the call itself, chiefly duties after the call returns, when the schema has lost salience. |

Ambient cost: `promptGuidelines` are injected into every turn of every thread
that has the tool active, paid overwhelmingly by turns that never call the
tool. The bar for a guideline is not "useful information about this tool"; it
is "must be ambiently present even when the model is not calling it". A tool
whose description is the contract of record (`mcp__t3-code__workstream_submit`,
`mcp__t3-code__workstream_set_outcome`, `mcp__t3-code__workstream_request_attention`)
carries no guidelines by design — the comment on its entry says so, so the next
editor does not "fill the gap".

## Principles

1. **Characterise the recipient.** Any parameter whose value becomes another
   agent's prompt (a brief, a kickoff, a steer, a report) must say who reads it
   and what that reader does with it. The author's model of the reader
   determines everything else they write; with no stated reader, the author
   defaults to the most familiar register, which is usually wrong. State the
   recipient at both selection time (description) and composition time (the
   parameter), and keep the two registers consistent: the parameter text wins
   at composition time, so a contradiction resolves silently in its favour.
   The recipient of a child's brief is an agent with no human reader — a
   child's questions come back to the parent, not to a person — and the brief
   contract says so.

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
   Either reference explicitly ("as in `mcp__t3-code__workstream_spawn`") or
   own the full text. Any rewrite of a shared field must land on every def
   that carries it, in the same change.

8. **Price the ambient block as a whole.** Each guideline bullet competes
   with every other bullet for salience on every turn; the marginal bullet
   dilutes the load-bearing ones. When adding a bullet, ask which existing
   bullet it outranks; if the honest answer is none, it belongs on a
   lower-cost surface or nowhere.

9. **Say what is gone, nowhere.** When a capability is removed (per-child
   worktree isolation, staging and release of a graph, the plan lane), every
   sentence about it is deleted, not renamed or hedged. A model reading "no
   longer supported" spends attention on a thing that does not exist; a model
   reading nothing does not.

## Audit checklist (static smells)

- Guideline bullet that names a parameter: composition rule in ambient space.
- Description explaining plumbing the caller cannot act on.
- "Required"/"Optional" (or any schema fact) restated in prose.
- Budget inversion: worked examples on cosmetic fields, one-liners on
  artefact-carrying fields.
- Prompt-carrying parameter with no recipient characterisation.
- Cross-surface contradiction or register drift between description,
  guidelines, and parameters.
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
  received — read it before concluding a rule was present.
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
