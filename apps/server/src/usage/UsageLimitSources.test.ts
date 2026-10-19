import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import { makeFakeHub } from "../dev/fakeCliproxy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-limit-sources-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ]),
    Effect.scoped,
  ),
);

// loom: the hub login record and the in-app login, against the committed fake hub.
it.effect("records a login made through the dialog and moves that account's schedule", () => {
  let hubNow = Date.parse("2026-10-19T03:00:00Z");
  const hub = makeFakeHub(["caaarl@unseen.id", "carl@unseen.id"], () => hubNow);
  return Effect.gen(function* () {
    yield* TestClock.setTime(hubNow);
    const sources = yield* UsageLimitSources.UsageLimitSources;
    yield* sources.refresh;
    const relogins = Effect.map(sources.current, ([source]) =>
      Object.fromEntries(
        source!.accounts.map((account) => [account.email, account.login?.relogin]),
      ),
    );
    // First sight of a login made long ago: no date, so it is asked for now.
    const before = yield* relogins;
    expect(before["caaarl@unseen.id"]).toMatchObject({ phase: "due", kind: "login" });
    expect(before["caaarl@unseen.id"]?.mayExpireAt).toBeUndefined();

    const sourceId = UsageLimitSourceId.make("fake");
    const { url, state } = yield* sources.loginStart({ sourceId });
    expect(url).toContain(state);
    const finish = yield* sources
      .loginFinish({ sourceId, state, pasted: `login:caaarl@unseen.id#${state}` })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    hubNow += 2_000;
    yield* TestClock.adjust("2 seconds");
    expect(yield* Fiber.join(finish)).toEqual({ loggedIn: "caaarl@unseen.id" });

    const after = yield* relogins;
    expect(after["caaarl@unseen.id"]).toMatchObject({
      phase: "later",
      loggedInAt: isoOf(hubNow),
      mayExpireAt: isoOf(hubNow + 27 * 86_400_000),
    });
    expect(after["carl@unseen.id"]?.phase).toBe("due");
    // Persisted by email, with no token in it.
    const path = (yield* Path.Path).join((yield* ServerConfig).stateDir, "hub-logins.json");
    const saved = yield* (yield* FileSystem.FileSystem).readFileString(path);
    expect(JSON.parse(saved)["caaarl@unseen.id"].loggedInAt).toBe(isoOf(hubNow));
    expect(saved).not.toContain("fake-access");
    expect(saved).not.toContain("fake-refresh");

    // A code the hub cannot exchange fails with the hub's own words.
    const retry = yield* sources.loginStart({ sourceId });
    const failed = yield* sources
      .loginFinish({ sourceId, state: retry.state, pasted: "not-a-code" })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    hubNow += 2_000;
    yield* TestClock.adjust("2 seconds");
    expect((yield* Fiber.join(failed)).detail).toContain("Failed to exchange");
  }).pipe(
    Effect.provide(
      UsageLimitSources.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.layerTest({
              usageLimitSources: {
                [UsageLimitSourceId.make("fake")]: {
                  kind: "cliproxy",
                  url: "http://hub.test",
                  managementKey: "fake",
                  enabled: true,
                },
              },
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  const body =
                    request.body._tag === "Uint8Array"
                      ? JSON.parse(new TextDecoder().decode(request.body.body))
                      : undefined;
                  const reply = hub.handle(request.method, request.url, body);
                  return HttpClientResponse.fromWeb(
                    request,
                    Response.json(reply.body, { status: reply.status }),
                  );
                }),
              ),
            ),
            NodeCrypto.layer,
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-login-" }),
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    ),
    Effect.scoped,
  );
});

it("reads the three paste shapes claude.ai's sign-in leaves", () => {
  expect(
    UsageLimitSources.oauthCallbackBody(
      "http://localhost:54545/callback?code=abc&state=s1",
      "fallback",
    ),
  ).toEqual({ redirect_url: "http://localhost:54545/callback?code=abc&state=s1" });
  expect(UsageLimitSources.oauthCallbackBody("'abc#s1'", "fallback")).toEqual({
    code: "abc",
    state: "s1",
  });
  expect(UsageLimitSources.oauthCallbackBody("abc&state=s1", "fallback")).toEqual({
    code: "abc",
    state: "s1",
  });
  expect(UsageLimitSources.oauthCallbackBody("abc", "fallback")).toEqual({
    code: "abc",
    state: "fallback",
  });
});
