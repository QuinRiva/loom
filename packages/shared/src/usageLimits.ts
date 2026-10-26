import {
  type EnvironmentId,
  type UsageLimitsReport,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProviderSlashCommand,
  isProviderAvailable,
  type ServerProvider,
  type ServerSettings, // loom
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceId, // loom
  type UsageLimitSourceLogin,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/** A ChatGPT Business admin caps plan use in other apps; only the admin can raise it. */
export const CHATGPT_WORKSPACE_USAGE_LIMIT_CODE =
  "subscription_sharing_workplace_individual_usage_limit_exceeded";
/** OpenAI's partner guidelines fix this wording; the user sends it to their admin themselves. */
export const CHATGPT_WORKSPACE_ADMIN_REQUEST =
  "I've reached the limit for using my ChatGPT plan in T3 Code. Could you increase our workspace's usage limits so I can continue?\n\nGo to admin.openai.com → Workspace → Usage limits. Thank you!";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "Combined usage across both allowances, not a third quota.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok and Composer use this first. Auto can use either pool.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Claude, GPT, and Gemini use this pool. Grok and Composer fall back here.",
  },
] as const;

export function cursorUsageWindowDetails(id: string) {
  return CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

function providersWithLimits(providers: readonly ServerProvider[]): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers: readonly ServerProvider[];
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      // loom: the pooled usage sources, for `unlinkedUsageSources`.
      readonly settings?: Pick<ServerSettings, "providerInstances"> | undefined;
    } | null;
  }
>;

export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const links = new Map<
    string,
    {
      readonly label: string;
      readonly url: string;
      readonly message: string | undefined;
      readonly accounts: readonly string[];
    }
  >();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      if (external && provider.auth.status === "authenticated") {
        const account = `${provider.displayName ?? provider.instanceId} on ${presentation.entry.target.label}`;
        links.set(external.url, {
          ...external,
          message: provider.usageLimits?.unavailable?.message,
          accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
        });
      }
    }
  }
  return [...links.values()];
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

// Include every enabled login, even unreadable workspaces.
function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly sourceLabel: string | null;
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
  /**
   * loom: the hub's view of the account's login, from its freshest hub
   * reading; null when no hub reports it. A dead account has no windows and is
   * left out of pools.
   */
  readonly login: UsageLimitSourceLogin | null;
}

export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Prefer hub redemption to clear its routing cooldown too; displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const loser = fresher ? previous : next; // loom
    const creditSource = creditSources.get(key);
    accounts.set(key, {
      ...previous,
      displayName: previous.displayName ?? next.displayName,
      plan: previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      login: winner.login ?? loser.login, // loom: a native reading knows no login
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = accountKeyResolver(
    [...presentations.values()].flatMap((presentation) => [
      ...(presentation.serverConfig?.providers ?? [])
        .filter((provider) => provider.enabled)
        .map(nativeReport),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ]),
  );
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits || limitsNotice(provider.usageLimits) !== null) continue;
      merge(resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`, {
        key: `${environmentId}:${provider.instanceId}`,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        plan: provider.auth.label,
        accentColor: provider.accentColor,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        redeem: { environmentId, input: { instanceId: provider.instanceId } },
        limits: provider.usageLimits,
        login: null, // loom
      });
    }
  }
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        // loom: a signed-out account stays, so every view can say so.
        const dead = account.login?.status === "dead";
        if (limitsNotice(account.usageLimits) !== null && !dead) continue;
        const key = `${source.id}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(resolveKey(account) ?? key, {
          key,
          driver: account.driver,
          displayName: account.email ? null : account.id.replace(/\.json$/i, ""),
          email: account.email,
          plan: account.plan,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          limits: account.usageLimits,
          login: account.login ?? null, // loom
        });
      }
    }
  }
  return [...accounts.values()];
}

