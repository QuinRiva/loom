/**
 * Selection and pace maths for the provider limits view, shared by web and
 * mobile so both agree on which providers show, what "ahead of pace" means,
 * and how a reset is phrased.
 *
 * @module usageLimits
 */
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

/**
 * Providers that belong on the Limits view: enabled, installed, and one whose
 * driver reports subscription usage at all. A driver with no notion of usage
 * never sets `usageLimits`, so it has no row rather than an empty one.
 */
export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
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
      readonly providers?: readonly ServerProvider[] | undefined;
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      // loom: the pooled usage sources, for `unlinkedUsageSources`.
      readonly settings?: Pick<ServerSettings, "providerInstances"> | undefined;
    } | null;
  }
>;

/** One destination per service, even when several accounts or environments use it. */
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

/** Prefer the reported email; use an identical credential when no email is available. */
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

/**
 * Keys each report by the account it draws on. One email can belong to
 * several workspaces, each with its own quota, so a report that names its
 * workspace is keyed by it too. One that does not (a hub, an older server)
 * joins the only workspace known for its email, and gets no key when there
 * are several, since it cannot say which one it read. Pass every enabled
 * login, read or not, so an unreadable workspace still counts as one.
 */
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

/**
 * One subscription account as the pooled views see it, whichever way it was
 * reported. Matching emails or credentials across environments name one
 * account, unless they name different workspaces. Its quota is one bucket, so
 * counting it twice would misstate what is left.
 */
export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  /** The instance's configured name, which is not sensitive; null for hub accounts. */
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  /** Environments the account is signed in on; empty when only a hub reports it. */
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  /** The hub that reported it, when no environment has it natively. */
  readonly sourceLabel: string | null;
  /** Where the displayed reset credit can be redeemed. */
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

/**
 * Every account with usable windows across the connected environments, one
 * entry per distinct account. The freshest reads supply windows and credits;
 * native instances supply names and environment labels.
 */
