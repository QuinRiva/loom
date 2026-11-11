# Loom hand-back

Measures whether a Loom thread hands back, holds and tells its parent the way the control plane expects: a child whose work a human must accept, a child the human corrects or approves in its own thread, an orchestrator that receives a held child's notices, an orchestrator asked for a thread the human will work in, and a finished or human-led child the human asks to get something delegated. Source: `plans/human-in-child-thread/plan.mdx` §5; the text it is run against is `plans/human-in-child-thread/model-text.md`, whose §7 is the pre-registered hypothesis.

Each case is an authored Acme transcript that ends at a decision. Everything Loom produces in it is assembled from this checkout:

- The system prompt: pi's preamble and `addendumParts` (`sessionComposerLive.ts`), joined in the composer's order, then the role's skills as pi lists them.
- The tools: `LOOM_TOOL_DEFS` and `ask_user_question` filtered to the role's profile (`loadRoleOverlay`), human input when a person can read the thread, `bg_start`/`bg_wait`, and stubs of pi's `read`, `bash`, `edit`, `tool_search` and pi-craft's `sign_document`.
- Kickoffs (`workstreamChildPrompt`), author labels (`labelledForModel`), submit echoes (`routeWorkSubmit` and `renderSubmitOutcome`), notices and refusals, and the skills' own `lint-doc.sh` run on the authored documents.
- `world.ts` gathers what the control plane sends where the human-in-child change altered it: the held notice, the result of a finished child's submit, the tools loaded once a person has written to a child. Where a revision adds an export, `world.ts` looks it up by name and falls back to the build before it, so the same eval files run on both arms. A human-led kickoff passes `humanLed` to `workstreamChildPrompt`.

The model continues from the transcript until a message decides: it ends the turn, or makes a call other than reading, running, editing or orienting (`LOOKING` in `grade.ts`). That message is graded. Calls before it are answered by a simulator model told to agree with the transcript and add nothing the agent must act on. An attempt that has not decided after five messages counts as "looked" and is attempted again, up to twice the samples.

## Run

```sh
cd evals
pnpm loom-handback --out runs/<name>
pnpm loom-handback --out runs/<name> --case planner-holds-brief,coder-holds-prototype --baseline runs/<base>
```

- Models: every case on `claude-fable-5-2` (pi's default, and the planner preset); the coder-role cases also on `claude-opus-5-5` (the coder preset). Effort `high`, adaptive thinking, as pi sends them. Override with `--model`, `--coder-model` (`none` skips the second model) and `--effort`. The simulator is `claude-sonnet-5-5` (`--simulator-model`).
- Route: Loom's local CLIProxyAPI pool (`localhost:8317`, key in `~/cli-proxy/.apikey`) when the key exists, else the `vibeproxy` provider in `~/.codex/config.toml`, as `explainer-density`.
- Flags: `--samples <n>` decided samples per case and model (default 5; a case may set its own), `--case <ids>` (comma-separated or repeated), `--baseline <run dir>` to add the earlier verdict and a fixed/broken column, `--concurrency <n>` cases in flight (default 4). Each attempt starts its system prompt with a fresh session line, so no cache serves an earlier one.
- Output: `requests/<case>.json` (the system prompt, tool names and transcript the model saw), `samples/<model>-<case>-<n>.json` (what the model and the simulator added), `results.ndjson` (one graded row per attempt) and `summary.md`.
- A case passes when more than half its samples pass. Five samples a case can only show a large effect; run the same commit twice for the noise floor.
- Cost: proxy quota only. A full run is about 140 attempts and 30 minutes: 8 to 10M input and 0.4M output tokens (the fresh session line keeps every system prompt uncached), plus about 0.4M for the simulator.

## Reading a run

Read every sample that flipped, and the final text of the orchestrator cases that end in prose: whether a parent asked for approval in its own thread is not something a pattern can grade. A sample whose decision rests on something the simulator invented is a harness problem, not a finding.

## The grader

`grade.ts` checks the deciding message's tool calls and text; `run.test.ts` tests it. A plain submit has no outcome or `done`; a held one has `awaiting_acceptance`. A quote is a case-insensitive fragment of the human's words, after whitespace and typographic quotes are normalised.

## Add a case

Add an entry to `cases.ts`: Acme data only, a `source` naming the real situation it mirrors, a `kind` (`bad` fails on the text it is written against, `control` and `guard` pass on both sides), and the plan's prediction for the base text in `base`. Build every Loom-produced message from source, through `world.ts` when the change alters it.
