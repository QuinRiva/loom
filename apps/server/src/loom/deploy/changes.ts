// @effect-diagnostics nodeBuiltinImport:off
// What a deploy changed, for the "Loom updated" notice: the first-parent PR merges between two
// shas, with the `Loom-Summary:`, `Loom-Kind:` and `Loom-Thread:` trailers `pnpm ship` writes.
// Ported from the bridge repository's deploy/changes.ts. Nothing here may fail or slow a deploy.
import type { LoomDeployChange, ThreadId } from "@t3tools/contracts";

import { run } from "./store.ts";

const RS = "\x1e";
const US = "\x1f";

/** The thread named on the most commits, ties to the newest; `perCommit` is newest first. */
export function pickThread(perCommit: ReadonlyArray<ReadonlyArray<string>>): string | null {
  const counts = new Map<string, number>();
  for (const ids of perCommit)
    for (const id of new Set(ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best: string | null = null;
  // Map order is first-seen, newest commit first, so a strict `>` keeps the newest on a tie.
  for (const [id, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = id;
  return best;
}

/** The first noticeable PR's own summary alone, or with a count of the rest. */
export function composeHeadline(changes: ReadonlyArray<LoomDeployChange>): string | null {
  const [first, ...rest] = changes.filter((c) => c.kind === "noticeable" && c.summary !== null);
  if (first?.summary == null) return null;
  return rest.length === 0
    ? first.summary
    : `${first.summary.replace(/\.$/, "")} and ${rest.length} more`;
}

function readChanges(repoUrl: string, mirror: string, from: string, to: string) {
  const log = run("git", [
    "-C",
    mirror,
    "log",
    "--first-parent",
    `--format=%H${US}%s${US}%(trailers:key=Loom-Summary,valueonly)${US}%(trailers:key=Loom-Kind,valueonly)${US}%b${RS}`,
    `${from}..${to}`,
  ]);
  if (log.code !== 0) throw new Error(`git log ${from}..${to} failed: ${log.stderr.trim()}`);
  const repo = repoUrl.replace(/\.git$/, "");
  return log.stdout.split(RS).flatMap((entry): Array<LoomDeployChange> => {
    const [sha = "", subject = "", summary = "", kindText = "", body = ""] = entry
      .trimStart()
      .split(US);
    const pr = /^Merge pull request #(\d+)\b/.exec(subject)?.[1];
    if (pr === undefined) return [];
    const threads = run("git", [
      "-C",
      mirror,
      "log",
      `--format=%(trailers:key=Loom-Thread,valueonly)${RS}`,
      `${sha}^1..${sha}^2`,
    ]);
    const perCommit = (threads.code === 0 ? threads.stdout.split(RS) : []).map((text) =>
      text
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const kind = kindText.split("\n")[0]?.trim();
    // The title is the body's first line unless the body is only Loom's trailers.
    const firstLine = body.trim().split("\n")[0]?.trim() ?? "";
    return [
      {
        pr: Number(pr),
        title: firstLine === "" || /^Loom-(Summary|Kind):/i.test(firstLine) ? subject : firstLine,
        summary: summary.split("\n")[0]?.trim() || null,
        kind: kind === "noticeable" || kind === "behind" ? kind : null,
        threadId: pickThread(perCommit) as ThreadId | null,
        url: `${repo}/pull/${pr}`,
      },
    ];
  });
}

/** The PRs in `from..to` and the notice's headline; no `from` or a bad range is an empty list. */
export function listChanges(repoUrl: string, mirror: string, from: string | undefined, to: string) {
  if (from === undefined || from === "") return { headline: null, changes: [] };
  try {
    const changes = readChanges(repoUrl, mirror, from, to);
    return { headline: composeHeadline(changes), changes };
  } catch {
    return { headline: null, changes: [] };
  }
}
