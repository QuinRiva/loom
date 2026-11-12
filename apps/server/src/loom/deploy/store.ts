// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
// The release store Loom deploys from (plans/loom-deploy-redesign §3, §7). Node built-ins and
// upstream's protocol module only: the runner and the command run from source, before any bundle.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { LoomDeployChange, LoomDeployNotice } from "@t3tools/contracts";

import { SERVICE_STATE_FILE } from "../../cloud/serviceProtocol.ts";

export interface DeployConfig {
  readonly root: string;
  readonly home: string;
  readonly stateDir: string;
  readonly unit: string;
  /** The engine's transient unit; a scratch store names its own so it never meets production's. */
  readonly engineUnit: string;
  readonly port: number;
  readonly repoUrl: string;
  readonly defaultRef: string;
  readonly path: string;
  readonly trialPort: number;
  readonly watchSeconds: number;
  readonly probeSeconds: number;
  readonly startTimeoutSeconds: number;
  readonly keepReleases: number;
  readonly keepCopies: number;
  readonly backupDir: string | null;
  readonly bridge: { readonly unit: string; readonly healthUrl: string } | null;
  readonly refreshCheckouts: ReadonlyArray<string>;
  readonly piSkillsDir: string | null;
  readonly reapBeforeStart: string | null;
}

/** The store a release folder sits in: `<store>/releases/<id>`. */
export const storeOfRelease = (releaseDir: string) =>
  NodePath.dirname(NodePath.dirname(NodePath.resolve(releaseDir)));

export function readConfig(root: string): DeployConfig {
  const file = NodePath.join(root, "deploy.json");
  const raw = readJson<Record<string, unknown>>(file);
  if (raw === undefined) throw new Error(`No readable ${file}: this is not a release in a store.`);
  const text = (key: string, fallback?: string) => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "string" || value === "") throw new Error(`${file}: "${key}" is missing.`);
    return value;
  };
  const num = (key: string, fallback: number) => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "number") throw new Error(`${file}: "${key}" must be a number.`);
    return value;
  };
  const optional = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : null);
  const bridge = raw.bridge as { unit?: unknown; healthUrl?: unknown } | undefined;
  const home = text("home");
  return {
    root,
    home,
    stateDir: text("stateDir", NodePath.join(home, "userdata")),
    unit: text("unit"),
    engineUnit: text("engineUnit", "loom-deploy"),
    port: num("port", 0),
    repoUrl: text("repoUrl"),
    defaultRef: text("defaultRef", "main"),
    path: text("path", "/usr/local/bin:/usr/bin:/bin"),
    trialPort: num("trialPort", 13998),
    watchSeconds: num("watchSeconds", 300),
    probeSeconds: num("probeSeconds", 5),
    startTimeoutSeconds: num("startTimeoutSeconds", 240),
    keepReleases: num("keepReleases", 3),
    keepCopies: num("keepCopies", 3),
    backupDir: optional("backupDir"),
    bridge:
      typeof bridge?.unit === "string" && typeof bridge.healthUrl === "string"
        ? { unit: bridge.unit, healthUrl: bridge.healthUrl }
        : null,
    refreshCheckouts: Array.isArray(raw.refreshCheckouts)
      ? raw.refreshCheckouts.filter((entry): entry is string => typeof entry === "string")
      : [],
    piSkillsDir: optional("piSkillsDir"),
    reapBeforeStart: optional("reapBeforeStart"),
  };
}

export const storePaths = (root: string) => ({
  mirror: NodePath.join(root, "repo.git"),
  releases: NodePath.join(root, "releases"),
  current: NodePath.join(root, "current"),
  previous: NodePath.join(root, "previous"),
  manifest: NodePath.join(root, "manifest.json"),
  history: NodePath.join(root, "deploy-history.jsonl"),
  trial: NodePath.join(root, "trial"),
});

export const homePaths = (config: DeployConfig) => ({
  versions: NodePath.join(config.home, "runtime", "versions"),
  state: NodePath.join(config.home, "runtime", SERVICE_STATE_FILE),
  backups: NodePath.join(config.home, "runtime", "db-backup"),
  database: NodePath.join(config.stateDir, "statev2.sqlite"),
  status: NodePath.join(config.stateDir, "deploy-status.json"),
  notice: NodePath.join(config.stateDir, "deploy-notice.json"),
});