export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices: string[] = [];
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
      const notice = provider.usageLimits ? limitsNotice(provider.usageLimits) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.push(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.push(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (source.accounts.length === 0) {
        notices.push(`${label(environmentLabel, source.label)}: No accounts reported.`);
      }
    }
  }
  return notices;
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly refillPercent: number;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  readonly columns: ReadonlyArray<
    LimitPoolMember | { readonly account: LimitAccount; readonly window: null }
  >;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver === "antigravity") {
    return [...pool.windows].sort(
      (left, right) =>
        Number(!left.id.startsWith("gemini-")) - Number(!right.id.startsWith("gemini-")) ||
        left.id
          .replace(/-(5h|weekly|quota)$/, "")
          .localeCompare(right.id.replace(/-(5h|weekly|quota)$/, "")) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hasBothPools = hasAuto && hasApi;
  return pool.windows
    .filter((window) => !hasBothPools || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  // loom: a signed-out account is no capacity; the views list it on its own.
  for (const account of accounts.filter((entry) => entry.login?.status !== "dead")) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
      );
      return (
        (window ? resetMillis(poolMember(account, window, now).window) : null) ??
        Number.POSITIVE_INFINITY
      );
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

// Codex ids name slots, so pool by kind; other drivers' ids identify distinct allowances.
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolMember(account: LimitAccount, reported: ServerProviderUsageWindow, now: number) {
  const spentWeekly =
    reported.kind === "session"
      ? account.limits.windows.find(
          (window) =>
            window.usedPercent >= 100 &&
            (account.driver === "claudeAgent"
              ? window.id === "seven_day"
              : account.driver === "codex" && window.kind === "weekly"),
        )
      : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };

  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt));
  let resetsAt: string | undefined;
  let refillPercent = 0;
  // A stale or missing clock cannot tell us when blocked quota becomes usable.
  if (
    weeklyReset !== null &&
    sessionReset !== null &&
    weeklyReset > cutoff &&
    sessionReset > cutoff
  ) {
    if (sessionReset <= weeklyReset) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100;
    } else if (reported.usedPercent >= 100) {
      resetsAt = reported.resetsAt;
      refillPercent = 100;
    } else {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent));
    }
  }
  return {
    account,
    // Suppression is not session spending, so it has no session pace clock.
    window: { ...reported, usedPercent: 100, resetsAt, windowDurationMins: undefined },
    refillPercent,
  };
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const reported of account.limits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    const usedPercent = members.reduce((sum, m) => sum + m.window.usedPercent, 0) / members.length;
    // Judge pace only for windows with reset clocks; others add spend without elapsed time.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null ? [] : [{ used: m.window.usedPercent, elapsed: share }];
    });
    const timedUsed = timed.reduce((sum, t) => sum + t.used, 0) / timed.length;
    const meanElapsed =
      timed.length > 0 ? timed.reduce((sum, t) => sum + t.elapsed, 0) / timed.length : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(member.refillPercent / members.length),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

/**
 * loom: one line for an account whose hub login is failing or dead: what
 * happens and when, and that it needs logging in again.
 */
export function loginAlertText(login: UsageLimitSourceLogin, now: number): string {
  const at = login.expiresAt ? Date.parse(login.expiresAt) : Number.NaN;
  if (login.status === "dead") {
    const since = Number.isFinite(at) && at <= now ? ` ${formatDuration(now - at)} ago` : "";
    const reason = login.reason ? ` (the hub reports "${login.reason}")` : "";
    return `Signed out${since}${reason}. Log in to this account again.`;
  }
  const when = Number.isFinite(at) ? `in ${formatDuration(at - now)}` : "soon";
  return `Login refresh is failing: stops working ${when}. Log in to this account again.`;
}

/**
 * loom: the hub readings alone, which `LimitPresentations` satisfies, so the
 * login alerts need not subscribe to provider pushes (the composer banner).
 */
type HubPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly serverConfig: {
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
    } | null;
  }
>;

