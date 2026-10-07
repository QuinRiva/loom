// QA-ONLY. Host side of the QA unit's network boundary, run as its own small unit
// (qa_start_bridge in lib.sh). The QA unit has PrivateNetwork=yes; these are the only
// flows across it (the inner halves are socat relays in sandbox-entry.sh):
//   out: <qa>/run/cliproxy.sock → 127.0.0.1:8317 — HTTP-aware ALLOW-LIST: only POST to
//        cliproxy's inference paths is forwarded (pi's anthropic-messages client calls
//        /v1/messages); /v0/management/* and everything else is answered 403 here,
//        because a management key is reachable from QA data (old transcripts).
//   in:  127.0.0.1:13940 → <qa>/run/server.sock (server mode only), opened O_PATH|O_NOFOLLOW
//        and connected through /proc/self/fd so QA cannot swap in a symlink to a host socket.
//   usage: node relay.mjs <qa>/run <server|probe>
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

const [runDir, mode] = process.argv.slice(2);
const INFERENCE = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);
const strip = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k)));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const cliproxy = NodeHttp.createServer((req, res) => {
  // WHATWG URL resolves dot segments (including %2e) before the check, and only the
  // normalised constant path is forwarded — never the raw request target.
  const url = new URL(req.url, "http://relay.invalid");
  if (req.method !== "POST" || !INFERENCE.has(url.pathname)) {
    log("refused", req.method, req.url);
    res
      .writeHead(403, { "content-type": "text/plain" })
      .end(`qa relay: refused ${req.method} ${url.pathname}\n`);
    req.resume();
    return;
  }
  const upstream = NodeHttp.request(
    {
      host: "127.0.0.1",
      port: 8317,
      method: "POST",
      path: url.pathname + url.search,
      headers: { ...strip(req.headers), host: "127.0.0.1:8317" },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, strip(up.headers));
      up.pipe(res);
    },
  );
  upstream.on("error", (e) =>
    res.headersSent ? res.destroy() : res.writeHead(502).end(`qa relay: ${e.message}\n`),
  );
  req.pipe(upstream);
});
const cliproxySock = `${runDir}/cliproxy.sock`;
NodeFS.rmSync(cliproxySock, { force: true });
cliproxy.listen(cliproxySock, () => NodeFS.chmodSync(cliproxySock, 0o600));

if (mode === "server") {
  const O_PATH = 0o10000000;
  NodeNet.createServer((client) => {
    let fd;
    try {
      fd = NodeFS.openSync(`${runDir}/server.sock`, O_PATH | NodeFS.constants.O_NOFOLLOW);
      if (!NodeFS.fstatSync(fd).isSocket()) throw new Error("server.sock is not a socket");
    } catch (e) {
      log("inbound refused:", e.message);
      if (fd !== undefined) NodeFS.closeSync(fd);
      client.destroy();
      return;
    }
    const inner = NodeNet.connect(`/proc/self/fd/${fd}`, () => NodeFS.closeSync(fd));
    inner.on("error", () => {
      if (inner.connecting) NodeFS.closeSync(fd);
      client.destroy();
    });
    client.on("error", () => inner.destroy());
    client.pipe(inner).pipe(client);
  }).listen(13940, "127.0.0.1");
}
log(
  `relay up: ${cliproxySock} → 127.0.0.1:8317 (inference only)${mode === "server" ? "; 127.0.0.1:13940 → server.sock" : ""}`,
);
