import { expect, it, vi } from "vite-plus/test";

import sqlitePlan from "../../../../../plans/sqlite-read-lane-v2/plan.mdx?raw";
import { render } from "../../../test/render";

// The viewer runs on the server's origin with no credential; it must never start the app's
// connection runtime (environment discovery, a socket), which an import side effect can do.
it("draws a document without a single network request or socket", async () => {
  using fetchSpy = vi.spyOn(window, "fetch");
  using socketSpy = vi.spyOn(window, "WebSocket");
  const { DocumentViewerApp } = await import("./DocumentViewerApp");
  const posted: string[] = [];
  window.ReactNativeWebView = { postMessage: (data) => posted.push(data) };
  using _bridge = { [Symbol.dispose]: () => delete window.ReactNativeWebView };
  // The viewer is a page of its own with no router.
  await using _screen = await render(<DocumentViewerApp />, { router: false });
  window.postMessage(
    {
      type: "init",
      protocol: 1,
      token: "test-token-0123456789",
      source: sqlitePlan,
      filePath: "plans/sqlite-read-lane-v2/plan.mdx",
      baseDir: "/repo/plans/sqlite-read-lane-v2",
      appearance: "light",
    },
    "*",
  );
  await vi.waitFor(() => expect(posted.some((data) => data.includes('"rendered"'))).toBe(true));
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(socketSpy).not.toHaveBeenCalled();
});
