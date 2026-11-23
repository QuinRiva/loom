#!/usr/bin/env python3
"""Loom-only source files whose imports break against the merged (trial) tree.

Loom-only = `git ls-tree HEAD` minus `git ls-tree <UP>`, `.ts/.tsx/.mjs` under apps, packages,
scripts, evals. Files that also exist at the base are upstream deletions Loom still carries; they
are listed separately with the deleting upstream commit and whether Loom modified them (Loom
untouched: the merge deletes the file; Loom modified: a modify/delete conflict). For every other
Loom-only file, as it stands in the trial tree:
  - each relative, `~/` (apps/web/src) and `@t3tools/*` specifier is resolved (package `exports`
    maps; for a package.json with conflict markers the union of stage 2 and stage 3 maps);
  - each named import (and `export {..} from`) is checked against the target's exports, found by
    regex over `export` statements, following `export * from` re-exports;
  - each bare package import is checked against every package.json at <UP> (dependency names in
    any field); a package no upstream manifest declares is a dependency upstream dropped (or never
    had) that Loom needs, so Loom's package.json lines must survive the merge.
Name checks are a regex, not the checker: `default` imports of non-workspace targets, `import *`
and query-suffixed specifiers (`?raw`, `?worker`) are only resolved, not name-checked.

Read-only. Run from this worktree's root:
  python3 docs/upstream-sync/41-cadence-pull-16-20261122/tools/imports.py \
      /home/Carl/.t3/cockpit/worktrees/loom/t3-7634b056-pull16-trial .artifacts/pull16-measure/loom-only-imports.md
"""
import collections, json, os, re, subprocess, sys

