# Task for reviewer

Review a focused UI change in the loom repo at /home/Carl/.t3/cockpit/worktrees/loom/t3code-cc19c482 (branch t3code/add-middle-click-history). Run `git diff` from that directory to see the full change.

Context: The change binds MIDDLE-CLICK on a workstream graph node to open that node's lifecycle "history" drawer, and makes middle-clicking a different node re-point the same drawer (switch histories) without needing to click into the graph to reselect. Previously "View history" was only reachable via the right-click context menu.

Files touched:

- apps/web/src/components/WorkstreamGraph.tsx (new onOpenHistory prop threaded to GraphNode; onAuxClick/onMouseDown middle-button handlers; hint text)
- apps/web/src/components/WorkstreamPanel.tsx (wires onOpenHistory -> setInspectedThreadId; comment update)
- apps/web/src/preview/fixtures.tsx (added onOpenHistory to preview fixture)

Focus your review on correctness and fit:

1. Does the middle-click gesture reliably open/switch the history drawer? Any event-handling pitfalls (autoscroll, pan conflict, event bubbling to SVG canvas, right-click menu interference)?
2. Is the drawer-switch-while-open behaviour actually achieved given how inspectedThreadId / the drawer open condition work?
3. Any accessibility or consistency regressions.
4. Code quality per the repo's conventions (minimal, no over-engineering).

typecheck already passes (tsc --noEmit is clean). Do NOT modify files — report findings only, classified must-fix vs nice-to-have.

## Acceptance Contract

Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:

- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```
