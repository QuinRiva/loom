import {
  DOCUMENT_VIEWER_PROTOCOL,
  type DocumentViewerInit,
  type DocumentViewerPageMessage,
  readDocumentViewerAppMessage,
} from "@t3tools/shared/documentViewerBridge.loom";
import { useEffect, useState } from "react";

import { MdxPlanRenderer } from "~/components/files/mdx-plan/MdxPlanRenderer";
import { PlanDocumentContext } from "~/components/files/mdx-plan/planDocument";
import { setAppearanceMode } from "~/hooks/useTheme";

/**
 * loom: the mobile app's document viewer. The app loads this page in its WebView and hands it
 * the document over the bridge; the page holds no credential and fetches nothing private. It
 * renders what web's file preview renders for an `.mdx`, without the annotation layer.
 */

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (data: string) => void };
  }
}

type TokenedMessage = Exclude<DocumentViewerPageMessage, { type: "ready" }>;

const ANSWERABLE_BLOCKS = ["question-form", "visual-questions", "review-choice"]
  .map((type) => `[data-plan-block-type="${type}"]`)
  .join(", ");

const post = (message: DocumentViewerPageMessage) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));

// One page load is one viewer, so the bridge state lives with the page.
let token: string | null = null;
let imageRequestCounter = 0;
const pendingImages = new Map<number, (url: string | null) => void>();

const send = (message: DistributiveOmit<TokenedMessage, "token">) => {
  if (token !== null) post({ ...message, token } as TokenedMessage);
};
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const resolveImageUrl = (path: string) =>
  new Promise<string | null>((resolve) => {
    if (token === null) return resolve(null);
    const id = ++imageRequestCounter;
    pendingImages.set(id, resolve);
    send({ type: "image-request", id, path });
  });

// Every link leaves the page through the app; an in-page `#anchor` stays a jump.
const interceptLink = (event: MouseEvent) => {
  const anchor = event
    .composedPath()
    .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
  const href = anchor?.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  event.preventDefault();
  send({ type: "link", href });
};

export function DocumentViewerApp() {
  const [init, setInit] = useState<DocumentViewerInit | null>(null);
  const [answerable, setAnswerable] = useState(false);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the bridge to the host app is a window message channel outside React
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the app's injected `window.postMessage`; a document's own frames post as themselves.
      if (event.source !== window) return;
      const message = readDocumentViewerAppMessage(event.data);
      if (message?.type === "init") {
        token = message.token;
        setAppearanceMode(message.appearance);
        setInit(message);
      } else if (message?.type === "image-url") {
        pendingImages.get(message.id)?.(message.url);
        pendingImages.delete(message.id);
      }
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("click", interceptLink, true);
    post({ type: "ready", protocol: DOCUMENT_VIEWER_PROTOCOL });
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("click", interceptLink, true);
    };
  }, []);

  if (init === null) return null;
  return (
    // The phone is the whole viewport, so wide blocks bleed to it (as `lint-plan.mjs` does).
    <div
      ref={setFrame}
      className="min-h-dvh w-full min-w-0 bg-background text-foreground [--timeline-available-width:100vw]"
    >
      {answerable ? (
        <p className="mx-auto max-w-4xl px-6 pt-4 text-xs text-muted-foreground">
          Questions here are answered by replying in chat.
        </p>
      ) : null}
      <PlanDocumentContext.Provider
        value={{ baseDir: init.baseDir, cwd: init.cwd, resolveImageUrl }}
      >
        <MdxPlanRenderer
          source={init.source}
          onSettled={(error) => {
            setAnswerable(error === null && frame?.querySelector(ANSWERABLE_BLOCKS) != null);
            send(
              error === null
                ? { type: "rendered", ok: true }
                : { type: "rendered", ok: false, error },
            );
          }}
        />
      </PlanDocumentContext.Provider>
    </div>
  );
}