/** loom: what a hub login needs from the user now, most urgent first. */
export type LoginAttention = "dead" | "refreshFailing" | "overdue" | "due";
const ATTENTION_ORDER: readonly LoginAttention[] = ["dead", "refreshFailing", "overdue", "due"];

/** loom: the precedence for one account: dead › failing › overdue › due › nothing. */
export function loginAttention(
  login: UsageLimitSourceLogin | null | undefined,
): LoginAttention | null {
  if (!login) return null;
  if (login.status !== "healthy") return login.status;
  const phase = login.relogin?.phase;
  return phase === "due" || phase === "overdue" ? phase : null;
}

const DAY_FORMAT = { weekday: "short", day: "numeric", month: "short" } as const;
/** loom: `Fri 30 Oct` (the year too when it is not this one), in `timeZone` or local time. */
function formatDay(at: number, now: number, timeZone?: string): string {
  const sameYear =
    new Intl.DateTimeFormat("en-GB", { year: "numeric", ...(timeZone ? { timeZone } : {}) }).format(
      at,
    ) === new Intl.DateTimeFormat("en-GB", { year: "numeric" }).format(now);
  return new Intl.DateTimeFormat("en-GB", {
    ...DAY_FORMAT,
    ...(sameYear ? {} : { year: "numeric" }),
    ...(timeZone ? { timeZone } : {}),
  })
    .format(at)
    .replace(",", "");
}

/**
 * loom: the re-login reminder for an account named `name` (`caaarl@`), or
 * null while it is not yet due. An account someone else logs in (a lead of
 * more than a weekday) is asked of its owner.
 */
export function reloginText(
  login: UsageLimitSourceLogin,
  name: string,
  now: number,
): string | null {
  const relogin = login.relogin;
  if (!relogin || relogin.phase === "later") return null;
  if (!relogin.mayExpireAt) return `${name}: no login date on record. Log in to start its clock.`;
  const due = formatDay(Date.parse(relogin.dueBy), now, "UTC");
  const expires = formatDay(Date.parse(relogin.mayExpireAt), now);
  if (relogin.kind === "token") {
    // `account add-token` re-mints in place; it takes any unique part of the email.
    const remint = `claude setup-token, then ~/cli-proxy/account add-token ${name}`;
    return relogin.phase === "overdue"
      ? `${name}'s one-year token is overdue for re-minting (${remint}). It expires ${expires}.`
      : `Re-mint ${name}'s one-year token by ${due}: ${remint}. It expires ${expires}.`;
  }
  const owner = name.replace(/@.*$/, "");
  const ask =
    relogin.leadWeekdays > 1
      ? `Ask ${owner.charAt(0).toUpperCase()}${owner.slice(1)} to re-log ${name}`
      : `Re-log ${name}`;
  if (relogin.phase === "overdue")
    return relogin.leadWeekdays > 1
      ? `${ask} now; it is overdue. It could expire from ${expires}.`
      : `${name} is overdue; re-log it now. It could expire from ${expires}.`;
  return `${ask} by ${due}${relogin.early ? " (early, to keep the accounts spread out)" : ""}. It could expire from ${expires}.`;
}

/** loom: the day a hub login is next due by (`Fri 6 Nov`), as the reminder words it; null with none. */
export function reloginDueDay(login: UsageLimitSourceLogin, now: number): string | null {
  return login.relogin ? formatDay(Date.parse(login.relogin.dueBy), now, "UTC") : null;
}

/**
 * loom: the freshest login any environment's hub reports for `email`, across
 * the presentations `loginAlerts` reads; null when no hub names it.
 */
export function hubAccountLogin(
  presentations: HubPresentations,
  email: string,
): UsageLimitSourceLogin | null {
  return (
    [...presentations.values()]
      .flatMap((presentation) => presentation.serverConfig?.usageLimitSources ?? [])
      .flatMap((source) =>
        source.accounts.flatMap((account) =>
          account.email === email && account.login
            ? [{ login: account.login, at: Date.parse(source.checkedAt) }]
            : [],
        ),
      )
      .reduce<{ login: UsageLimitSourceLogin; at: number } | null>(
        (freshest, next) => (freshest && freshest.at >= next.at ? freshest : next),
        null,
      )?.login ?? null
  );
}

