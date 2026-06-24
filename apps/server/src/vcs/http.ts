/**
 * Generic VCS HTTP routes for the web client.
 *
 * `GET /api/vcs/diff` returns `git diff` output for an arbitrary working
 * directory. This is pure source-control plumbing (consumed by the diff
 * viewer) and has nothing to do with goals.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const vcsRouteLayer = HttpRouter.add(
  "GET",
  "/api/vcs/diff",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const cwd = url.value.searchParams.get("cwd");
    if (!cwd) return HttpServerResponse.text("cwd is required.", { status: 400 });
    const args = ["diff", "--no-ext-diff", "--no-color"];
    if (url.value.searchParams.get("ignoreWhitespace") === "1") args.push("--ignore-all-space");
    return HttpServerResponse.text(execFileSync("git", args, { cwd, encoding: "utf8" }));
  }),
);
