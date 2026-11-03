# Explainer density

Measures how dense the prose is when an agent turns a fact-dense investigation into one section of an explainer, under the MDX document skills at a given git ref. It answers whether the skills' own register (their sentence length) carries into what an agent writes, beyond the effect of a rule and an exemplar. Source: `plans/fact-dense-explanations/plan.mdx` §4.

The system prompt is the three files an agent reads before writing an explainer, read with `git show <ref>:<path>`: `skills/mdx-visual-explainer/SKILL.md`, `skills/mdx-doc-core/references/document-quality.md` and `skills/mdx-doc-core/references/exemplar.md`. The user prompt is a fact pack from `cases.ts`. Each `--skills-ref` is one arm. Pass a ref twice for a second run of that arm; the difference between the two is the noise floor.

## Run

```sh
cd evals
pnpm explainer-density --out runs/<name> --skills-ref <base> --skills-ref <change> --skills-ref <base>
```

- Model: `claude-fable-5-1`, the default in Carl's pi settings, at effort `high` with adaptive thinking, as pi sends it. Override with `--model` and `--effort`.
- Route: loom's local CLIProxyAPI pool (`localhost:8317`, key in `~/cli-proxy/.apikey`) when that key exists, which is how pi reaches Claude on the cockpit machine; otherwise the `vibeproxy` provider in `~/.codex/config.toml`. Either way a run costs proxy quota, not a key.
- Flags: `--samples <n>` per arm (default 5), `--concurrency <n>` (default 5). Each sample starts the system prompt with a fresh session line, so no cache serves an earlier sample.
- Output: `samples/<arm>-<case>-<n>.mdx` (the section each sample wrote), `results.ndjson` (one graded row per sample) and `summary.md` (one row per arm).
- Cost: about 20k input tokens a sample. A four-arm run of five samples is about 400k input and 120k output tokens; `summary.md` records the actual figure.

## The grader

`grade.ts` scores each output. `run.test.ts` tests it.

- From `proseDensity.ts`, the lint's own module: sentences over 30 words, paragraphs over 100 words, bracketed inline-code citations.
- Mean sentence length over the document's prose (the paragraphs the lint reads, notes excluded). This is the primary metric for the register question.
- Shape D's three parts: a verdict line (the first prose line is bold-led and names the outcome, or a line opens `**Verdict`), a `<Table>`, and at least two bold-labelled paragraphs.
- Also counted: `<Sidenote>`s, em-dashes and words.

Read the samples behind any number that moved before drawing a conclusion.

## Add a case

Add an entry to `cases.ts`: an invented fact pack, never real data, with a source line naming the real document it mirrors.