/** loom: the line for an account that needs attention, naming it; null when it needs none. */
export function loginAttentionText(
  login: UsageLimitSourceLogin | null | undefined,
  name: string,
  now: number,
): string | null {
  const attention = loginAttention(login);
  if (!login || attention === null) return null;
  return attention === "dead" || attention === "refreshFailing"
    ? `${name}: ${loginAlertText(login, now)}`
    : reloginText(login, name, now);
}

/** loom: one hub account whose login needs the user, with where to log it in. */
export interface LoginAlert {
  readonly email: string;
  /** `caaarl@`, as the subscription meter names accounts. */
  readonly name: string;
  readonly attention: LoginAttention;
  readonly text: string;
  readonly login: UsageLimitSourceLogin;
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceId;
}

/**
 * loom: every hub account across the environments whose login needs the
 * user, most urgent first: one per email, from the freshest hub reading.
 * Read from the hub snapshots directly, so an account whose usage could not
 * be read is still named.
 */
export function loginAlerts(presentations: HubPresentations, now: number): LoginAlert[] {
  const freshest = new Map<string, LoginAlert & { readonly checkedAt: number }>();
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        const name = account.email ? `${account.email.split("@")[0]}@` : account.id;
        const text = loginAttentionText(account.login, name, now);
        const attention = loginAttention(account.login);
        const key = account.email ?? `${source.id}:${account.id}`;
        const checkedAt = Date.parse(source.checkedAt);
        if (text === null || attention === null || !account.login) continue;
        if ((freshest.get(key)?.checkedAt ?? Number.NEGATIVE_INFINITY) >= checkedAt) continue;
        freshest.set(key, {
          email: account.email ?? account.id,
          name,
          attention,
          text,
          login: account.login,
          environmentId,
          sourceId: source.id,
          checkedAt,
        });
      }
    }
  }
  return [...freshest.values()]
    .sort((a, b) => ATTENTION_ORDER.indexOf(a.attention) - ATTENTION_ORDER.indexOf(b.attention))
    .map(({ checkedAt: _checkedAt, ...alert }) => alert);
}

/** loom: the alert lines alone, for surfaces with no Log in… action (mobile). */
export function loginAlertNotices(presentations: HubPresentations, now: number): string[] {
  return loginAlerts(presentations, now).map((alert) => alert.text);
}

// loom: linking pooled usage sources to hub accounts, through cliproxy renames.
/**
 * The hub accounts a pooled usage source (`tokenFile`) names. cliproxy
 * renames an account's auth file on re-login (`claude-<email>.json` becomes
 * `claude-<hash>-<email>.json`), so the email it reports is the stable key: a
 * source names the account whose file it is, else the account whose email
 * ends its file name — the longest such email, so `x-carl@` beats `carl@`.
 * Several accounts come back when hubs share one.
 */
export function usageSourceAccounts<
  A extends { readonly id: string; readonly email?: string | undefined },
>(tokenFile: string, accounts: readonly A[]): A[] {
  const name = tokenFile.slice(tokenFile.lastIndexOf("/") + 1);
  const rank = (account: A) =>
    account.id === name
      ? Number.POSITIVE_INFINITY
      : account.email && name.endsWith(`-${account.email}.json`)
        ? account.email.length
        : 0;
  const best = Math.max(0, ...accounts.map(rank));
  return best === 0 ? [] : accounts.filter((account) => rank(account) === best);
}

/**
 * One entry per pooled usage source that names no Claude account its
 * environment's hubs report, so failover has no reading for it: `name` for a
 * narrow surface, `notice` the full line with the token file. Judged only
 * while every hub read cleanly and reports some Claude account: a failed or
 * empty hub already has its own notice, and with no hub the server reads the
 * token file itself.
 */
