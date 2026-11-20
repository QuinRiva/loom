# Loom hand-back

Measures whether a Loom thread hands back, holds and tells its parent the way the control plane expects: a child whose work a human must accept, a child the human corrects or approves in its own thread, an orchestrator that receives a held child's notices, an orchestrator asked for a thread the human will work in, and a finished or human-led child the human asks to get something delegated. Source: `plans/human-in-child-thread/plan.mdx` §5; the text it is run against is `plans/human-in-child-thread/model-text.md`, whose §7 is the pre-registered hypothesis.

It also measures a query thread, the read-only fork of a document's or a commit's author that the human questions in review: that it promotes an exchange with one call, answers an ordinary question, changes nothing in the worktree when asked to, and when asked about a line its thread did not write, says whose it is and what it knows of it without passing its own reading off as the author's reason. Source: `plans/code-query/plan.mdx` §5.

Each case is an authored Acme transcript that ends at a decision. Everything Loom produces in it is assembled from this checkout:

- The system prompt: pi's preamble and `addendumParts` (`sessionComposerLive.ts`), joined in the composer's order, then the role's skills as pi lists them.
- The tools: `LOOM_TOOL_DEFS` and `ask_user_question` filtered to the role's profile (`loadRoleOverlay`), human input when a person can read the thread, `bg_start`/`bg_wait`, and stubs of pi's `read`, `bash`, `edit`, `tool_search` and pi-craft's `sign_document`.
- Kickoffs (`workstreamChildPrompt`), author labels (`labelledForModel`), submit echoes (`routeWorkSubmit` and `renderSubmitOutcome`), notices and refusals, and the skills' own `lint-doc.sh` run on the authored documents.
- A query thread (`queryFork` on the case) replays its author's launch, so it runs on the author's role and ids. Its first message is the overlay and question as the server joins them (`buildQueryForkLaunch`, `buildCodeQueryOverlay`, `buildCodeQueryQuestion`), it arrives bare because the thread is a root, and the promote tool is declared as a `tool_search` would have loaded it. Its `edit` is answered with the refusal pi's query guard gives. A case's `world` is a fact of the repository the transcript does not show (a commit the question names, what its message does and does not say), given to the simulator so it cannot invent otherwise.
- `world.ts` gathers what the control plane sends where the human-in-child change altered it: the held notice, the result of a finished child's submit, the tools loaded once a person has written to a child. An arm before such a change runs with `world.ts` from that change's base, as the base runs did. A human-led kickoff passes `humanLed` to `workstreamChildPrompt`.

The model continues from the transcript until a message decides: it ends the turn, or makes a call other than reading, running, editing or orienting (`LOOKING` in `grade.ts`). That message is graded. Calls before it are answered by a simulator model told to agree with the transcript and add nothing the agent must act on. An attempt that has not decided after five messages counts as "looked" and is attempted again, up to twice the samples. Under a `read-only` check a shell command that writes decides too, so the attempt stops at the write; `shellWrite` in `grade.ts` says which commands write.

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
- Cost: proxy quota only. A full run is about 140 attempts and 30 minutes: 8 to 10M input and 0.4M output tokens (the fresh session line keeps every system prompt uncached), plus about 0.4M for the simulator. The seven query-thread cases add about 116 attempts: 3.9M input and 0.15M output, and 0.25M for the simulator.

## Reading a run

Read every sample that flipped, and the final text of the orchestrator cases that end in prose: whether a parent asked for approval in its own thread is not something a pattern can grade. A sample whose decision rests on something the simulator invented is a harness problem, not a finding. The `others-lines` check knows a marked reason only by its phrases (`OWN_READING` in `grade.ts`), so read every answer it passes for a reason stated as the author's and every answer it fails for one marked in other words. In a query thread that calls `edit`, the sample has already failed; read what follows for whether the fork then went to the shell, and discount a simulated `git status` that shows the refused edit as applied.

## The grader

`grade.ts` checks the deciding message's tool calls and text; `run.test.ts` tests it. A Loom tool called by its bare name (`notify_thread`, which Opus often does and pi answers "not found") grades as that tool. After a grader fix, `pnpm loom-handback:regrade runs/<name> [runs/<baseline>]` grades a finished run again from its saved samples and writes `summary.regraded.md` beside it. A plain submit has no outcome or `done`; a held one has `awaiting_acceptance`. A quote is a case-insensitive fragment of the human's words, after whitespace and typographic quotes are normalised.

## Add a case

Add an entry to `cases.ts`: Acme data only, a `source` naming the real situation it mirrors, a `kind` (`bad` fails on the text it is written against, `control` and `guard` pass on both sides), and the plan's prediction for the base text in `base`. Build every Loom-produced message from source, through `world.ts` when the change alters it. A finished child that may add to its report lists `mcp__t3-code__workstream_submit` in `looking` and gives `finishedReport`: the addition is answered with this checkout's result and the message after it is graded.
