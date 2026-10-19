import type { EnvironmentId, FilesystemEntryMetadata } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __setMetadataFetcherForTests,
  readPathExistence,
} from "~/components/chat/usePathExistence";
import type { MarkdownFileLinkMeta } from "~/markdown-links";

type Kind = FilesystemEntryMetadata["kind"];

const toastAdd = vi.fn();
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => toastAdd(...args) },
  stackedThreadToast: (options: unknown) => options,
}));

import { makeVerifiedFileLinkChip, verifyChipTargetBeforeOpen } from "./verifiedFileChips";

const ENV = "env-1" as EnvironmentId;
const CWD = "/w";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

const missingChips = () => [...container.querySelectorAll('[data-file-missing="true"]')];
const upstreamChips = () => [...container.querySelectorAll("[data-upstream-chip]")];

function meta(filePath: string): MarkdownFileLinkMeta {
  return {
    filePath,
    targetPath: filePath,
    displayPath: filePath.slice(CWD.length + 1),
    workspaceRelativePath: filePath.slice(CWD.length + 1),
    basename: filePath.slice(filePath.lastIndexOf("/") + 1),
  } as MarkdownFileLinkMeta;
}

/** Renders every meta through the wrapper; upstream's chip is a bare marker. */
function Harness({ metas }: { metas: ReadonlyArray<MarkdownFileLinkMeta> }) {
  const chip = makeVerifiedFileLinkChip({
    environmentId: ENV,
    renderChip: (fileLinkMeta) => <b data-upstream-chip>{fileLinkMeta.basename}</b>,
  });
  return (
    <div>
      {metas.map((entry) => (
        <span key={entry.filePath}>{chip(entry, `\`${entry.filePath}\``)}</span>
      ))}
    </div>
  );
}

async function renderHarness(
  metas: ReadonlyArray<MarkdownFileLinkMeta>,
  kinds: Record<string, Kind>,
  { settle = true }: { settle?: boolean } = {},
) {
  __setMetadataFetcherForTests((_environmentId, paths) =>
    Promise.resolve(
      new Map(paths.map((path) => [path, kinds[path] ? { kind: kinds[path] } : null])),
    ),
  );
  await act(async () => root.render(<Harness metas={metas} />));
  if (settle) {
    // The shared store coalesces for 80ms before its batched stat. Wait on the
    // store itself (not a fixed sleep) so the assertion never races a slow box;
    // real timers, because React's scheduler runs on them.
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      if (metas.every((entry) => readPathExistence(ENV, entry.filePath) !== undefined)) break;
    }
  }
}

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __setMetadataFetcherForTests(null);
  vi.unstubAllGlobals();
  toastAdd.mockClear();
});

describe("makeVerifiedFileLinkChip", () => {
  it("keeps upstream's chip for a file that exists", async () => {
    await renderHarness([meta(`${CWD}/main.ts`)], { [`${CWD}/main.ts`]: "file" });
    expect(upstreamChips()).toHaveLength(1);
    expect(missingChips()).toHaveLength(0);
  });

  it("replaces a chip whose file the server reports as gone with a labelled missing state", async () => {
    await renderHarness([meta(`${CWD}/gone.ts`)], {});
    expect(upstreamChips()).toHaveLength(0);
    const missing = missingChips();
    expect(missing).toHaveLength(1);
    // Clearly labelled, and inert: a span, so there is no dead click.
    expect(missing[0]?.getAttribute("aria-label")).toContain("Missing — moved or deleted?");
    expect(missing[0]?.tagName).toBe("SPAN");
  });

  it("keeps upstream's chip while a path is still unverified, so nothing flickers", async () => {
    await renderHarness([meta(`${CWD}/pending.ts`)], {}, { settle: false });
    expect(upstreamChips()).toHaveLength(1);
    expect(missingChips()).toHaveLength(0);
  });

  // The window this closes: the chip was live when the message rendered, and
  // the file moved before the click. Verification is on the click itself.
  it("flips a chip that went stale since render and blocks the open", async () => {
    const filePath = `${CWD}/moved.ts`;
    // The harness fetcher reads this map per stat, so deleting the entry is the
    // file moving underneath an already-rendered chip.
    const kinds: Record<string, Kind> = { [filePath]: "file" };
    await renderHarness([meta(filePath)], kinds);
    expect(upstreamChips()).toHaveLength(1);

    delete kinds[filePath];
    let opened: boolean | undefined;
    await act(async () => {
      opened = await verifyChipTargetBeforeOpen(ENV, filePath);
    });

    expect(opened).toBe(false);
    expect(missingChips()).toHaveLength(1);
    expect(String(toastAdd.mock.calls[0]?.[0]?.title)).toBe("moved.ts has moved or been deleted");
  });

  it("opens when the click-time stat fails, so an unhealthy RPC never blocks a live link", async () => {
    __setMetadataFetcherForTests(() => Promise.resolve(new Map()));
    expect(await verifyChipTargetBeforeOpen(ENV, `${CWD}/unknown.ts`)).toBe(true);
    // No environment (the /preview harness) cannot verify anything either.
    expect(await verifyChipTargetBeforeOpen(null, `${CWD}/unknown.ts`)).toBe(true);
    expect(toastAdd).not.toHaveBeenCalled();
  });

  // Artifact routing now lives in upstream's chip (`onOpenArtifact`), so the
  // seam only has to keep a missing artifact from rendering as a live chip.
  it("still reports a missing .html artifact — missing outranks artifact routing", async () => {
    await renderHarness([meta(`${CWD}/stale.html`)], {});
    expect(upstreamChips()).toHaveLength(0);
    expect(missingChips()).toHaveLength(1);
  });
});