export const releasePaths = (releaseDir: string) => ({
  runtime: NodePath.join(releaseDir, "deploy", "runtime"),
  record: NodePath.join(releaseDir, "deploy", "runtime", "deploy.json"),
  sentinel: NodePath.join(releaseDir, "deploy", "runtime", ".install-complete"),
  command: NodePath.join(releaseDir, "deploy", "loom-deploy"),
  cli: NodePath.join(releaseDir, "apps", "server", "src", "loom", "deploy", "cli.ts"),
  packageJson: NodePath.join(releaseDir, "apps", "server", "package.json"),
  bin: NodePath.join(releaseDir, "apps", "server", "dist", "bin.mjs"),
});

/** Kept copies sit beside the launcher's backups, on the same mount, so a hard link reaches them. */
export const keptDir = (config: DeployConfig) =>
  NodePath.join(NodePath.dirname(realpathOr(homePaths(config).backups)), "kept");

/** The release folder a staged version names, through `runtime/versions/<v>` → `deploy/runtime`. */
export function releaseOfVersion(config: DeployConfig, version: string): string | undefined {
  try {
    const runtime = NodeFS.realpathSync(NodePath.join(homePaths(config).versions, version));
    return NodePath.dirname(NodePath.dirname(runtime));
  } catch {
    return undefined;
  }
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Through a temp file and a rename, so a reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  NodeFS.renameSync(temp, file);
}

export function atomicLink(link: string, target: string): void {
  const temp = `${link}.${process.pid}.tmp`;
  NodeFS.rmSync(temp, { force: true });
  NodeFS.symlinkSync(target, temp);
  NodeFS.renameSync(temp, link);
}

export function realpathOr(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function run(command: string, args: ReadonlyArray<string>, cwd?: string) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export const systemctl = (...args: ReadonlyArray<string>) => run("systemctl", ["--user", ...args]);

export const releaseVersion = (releaseDir: string) =>
  readJson<{ version?: string }>(releasePaths(releaseDir).packageJson)?.version;

export function releaseSha(root: string, releaseDir: string): string {
  const id = NodePath.basename(releaseDir);
  return (
    readManifest(storePaths(root).manifest).releases[id]?.sha ??
    run("git", ["-C", releaseDir, "rev-parse", "HEAD"]).stdout.trim()
  );
}

/** Loom answers its environment probe on loopback. */
export async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The bridge's own health answer: Slack and Loom both connected. Fails closed. */
export async function bridgeHealthy(healthUrl: string): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(4_000) });
    const body = (await response.json()) as { ok?: unknown; slack?: unknown; loom?: unknown };
    return (
      response.ok && body.ok === true && body.slack === "connected" && body.loom === "connected"
    );
  } catch {
    return false;
  }
}

/** `100.<UTC date>.<n>`, above every version already staged or active (plan §7.4). */
export function nextVersion(todayUtc: string, used: ReadonlyArray<string>): string {
  const ours = used.flatMap((version) => {
    const match = /^100\.(\d{8})\.(\d+)$/.exec(version);
    return match ? [{ date: match[1]!, n: Number(match[2]) }] : [];
  });
  const date = ours.reduce((latest, { date }) => (date > latest ? date : latest), todayUtc);
  const n = Math.max(0, ...ours.filter((entry) => entry.date === date).map((entry) => entry.n));
  return `100.${date}.${n + 1}`;
}

export type ReleaseStatus = "ready" | "current" | "previous" | "failed";

export interface ReleaseRecord {
  readonly id: string;
  readonly ref: string;
  readonly sha: string;
  readonly builtAt: string;
  readonly status: ReleaseStatus;
  readonly version?: string;
}

export interface Manifest {
  readonly releases: Readonly<Record<string, ReleaseRecord>>;
}

export const readManifest = (file: string): Manifest =>
  readJson<Manifest>(file) ?? { releases: {} };

