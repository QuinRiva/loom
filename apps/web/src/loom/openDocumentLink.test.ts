import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DOCUMENT_QUERY_ROLE,
  type DocumentQueryAuthorResult,
  type EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import {
  type DocumentLinkEnvironment,
  documentFollowTarget,
  openDocumentLink,
} from "./openDocumentLink";

const environmentId = "env-1" as EnvironmentId;
const viewer = scopeThreadRef(environmentId, ThreadId.make("orchestrator"));
const planner = scopeThreadRef(environmentId, ThreadId.make("planner"));
const brief = "plans/x/intent.mdx";

const signedBy = (
  author: ScopedThreadRef,
  overrides: Partial<DocumentQueryAuthorResult> = {},
): DocumentQueryAuthorResult => ({
  authorThreadId: author.threadId,
  authorTitle: "Planner: intent brief",
  authorSource: "signature",
  filePath: brief,
  authoringSignature: true,
  authorArchived: false,
  sameFile: true,
  laterEditors: [],
  ...overrides,
});

const panelOf = (ref: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

/** A lookup the test settles by hand, with the route on `viewer` unless moved. */
function harness() {
  let answer: (result: DocumentQueryAuthorResult | null) => void = () => {};
  const route = { current: viewer as ScopedThreadRef | null };
  const navigate = vi.fn<(ref: ScopedThreadRef) => void>();
  const env: DocumentLinkEnvironment = {
    lookup: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    viewingRole: () => null,
    routeThread: () => route.current,
    navigate,
  };
  return {
    env,
    route,
    navigate,
    answer: (result: DocumentQueryAuthorResult | null) => answer(result),
  };
}

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

describe("documentFollowTarget", () => {
  it("follows only another live author's own signature on the same file", () => {
    const follows = (result: DocumentQueryAuthorResult, role: string | null = null) =>
      documentFollowTarget(result, viewer.threadId, role) !== null;
    expect(follows(signedBy(planner))).toBe(true);
    expect(follows(signedBy(viewer))).toBe(false);
    expect(follows(signedBy(planner, { authorSource: "viewing-thread" }))).toBe(false);
    expect(follows(signedBy(planner, { authoringSignature: false }))).toBe(false);
    expect(follows(signedBy(planner, { authorArchived: true }))).toBe(false);
    expect(follows(signedBy(planner, { sameFile: false }))).toBe(false);
    expect(follows(signedBy(planner), DOCUMENT_QUERY_ROLE)).toBe(false);
  });
});

describe("openDocumentLink", () => {
  it("opens the document where it was clicked before the lookup answers", () => {
    const { env } = harness();
    void openDocumentLink(env, viewer, brief);
    expect(panelOf(viewer)).toMatchObject({ isOpen: true, activeSurfaceId: `file:${brief}` });
  });

  it("follows to the author and puts the viewer's panel back as it was", async () => {
    useRightPanelStore.getState().openFile(viewer, "src/a.ts");
    const before = panelOf(viewer);
    const { env, navigate, answer } = harness();
    const done = openDocumentLink(env, viewer, brief, { line: 4 });
    answer(signedBy(planner));
    await done;
    expect(panelOf(viewer)).toEqual(before);
    expect(panelOf(planner)).toMatchObject({ isOpen: true, activeSurfaceId: `file:${brief}` });
    expect(panelOf(planner).surfaces[0]).toMatchObject({ revealLine: 4 });
    expect(navigate).toHaveBeenCalledWith(planner);
  });

  it("stays when the viewer's panel is used, or the route leaves, before the answer", async () => {
    const used = harness();
    const first = openDocumentLink(used.env, viewer, brief);
    useRightPanelStore.getState().openFile(viewer, "src/b.ts");
    used.answer(signedBy(planner));
    await first;
    expect(panelOf(viewer).activeSurfaceId).toBe("file:src/b.ts");

    const moved = harness();
    const second = openDocumentLink(moved.env, viewer, brief);
    moved.route.current = scopeThreadRef(environmentId, ThreadId.make("elsewhere"));
    moved.answer(signedBy(planner));
    await second;

    expect(panelOf(viewer).surfaces.map((surface) => surface.id)).toContain(`file:${brief}`);
    expect(panelOf(planner).surfaces).toEqual([]);
    expect([...used.navigate.mock.calls, ...moved.navigate.mock.calls]).toEqual([]);
  });

  it("never looks up a file that is not a document", () => {
    const lookup = vi.fn<DocumentLinkEnvironment["lookup"]>();
    void openDocumentLink({ ...harness().env, lookup }, viewer, "src/a.ts");
    expect(lookup).not.toHaveBeenCalled();
    expect(panelOf(viewer).activeSurfaceId).toBe("file:src/a.ts");
  });
});
