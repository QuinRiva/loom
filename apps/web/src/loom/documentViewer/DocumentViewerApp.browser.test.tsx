import "~/index.css";
import "./documentViewer.css";

import {
  EnvironmentId,
  OrchestrationMessageContext,
  type ReviewCommentContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import type {
  DocumentViewerAppMessage,
  DocumentViewerPageMessage,
} from "@t3tools/shared/documentViewerBridge.loom";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { MdxPlanAnnotationLayer } from "~/components/files/mdx-plan/annotation/MdxPlanAnnotationLayer";
import { useComposerDraftStore } from "~/composerDraftStore";
import { buildMessageContext } from "~/lib/composerContextRecords";

import openPrIntent from "../../../../../plans/open-pr-keeps-thread-active/intent.mdx?raw";
import sqlitePlan from "../../../../../plans/sqlite-read-lane-v2/plan.mdx?raw";
import { render } from "../../../test/render";
import { DocumentViewerApp } from "./DocumentViewerApp";

const TOKEN = "test-token-0123456789";

/** Plays the mobile app's side of the bridge: what the page posts, and `init` as the app sends it. */
function installApp() {
  const received: DocumentViewerPageMessage[] = [];
  window.ReactNativeWebView = { postMessage: (data) => received.push(JSON.parse(data)) };
  return {
    received,
    send: (message: DocumentViewerAppMessage) => window.postMessage(message, "*"),
    init: (
      source: string,
      baseDir = "/repo/plans/doc",
      extra: Partial<Extract<DocumentViewerAppMessage, { type: "init" }>> = {},
    ) =>
      window.postMessage(
        {
          type: "init",
          protocol: 1,
          token: TOKEN,
          source,
          filePath: "plans/doc/plan.mdx",
          baseDir,
          cwd: "/repo",
          appearance: "dark",
          ...extra,
        } satisfies DocumentViewerAppMessage,
        "*",
      ),
    [Symbol.dispose]: () => {
      delete window.ReactNativeWebView;
    },
  };
}

const openViewer = async () => {
  const app = installApp();
  // The viewer is a page of its own with no router.
  const screen = await render(<DocumentViewerApp />, { router: false });
  await vi.waitFor(() => expect(app.received).toContainEqual({ type: "ready", protocol: 1 }));
  return { app, screen };
};

describe("document viewer page", () => {
  it("draws a real plan at phone width with no sideways page scroll", async () => {
    await page.viewport(390, 844);
    const { app, screen } = await openViewer();
    using _app = app;
    await using _screen = screen;
    app.init(sqlitePlan);
    await vi.waitFor(() =>
      expect(app.received).toContainEqual({ type: "rendered", token: TOKEN, ok: true }),
    );
    const root = document.querySelector("[data-plan-root]")!;
    // The sixth table sits in a collapsed <Details>.
    await page.getByText("The full measurement table", { exact: false }).click();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-plan-block-type="table"]')).toHaveLength(6),
    );
    expect(root.querySelectorAll('[data-plan-block-type="callout"]').length).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth),
    );
    // A table too wide for the phone scrolls inside itself instead.
    const scrollers = [...root.querySelectorAll<HTMLElement>('[data-plan-block-type="table"] *')];
    expect(scrollers.some((element) => element.scrollWidth > element.clientWidth + 1)).toBe(true);
  });

  it("says a question is answered in chat, and posts links rather than following them", async () => {
    const { app, screen } = await openViewer();
    using _app = app;
    await using _screen = screen;
    app.init(`${openPrIntent}\n\nSee [the plan](../other/plan.mdx) and [below](#top).`);
    await expect
      .element(page.getByText("Questions here are answered by replying in chat."))
      .toBeVisible();
    await page.getByRole("link", { name: "the plan" }).click();
    await page.getByRole("link", { name: "below" }).click();
    expect(app.received.filter((message) => message.type === "link")).toEqual([
      { type: "link", token: TOKEN, href: "../other/plan.mdx" },
    ]);
  });

  it("asks the app to sign an image and shows what it returns", async () => {
    const { app, screen } = await openViewer();
    using _app = app;
    await using _screen = screen;
    app.init('# Shot\n\n<Image src="shots/a.png" alt="A shot" />\n');
    await vi.waitFor(() =>
      expect(app.received).toContainEqual({
        type: "image-request",
        token: TOKEN,
        id: expect.any(Number),
        path: "/repo/plans/doc/shots/a.png",
      }),
    );
    const request = app.received.find((message) => message.type === "image-request")!;
    const url = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    app.send({ type: "image-url", id: (request as { id: number }).id, url });
    await expect.element(page.getByRole("img", { name: "A shot" })).toHaveAttribute("src", url);
  });

  it("ignores a message that a frame inside the page posts", async () => {
    const { app, screen } = await openViewer();
    using _app = app;
    await using _screen = screen;
    app.init("# The real document\n\n[Out](https://example.com)\n");
    await expect.element(page.getByRole("heading", { name: "The real document" })).toBeVisible();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          type: "init",
          protocol: 1,
          token: "forged-token-0123456789",
          source: "# Forged\n",
          filePath: "x.mdx",
          baseDir: "/",
          appearance: "dark",
        },
      }),
    );
    frame.remove();
    // Had the page taken the forged init, the link would now carry the forged token.
    await page.getByRole("link", { name: "Out" }).click();
    expect(app.received.filter((message) => message.type === "link")).toEqual([
      { type: "link", token: TOKEN, href: "https://example.com" },
    ]);
    await expect.element(page.getByRole("heading", { name: "The real document" })).toBeVisible();
  });
});