/** `id` becomes the one `current`, the old current `previous`, and an older previous `ready`. */
export function markCurrent(manifest: Manifest, id: string): Manifest {
  if (manifest.releases[id] === undefined || manifest.releases[id].status === "current") {
    return manifest;
  }
  const next = (record: ReleaseRecord): ReleaseStatus =>
    record.id === id
      ? "current"
      : record.status === "current"
        ? "previous"
        : record.status === "previous"
          ? "ready"
          : record.status;
  return {
    releases: Object.fromEntries(
      Object.entries(manifest.releases).map(([key, record]) => [
        key,
        { ...record, status: next(record) },
      ]),
    ),
  };
}

export const withRelease = (manifest: Manifest, record: ReleaseRecord): Manifest => ({
  releases: { ...manifest.releases, [record.id]: record },
});

export const withoutReleases = (manifest: Manifest, ids: ReadonlyArray<string>): Manifest => ({
  releases: Object.fromEntries(
    Object.entries(manifest.releases).filter(([key]) => !ids.includes(key)),
  ),
});

/** `kept/<update id>/meta.json`: the switch the copy was taken at, and the release it returns to. */
export interface KeptCopy {
  readonly updateId: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly fromRelease: string | null;
  readonly toRelease: string;
  readonly at: string;
}

export function listKeptCopies(config: DeployConfig): ReadonlyArray<KeptCopy> {
  const dir = keptDir(config);
  const names = NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : [];
  return names
    .flatMap((name) => readJson<KeptCopy>(NodePath.join(dir, name, "meta.json")) ?? [])
    .toSorted((left, right) => right.at.localeCompare(left.at));
}

/**
 * What after-accept removes: release folders beyond the current, the previous and the newest
 * other, keeping any release a kept copy returns to; kept copies beyond the newest `keepCopies`.
 */
export function planRetention(input: {
  readonly manifest: Manifest;
  readonly keepReleases: number;
  readonly keepCopies: number;
  readonly copies: ReadonlyArray<KeptCopy>;
}): { readonly releases: ReadonlyArray<string>; readonly copies: ReadonlyArray<string> } {
  const kept = input.copies.toSorted((left, right) => right.at.localeCompare(left.at));
  const copies = kept.slice(input.keepCopies).map((copy) => copy.updateId);
  const protectedIds = new Set(
    kept.slice(0, input.keepCopies).flatMap((copy) => [copy.fromRelease ?? "", copy.toRelease]),
  );
  const records = Object.values(input.manifest.releases).filter(
    (record) => record.status !== "failed",
  );
  const pinned = records.filter((record) => record.status !== "ready").map((record) => record.id);
  const others = records
    .filter((record) => record.status === "ready")
    .toSorted((left, right) => right.builtAt.localeCompare(left.builtAt))
    .map((record) => record.id);
  const keep = new Set([
    ...pinned,
    ...others.slice(0, Math.max(0, input.keepReleases - pinned.length)),
  ]);
  return {
    releases: others.filter((id) => !keep.has(id) && !protectedIds.has(id)),
    copies,
  };
}

// Phase 2 moves this shape into packages/contracts as a schema and imports the type from there.
export type DeployPhase =
  | "building"
  | "checking"
  | "switching"
  | "watching"
  | "live"
  | "put-back"
  | "held"
  | "called-off";
export type DeployOrigin = "loom" | "cli" | "slack";

export interface LoomDeployStatus {
  readonly id: string;
  readonly sha: string;
  readonly version: string | null;
  readonly phase: DeployPhase;
  readonly origin: DeployOrigin;
  readonly who: string | null;
  readonly noReturn: boolean;
  readonly startedAt: string;
  readonly stopAt: string | null;
  readonly watchUntil: string | null;
  readonly reason: string | null;
  readonly bridge: "connected" | "fault" | null;
  readonly at: string;
}

export const ENDED_PHASES: ReadonlyArray<DeployPhase> = ["live", "put-back", "held", "called-off"];

export const readStatus = (config: DeployConfig) =>
  readJson<LoomDeployStatus>(homePaths(config).status);

export function writeStatus(config: DeployConfig, status: LoomDeployStatus): LoomDeployStatus {
  const stamped = { ...status, at: nowIso() };
  NodeFS.mkdirSync(config.stateDir, { recursive: true });
  writeJsonAtomic(homePaths(config).status, stamped);
  return stamped;
}

