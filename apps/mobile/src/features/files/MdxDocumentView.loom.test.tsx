import { RegistryContext } from "@effect/atom-react";
import type { DocumentQueryAuthorResult } from "@t3tools/contracts";
import { ComposerContextId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { DocumentViewerAppMessage } from "@t3tools/shared/documentViewerBridge.loom";
import { Atom } from "effect/reactivity";
import { act, forwardRef, type ReactNode, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

// The phone's side of a document's answers: which draft they join, decided by the author lookup.
const harness = vi.hoisted(() => ({
  injected: [] as string[],
  onMessage: null as ((event: { nativeEvent: { data: string } }) => void) | null,
  lookup: null as ((result: unknown) => void) | null,
  dispatched: [] as unknown[],
}));

vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    exists = false;
    create() {}
    write() {}
    async text() {
      return JSON.stringify({ schemaVersion: 1, drafts: {} });
    }
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "0123456789abcdef0123" }));
vi.mock("react-native", () => ({
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native-webview", () => ({
  WebView: forwardRef(
    (props: { readonly onMessage: typeof harness.onMessage }, ref: React.Ref<unknown>) => {
      // Re-run each render, so the test posts through the view's latest handler.
      useImperativeHandle(ref, () => {
        harness.onMessage = props.onMessage;
        return { injectJavaScript: (script: string) => harness.injected.push(script) };
      });
      return null;
    },
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: (action: unknown) => harness.dispatched.push(action) }),
  StackActions: {
    popTo: (name: string, params: object) => ({ type: "POP_TO", name, params }),
    replace: (name: string, params: object) => ({ type: "REPLACE", name, params }),
    push: (name: string, params: object) => ({ type: "PUSH", name, params }),
  },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <p>{props.children}</p>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { readonly label: string; readonly onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../lib/markdownMedia", () => ({ resolveMarkdownMediaPreview: () => null }));
vi.mock("../../lib/markdownLinks", () => ({ resolveMarkdownLinkPresentation: () => null }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../../state/assets", () => ({ assetEnvironment: {}, refreshAssetUrl: vi.fn() }));
vi.mock("../../state/attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("../../state/session", () => ({
  environmentSession: {},
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "http://server/" } }),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => ({ title: "Orchestrator" }) }));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => Atom.make(null) },
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("@t3tools/client-runtime/state/loom/goalCommands", () => ({
  createLoomCommandAtoms: () => ({ documentQueryAuthor: (target: unknown) => target }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeAtomQuery: () =>
    new Promise((resolve) => {
      harness.lookup = resolve;
    }),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { composerDraftsAtom, getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { MdxDocumentView } from "./MdxDocumentView.loom";

const environmentId = EnvironmentId.make("env");
const DOC = "plans/x/intent.mdx";
const viewerKey = "env:orchestrator";
const authorKey = "env:planner";

const signed: DocumentQueryAuthorResult = {
  authorThreadId: ThreadId.make("planner"),
  authorTitle: "Planner: intent brief",
  authorSource: "signature",
  filePath: DOC,
  authoringSignature: true,
  authorArchived: false,
  sameFile: true,
  laterEditors: [],
};

const sentInits = () =>
  harness.injected
    .map((script) =>
      JSON.parse(script.slice("window.postMessage(".length, script.lastIndexOf(", window"))),
    )
    .filter((message: DocumentViewerAppMessage) => message.type === "init") as Extract<
    DocumentViewerAppMessage,
    { type: "init" }
  >[];

async function open() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(harness, { injected: [], onMessage: null, lookup: null, dispatched: [] });
  appAtomRegistry.set(composerDraftsAtom, {});
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MdxDocumentView
          environmentId={environmentId}
          source="# Brief"
          filePath={DOC}
          workspace={{ cwd: "/repo", threadId: ThreadId.make("orchestrator") }}
          onViewSource={() => {}}
        />
      </RegistryContext.Provider>,
    ),
  );
  const page = (message: object) =>
    act(() => harness.onMessage!({ nativeEvent: { data: JSON.stringify(message) } }));
  const token = () => sentInits()[0]!.token;
  const answer = (id: string) =>
    page({
      type: "comment-upsert",
      token: token(),
      record: {
        version: 1,
        kind: "review-comment",
        contextId: ComposerContextId.make(`review-comment_mdx-question-${id}`),
        label: `intent.mdx answer: ${id}`,
        sectionId: `file:${DOC}`,
        sectionTitle: "intent.mdx",
        filePath: DOC,
        startIndex: 0,
        endIndex: 0,
        rangeLabel: `answer: ${id}`,
        text: `Q → chose ${id}`,
        diff: "",
        mdxAnchor: {
          anchor: { anchorKind: "visual", targetKind: "control", blockType: "question-form" },
          quotedText: "Q",
        },
      },
    });
  return { container, page, answer, token };
}

const records = (key: string) => getComposerDraftSnapshot(key).context?.records ?? [];

it("draws at once, takes answers only once the lookup names the author, and opens the author's chat", async () => {
  const view = await open();
  await view.page({ type: "ready", protocol: 1 });
  expect(sentInits()).toHaveLength(1);
  expect(sentInits()[0]!.answers).toBeUndefined();
  // A tap the page should not have offered lands in no draft.
  await view.answer("early");
  expect(records(viewerKey)).toEqual([]);

  await act(async () => harness.lookup!({ _tag: "Success", value: signed }));
  expect(sentInits().at(-1)!.answers).toEqual({ draftTarget: authorKey, present: [] });
  await view.answer("a");
  await view.answer("b");
  expect(records(authorKey)).toHaveLength(2);
  expect(records(viewerKey)).toEqual([]);
  expect(view.container.textContent).toContain("2 answers ready to send to Planner: intent brief");

  await act(async () => view.container.querySelector("button")!.click());
  expect(harness.dispatched).toEqual([
    { type: "REPLACE", name: "Thread", params: { environmentId: "env", threadId: "planner" } },
  ]);
});

it("sends answers to the thread it was opened in when the lookup fails, and says so", async () => {
  const view = await open();
  await act(async () => harness.lookup!({ _tag: "Failure" }));
  await view.page({ type: "ready", protocol: 1 });
  expect(sentInits()[0]!.answers).toEqual({ draftTarget: viewerKey, present: [] });
  await view.answer("a");
  expect(records(viewerKey)).toHaveLength(1);
  expect(view.container.textContent).toContain("1 answer ready to send to Orchestrator");
  await act(async () => view.container.querySelector("button")!.click());
  expect(harness.dispatched).toEqual([
    { type: "POP_TO", name: "Thread", params: { environmentId: "env", threadId: "orchestrator" } },
  ]);
});
