/**
 * loom: an `.mdx` drawn by web's renderer in a viewer page the server serves (so a new block
 * reaches the phone with a deploy). The app hands it the text and signs its images, so the page
 * holds no credential; in a thread, a tapped answer arrives as web's record for the draft.
 */
import { StackActions, useNavigation } from "@react-navigation/native";
import { getBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  acceptDocumentViewerPageMessage,
  DOCUMENT_VIEWER_PATH,
  DOCUMENT_VIEWER_PROTOCOL,
  type DocumentViewerAppMessage,
  documentViewerAppMessageScript,
} from "@t3tools/shared/documentViewerBridge.loom";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { refreshAssetUrl } from "../../state/assets";
import {
  removeComposerDraftContextRecord,
  upsertComposerDraftContextRecord,
} from "../../state/composerDraftContextRecord.loom";
import { useComposerDraft } from "../../state/use-composer-drafts";
import { usePreparedConnection } from "../../state/session";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  fileRoutePathSegments,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

/** From the page's load end, not mount, so a slow first download on mobile data is not a failure. */
const READY_TIMEOUT_MS = 8_000;

const withoutFragment = (url: string) => url.split("#", 1)[0];

type ViewerState = "loading" | "ready" | "rendered" | "compile-error" | "unavailable";

export function MdxDocumentView(props: {
  readonly environmentId: EnvironmentId;
  readonly source: string;
  /** As the app opened it: workspace-relative, or absolute. */
  readonly filePath: string;
  /** The workspace the document lives in; null for an attached file, which has none. */
  readonly workspace: { readonly cwd: string; readonly threadId: ThreadId | null } | null;
  readonly onViewSource: () => void;
}) {
  const navigation = useNavigation();
  const connection = usePreparedConnection(props.environmentId);
  const { themeAppearance } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<ViewerState>("loading");
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
  const webView = useRef<WebView<object>>(null);
  const token = useRef(uuidv4());
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A ref, not state: `ready` and the load end can arrive in one native batch, before a re-render.
  const answered = useRef(false);
  // The answers last told to this load of the page; null until it has had `init`.
  const sentPresent = useRef<string | null>(null);
  const viewerUrl =
    connection._tag === "Some"
      ? new URL(DOCUMENT_VIEWER_PATH, connection.value.httpBaseUrl).toString()
      : null;
  const { workspace } = props;
  const absolutePath = workspace ? resolveWorkspaceFilePath(workspace.cwd, props.filePath) : null;
  const baseDir =
    absolutePath === null ? "" : getBrowseDirectoryPath(absolutePath).replace(/(.)[\\/]+$/, "$1");
  // The path web names the document by, so an answer's record matches web's.
  const documentPath =
    (workspace && resolveWorkspaceRelativeFilePath(workspace.cwd, props.filePath)) ??
    props.filePath;

  // Answers are tappable only in a thread, whose draft is the truth for which are answered.
  const answersTarget =
    workspace?.threadId != null ? scopedThreadKey(props.environmentId, workspace.threadId) : null;
  const draft = useComposerDraft(answersTarget);
  const chips = new Set(collectComposerContextReferences(draft.text).map((ref) => ref.contextId));
  const present = (draft.context?.records ?? []).flatMap((record) =>
    record.kind === "review-comment" &&
    "mdxAnchor" in record &&
    record.mdxAnchor !== undefined &&
    record.filePath === documentPath &&
    chips.has(record.contextId)
      ? [record.contextId]
      : [],
  );
  const presentKey = present.join("\n");

  const deliver = (message: DocumentViewerAppMessage) =>
    webView.current?.injectJavaScript(documentViewerAppMessageScript(message));
  const sendInit = () =>
    deliver({
      type: "init",
      protocol: DOCUMENT_VIEWER_PROTOCOL,
      token: token.current,
      source: props.source,
      filePath: documentPath,
      baseDir,
      ...(workspace ? { cwd: workspace.cwd } : {}),
      appearance: themeAppearance,
      ...(answersTarget === null ? {} : { answers: { draftTarget: answersTarget, present } }),
    });

  const clearReadyTimer = () => {
    if (readyTimer.current !== null) clearTimeout(readyTimer.current);
    readyTimer.current = null;
  };
  const restart = () => {
    clearReadyTimer();
    token.current = uuidv4();
    answered.current = false;
    sentPresent.current = null;
    setState("loading");
    setGeneration((value) => value + 1);
  };

  // A new text (Refresh, a file that changed) or theme goes to the page already showing.
  const sentInit = useRef<{ source: string; appearance: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes a changed document or theme into the WebView, a native view outside React
  useEffect(() => {
    const sent = sentInit.current;
    if (sent === null || (sent.source === props.source && sent.appearance === themeAppearance))
      return;
    sentInit.current = { source: props.source, appearance: themeAppearance };
    sendInit();
  });
  // The thread's draft changed (an answer joined it, its chip was removed): the page re-reads it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the page in the WebView, a native view outside React, which answers the draft holds
  useEffect(() => {
    if (sentPresent.current === null || sentPresent.current === presentKey) return;
    sentPresent.current = presentKey;
    deliver({ type: "answers-present", present });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending ready timeout when the view goes away
  useEffect(
    () => () => {
      if (readyTimer.current !== null) clearTimeout(readyTimer.current);
    },
    [],
  );

  const openLink = (href: string) => {
    const threadId = workspace?.threadId ?? undefined;
    const media = resolveMarkdownMediaPreview(href, {
      environmentId: props.environmentId,
      threadId,
      workspaceRoot: baseDir,
      captured: workspace === null,
    });
    if (media && media.kind === "video") return setExpandedVideo(media.source);
    if (media && media.kind !== "file") return setExpandedFile(media.source);
    const link = resolveMarkdownLinkPresentation(href);
    if (link.kind === "file") {
      if (workspace === null) return;
      const params = {
        environmentId: String(props.environmentId),
        path: fileRoutePathSegments(resolveWorkspaceFilePath(baseDir, link.path)),
        ...(link.line ? { line: String(link.line) } : {}),
      };
      if (workspace.threadId !== null) {
        navigation.navigate("ThreadFile", { ...params, threadId: String(workspace.threadId) });
      } else {
        navigation.dispatch(StackActions.push("NewTaskFile", { ...params, cwd: workspace.cwd }));
      }
      return;
    }
    if (link.href !== null && /^(?:https?|mailto|tel):/i.test(link.href))
      void tryOpenExternalUrl(link.href, "markdown-link");
  };

  const signImage = async (id: number, path: string) => {
    const resource: AssetResource | null =
      workspace === null
        ? null
        : workspace.threadId !== null
          ? { _tag: "media-file", threadId: workspace.threadId, path }
          : { _tag: "draft-workspace-file", cwd: workspace.cwd, path };
    const url = resource === null ? null : await refreshAssetUrl(props.environmentId, resource);
    deliver({ type: "image-url", id, url });
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    const message = acceptDocumentViewerPageMessage(event.nativeEvent.data, token.current);
    if (message === null) return;
    switch (message.type) {
      case "ready":
        // Once per load: a document's own frame can post `ready` too, and need not get the text again.
        if (answered.current) return;
        answered.current = true;
        clearReadyTimer();
        setState("ready");
        sentInit.current = { source: props.source, appearance: themeAppearance };
        sentPresent.current = presentKey;
        sendInit();
        return;
      case "rendered":
        setState(message.ok ? "rendered" : "compile-error");
        return;
      case "link":
        openLink(message.href);
        return;
      case "image-request":
        void signImage(message.id, message.path);
        return;
      case "comment-upsert": {
        const { record } = message;
        // The page shows a tapped answer at once; one the draft did not take is reported back.
        if (
          answersTarget === null ||
          record.mdxAnchor === undefined ||
          record.filePath !== documentPath
        ) {
          deliver({ type: "answers-present", present });
        } else if (!upsertComposerDraftContextRecord(answersTarget, record)) {
          Dialog.alert(
            "Too many context items",
            "Remove some context from the draft and try again.",
          );
          deliver({ type: "answers-present", present });
        }
        return;
      }
      case "comment-remove":
        if (answersTarget !== null && present.includes(message.contextId))
          removeComposerDraftContextRecord(answersTarget, message.contextId);
        else deliver({ type: "answers-present", present });
        return;
    }
  };

  if (viewerUrl === null || state === "unavailable") {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState
          title="Document view unavailable"
          detail={
            viewerUrl === null
              ? "Connect to this environment to view the document."
              : "The document view did not load from the server."
          }
          action={
            <View className="flex-row gap-2">
              {viewerUrl === null ? null : (
                <Button tone="primary" label="Try again" onPress={restart} />
              )}
              <Button label="View source" onPress={props.onViewSource} />
            </View>
          }
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      {state === "compile-error" ? (
        <View className="flex-row items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
          <Text className="flex-1 text-xs text-foreground-muted">
            This document could not be drawn.
          </Text>
          <Button label="View source" onPress={props.onViewSource} />
        </View>
      ) : null}
      <WebView<object>
        key={generation}
        ref={webView}
        source={{ uri: viewerUrl }}
        // Hidden until the viewer answers, so a server without it never shows its app shell here.
        style={{ flex: 1, backgroundColor: "transparent", opacity: state === "loading" ? 0 : 1 }}
        // Starts the page below a translucent iOS bar, as the file screen's other web previews do.
        contentInsetAdjustmentBehavior="automatic"
        originWhitelist={["*"]}
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
        // Sub-frames are a document's own <Prototype> and <HtmlBlock>; the page never leaves.
        onShouldStartLoadWithRequest={(request) =>
          request.isTopFrame === false ||
          withoutFragment(request.url) === withoutFragment(viewerUrl)
        }
        onMessage={handleMessage}
        onLoadEnd={() => {
          if (answered.current || readyTimer.current !== null) return;
          readyTimer.current = setTimeout(() => {
            readyTimer.current = null;
            if (!answered.current) setState("unavailable");
          }, READY_TIMEOUT_MS);
        }}
        onError={() => setState("unavailable")}
        onHttpError={() => setState("unavailable")}
        // Android kills a backgrounded app's renderer; the view would otherwise stay blank.
        onRenderProcessGone={restart}
        onContentProcessDidTerminate={restart}
      />
      {state === "rendered" || state === "compile-error" ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
      {workspace?.threadId && present.length > 0 ? (
        <View
          className="flex-row items-center justify-between gap-3 border-t border-border bg-card px-4 pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <Text className="flex-1 text-sm text-foreground">
            {present.length === 1 ? "1 answer" : `${present.length} answers`} ready to send
          </Text>
          <Button
            tone="primary"
            label="Back to chat"
            onPress={() =>
              navigation.dispatch(
                StackActions.popTo("Thread", {
                  environmentId: String(props.environmentId),
                  threadId: String(workspace.threadId),
                }),
              )
            }
          />
        </View>
      ) : null}
      <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
      <VideoPreviewModal source={expandedVideo} onRequestClose={() => setExpandedVideo(null)} />
    </View>
  );
}