/** Written by the running release's engine, read by the new release's runner: decode loosely. */
export interface DeployRecord {
  readonly id: string;
  readonly sha: string;
  readonly version: string;
  readonly origin: DeployOrigin;
  readonly who: string | null;
  readonly noReturn: boolean;
  readonly fromRelease: string | null;
  readonly startedAt: string;
  readonly installedAt: string | null;
  readonly switchedAt: string;
  readonly headline: string | null;
  readonly changes: ReadonlyArray<LoomDeployChange>;
}

export function readRecord(releaseDir: string): Partial<DeployRecord> | undefined {
  const record = readJson<Partial<DeployRecord>>(releasePaths(releaseDir).record);
  return record?.id === NodePath.basename(releaseDir) ? record : undefined;
}

export function writeNotice(config: DeployConfig, body: Omit<LoomDeployNotice, "id" | "at">): void {
  const at = nowIso();
  const id = `${body.release.id}@${at}${body.kind === "rolled-back" ? ":rolled-back" : ""}`;
  writeJsonAtomic(homePaths(config).notice, { id, at, ...body } satisfies LoomDeployNotice);
}

export interface HistoryLine {
  readonly id: string;
  readonly version: string | null;
  readonly origin: DeployOrigin;
  readonly who: string | null;
  readonly noReturn: boolean;
  readonly startedAt: string;
  readonly installedAt: string | null;
  readonly switchedAt: string | null;
  readonly endedAt: string;
  readonly outcome: "live" | "put-back" | "back" | "called-off";
  readonly reason: string | null;
}

export function appendHistory(root: string, line: HistoryLine): void {
  NodeFS.appendFileSync(storePaths(root).history, `${JSON.stringify(line)}\n`);
}

export const readHistory = (root: string): ReadonlyArray<HistoryLine> =>
  (NodeFS.existsSync(storePaths(root).history)
    ? NodeFS.readFileSync(storePaths(root).history, "utf8")
    : ""
  )
    .split("\n")
    .flatMap((line) => {
      try {
        return line.trim() === "" ? [] : [JSON.parse(line) as HistoryLine];
      } catch {
        return [];
      }
    });

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * When Loom goes down: the start plus the median start-to-stop of the last ten deploys (150 s
 * without history); once the install is done, that moment plus the median of what remains.
 */
