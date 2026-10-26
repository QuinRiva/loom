---
name: cold-reader
description: >-
  Opt-in glossary and cold-reader pass for an MDX plan, recap or explainer:
  the document defines the vocabulary it coined in a <Glossary> block, and a
  child that knows nothing of the workstream lists the terms it still cannot
  resolve before the document reaches Carl. Load only when Carl names this
  skill or asks for a glossary or a cold-reader pass on a document. It is not
  for every document: an ordinary plan, recap or explainer request is owned
  by mdx-visual-plan, mdx-visual-recap or mdx-visual-explainer alone.
pi_global: true
pi_global_requires: [mdx-doc-core]
---

# Cold-reader pass

A document Carl reads was written by an agent that spent the workstream
talking to other agents, and the words coined on the way ("unit", "run",
"escalated", each with a precise meaning the document never states) read as
plain English to the author and as noise to him. The author cannot tell which
words those are, because it coined them; a reader as cold as Carl can. So a
document written under this skill carries a `<Glossary>` block, and a cold
reader checks it before the document is handed on.

## The glossary

Syntax and placement are in
[`block-vocabulary.md`](../mdx-doc-core/references/block-vocabulary.md). A
term defined here needs no inline gloss at first use (`document-quality.md`
§3): every occurrence links to the definition, so it reaches a reader who
lands mid-document, which the inline gloss does not.

A term belongs in it when the document uses a word with a meaning the reader
cannot get from the project's `AGENTS.md`, its glossary (`docs/internals/glossary.md`
in loom) or general software vocabulary: a word the workstream coined, a
project word used in a narrower sense, a label a sibling report introduced.
The author can list the first kind from memory; the other two are what the
cold read finds.

## The gate

It runs after the lint and render check, so the reader sees the final text,
and before the path reaches Carl, whether the author hands it on directly or
through its parent's report. Spawn a `researcher` child with this brief,
paths filled in:

> Read `<document path>` as a reader who knows this project at the level of
> `<AGENTS.md path>` and `<project glossary path, if there is one>` and
> general software vocabulary, and nothing of the work that produced the
> document; the goal statement in your prompt is part of what the reader
> knows. Read those first, then the document, each whole with `read_full`
> so no passage goes unread. Hand back the terms, phrases
> and labels whose meaning you cannot state from those sources or the
> document itself, its `<Glossary>` included, each with the sentence of its
> first use quoted and what, if anything, you took it to mean; a glossary
> entry that itself uses an undefined term counts. A term a later passage
> makes clear is resolved; say where. An empty list is a valid hand-back. The
> author will add definitions and change nothing else, so a note on the
> argument, the structure or the prose has no one to act on it.

The author defines what came back and runs the read once more; what the
second read still lists is defined without a third. The report that carries
the document's path says how many terms the first read listed and how many
the glossary holds: Carl is judging this skill on its first uses, and that
pair of numbers is the evidence.