const INTENT_PATH = "plans/open-pr-keeps-thread-active/intent.mdx";
const upserts = (received: DocumentViewerPageMessage[]) =>
  received.flatMap((message) => (message.type === "comment-upsert" ? [message.record] : []));
const decodeMessageContext = Schema.decodeSync(OrchestrationMessageContext);
/** What the server decodes from a sent message and hands the agent. */
const agentText = (text: string, records: ReadonlyArray<unknown>) => {
  const context = decodeMessageContext({ version: 1, records });
  return projectComposerContextForProvider({ text, records: context.records });
};

describe("document viewer answers", () => {
  it("posts a tapped answer as a review record, and its removal when cleared", async () => {
    await page.viewport(390, 844);
    const { app, screen } = await openViewer();
    using _app = app;
    await using _screen = screen;
    app.init(openPrIntent, "/repo/plans/open-pr-keeps-thread-active", {
      filePath: INTENT_PATH,
      answers: { draftTarget: "env:thread-answers-1", present: [] },
    });
    const yes = page.getByRole("radio", { name: /Yes, go/ });
    await yes.click();
    await vi.waitFor(() => expect(upserts(app.received)).toHaveLength(1));
    const [record] = upserts(app.received) as [ReviewCommentContextRecord];
    expect(record).toMatchObject({
      kind: "review-comment",
      filePath: INTENT_PATH,
      label: "intent.mdx answer: go",
      text: 'Q: Build it as the pick above? → chose: "Yes, go" (the recommended option)',
      mdxAnchor: { quotedText: "Build it as the pick above?" },
    });
    await expect.element(yes).toHaveAttribute("aria-checked", "true");
    expect(page.getByText("Questions here are answered by replying in chat.").query()).toBeNull();

    // The app confirms the chip is in the draft; tapping again clears the answer.
    app.send({ type: "answers-present", present: [record.contextId] });
    await yes.click();
    await vi.waitFor(() =>
      expect(app.received).toContainEqual({
        type: "comment-remove",
        token: TOKEN,
        contextId: record.contextId,
      }),
    );
    await expect.element(yes).toHaveAttribute("aria-checked", "false");
  });

  it("shows an answer as chosen only while the app reports its chip in the draft", async () => {
    const { app, screen } = await openViewer();
    using _app = app;
    await using _screen = screen;
    app.init(openPrIntent, "/repo/plans/open-pr-keeps-thread-active", {
      filePath: INTENT_PATH,
      answers: { draftTarget: "env:thread-answers-2", present: [] },
    });
    const yes = page.getByRole("radio", { name: /Yes, go/ });
    await yes.click();
    await vi.waitFor(() => expect(upserts(app.received)).toHaveLength(1));
    // The chip was removed in the composer: the question reads unanswered again.
    app.send({ type: "answers-present", present: [] });
    await expect.element(yes).toHaveAttribute("aria-checked", "false");
  });

  it("posts a verdict on a review item", async () => {
    const { app, screen } = await openViewer();
    using _app = app;
    await using _screen = screen;
    app.init('# Items\n\n<ReviewChoice itemId="a1" label="A-1" />\n', "/repo/plans/doc", {
      answers: { draftTarget: "env:thread-answers-3", present: [] },
    });
    await page.getByRole("button", { name: "Accept" }).click();
    await vi.waitFor(() =>
      expect(upserts(app.received)).toEqual([
        expect.objectContaining({ label: "plan.mdx review: a1", text: "Review A-1 → accept" }),
      ]),
    );
  });

  it("gives the agent the same text as web's answer to the same question", async () => {
    await page.viewport(390, 844);
    const threadRef = {
      environmentId: EnvironmentId.make("env-parity"),
      threadId: ThreadId.make("thread-parity"),
    };
    {
      await using _web = await render(
        <MdxPlanAnnotationLayer
          source={openPrIntent}
          filePath={INTENT_PATH}
          composerDraftTarget={threadRef}
        />,
        { router: false },
      );
      await page.getByRole("radio", { name: /Yes, go/ }).click();
      await vi.waitFor(() =>
        expect(
          useComposerDraftStore.getState().getComposerDraft(threadRef)?.reviewComments,
        ).toHaveLength(1),
      );
    }
    const webDraft = useComposerDraftStore.getState().getComposerDraft(threadRef)!;
    const webContext = buildMessageContext({
      terminalContexts: [],
      reviewComments: webDraft.reviewComments,
      previewAnnotations: [],
    })!;
    const web = agentText(webDraft.prompt.trim(), webContext.records);

    const { app, screen } = await openViewer();
    using _app = app;
    await using _screen = screen;
    app.init(openPrIntent, "/repo/plans/open-pr-keeps-thread-active", {
      filePath: INTENT_PATH,
      answers: { draftTarget: "env:thread-parity", present: [] },
    });
    await page.getByRole("radio", { name: /Yes, go/ }).click();
    await vi.waitFor(() => expect(upserts(app.received)).toHaveLength(1));
    // Over the bridge as JSON, then into the phone's draft as the record plus its chip token.
    const [record] = upserts(JSON.parse(JSON.stringify(app.received)));
    const phone = agentText(formatComposerContextReference(record!), [record]);

    expect(phone).toBe(web);
    expect(phone).toContain(
      'Q: Build it as the pick above? → chose: "Yes, go" (the recommended option)',
    );
  });
});
