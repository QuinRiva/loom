#!/usr/bin/env bash
# Pull 9 name-sweep gate (Phase 3 plan, "The name sweep"; track 3a-5).
#
# Loom's agent tools reach pi only under their prefixed names
# (`mcp__t3-code__<name>`), so model-facing text must never name one bare.
# This greps the 25 names below — the 21 MCP tools, the two extension tools,
# and the two dropped tools that must not appear at all, prefixed or not — in:
#
#   1. this repository (FATAL): every tracked file outside the allowlist.
#   2. ~/pi-craft/plugins/pi-craft/skills/ (REPORTED, read-only): a separate
#      repo; 3a-T's out-of-repo edit list carries the fixes for Carl.
#   3. Carl's pi memory, read-only from ~/.pi/memory/memory.db when sqlite3 can
#      open it (REPORTED; 3a-T's memo lists the rewrites for Carl to veto).
#      Without it, run `memory_search` for each name by hand.
#
# Exit 0 iff (1) has no hits.
#
# In code (.ts/.tsx/.js/.mjs) a name is the WIRE name, not prose, when it is a
# whole string literal ("workstream_submit" — what `agentToolName(...)` and the
# MCP `tools/call` take), an object key (`workstream_submit:`) or a property
# (`.workstream_submit`); those are skipped. A name inside longer string text
# or a comment is prose and is flagged. Other files are prose throughout.
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
cd "$repo"

python3 - "$repo" <<'PY'
import os, re, sqlite3, subprocess, sys

repo = sys.argv[1]
TOOLS = [
    "workstream_spawn", "workstream_scaffold", "workstream_brief", "workstream_set_outcome",
    "workstream_request_attention", "workstream_stop", "workstream_prompt",
    "workstream_set_dependencies", "workstream_submit", "workstream_list", "consult_thread",
    "notify_thread", "set_thread_title", "thread_fork", "goal_task_list", "goal_task_add",
    "goal_task_update", "goal_tasks_rewrite", "goal_handoff", "goal_continue", "goal_update",
    "enable_toolset", "ask_user_question",
]
DROPPED = ["workstream_set_lane", "workstream_release"]
# A bare name: not part of a longer identifier and not already prefixed (the
# prefix ends in `_`, so the look-behind rejects `mcp__t3-code__<name>`).
BARE = re.compile(r"(?<![\w-])(" + "|".join(TOOLS) + r")(?![\w])")
GONE = re.compile(r"(" + "|".join(DROPPED) + r")")

# History may name anything: the upstream-sync record, plans, the V1 reference
# under quarantine/ (deleted in Phase 4), and — orchestrator ruling, DL-353 —
# the historical recaps and dated design/plan docs, the committed
# consult_manager transcripts and consult log (.pi/, progress.md), and applied
# migrations (immutable once run).
ALLOW = (
    "docs/upstream-sync/", "plans/", "quarantine/", "recaps/", "docs/plans/", "docs/design/",
    ".pi/", "progress.md", "apps/server/src/persistence/Migrations/",
)
# Upstream-owned files where `ask_user_question` is a provider's own native
# tool name (Grok / xAI ACP sessions), not Loom's: excluded by path.
UPSTREAM_NATIVE = (
    "apps/server/src/orchestration-v2/testkit/fixtures/",
    "apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts",
    "apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts",
    "apps/server/scripts/acp-mock-agent.ts",
    "apps/server/src/provider/acp/",
)
# Loom files with known hits this session may not edit: printed every run, not fatal.
PENDING = {
    "packages/contracts/src/orchestrationV2.loom.ts": "frozen contract; comment-only hits (integration)",
    "apps/server/src/orchestration-v2/Orchestrator.ts": "not 3a-5's file; one comment in 3a-4's respond hunk (integration)",
    "apps/server/src/mcp/toolkits/workstream/registration.test.ts": "pins 3a-1's stub text, which 3a-3's goal handlers replace (3a-3)",
}
# This gate itself names every tool.
SELF = ("docs/upstream-sync/pull9-tools/barenames.sh",)
CODE = (".ts", ".tsx", ".js", ".mjs", ".cjs")

def wire_use(line, start, end):
    before, after = line[:start], line[end:]
    quoted = before[-1:] in ("'", '"') and after[:1] == before[-1:]
    return quoted or re.match(r"\s*\??:", after) is not None or before.endswith(".")

def scan(path, text, code):
    hits = []
    for number, line in enumerate(text.splitlines(), 1):
        names = [m.group(0) for m in GONE.finditer(line)]
        names += [m.group(1) for m in BARE.finditer(line) if not (code and wire_use(line, m.start(1), m.end(1)))]
        if names:
            hits.append(f"{path}:{number}: [{', '.join(sorted(set(names)))}] {line.strip()[:160]}")
    return hits

def read(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
        return None

# Candidates: tracked and untracked (not ignored) text files naming any of them at all.
files = subprocess.run(
    ["git", "grep", "-l", "-z", "-I", "--untracked", "-E", "|".join(TOOLS + DROPPED)],
    capture_output=True,
).stdout.decode().split("\0")
repo_hits, pending_hits = [], []
for path in filter(None, files):
    if path.startswith(ALLOW + UPSTREAM_NATIVE + SELF):
        continue
    text = read(os.path.join(repo, path))
    if text is not None:
        hits = scan(path, text, path.endswith(CODE))
        (pending_hits if path in PENDING else repo_hits).extend(hits)

skills = os.path.expanduser("~/pi-craft/plugins/pi-craft/skills")
craft_hits = []
for root, _, names in os.walk(skills):
    for name in names:
        path = os.path.join(root, name)
        text = read(path)
        if text is not None:
            craft_hits += scan(path, text, False)

memory_hits, memory_note = [], None
db = os.path.expanduser("~/.pi/memory/memory.db")
try:
    connection = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = connection.execute(
        "SELECT 'fact ' || key, value FROM semantic UNION ALL "
        "SELECT 'lesson ' || id, rule FROM lessons WHERE is_deleted = 0"
    ).fetchall()
    for label, value in rows:
        memory_hits += [f"memory {label}: {hit.split(': ', 1)[1]}" for hit in scan(label, value, False)]
except sqlite3.Error as error:
    memory_note = f"memory export unreadable ({error}); run memory_search for each name by hand"

print(f"repo: {len(repo_hits)} hit(s) (fatal)")
print("\n".join(f"  {hit}" for hit in repo_hits))
print(f"pending: {len(pending_hits)} hit(s) in files this gate may not fix yet (not fatal)")
print("\n".join(f"  {path}: {why}" for path, why in PENDING.items()))
print("\n".join(f"  {hit}" for hit in pending_hits))
print(f"pi-craft skills: {len(craft_hits)} hit(s) (reported; see 3a-T-out-of-repo-edits.md)")
print("\n".join(f"  {hit}" for hit in craft_hits))
print(memory_note or f"memory: {len(memory_hits)} hit(s) (reported; Carl vetoes rewrites)")
print("\n".join(f"  {hit}" for hit in memory_hits))
sys.exit(1 if repo_hits else 0)
PY
