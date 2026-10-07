#!/usr/bin/env python3
"""QA-ONLY. build-home.sh step r5: the session manifest and the flat byte copy.

Every non-deleted thread of the (already relocated) QA copy is matched to pi's
session files by the deterministic `<timestamp>_<threadId>.jsonl` name, one walk
of the source root to depth 2 (pi's default root is one slug directory per cwd).
Matches are BYTE-copied (never linked: a hard link would let QA append to
production's file) flat into <qa>/pi-sessions/, mtimes preserved (the importer
picks the newest file on a duplicate id). Production's pi may be mid-write on a
live thread's file, so every copy's last line must parse as JSON; failures are
re-copied once a few seconds later and whatever still fails is reported.

usage: sessions.py <qa-copy-db> <source-sessions-root> <dest-dir> <qa-report-dir>
"""
import json, os, re, shutil, sqlite3, sys, time

db, root, dest, report_dir = sys.argv[1:]
# pi's session id for a thread is the thread id with non-[A-Za-z0-9_-] characters
# replaced by '-' (piSessionFiles.ts piSessionIdForThread).
ids = {re.sub(r"[^a-zA-Z0-9_-]", "-", r[0]) for r in sqlite3.connect(f"file:{db}?mode=ro", uri=True).execute(
    "SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL")}

def candidates():
    for entry in os.scandir(root):
        if entry.is_dir(follow_symlinks=False):
            yield from (f for f in os.scandir(entry.path) if f.is_file(follow_symlinks=False))
        elif entry.is_file(follow_symlinks=False):
            yield entry

def thread_of(name):
    # <timestamp>_<sessionId>.jsonl: the timestamp has no '_', the id may.
    return name[name.find("_") + 1:-len(".jsonl")] if name.endswith(".jsonl") and "_" in name else None

matches = [f for f in candidates() if thread_of(f.name) in ids]
by_name = {}
for f in matches:
    if f.name in by_name:
        sys.exit(f"duplicate session file name {f.name}: {by_name[f.name]} and {f.path} (flat copy would collide)")
    by_name[f.name] = f.path
total = sum(f.stat().st_size for f in matches)
have = {thread_of(f.name) for f in matches}
missing = sorted(ids - have)  # session ids (= thread ids for uuid-shaped ids)
free = shutil.disk_usage(dest).free
print(f"r5 manifest: {len(ids)} non-deleted threads; {len(matches)} session files for {len(have)} threads; "
      f"{total / 2**30:.2f} GiB; {len(missing)} threads with no session file; {free / 2**30:.1f} GiB free")
if total + 2**30 > free:
    sys.exit("REFUSED: not enough free space for the session copy (+1 GiB margin)")
with open(os.path.join(report_dir, "session-manifest.txt"), "w") as out:
    out.writelines(f"{f.path}\n" for f in sorted(matches, key=lambda f: f.name))
with open(os.path.join(report_dir, "sessions-missing.txt"), "w") as out:
    out.writelines(f"{t}\n" for t in missing)

def copy(src):
    shutil.copyfile(src, os.path.join(dest, os.path.basename(src)))  # bytes only: never a link
    shutil.copystat(src, os.path.join(dest, os.path.basename(src)))

def last_line_ok(path):
    with open(path, "rb") as fh:
        lines = [l for l in fh.read().splitlines() if l.strip()]
    try:
        return bool(lines) and json.loads(lines[-1]) is not None
    except ValueError:
        return False

def header_ok(path, thread_id):
    with open(path, "rb") as fh:
        first = fh.readline()
    try:
        h = json.loads(first)
        return h.get("type") == "session" and h.get("id") == thread_id
    except ValueError:
        return False

for f in matches:
    copy(f.path)
bad = [f.path for f in matches if not last_line_ok(os.path.join(dest, f.name))]
if bad:
    time.sleep(5)
    for p in bad:
        copy(p)
    bad = [p for p in bad if not last_line_ok(os.path.join(dest, os.path.basename(p)))]
headers = [f.name for f in matches if not header_ok(os.path.join(dest, f.name), thread_of(f.name))]
print(f"r5 copied {len(matches)} files flat into {dest}; last line unparseable after re-copy: {len(bad)}; "
      f"header id != thread id (importer will report corrupt): {len(headers)}")
for p in bad:
    print(f"  unparseable last line: {p}")
for n in headers[:50]:
    print(f"  header mismatch: {n}")