export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Redeeming through a hub also clears the routing cooldown that hub holds
    // for the account. Redeeming natively against the same subscription resets
    // it upstream but leaves the hub refusing to route to the account until
    // its own cooldown expires, so a hub target wins the redemption outright
    // while the displayed balance still follows the freshest read.
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
    // Two instances on one machine sharing an account still name it once.
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const loser = fresher ? previous : next; // loom
    // Credits and their redemption target travel together. A failed credit
    // probe must not erase a successful read from another environment.
    const creditSource = creditSources.get(key);
    accounts.set(key, {
      ...previous,
      displayName: previous.displayName ?? next.displayName,
      plan: previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      // A hub only names the account when no environment has it natively.
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
  // Every hub account, including those a native instance also knows: the hub
  // may hold a fresher read of the same subscription, and the merge above
  // keeps the redeem target consistent with whichever snapshot wins.
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

/**
 * What the pooled views cannot draw as a bar: a hub that failed to read, a
 * provider whose probe failed. Accounts that can never report (API keys)
 * are left out; there is nothing for the user to act on. The environment
 * is named only when more than one is connected.
 */
export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices: string[] = [];
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      // An account that can never report (API key) is left out; one that
      // failed, or reported nothing at all, is worth a line.
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
}

/**
 * One window id across every account that reports it: the pooled share left,
 * pace against the clock, and the resets in the order they will land, each
 * with the share of the pool it hands back.
 */
export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  /** Fixed account positions across rows; a null window leaves a gap. */
  readonly columns: ReadonlyArray<{
    readonly account: LimitAccount;
    readonly window: ServerProviderUsageWindow | null;
  }>;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    /** Points of the pool the reset restores: the member's used share over the member count. */
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

/** Show Cursor's two usable pools instead of a combined percentage when both are available. */
export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver === "antigravity") {
    // Keep each model group's five-hour and weekly buckets next to one another.
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

/**
 * Accounts grouped by driver, each with its windows pooled by kind and id.
 * Window ids are stable per provider, so a hub row and a native row for the
 * same window land in the same pool; the kind is part of the key because
 * Codex's `primary` is a position, not a duration (five hours on paid plans,
 * a month on Free/Go), and a monthly allowance must not average into a
 * five-hour pool. Pools order by kind, then first appearance.
 *
 * Accounts and columns share the session reset order, soonest first. When
 * no account reports a session window, use the first window by kind instead.
 * Missing reset times sort last, with account names and keys breaking ties.
 * Each window's reset list still follows its own clock.
 */
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
      return (window ? resetMillis(window) : null) ?? Number.POSITIVE_INFINITY;
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

/**
 * Codex ids are slots, not allowances: a weekly-only plan reports its weekly
 * window as `primary`, other plans as `secondary`. Its windows pool by kind;
 * other drivers' ids name distinct allowances.
 */
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const window of account.limits.windows) {
      const pooled = poolKey(account.driver, window);
      // An account with two windows of one kind keeps the second apart.
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push({ account, window });
      else byKey.set(key, [{ account, window }]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    // Pooled Codex slots take the pool's own key, so the id stays the same
    // whichever account sorts first.
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    const usedPercent = members.reduce((sum, m) => sum + m.window.usedPercent, 0) / members.length;
    // Pace compares spend against the clock, so it is judged only over the
    // members that have a clock; a window with no reset would otherwise
    // count as spend with no time elapsed and skew the verdict.
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
                restoresPercent: Math.round(member.window.usedPercent / members.length),
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

/** The one-line status under a provider heading when there are no bars to draw. */
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
    return relogin.phase === "overdue"
      ? `${name}'s one-year token is overdue for re-minting — it expires ${expires}.`
      : `Re-mint ${name}'s one-year token by ${due} (claude setup-token). It expires ${expires}.`;
  }
  if (relogin.phase === "overdue")
    return `${name} is overdue — re-log it now. It could expire from ${expires}.`;
  const owner = name.replace(/@.*$/, "");
  const ask =
    relogin.leadWeekdays > 1
      ? `Ask ${owner.charAt(0).toUpperCase()}${owner.slice(1)} to re-log ${name}`
      : `Re-log ${name}`;
  return `${ask} by ${due}${relogin.early ? " — early, to keep the accounts spread out" : ""}. It could expire from ${expires}.`;
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
export function loginAlerts(presentations: LimitPresentations, now: number): LoginAlert[] {
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
export function loginAlertNotices(presentations: LimitPresentations, now: number): string[] {
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

/** Quota left in the window, 0..100. Bars and labels show what remains, as Codex does. */
export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. Spending evenly leaves the same share of quota as
 * there is time left in the window; within five points of that counts as on
 * pace, further ahead means the window may run dry first.
 */
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

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `resets in 2h 13m`, or null when the window has no reset. */
export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return "resets now";
  if (resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(resetsAt - now)}`;
}

/** Limit commands are served by T3 from the same snapshots as Usage → Limits. */
export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

/** Handled by the client without sending a turn; anything with arguments stays an ordinary prompt. */
export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

/**
 * Whether Limits has anything to say about this driver. A source that failed to
 * read keeps no accounts, so its error counts for every driver rather than
 * disappearing until the next successful refresh.
 */
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

/**
 * The drivers a set of sources would offer the command to, where a source that
 * failed to read counts for every driver. Two snapshots with the same coverage
 * need no catalog republish, however much their quotas moved.
 */
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

/** A point-in-time report; never refreshes or guesses which pooled account serves a turn. */
export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  const native = providersWithLimits(providers).filter(
    (provider) => provider.driver === selected.driver,
  );
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  const nativeAccounts = new Set(
    native.flatMap((provider) => {
      const key = resolveKey(nativeReport(provider));
      return key && provider.usageLimits?.windows.length && !provider.usageLimits.unavailable
        ? [key]
        : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const provider of native) {
    if (!provider.usageLimits) continue;
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
    // Two independent decisions. Which balance to *display* follows whichever
    // snapshot is fresher. Which path to *redeem through* always prefers the
    // hub, because only the hub path clears the routing cooldown it holds for
    // that account; redeeming natively against the same account resets the
    // subscription upstream but leaves the hub refusing to route to it until
    // its own cooldown expires. A hub credit id that a fresher native redeem
    // already spent comes back as `alreadyRedeemed`, which still clears the
    // cooldown, so preferring it is safe even when the hub snapshot is stale.
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!provider.usageLimits.resetCredits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(provider.usageLimits.checkedAt));
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
          : { instanceId: provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: showHubCredits
        ? { ...provider.usageLimits, resetCredits: hubCredits.account.usageLimits.resetCredits }
        : provider.usageLimits,
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
      if (key && nativeAccounts.has(key)) continue;
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
    // A source that failed to read has no accounts left to match on, so its
    // error is reported to every provider rather than silently dropped.
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
