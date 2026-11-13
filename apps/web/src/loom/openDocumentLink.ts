/**
 * loom: a link to a signed document opens it where it was clicked, exactly as before, and in the
 * same tick asks the server who wrote it; when another live thread signed it and holds the same
 * file, the document follows to that thread's panel and the route follows it there
 * (plans/document-comments-to-author/plan.mdx §1, §3). Nothing waits on the lookup.
 */
import { useContext } from "react";
import { RegistryContext } from "@effect/atom-react";
import {
  DOCUMENT_QUERY_ROLE,
  type DocumentQueryAuthorResult,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";

import { isMdxPreviewFile } from "../components/files/filePreviewMode";
import {
  rightPanelHostRef,
  type RightPanelSnapshot,
  snapshotRightPanel,
  useRightPanelStore,
} from "../rightPanelStore";
import { environmentThreadShells } from "../state/threads";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { loomCommands } from "./loomGoalState";

interface FollowTarget {
  readonly threadId: ThreadId;
  readonly filePath: string;
}

/** Where a document opened in `viewingThreadId` should be reviewed: its author's thread, or null to stay. */
export function documentFollowTarget(
  result: DocumentQueryAuthorResult,
  viewingThreadId: ThreadId,
  viewingRole: string | null,
): FollowTarget | null {
  return result.authorSource === "signature" &&
    result.authoringSignature &&
    result.authorThreadId !== viewingThreadId &&
    !result.authorArchived &&
    result.sameFile &&
    viewingRole !== DOCUMENT_QUERY_ROLE
    ? { threadId: result.authorThreadId, filePath: result.filePath }
    : null;
}

/** What a follow reads from outside the panel store; the hooks wire it to the app. */
export interface DocumentLinkEnvironment {
  /** The author lookup, null when it fails. */
  readonly lookup: (
    ref: ScopedThreadRef,
    path: string,
  ) => Promise<DocumentQueryAuthorResult | null>;
  readonly viewingRole: (ref: ScopedThreadRef) => string | null;
  readonly routeThread: () => ScopedThreadRef | null;
  readonly navigate: (ref: ScopedThreadRef) => void;
}

export interface OpenDocumentLinkOptions {
  readonly line?: number | undefined;
  /** The path is a host path outside the workspace (`openFileAbsolute`). */
  readonly absolute?: boolean;
}

const isAbsolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

function follow(
  env: DocumentLinkEnvironment,
  ref: ScopedThreadRef,
  target: FollowTarget,
  line: number | undefined,
  before: RightPanelSnapshot,
  revision: number,
) {
  const author = scopeThreadRef(ref.environmentId, target.threadId);
  const followed = useRightPanelStore.getState().followDocumentToAuthor({
    from: rightPanelHostRef(ref),
    to: author,
    path: target.filePath,
    absolutePath: isAbsolutePath(target.filePath) ? target.filePath : null,
    line,
    before,
    expectedUserActionRevision: revision,
  });
  if (followed) env.navigate(author);
}

/**
 * Opens `path` in `ref`'s panel, then follows it to its author when the lookup says so. The
 * follow is dropped if the lookup fails, the route has left `ref`, or `ref`'s panel was used since.
 */
export function openDocumentLink(
  env: DocumentLinkEnvironment,
  ref: ScopedThreadRef,
  path: string,
  options: OpenDocumentLinkOptions = {},
): Promise<void> {
  const panelRef = rightPanelHostRef(ref);
  const before = snapshotRightPanel(panelRef);
  const store = useRightPanelStore.getState();
  if (options.absolute) store.openFileAbsolute(ref, path, options.line);
  else store.openFile(ref, path, options.line);
  if (!isMdxPreviewFile(path)) return Promise.resolve();
  const revision = useRightPanelStore.getState().getUserActionRevision(panelRef);
  return env.lookup(ref, path).then((result) => {
    const target = result && documentFollowTarget(result, ref.threadId, env.viewingRole(ref));
    const route = env.routeThread();
    if (!target || route?.environmentId !== ref.environmentId || route.threadId !== ref.threadId)
      return;
    follow(env, ref, target, options.line, before, revision);
  });
}

function useDocumentLinkEnvironment(): DocumentLinkEnvironment {
  // Optional: a few hosts (browser tests, the preview harness) render chat without a router.
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  const registry = useContext(RegistryContext);
  const lookup = useAtomQueryRunner(loomCommands.documentQueryAuthor, {
    reportFailure: false,
    reportDefect: false,
  });
  return {
    lookup: (ref, filePath) =>
      lookup({
        environmentId: ref.environmentId,
        input: { sourceThreadId: ref.threadId, filePath },
      }).then((result) => (result._tag === "Success" ? result.value : null)),
    viewingRole: (ref) =>
      registry.get(environmentThreadShells.threadShellAtom(ref))?.source.workstream?.role ?? null,
    routeThread: () => resolveThreadRouteRef(router?.state.matches.at(-1)?.params ?? {}),
    navigate: (ref) =>
      void router?.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      }),
  };
}

export function useOpenDocumentLink() {
  const env = useDocumentLinkEnvironment();
  return (ref: ScopedThreadRef, path: string, options?: OpenDocumentLinkOptions) =>
    void openDocumentLink(env, ref, path, options);
}

/** The header's Review there: moves the open document `path` from `ref`'s panel to its author's. */
export function useMoveDocumentToAuthor() {
  const env = useDocumentLinkEnvironment();
  return (ref: ScopedThreadRef, path: string, target: FollowTarget) => {
    const panelRef = rightPanelHostRef(ref);
    const store = useRightPanelStore.getState();
    store.closeSurface(ref, `file:${path}`);
    follow(
      env,
      ref,
      target,
      undefined,
      snapshotRightPanel(panelRef),
      store.getUserActionRevision(panelRef),
    );
  };
}
