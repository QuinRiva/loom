import type { EnvironmentId, FilesystemEntryMetadata } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  __setMetadataFetcherForTests,
  readPathExistence,
} from "~/components/chat/usePathExistence";
import type { MarkdownFileLinkMeta } from "~/markdown-links";

import { act, render } from "../../test/render";

type Kind = FilesystemEntryMetadata["kind"];
type Fetcher = Parameters<typeof __setMetadataFetcherForTests>[0];

const toastAdd = vi.fn();
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => toastAdd(...args) },
  stackedThreadToast: (options: unknown) => options,
}));

import { makeVerifiedFileLinkChip, verifyChipTargetBeforeOpen } from "./verifiedFileChips";

const ENV = "env-1" as EnvironmentId;
const CWD = "/w";

function setup() {
  toastAdd.mockClear();
}

function stubFetcher(fetcher: Fetcher): Disposable {
  __setMetadataFetcherForTests(fetcher);
  return { [Symbol.dispose]: () => __setMetadataFetcherForTests(null) };
}

/** The harness fetcher reads `kinds` per stat, so deleting an entry moves the file. */
const fetcherFor =
  (kinds: Record<string, Kind>): Fetcher =>
  (_environmentId, paths) =>
    Promise.resolve(
      new Map(paths.map((path) => [path, kinds[path] ? { kind: kinds[path] } : null])),
    );

const missingChips = (container: HTMLElement) => [
  ...container.querySelectorAll('[data-file-missing="true"]'),
];
const upstreamChips = (container: HTMLElement) => [
  ...container.querySelectorAll("[data-upstream-chip]"),
];

function meta(filePath: string): MarkdownFileLinkMeta {
  return {
    filePath,
    workspaceLookupPath: null,
    targetPath: filePath,
    displayPath: filePath.slice(CWD.length + 1),
    workspaceRelativePath: filePath.slice(CWD.length + 1),
    basename: filePath.slice(filePath.lastIndexOf("/") + 1),
  };
}

/** Renders every meta through the wrapper; upstream's chip is a bare marker. */
function Harness({ metas }: { metas: ReadonlyArray<MarkdownFileLinkMeta> }) {
  const chip = makeVerifiedFileLinkChip({
    environmentId: ENV,
    cwd: CWD,
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

/** Renders, then waits out the store's coalesced batch until every path is verified. */
async function renderSettled(metas: ReadonlyArray<MarkdownFileLinkMeta>) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(<Harness metas={metas} />));
  await vi.waitFor(() =>
    expect(metas.every((entry) => readPathExistence(ENV, entry.filePath) !== undefined)).toBe(true),
  );
  stack.move();
  return screen;
}

describe("makeVerifiedFileLinkChip", () => {
  it("keeps upstream's chip for a file that exists", async () => {
    setup();
    using _fetcher = stubFetcher(fetcherFor({ [`${CWD}/main.ts`]: "file" }));
    await using screen = await renderSettled([meta(`${CWD}/main.ts`)]);
    await vi.waitFor(() => expect(upstreamChips(screen.container)).toHaveLength(1));
    expect(missingChips(screen.container)).toHaveLength(0);
  });

  it("replaces a chip whose file the server reports as gone with a labelled missing state", async () => {
    setup();
    using _fetcher = stubFetcher(fetcherFor({}));
    await using screen = await renderSettled([meta(`${CWD}/gone.ts`)]);
    await vi.waitFor(() => expect(missingChips(screen.container)).toHaveLength(1));
    expect(upstreamChips(screen.container)).toHaveLength(0);
    const missing = missingChips(screen.container);
    // Clearly labelled, and inert: a span, so there is no dead click.
    expect(missing[0]?.getAttribute("aria-label")).toContain("Missing (moved or deleted?)");
    expect(missing[0]?.tagName).toBe("SPAN");
  });

  it("keeps upstream's chip while a path is still unverified, so nothing flickers", async () => {
    setup();
    using _fetcher = stubFetcher(fetcherFor({}));
    await using screen = await render(<Harness metas={[meta(`${CWD}/pending.ts`)]} />);
    expect(upstreamChips(screen.container)).toHaveLength(1);
    expect(missingChips(screen.container)).toHaveLength(0);
  });

  // The window this closes: the chip was live when the message rendered, and
  // the file moved before the click. Verification is on the click itself.
  it("flips a chip that went stale since render and blocks the open", async () => {
    setup();
    const filePath = `${CWD}/moved.ts`;
    const kinds: Record<string, Kind> = { [filePath]: "file" };
    using _fetcher = stubFetcher(fetcherFor(kinds));
    await using screen = await renderSettled([meta(filePath)]);
    await vi.waitFor(() => expect(upstreamChips(screen.container)).toHaveLength(1));

    delete kinds[filePath];
    let opened: boolean | undefined;
    await act(async () => {
      opened = await verifyChipTargetBeforeOpen(ENV, filePath);
    });

    expect(opened).toBe(false);
    await vi.waitFor(() => expect(missingChips(screen.container)).toHaveLength(1));
    expect(String(toastAdd.mock.calls[0]?.[0]?.title)).toBe("moved.ts has moved or been deleted");
  });

  it("opens when the click-time stat fails, so an unhealthy RPC never blocks a live link", async () => {
    setup();
    using _fetcher = stubFetcher(() => Promise.resolve(new Map()));
    expect(await verifyChipTargetBeforeOpen(ENV, `${CWD}/unknown.ts`)).toBe(true);
    // No environment (the /preview harness) cannot verify anything either.
    expect(await verifyChipTargetBeforeOpen(null, `${CWD}/unknown.ts`)).toBe(true);
    expect(toastAdd).not.toHaveBeenCalled();
  });

  // Upstream finds a bare name or a repository-relative path at open, so the literal path's
  // absence must not draw "missing?" over a link upstream would open.
  it("keeps upstream's chip for a link upstream re-resolves at open", async () => {
    setup();
    using _fetcher = stubFetcher(fetcherFor({}));
    const bare = { ...meta(`${CWD}/notes.md`), workspaceLookupPath: "notes.md" };
    const repoRelative = { ...meta(`${CWD}/w/src/a.ts`), workspaceLookupPath: "w/src/a.ts" };
    const plain = { ...meta(`${CWD}/src/gone.ts`), workspaceLookupPath: "src/gone.ts" };
    await using screen = await render(<Harness metas={[bare, repoRelative, plain]} />);
    await vi.waitFor(() => expect(readPathExistence(ENV, plain.filePath)).toBeDefined());
    await vi.waitFor(() => expect(missingChips(screen.container)).toHaveLength(1));
    expect(upstreamChips(screen.container)).toHaveLength(2);
  });

  // Artifact routing now lives in upstream's chip (`onOpenArtifact`), so the
  // seam only has to keep a missing artifact from rendering as a live chip.
  it("still reports a missing .html artifact: missing outranks artifact routing", async () => {
    setup();
    using _fetcher = stubFetcher(fetcherFor({}));
    await using screen = await renderSettled([meta(`${CWD}/stale.html`)]);
    await vi.waitFor(() => expect(missingChips(screen.container)).toHaveLength(1));
    expect(upstreamChips(screen.container)).toHaveLength(0);
  });
});
