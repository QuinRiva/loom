/**
 * A fake CLIProxyAPI hub (five pooled Claude accounts) so the in-app hub login runs without a real
 * sign-in. Callback code `login:<email>` logs that account in 2s later; any other code fails.
 * `POST /fake/account {email, ...}` edits an account. Run `vp run dev:fake-hub [--port 18417]` and
 * point a scratch instance's `usageLimitSources` at it with `"managementKey": "fake"`.
 */
// Dev-only fixture tooling (not shipped): plain node http, Date and JSON keep it legible.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface FakeAccount {
  email: string;
  deviceId: string;
  lastRefresh: number;
  createdAt: number;
  modtime: number;
  status: string;
  statusMessage: string;
  token: boolean;
  five: number;
  week: number;
}

interface Session {
  readonly completeAt: number;
  readonly email: string | null;
}

export interface FakeHubResponse {
  readonly status: number;
  readonly body: unknown;
}

const fileName = (account: FakeAccount) =>
  account.token ? `claude-token-${account.email}.json` : `claude-a42236a2-${account.email}.json`;

/** A hub over `emails`, each last refreshed an hour ago on a login made long before. */
export function makeFakeHub(
  emails: ReadonlyArray<string> = [
    "caaarl@unseen.id",
    "carl@unseen.id",
    "carl3@unseen.id",
    "carl4@unseen.id",
    "jacob@unseen.id",
  ],
  now: () => number = Date.now,
) {
  const start = now();
  const accounts = new Map(
    emails.map((email, index): [string, FakeAccount] => [
      email,
      {
        email,
        deviceId: `fake-device-${email}`,
        lastRefresh: start - HOUR,
        createdAt: start - 10 * DAY,
        modtime: start - HOUR,
        status: "active",
        statusMessage: "",
        token: false,
        five: 10 + index * 15,
        week: 30 + index * 10,
      },
    ]),
  );
  const sessions = new Map<string, Session>();
  const list = () => [...accounts.values()];
  const byName = (name: string | null) => list().find((account) => fileName(account) === name);
  const iso = (ms: number) => new Date(ms).toISOString();

  /** Apply every login whose exchange has finished by now. */
  const settle = () => {
    for (const [state, session] of sessions) {
      if (session.completeAt > now() || !session.email) continue;
      const existing = accounts.get(session.email);
      accounts.set(session.email, {
        ...(existing ?? {
          email: session.email,
          createdAt: session.completeAt,
          five: 0,
          week: 0,
        }),
        deviceId: NodeCrypto.randomBytes(32).toString("hex"),
        lastRefresh: session.completeAt,
        modtime: session.completeAt,
        status: "active",
        statusMessage: "",
        token: false,
      });
      sessions.set(state, { ...session, email: null });
    }
  };

  const handle = (method: string, url: string, body: unknown): FakeHubResponse => {
    settle();
    const { pathname, searchParams } = new URL(url, "http://fake");
    const path = pathname.replace(/^\/v0\/management\//, "");
    const input = (body ?? {}) as Record<string, unknown>;
    if (method === "GET" && path === "auth-files") {
      return {
        status: 200,
        body: {
          files: list().map((account, index) => ({
            id: fileName(account),
            name: fileName(account),
            auth_index: String(index),
            provider: "claude",
            email: account.email,
            status: account.status,
            status_message: account.statusMessage,
            disabled: false,
            created_at: iso(account.createdAt),
            modtime: iso(account.modtime),
            ...(account.token
              ? {
                  // A token seat's usage comes only from the hub's traffic headers.
                  model_quotas: {
                    "claude-opus-5-5": {
                      observed_at: iso(now() - 4 * 60_000),
                      signals: {
                        "Anthropic-Ratelimit-Unified-5h-Utilization": String(account.five / 100),
                        "Anthropic-Ratelimit-Unified-5h-Reset": String(
                          Math.round((now() + 2 * HOUR) / 1000),
                        ),
                        "Anthropic-Ratelimit-Unified-7d-Utilization": String(account.week / 100),
                        "Anthropic-Ratelimit-Unified-7d-Reset": String(
                          Math.round((now() + 3 * DAY) / 1000),
                        ),
                      },
                    },
                  },
                }
              : { last_refresh: iso(account.lastRefresh) }),
          })),
        },
      };
    }
    if (method === "GET" && path === "auth-files/download") {
      const account = byName(searchParams.get("name"));
      if (!account) return { status: 404, body: { error: "file not found" } };
      return {
        status: 200,
        body: {
          type: "claude",
          email: account.email,
          access_token: `fake-access-${account.deviceId}`,
          claude_device_ids: [account.deviceId],
          ...(account.token
            ? { is_setup_token: true, expired: iso(account.modtime + 365 * DAY) }
            : {
                refresh_token: `fake-refresh-${account.deviceId}`,
                last_refresh: iso(account.lastRefresh),
                expired: iso(account.lastRefresh + 8 * HOUR),
              }),
        },
      };
    }
    if (method === "POST" && path === "api-call") {
      const account = list()[Number(input.auth_index)];
      if (!account || account.status !== "active")
        return { status: 200, body: { status_code: 401, body: "{}" } };
      // A setup token cannot read the usage endpoint (the known follow-up).
      if (account.token) return { status: 200, body: { status_code: 403, body: "{}" } };
      return {
        status: 200,
        body: {
          status_code: 200,
          body: JSON.stringify({
            five_hour: { utilization: account.five, resets_at: iso(now() + 2 * HOUR) },
            seven_day: { utilization: account.week, resets_at: iso(now() + 3 * DAY) },
          }),
        },
      };
    }
    if (method === "GET" && path === "anthropic-auth-url") {
      const state = NodeCrypto.randomBytes(16).toString("hex");
      sessions.set(state, { completeAt: Number.POSITIVE_INFINITY, email: null });
      return {
        status: 200,
        body: {
          status: "ok",
          url: `https://claude.ai/oauth/authorize?code=true&client_id=fake&state=${state}`,
          state,
        },
      };
    }
    if (method === "POST" && path === "oauth-callback") {
      const redirect =
        typeof input.redirect_url === "string" ? new URL(input.redirect_url).searchParams : null;
      const state = String(input.state ?? redirect?.get("state") ?? "");
      const code = String(input.code ?? redirect?.get("code") ?? "").split("#")[0]!;
      if (!state) return { status: 400, body: { status: "error", error: "state is required" } };
      const session = sessions.get(state);
      if (!session)
        return { status: 404, body: { status: "error", error: "unknown or expired state" } };
      if (session.completeAt !== Number.POSITIVE_INFINITY)
        return { status: 409, body: { status: "error", error: "oauth flow is already completed" } };
      const email = code.startsWith("login:") ? code.slice("login:".length) : null;
      sessions.set(state, { completeAt: now() + 2_000, email: email ?? "" });
      return { status: 200, body: { status: "ok" } };
    }
    if (method === "GET" && path === "get-auth-status") {
      const session = sessions.get(searchParams.get("state") ?? "");
      if (!session)
        return { status: 200, body: { status: "error", error: "unknown or expired state" } };
      if (session.completeAt > now()) return { status: 200, body: { status: "wait" } };
      return session.email === ""
        ? {
            status: 200,
            body: { status: "error", error: "Failed to exchange authorization code for tokens" },
          }
        : { status: 200, body: { status: "ok" } };
    }
    if (method === "POST" && pathname === "/fake/account") {
      const account = accounts.get(String(input.email));
      if (!account) return { status: 404, body: { error: "no such account" } };
      const { lastRefreshHoursAgo, status_message, ...rest } = input;
      Object.assign(account, rest, {
        ...(typeof status_message === "string" ? { statusMessage: status_message } : {}),
        ...(typeof lastRefreshHoursAgo === "number"
          ? { lastRefresh: now() - lastRefreshHoursAgo * HOUR }
          : {}),
        modtime: now(),
      });
      return { status: 200, body: account };
    }
    return { status: 404, body: { error: "not found" } };
  };

  return { handle };
}

if (import.meta.main) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag === -1 ? 18417 : Number(process.argv[portFlag + 1]);
  const hub = makeFakeHub();
  NodeHttp.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const result = hub.handle(
        request.method ?? "GET",
        request.url ?? "/",
        raw ? JSON.parse(raw) : {},
      );
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  }).listen(port, "127.0.0.1", () => console.log(`fake cliproxy hub on http://127.0.0.1:${port}`));
}