export function unlinkedUsageSources(
  presentations: LimitPresentations,
): { readonly name: string; readonly notice: string }[] {
  return [...presentations.values()].flatMap(({ entry, serverConfig }) => {
    const hubs = serverConfig?.usageLimitSources ?? [];
    const accounts = hubs
      .flatMap((hub) => hub.accounts)
      .filter((account) => account.driver === "claudeAgent");
    if (accounts.length === 0 || hubs.some((hub) => hub.error)) return [];
    const prefix = presentations.size > 1 ? `${entry.target.label} · ` : "";
    return Object.values(serverConfig?.settings?.providerInstances ?? {}).flatMap((instance) =>
      (instance.usageSources ?? []).flatMap((source) => {
        if (usageSourceAccounts(source.tokenFile, accounts).length > 0) return [];
        const name = `${prefix}${source.label ?? source.tokenFile.slice(source.tokenFile.lastIndexOf("/") + 1)}`;
        return [
          {
            name,
            notice: `${name}: usage source ${source.tokenFile} matches no account the hub pools, so failover cannot see this account.`,
          },
        ];
      }),
    );
  });
}

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

// Bars show quota remaining, so even pace tracks time remaining.
export function paceRemainingPercent(
  window: ServerProviderUsageWindow,
  now: number,
): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return "resets now";
  if (resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(resetsAt - now)}`;
}

export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  return providers.map((provider) => {
    if (!hasProviderUsageLimits(provider.driver, providers, sources)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  type NativeSnapshot = { provider: ServerProvider; limits: ServerProviderUsageLimits };
  const nativeByAccount = new Map<
    string,
    { usage: NativeSnapshot; credits: NativeSnapshot | null }
  >();
  for (const provider of providersWithLimits(providers)) {
    if (provider.driver !== selected.driver || !provider.usageLimits) continue;
    const snapshot = { provider, limits: provider.usageLimits };
    const key = resolveKey(nativeReport(provider)) ?? `instance:${provider.instanceId}`;
    const previous = nativeByAccount.get(key);
    const previousUsable = previous ? limitsNotice(previous.usage.limits) === null : false;
    const usable = limitsNotice(snapshot.limits) === null;
    const providerWins =
      !previous ||
      (usable && !previousUsable) ||
      (usable === previousUsable &&
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previous.usage.limits.checkedAt));
    const previousCredit = previous?.credits;
    const credits =
      snapshot.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
        ? snapshot
        : (previousCredit ?? null);
    nativeByAccount.set(key, {
      usage: providerWins ? snapshot : previous.usage,
      credits,
    });
  }
  const native = [...nativeByAccount.values()];
  const nativeAccountKeys = new Set(
    native.flatMap(({ usage: { provider, limits } }) => {
      const key = resolveKey(nativeReport(provider));
      return key && limits.windows.length && !limits.unavailable ? [key] : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const {
    usage: { provider, limits },
    credits,
  } of native) {
    const key = resolveKey(nativeReport(provider));
    const hubCredits = sources
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!credits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(credits.limits.checkedAt));
    const shownCredits = showHubCredits
      ? hubCredits.account.usageLimits.resetCredits
      : credits?.limits.resetCredits;
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: credits?.provider.instanceId ?? provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: shownCredits ? { ...limits, resetCredits: shownCredits } : limits,
    });
  }
  for (const source of sources) {
    const matching = source.accounts.filter((account) => account.driver === selected.driver);
    for (const account of matching) {
      // loom: a failing login warns while its bars still draw; a dead one says so in its limits.
      if (account.login?.status === "refreshFailing") {
        notices.push(
          `${source.label} · ${account.email ?? account.id}: ${loginAlertText(account.login, now)}`,
        );
      }
      const key = resolveKey(account);
      if (key && nativeAccountKeys.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${account.id}`,
        sourceLabel: "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
