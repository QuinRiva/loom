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
import { rightPanelHostRef, snapshotRightPanel, useRightPanelStore } from "../rightPanelStore";
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
  /** True once `ref`'s panel has drawn `path`, false if it never does. */
  readonly documentShown: (ref: ScopedThreadRef, path: string) => Promise<boolean>;
  readonly viewingRole: (ref: ScopedThreadRef) => string | null;
  readonly routeThread: () => ScopedThreadRef | null;
  readonly navigate: (ref: ScopedThreadRef) => Promise<void>;
}

export interface OpenDocumentLinkOptions {
  readonly line?: number | undefined;
  /** The path is a host path outside the workspace (`openFileAbsolute`). */
  readonly absolute?: boolean;
}

const isAbsolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

const shownKey = (ref: ScopedThreadRef, path: string) =>
  JSON.stringify([ref.environmentId, ref.threadId, path]);
const shownWaiters = new Map<string, (shown: boolean) => void>();
/** A cold read over the relay can take seconds; past this the document stays where it opened. */
const SHOWN_TIMEOUT_MS = 8_000;

/** Called by the document panel each time it draws `path` for `ref`. */
export function markDocumentShown(ref: ScopedThreadRef, path: string) {
  shownWaiters.get(shownKey(ref, path))?.(true);
}

function waitForDocumentShown(ref: ScopedThreadRef, path: string) {
  const key = shownKey(ref, path);
  shownWaiters.get(key)?.(false);
  return new Promise<boolean>((resolve) => {
    const settle = (shown: boolean) => {
      clearTimeout(timer);
      if (shownWaiters.get(key) === settle) shownWaiters.delete(key);
      resolve(shown);
    };
    const timer = setTimeout(() => settle(false), SHOWN_TIMEOUT_MS);
    shownWaiters.set(key, settle);
  });
}

/**
 * Opens the document in the author's panel and routes there, then calls `leave` for the thread
 * left behind, so neither panel visibly changes before the author's thread is on screen.
 */
async function follow(
  env: DocumentLinkEnvironment,
  ref: ScopedThreadRef,
  target: FollowTarget,
  line: number | undefined,
  revision: number,
  leave: () => void,
) {
  const author = scopeThreadRef(ref.environmentId, target.threadId);
  const followed = useRightPanelStore.getState().followDocumentToAuthor({
    from: rightPanelHostRef(ref),
    to: author,
    path: target.filePath,
    absolutePath: isAbsolutePath(target.filePath) ? target.filePath : null,
    line,
    expectedUserActionRevision: revision,
  });
  if (!followed) return;
  await env.navigate(author);
  leave();
}

/**
 * Opens `path` in `ref`'s panel; once it is drawn there and the lookup names another author, the
 * document follows to it. Dropped if the lookup fails, the document never draws, the route has
 * left `ref`, or `ref`'s panel was used since the click.
 */
export function openDocumentLink(
  env: DocumentLinkEnvironment,
  ref: ScopedThreadRef,
  path: string,
  options: OpenDocumentLinkOptions = {},
): Promise<void> {
  const panelRef = rightPanelHostRef(ref);
  const before = snapshotRightPanel(panelRef);
  const alreadyShown =
    before.panel?.isOpen === true && before.panel.activeSurfaceId === `file:${path}`;
  const store = useRightPanelStore.getState();
  if (options.absolute) store.openFileAbsolute(ref, path, options.line);
  else store.openFile(ref, path, options.line);
  if (!isMdxPreviewFile(path)) return Promise.resolve();
  const revision = useRightPanelStore.getState().getUserActionRevision(panelRef);
  return Promise.all([env.lookup(ref, path), alreadyShown || env.documentShown(ref, path)]).then(
    async ([result, shown]) => {
      const target =
        shown && result && documentFollowTarget(result, ref.threadId, env.viewingRole(ref));
      const route = env.routeThread();
      if (!target || route?.environmentId !== ref.environmentId || route.threadId !== ref.threadId)
        return;
      await follow(env, ref, target, options.line, revision, () =>
        useRightPanelStore.getState().restoreRightPanel(panelRef, before, revision),
      );
    },
  );
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
    documentShown: waitForDocumentShown,
    viewingRole: (ref) =>
      registry.get(environmentThreadShells.threadShellAtom(ref))?.source.workstream?.role ?? null,
    routeThread: () => resolveThreadRouteRef(router?.state.matches.at(-1)?.params ?? {}),
    navigate: async (ref) => {
      await router?.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
    },
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
  return (ref: ScopedThreadRef, path: string, target: FollowTarget) =>
    void follow(
      env,
      ref,
      target,
      undefined,
      useRightPanelStore.getState().getUserActionRevision(rightPanelHostRef(ref)),
      () => useRightPanelStore.getState().closeSurface(ref, `file:${path}`),
    );
}
