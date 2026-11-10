import "~/index.css";
import "./documentViewer.css";

import type {
  DocumentViewerAppMessage,
  DocumentViewerPageMessage,
} from "@t3tools/shared/documentViewerBridge.loom";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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
    init: (source: string, baseDir = "/repo/plans/doc") =>
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
