import { describe, expect, it } from "vite-plus/test";

import { acceptDocumentViewerPageMessage } from "./documentViewerBridge.loom.ts";

const token = "0123456789abcdef-token";
const accept = (message: unknown) =>
  acceptDocumentViewerPageMessage(JSON.stringify(message), token);

// A document's <Prototype> frame can reach the app's message channel on Android but never
// sees the token, so everything it can post must be dropped except a harmless `ready`.
describe("acceptDocumentViewerPageMessage", () => {
  it("takes `ready` without a token, since it precedes init", () => {
    expect(accept({ type: "ready", protocol: 1 })).toEqual({ type: "ready", protocol: 1 });
  });

  it("takes a message carrying this load's token", () => {
    expect(accept({ type: "link", token, href: "plans/x.mdx" })).toEqual({
      type: "link",
      token,
      href: "plans/x.mdx",
    });
  });

  it("drops a message with no token or another load's token", () => {
    expect(accept({ type: "link", href: "https://example.com" })).toBeNull();
    expect(
      accept({ type: "image-request", token: "another-load-token-0000", id: 1, path: "/x.png" }),
    ).toBeNull();
  });

  it("drops unknown types, malformed fields and non-JSON", () => {
    expect(accept({ type: "comment-upsert", token, record: {} })).toBeNull();
    expect(accept({ type: "image-request", token, id: "1", path: "/x.png" })).toBeNull();
    expect(acceptDocumentViewerPageMessage("not json", token)).toBeNull();
  });

  it("ignores fields it does not know, so a newer page still talks to this app", () => {
    expect(accept({ type: "rendered", token, ok: true, later: 1 })).toEqual({
      type: "rendered",
      token,
      ok: true,
    });
  });
});
