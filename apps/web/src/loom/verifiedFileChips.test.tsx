import type { EnvironmentId, ProjectPathKind } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __setStatFetcherForTests, readPathExistence } from "~/components/chat/usePathExistence";
import type { MarkdownFileLinkMeta } from "~/markdown-links";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/components/ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ render, children }: { render?: unknown; children?: ReactNode }) =>
      isValidElement(render) ? cloneElement(render) : <>{children}</>,
    TooltipPopup: () => null,
  };
});

import { useVerifiedFileLinkChip } from "./verifiedFileChips";

const ENV = "env-1" as EnvironmentId;
const CWD = "/w";

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
  const chip = useVerifiedFileLinkChip({
    environmentId: ENV,
    metas,
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
  kinds: Record<string, ProjectPathKind>,
  { settle = true }: { settle?: boolean } = {},
) {
  __setStatFetcherForTests((_environmentId, paths) =>
    Promise.resolve(paths.map((path) => ({ path, kind: kinds[path] ?? "missing" }))),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Harness metas={metas} />);
  });
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
  return renderer!;
}

afterEach(() => {
  __setStatFetcherForTests(null);
  vi.unstubAllGlobals();
});

describe("useVerifiedFileLinkChip", () => {
  it("keeps upstream's chip for a file that exists", async () => {
    const renderer = await renderHarness([meta(`${CWD}/main.ts`)], { [`${CWD}/main.ts`]: "file" });
    expect(renderer.root.findAllByType("b")).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "data-file-missing": "true" })).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it("replaces a chip whose file the server reports as gone with a labelled missing state", async () => {
    const renderer = await renderHarness([meta(`${CWD}/gone.ts`)], {});
    expect(renderer.root.findAllByType("b")).toHaveLength(0);
    const missing = renderer.root.findAllByProps({ "data-file-missing": "true" });
    expect(missing).toHaveLength(1);
    // Clearly labelled, and inert: a span, so there is no dead click.
    expect(String(missing[0]?.props["aria-label"])).toContain("Missing — moved or deleted?");
    expect(missing[0]?.type).toBe("span");
    await act(async () => renderer.unmount());
  });

  it("keeps upstream's chip while a path is still unverified, so nothing flickers", async () => {
    const renderer = await renderHarness([meta(`${CWD}/pending.ts`)], {}, { settle: false });
    expect(renderer.root.findAllByType("b")).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "data-file-missing": "true" })).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  // Artifact routing now lives in upstream's chip (`onOpenArtifact`), so the
  // seam only has to keep a missing artifact from rendering as a live chip.
  it("still reports a missing .html artifact — missing outranks artifact routing", async () => {
    const renderer = await renderHarness([meta(`${CWD}/stale.html`)], {});
    expect(renderer.root.findAllByType("b")).toHaveLength(0);
    expect(renderer.root.findAllByProps({ "data-file-missing": "true" })).toHaveLength(1);
    await act(async () => renderer.unmount());
  });
});
