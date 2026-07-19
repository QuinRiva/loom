---
manager_sessions:
  - id: 6871d411-1ff8-4f6b-a7a0-69f8591f0d53
    role: architecture
    authored_at: 2026-07-19T01:15:54.617Z
---

# Tool definition authoring

How to write (and audit) the text surfaces of a provider tool definition
(`apps/server/src/provider/Drivers/Pi/providerToolDefs.ts`). A tool def is not
documentation. It is a distributed prompt whose fragments are read at different
decision moments with different salience. Documentation optimises for a reader
seeking understanding; a tool def must optimise for a generator making choices.
The test for every sentence is behavioural: what will a model _do_ after
reading this, at the moment it reads it?

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
that has the tool registered, paid overwhelmingly by turns that never call the
tool. The bar for a guideline is not "useful information about this tool"; it
is "must be ambiently present even when the model is not calling it".

## Principles

1. **Characterise the recipient.** Any parameter whose value becomes another
   agent's prompt (a brief, a kickoff, a steer, a report) must say who reads it
   and what that reader does with it. The author's model of the reader
   determines everything else they write; with no stated reader, the author
   defaults to the most familiar register, which is usually wrong. State the
   recipient at both selection time (description) and composition time (the
   parameter), and keep the two registers consistent: the parameter text wins
   at composition time, so a contradiction resolves silently in its favour.

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
   of the tool that taught the model to write them (`workstream_spawn`: an
   executable assignment for a doer). A tool reusing the word under a
   different contract (a goal charter for an orchestrator) must explicitly
   break the import, or the old register arrives wholesale.

6. **Trace the artefact across boundaries.** The worst defects are emergent:
   each component correct, the composition broken (tool text shapes a brief;
   the brief lands as a first message; a precedence rule elsewhere decides
   what wins). When auditing a tool, follow its arguments to where they land
   and read the rules in force _there_.

7. **Own or reference, never paraphrase, a shared contract.** When two tools
   carry the same field (spawn and scaffold nodes) or one defines itself
   relative to another ("Like goal_handoff, but…"), a paraphrase silently
   inherits the other def's future edits and drifts. Either reference
   explicitly ("as in workstream_spawn") or own the full text. Any rewrite of
   a shared field must land on every def that carries it, in the same change.

8. **Price the ambient block as a whole.** Each guideline bullet competes
   with every other bullet for salience on every turn; the marginal bullet
   dilutes the load-bearing ones. When adding a bullet, ask which existing
   bullet it outranks; if the honest answer is none, it belongs on a
   lower-cost surface or nowhere.

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

## Validation

Wording changes ship on evidence, not intuition. Two probes:

- **Corpus mining**: real calls from session logs; rejection and retry rates;
  for prompt-carrying parameters, sample the authored artefacts and judge them
  against intent.
- **Generative probing**: give a fresh model the tool def plus a realistic
  scenario and judge what it authors. Run the same scenarios before and after
  a rewrite; the rewrite is accepted only if the authored artefact improves.

## Provenance

Distilled from the `goal_handoff` incident and rewrite (2026-07-17): a
handoff-created orchestrator root worked inline for 20+ minutes because the
tool's guidance induced a doer-framed brief, and the work-model rule that
assignment beats overlay let that brief silently override the orchestrator
role. PR #113 carries the rewrite; the session behind it holds the full
analysis.
