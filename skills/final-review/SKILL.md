---
name: final-review
description: >-
  The final reviewer's yardstick: one command prints every message the human
  wrote in a goal, verbatim and in time order, with agent text marked as such.
  Loaded by the final-reviewer role before it reads the build.
---

# Final review: the human's words for a goal

```
python3 scripts/human_words.py <thread-id> > <file>
```

The script path resolves against this skill's directory. `<thread-id>` is any
thread of the goal, your own included; the record covers every thread of that
goal and, where the goal was started by another agent's handoff, the human's
messages behind the handoff. It reads Loom's database read-only and takes
about a second.

The output opens by explaining its own markers. Read that header before the
entries: it says how the human's text is set apart from the agent text shown
for context, and how a picked option differs from words they typed. It closes
with the questions agents put to the human through the question tool that
are still unanswered; a question asked in an agent's prose or in a document's
form is not in that list.

Three things the record cannot hold:

- An image the human attached. The record prints its path; open the ones
  that carry part of the ask, such as a diagram.
- Words the human typed straight into an artefact: a ticket, a pull-request
  description, a template. Their messages usually say when they did.
- Anything they said outside this goal's threads.