export function estimateStopAt(
  history: ReadonlyArray<HistoryLine>,
  startedAt: string,
  installedAt?: string,
): string {
  const recent = history.filter((line) => line.switchedAt !== null).slice(-10);
  const seconds = (from: string | null, to: string | null) =>
    from === null || to === null ? [] : [(Date.parse(to) - Date.parse(from)) / 1000];
  const remaining = recent.flatMap((line) => seconds(line.installedAt, line.switchedAt));
  const whole = recent.flatMap((line) => seconds(line.startedAt, line.switchedAt));
  const [from, span] =
    installedAt !== undefined && remaining.length > 0
      ? [installedAt, median(remaining)]
      : [startedAt, whole.length > 0 ? median(whole) : 150];
  return new Date(Date.parse(from) + span * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const LOOM_MANAGED_MARKER = ".loom-managed.json";

export interface SkillFlags {
  readonly piGlobal: boolean;
  readonly requires: ReadonlyArray<string>;
}

const unquote = (value: string) => value.replace(/^['"]/, "").replace(/['"]$/, "");

/** `pi_global` and `pi_global_requires` (inline or block list) from a SKILL.md's frontmatter. */
export function parseSkillFlags(markdown: string): SkillFlags {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  if (frontmatter === undefined) return { piGlobal: false, requires: [] };
  const lines = frontmatter.split(/\r?\n/).map((line) => line.trim());
  let piGlobal = false;
  const requires: Array<string> = [];
  lines.forEach((line, index) => {
    const global = /^pi_global\s*:\s*(\S+)/.exec(line);
    if (global) piGlobal = global[1] === "true";
    const rest = /^pi_global_requires\s*:\s*(.*)$/.exec(line)?.[1]?.trim();
    if (rest === undefined) return;
    if (rest !== "" && rest !== "[]") {
      const inner = rest.startsWith("[") && rest.endsWith("]") ? rest.slice(1, -1) : rest;
      requires.push(
        ...inner
          .split(",")
          .map((entry) => unquote(entry.trim()))
          .filter(Boolean),
      );
      return;
    }
    for (const next of lines.slice(index + 1)) {
      const item = /^-\s+(.+)$/.exec(next)?.[1];
      if (item === undefined) break;
      requires.push(unquote(item.trim()));
    }
  });
  return { piGlobal, requires };
}

/** Every `pi_global` skill and the sibling folders it requires, sorted and deduplicated. */
export const desiredManagedSkills = (
  skills: ReadonlyArray<{ readonly name: string; readonly flags: SkillFlags }>,
): ReadonlyArray<string> =>
  [
    ...new Set(
      skills.flatMap((skill) =>
        skill.flags.piGlobal ? [skill.name, ...skill.flags.requires] : [],
      ),
    ),
  ].toSorted();

/** Prune only names this installer linked before, so a user's own entries are never touched. */
export const linkPlan = (
  desired: ReadonlyArray<string>,
  previouslyManaged: ReadonlyArray<string>,
) => ({
  link: [...desired],
  prune: previouslyManaged.filter((name) => !desired.includes(name)),
});

export const checkoutFastForwardable = (branch: string, defaultRef: string, porcelain: string) =>
  branch.trim() === defaultRef && porcelain.trim() === "";

const isSymlink = (path: string) => {
  try {
    return NodeFS.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Links point through `current/skills`, so pruning a release never dangles them. Never throws. */
export function installPiSkills(config: DeployConfig, log: (line: string) => void): void {
  if (config.piSkillsDir === null) return;
  const skillsDir = config.piSkillsDir;
  try {
    const currentSkills = NodePath.join(storePaths(config.root).current, "skills");
    const marker = NodePath.join(skillsDir, LOOM_MANAGED_MARKER);
    const scanned = (NodeFS.existsSync(currentSkills) ? NodeFS.readdirSync(currentSkills) : [])
      .toSorted()
      .flatMap((name) => {
        const file = NodePath.join(currentSkills, name, "SKILL.md");
        return NodeFS.existsSync(file)
          ? [{ name, flags: parseSkillFlags(NodeFS.readFileSync(file, "utf8")) }]
          : [];
      });
    const managed = readJson<{ managed?: unknown }>(marker)?.managed;
    const previous = Array.isArray(managed)
      ? managed.filter((name): name is string => typeof name === "string")
      : [];
    const { link, prune } = linkPlan(desiredManagedSkills(scanned), previous);
    if (link.length === 0 && previous.length === 0) return;
    NodeFS.mkdirSync(skillsDir, { recursive: true });
    for (const name of prune) {
      if (isSymlink(NodePath.join(skillsDir, name)))
        NodeFS.unlinkSync(NodePath.join(skillsDir, name));
    }
    for (const name of link) {
      const linkPath = NodePath.join(skillsDir, name);
      if (NodeFS.existsSync(linkPath) && !isSymlink(linkPath)) {
        log(`pi-skill: ${name} exists and is not a link; left alone`);
        continue;
      }
      atomicLink(linkPath, NodePath.join(currentSkills, name));
    }
    NodeFS.writeFileSync(marker, `${JSON.stringify({ managed: link }, null, 2)}\n`);
    log(`pi-skill: ${link.length} linked, ${prune.length} pruned`);
  } catch (error) {
    log(`pi-skill: install failed (ignored): ${String(error)}`);
  }
}

/** Fast-forward each configured checkout to `sha` when it is on the default ref and clean. */
export function refreshCheckouts(config: DeployConfig, sha: string, log: (line: string) => void) {
  for (const dir of config.refreshCheckouts) {
    const git = (...args: ReadonlyArray<string>) => run("git", ["-C", dir, ...args]);
    if (!NodeFS.existsSync(dir) || git("fetch", "origin", "--quiet").code !== 0) {
      log(`checkout-refresh: ${dir} skipped (missing or fetch failed)`);
      continue;
    }
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout;
    const porcelain = git("status", "--porcelain", "--untracked-files=no").stdout;
    if (!checkoutFastForwardable(branch, config.defaultRef, porcelain)) {
      log(`checkout-refresh: ${dir} skipped (not on a clean ${config.defaultRef})`);
      continue;
    }
    const merged = git("merge", "--ff-only", sha);
    log(
      `checkout-refresh: ${dir} ${merged.code === 0 ? `at ${sha.slice(0, 7)}` : "could not fast-forward"}`,
    );
  }
}