TRIAL, OUT = sys.argv[1], sys.argv[2]
BASE, UP, HEAD = "3fa57b92a2", "a09738fb43", "HEAD"
git = lambda *a, cwd=None: subprocess.run(["git", *a], capture_output=True, text=True, cwd=cwd).stdout
ls = lambda rev: set(git("ls-tree", "-r", "--name-only", rev).split("\n")) - {""}
SRC = re.compile(r"^(apps|packages|scripts|evals)/.*\.(ts|tsx|mjs)$")
head_files, up_files, base_files = ls(HEAD), ls(UP), ls(BASE)
loom_only = sorted(f for f in head_files - up_files if SRC.match(f))
carried = [f for f in loom_only if f in base_files]
genuine = [f for f in loom_only if f not in base_files]
unmerged = set(git("diff", "--name-only", "--diff-filter=U", cwd=TRIAL).split())
BUILTIN = set("assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split())


def read(p):
    try:
        return open(os.path.join(TRIAL, p), errors="replace").read()
    except OSError:
        return None


# workspace packages: name -> (dir, exports map), from the trial tree (stage 2 + 3 when conflicted)
def pkg_json_variants(p):
    txt = read(p)
    try:
        return [json.loads(txt)]
    except (TypeError, ValueError):
        return [json.loads(s) for s in (git("show", f":{n}:{p}", cwd=TRIAL) for n in (2, 3)) if s.strip()]

PKGS = {}
for pj in [f for f in head_files | up_files if re.match(r"^(apps|packages)/[^/]+/package\.json$", f)]:
    if read(pj) is None: continue
    for d in pkg_json_variants(pj):
        name, ex = d.get("name"), d.get("exports") or {}
        if not name: continue
        cur = PKGS.setdefault(name, (os.path.dirname(pj), {}))
        if isinstance(ex, dict):
            for k, v in ex.items():
                tgt = v if isinstance(v, str) else (v.get("import") or v.get("types") or v.get("default")) if isinstance(v, dict) else None
                if tgt: cur[1].setdefault(k, tgt)

# every dependency name declared by any package.json at UP (and at HEAD, for the "Loom declares it" column)
def declared(rev):
    out = collections.defaultdict(set)
    for pj in (f for f in (up_files if rev == UP else head_files) if f.endswith("package.json") and "node_modules" not in f and not f.startswith(".repos/")):
        try:
            d = json.loads(git("show", f"{rev}:{pj}"))
        except ValueError:
            continue
        for fld in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            for k in d.get(fld) or {}: out[k].add(pj)
        if d.get("name"): out[d["name"]].add(pj)
    return out
DEP_UP, DEP_HEAD = declared(UP), declared(HEAD)

EXTS = ["", ".ts", ".tsx", ".mts", ".d.ts", ".js", ".mjs", ".json", "/index.ts", "/index.tsx", "/index.js"]
def resolve_file(path):
    path = os.path.normpath(path)
    stems = [path] + ([re.sub(r"\.(m?js|jsx)$", "", path)] if re.search(r"\.(m?js|jsx)$", path) else [])
    for s in stems:
        for e in EXTS:
            if os.path.isfile(os.path.join(TRIAL, s + e)): return s + e
    return None

def resolve(spec, frm):
    spec = spec.split("?")[0]
    if spec.startswith("."): return resolve_file(os.path.join(os.path.dirname(frm), spec)), "rel"
    if spec.startswith("~/"): return resolve_file("apps/web/src/" + spec[2:]), "rel"
    m = re.match(r"^(@t3tools/[^/]+)(/.*)?$", spec)
    if m and m.group(1) in PKGS:
        d, ex = PKGS[m.group(1)]
        key = "." + (m.group(2) or "")
        if key in ex: return resolve_file(os.path.join(d, ex[key])), "pkg"
        return None, f"not in {m.group(1)} exports"
    return None, "bare"

DECL = re.compile(r"^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)", re.M)
BRACE = re.compile(r"export\s+(?:type\s+)?\{([^}]*)\}", re.S)
STAR = re.compile(r"""export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+["']([^"']+)["']""")
_exports = {}
def exports(path, depth=0):
    if path in _exports: return _exports[path]
    _exports[path] = names = set()
    src = read(path) or ""
    names.update(DECL.findall(src))
    if re.search(r"^\s*export\s+default\b", src, re.M): names.add("default")
    for body in BRACE.findall(src):
        for part in re.sub(r"//[^\n]*|/\*.*?\*/", "", body, flags=re.S).split(","):
            part = re.sub(r"^\s*type\s+", "", part.strip())
            if part: names.add(part.split(" as ")[-1].strip())
    for ns, spec in STAR.findall(src):
        if ns: names.add(ns)
        elif depth < 8:
            tgt, _ = resolve(spec, path)
            if tgt: names |= exports(tgt, depth + 1)
    return names

_up = {}
def up_exports(path, depth=0):  # the same export scan over upstream's blob, following relative `export *`
    if path in _up: return _up[path]
    _up[path] = names = set()
    src = git("show", f"{UP}:{path}")
    names.update(DECL.findall(src))
    if re.search(r"^\s*export\s+default\b", src, re.M): names.add("default")
    for body in BRACE.findall(src):
        for part in re.sub(r"//[^\n]*|/\*.*?\*/", "", body, flags=re.S).split(","):
            part = re.sub(r"^\s*type\s+", "", part.strip())
            if part: names.add(part.split(" as ")[-1].strip())
    for ns, spec in STAR.findall(src):
        if ns: names.add(ns)
        elif spec.startswith(".") and depth < 8:
            p = os.path.normpath(os.path.join(os.path.dirname(path), spec))
            stem = re.sub(r"\.(m?js)$", "", p)
            tgt = next((c for c in (p, stem + ".ts", stem + ".tsx", stem + "/index.ts") if c in up_files), None)
            if tgt: names |= up_exports(tgt, depth + 1)
    return names

IMP = re.compile(r"""(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']""", re.S)
SIDE = re.compile(r"""(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|vi\.mock\(\s*["']([^"']+)["']""")
def specifiers(src):
    for kind, _t, clause, spec in IMP.findall(src):
        named, default = [], None
        mb = re.search(r"\{([^}]*)\}", clause)
        if mb:
            for part in re.sub(r"//[^\n]*|/\*.*?\*/", "", mb.group(1), flags=re.S).split(","):
                part = re.sub(r"^\s*type\s+", "", part.strip())
                if part: named.append(part.split(" as ")[0].strip())
        head = re.sub(r"\{[^}]*\}", "", clause).strip().rstrip(",").strip()
        if kind == "import" and head and not head.startswith("*"): default = head.split(",")[0].strip()
        yield spec, named, default
    for g in SIDE.findall(src):
        yield next(s for s in g if s), [], None

# Loom-modified upstream files that merged without a marker: same check, but a failure counts only
# when the name or specifier sits on a line Loom added (upstream keeps its own imports consistent).
loom_mod = sorted(l.rstrip("\n").split("\t")[-1] for l in open(os.path.join(os.path.dirname(OUT), "loom-namestatus.txt")) if l[0] == "M")
loom_mod = [f for f in loom_mod if SRC.match(f) and f not in unmerged and os.path.exists(os.path.join(TRIAL, f))]
broken, bare, shared_broken = [], collections.defaultdict(set), []
needs = collections.defaultdict(set)  # conflicted target -> names Loom-only files import that upstream's blob lacks
for f in loom_mod:
    added = "\n".join(l[1:] for l in git("diff", "-U0", BASE, HEAD, "--", f).splitlines() if l.startswith("+") and not l.startswith("+++"))
    for spec, named, default in specifiers(read(f)):
        if spec.startswith(("node:", "virtual:", "/", "#")) or spec.split("/")[0] in BUILTIN: continue
        tgt, how = resolve(spec, f)
        if how == "bare": continue
        if tgt is None:
            if spec in added: shared_broken.append((f, spec, "specifier", how))
            continue
        if "?" in spec or not tgt.endswith((".ts", ".tsx", ".mts", ".js", ".mjs")): continue
        ex = exports(tgt)
        for n in named + ([default] if default else []):
            if ("default" if n == default else n) not in ex and re.search(rf"\b{re.escape(n)}\b", added):
                shared_broken.append((f, spec, n, tgt + (" (conflicted)" if tgt in unmerged else "")))
for f in genuine:
    src = read(f)
    if src is None:
        broken.append((f, "(file absent from trial tree)", "", "")); continue
    for spec, named, default in specifiers(src):
        if spec.startswith(("node:", "virtual:", "/", "#")) or spec.split("/")[0] in BUILTIN: continue
        tgt, how = resolve(spec, f)
        if how == "bare":
            pk = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
            bare[pk].add(f); continue
        if tgt is None:
            broken.append((f, spec, "specifier", how)); continue
        if "?" in spec or not tgt.endswith((".ts", ".tsx", ".mts", ".js", ".mjs")): continue
        ex = exports(tgt)
        for n in named + ([default] if default and how != "bare" else []):
            want = "default" if n == default else n
            if want not in ex: broken.append((f, spec, n, tgt + (" (conflicted)" if tgt in unmerged else "")))
            elif tgt in unmerged:
                if want not in up_exports(tgt): needs[tgt].add(want)

def deleted_by(p):
    return git("log", "--first-parent", "--diff-filter=D", "--format=%h %s", "-1", f"{BASE}..{UP}", "--", p).strip()

out = ["# Loom-only files: imports against the trial tree", "",
       f"Loom-only `.ts/.tsx/.mjs` under apps, packages, scripts, evals (HEAD minus {UP}): **{len(loom_only)}**; "
       f"of which **{len(carried)}** exist at the base (upstream deleted them; Loom still carries them) and "
       f"**{len(genuine)}** are genuine Loom files.", "",
       f"## Broken imports in genuine Loom-only files ({len(broken)})", "",
       "| file | specifier | name | resolved target / reason |", "| --- | --- | --- | --- |"]
out += [f"| `{f}` | `{s}` | `{n}` | {t} |" for f, s, n, t in broken]
# a type-only package (`mdast`) is declared as `@types/<name>`
types_of = lambda k: "@types/" + k.lstrip("@").replace("/", "__")
for dmap in (DEP_UP, DEP_HEAD):
    for k in list(bare):
        if k not in dmap and types_of(k) in dmap: dmap[k] = dmap[types_of(k)]
out_shared = ["", f"## Loom-added imports in {len(loom_mod)} Loom-modified, non-conflicted upstream files that do not resolve ({len(shared_broken)})", "",
              "| file | specifier | name | resolved target / reason |", "| --- | --- | --- | --- |"] + [f"| `{f}` | `{s}` | `{n}` | {t} |" for f, s, n, t in shared_broken]
miss = {k: v for k, v in bare.items() if k not in DEP_UP}
out += out_shared
out += ["", f"## Exports Loom-only files need from conflicted files that upstream's side lacks ({sum(map(len, needs.values()))} names in {len(needs)} files)", "",
        "The conflict resolution must keep (or re-home) these Loom-side exports (upstream blob scanned by regex, following relative `export *`).", "",
        "| conflicted file | names Loom-only files import |", "| --- | --- |"] + [f"| `{t}` | {', '.join(f'`{n}`' for n in sorted(v))} |" for t, v in sorted(needs.items())]
out += ["", f"## Bare packages imported by Loom-only files that no package.json at {UP} declares ({len(miss)})", "",
        "| package | declared at HEAD in | importing Loom-only files |", "| --- | --- | --- |"]
for k in sorted(miss):
    fs = sorted(miss[k])
    out.append(f"| `{k}` | {', '.join(f'`{p}`' for p in sorted(DEP_HEAD.get(k, []))) or '**nowhere**'} | {len(fs)}: {', '.join(f'`{x}`' for x in fs[:4])}{' …' if len(fs) > 4 else ''} |")
# stricter: the importing workspace's own package.json at UP does not declare the package (Loom's manifest line must survive)
def owner(f):  # nearest package.json above the file, at HEAD or UP
    d = os.path.dirname(f)
    while d and f"{d}/package.json" not in head_files | up_files: d = os.path.dirname(d)
    return f"{d}/package.json" if d else "package.json"
strict = collections.defaultdict(set)
for k, fs in bare.items():
    for f in fs:
        if owner(f) not in DEP_UP.get(k, set()) and "package.json" not in DEP_UP.get(k, set()): strict[(owner(f), k)].add(f)
out += ["", f"## Bare packages a Loom-only file imports that its own workspace manifest at {UP} does not declare ({len(strict)})", "",
        "Resolution then depends on Loom's line in that manifest (or hoisting). `HEAD declares` says whether Loom's manifest has it.", "",
        "| manifest | package | HEAD declares | files |", "| --- | --- | --- | ---: |"]
for (m, k) in sorted(strict):
    out.append(f"| `{m}` | `{k}` | {'yes' if m in DEP_HEAD.get(k, set()) else 'no'} | {len(strict[(m, k)])} |")
out += ["", f"## Upstream deletions Loom still carries ({len(carried)})", "",
        "Loom `untouched` = identical to the base, so the merge deletes it; `modified` = Loom changed it (modify/delete).", "",
        "| file | Loom | in trial tree | upstream commit that deleted it |", "| --- | --- | --- | --- |"]
for f in carried:
    lm = "modified" if git("diff", "--name-only", BASE, HEAD, "--", f).strip() else "untouched"
    st = "conflicted" if f in unmerged else ("present" if read(f) is not None else "deleted")
    out.append(f"| `{f}` | {lm} | {st} | {deleted_by(f).replace('|', '/')} |")
open(OUT, "w").write("\n".join(out) + "\n")
print(f"loom-modified checked {len(loom_mod)}, shared broken {len(shared_broken)}; loom-only {len(loom_only)}, carried {len(carried)}, genuine {len(genuine)}, broken {len(broken)}, bare-missing {len(miss)}, strict {len(strict)}")
