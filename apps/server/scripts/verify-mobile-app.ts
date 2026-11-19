// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off globalDateInEffect:off globalJsonInEffect:off - Host-side verifier that plays the phone against a running server.
/**
 * Plays the phone against a running server (plans/mobile-self-hosted-updates/plan.mdx §9). Usage:
 * `node apps/server/scripts/verify-mobile-app.ts --origin http://127.0.0.1:<port> --token <pairing>
 * [--state <stateDir>/mobile-app.json] [--wait-for <sha>] [--timeout 120]`.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  LoomMobileAppFile,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const { values } = NodeUtil.parseArgs({
  options: {
    origin: { type: "string" },
    token: { type: "string" },
    state: { type: "string" },
    "wait-for": { type: "string" },
    timeout: { type: "string", default: "120" },
  },
});
NodeAssert.ok(values.origin && values.token, "--origin and --token (a pairing token) are required");
const origin = values.origin.replace(/\/$/, "");
const timeoutMs = Number(values.timeout) * 1000;

const step = (name: string, detail: unknown = "") =>
  console.log(`ok  ${name}${detail === "" ? "" : `  ${JSON.stringify(detail)}`}`);

const exchanged = await fetch(`${origin}/oauth/token`, {
  method: "POST",
  body: new URLSearchParams({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: values.token,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
  }),
});
if (!exchanged.ok) throw new Error(`pairing failed: ${exchanged.status} ${await exchanged.text()}`);
const { access_token } = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
  await exchanged.json(),
);
const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${access_token}`,
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  },
});
NodeAssert.ok(ticketResponse.ok, `websocket ticket failed: ${ticketResponse.status}`);
const { ticket } = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
  await ticketResponse.json(),
);
step("paired and opened the socket");

const decodeStored = Schema.decodeSync(Schema.fromJsonString(LoomMobileAppFile));
// Read when a download is compared, since a build may publish while the script waits.
const stored = () =>
  values.state === undefined ? null : decodeStored(NodeFS.readFileSync(values.state, "utf8"));

const fetchApk = async (relativeUrl: string) => {
  const response = await fetch(`${origin}${relativeUrl}`);
  const bytes = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  return { response, bytes };
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const waitFor = values["wait-for"];
  const seen: Array<unknown> = [];
  const state = yield* client["loom.subscribeMobileApp"]({}).pipe(
    Stream.tap((value) => Effect.sync(() => seen.push(value))),
    Stream.filter((value) => waitFor === undefined || value.current === waitFor),
    Stream.runHead,
    Effect.map(Option.getOrNull),
  );
  NodeAssert.ok(state !== null, "the stream ended without a state");
  step(`stream values seen (${seen.length})`, seen);

  for (const apk of state.apks) {
    const link = yield* client["loom.mobileApkUrl"]({ sha: apk.sha });
    const { response, bytes } = yield* Effect.promise(() => fetchApk(link.relativeUrl));
    NodeAssert.equal(response.status, 200, `download of ${apk.sha} answered ${response.status}`);
    NodeAssert.ok(bytes);
    NodeAssert.equal(
      response.headers.get("content-type"),
      "application/vnd.android.package-archive",
    );
    NodeAssert.equal(Number(response.headers.get("content-length")), bytes.length);
    NodeAssert.equal(bytes.length, apk.bytes, "downloaded length differs from the state's bytes");
    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const file = stored()?.apks.find((entry) => entry.sha === apk.sha)?.file;
    if (file !== undefined) {
      const expected = NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(file))
        .digest("hex");
      NodeAssert.equal(sha256, expected, `download of ${apk.sha} differs from ${file}`);
    }
    step(`downloaded ${apk.sha.slice(0, 7)} with no credentials`, {
      url: link.relativeUrl.replace(/\/[^/]+\/([^/]+)$/, "/<token>/$1"),
      expiresInSeconds: Math.round((link.expiresAt - Date.now()) / 1000),
      bytes: bytes.length,
      sha256,
      comparedWith: file ?? null,
    });

    const [route, token, name] = [
      link.relativeUrl.split("/").slice(0, -2).join("/"),
      link.relativeUrl.split("/").at(-2)!,
      link.relativeUrl.split("/").at(-1)!,
    ];
    const [payload, signature] = token.split(".");
    const tampered = [
      `${payload}.${signature!.slice(0, -2)}AA`,
      `${Buffer.from(JSON.stringify({ kind: "loom-mobile-apk", sha: apk.sha, expiresAt: 9e15 })).toString("base64url")}.${signature}`,
      "garbage",
    ];
    for (const forged of tampered) {
      const { response: refused } = yield* Effect.promise(() =>
        fetchApk(`${route}/${forged}/${name}`),
      );
      NodeAssert.equal(refused.status, 404, `a forged token answered ${refused.status}`);
    }
    step(`refused ${tampered.length} forged tokens for ${apk.sha.slice(0, 7)} with 404`);
  }

  const unknown = yield* client["loom.mobileApkUrl"]({ sha: "0".repeat(40) }).pipe(Effect.flip);
  step("refused a link for an unknown sha", { error: unknown._tag, message: unknown.message });
  return state;
});

const layerProtocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(
      `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
    ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  ),
  Layer.provide(RpcSerialization.layerJson),
);

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(layerProtocol), Effect.timeout(timeoutMs)),
);
console.log("PASS");
process.exit(0);
