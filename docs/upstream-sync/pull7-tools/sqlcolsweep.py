#!/usr/bin/env python3
"""Find SQL projection queries whose SELECT omits a column its Result schema
requires — merge damage that typecheck cannot see and only a runtime decode
error reveals (pull 7 lost `unsettledAt`, five message columns, four thread
columns and `lastErrorClass` this way).

Run from the repo root:  python3 docs/upstream-sync/pull7-tools/sqlcolsweep.py
Pass a path to sweep a different copy of the query file (e.g. one extracted
with `git show <sha>:<path>`), which is how the tool's own regressions are
tested.

Two rules earn their keep, both learned from a sweep that reported "0 problems"
on a tree whose every `getShellSnapshot()` was dying:

1. `mapFields` overrides are followed. `X = Base.mapFields(Struct.assign({…}))`
   REPLACES a field's schema, so a base field declared `Schema.optional` becomes
   required when the override does not repeat the optionality. Resolving to the
   base struct alone reads `titleState` as optional and misses the omission.
2. A schema this tool cannot parse is reported as UNPARSED and counts as a
   problem. Silently skipping it is what hid rule 1: every unreadable schema
   looked clean.
"""

import re
import subprocess
import sys

QUERY_FILE = "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts"
OPTIONAL_PREFIXES = ("Schema.optional", "Schema.optionalKey", "Schema.UndefinedOr")


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return "\n".join(line for line in src.split("\n") if not line.lstrip().startswith("//"))


def balanced(src: str, start: int) -> str:
    """Text inside the bracket that opens at/after `start`."""
    i = min((p for p in (src.find(c, start) for c in "([{") if p != -1), default=-1)
    depth = 0
    for j in range(i, len(src)):
        if src[j] in "([{":
            depth += 1
        elif src[j] in ")]}":
            depth -= 1
            if depth == 0:
                return src[i + 1 : j]
    raise ValueError("unbalanced")


def split_top_level(text: str, sep: str = ",") -> list[str]:
    parts, depth, current = [], 0, ""
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    parts.append(current)
    return [p.strip() for p in parts if p.strip()]


def declarations(src: str) -> dict[str, str]:
    """`[export] const Name = <rhs>;` → rhs, for every top-level declaration."""
    out: dict[str, str] = {}
    for m in re.finditer(r"^(?:export )?const (\w+) = ", src, re.M):
        depth, end = 0, None
        for j in range(m.end(), len(src)):
            if src[j] in "([{":
                depth += 1
            elif src[j] in ")]}":
                depth -= 1
            elif src[j] == ";" and depth == 0:
                end = j
                break
        if end is not None:
            out.setdefault(m.group(1), src[m.end() : end].strip())
    return out


def object_fields(body: str) -> dict[str, str]:
    """`{ key: value, … }` body → field name → value text."""
    fields = {}
    for entry in split_top_level(body):
        m = re.match(r"(?:readonly\s+)?\"?(\w+)\"?\s*:\s*(.*)", entry, re.S)
        if m:
            fields[m.group(1)] = m.group(2).strip()
    return fields


def name_list(body: str) -> list[str]:
    return re.findall(r"[\"'](\w+)[\"']", body)


def selected_columns(body: str) -> set[str]:
    """Names the SELECT list binds: an `AS` alias, else the bare column name."""
    names = set()
    for select in re.finditer(r"\bSELECT\b", body, re.I):
        # Scan to this SELECT's own FROM: a subquery's FROM is deeper, and a
        # scalar subquery in the select list (`(SELECT COUNT(*) …) AS "n"`) is
        # otherwise mistaken for the end of the list.
        depth, i = 0, select.end()
        while i < len(body):
            ch = body[i]
            if ch == "`":  # end of the sql template
                break
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                if depth == 0:
                    break
                depth -= 1
            elif depth == 0 and re.match(r"\bFROM\b", body[i:], re.I):
                break
            i += 1
        # `-- …` comments sit inside the select list and would swallow the
        # column on the line after them.
        for item in split_top_level(re.sub(r"--[^\n]*", "", body[select.end() : i])):
            alias = re.search(r'\bAS\s+"?(\w+)"?\s*$', item, re.I)
            bare = re.fullmatch(r'(?:DISTINCT\s+)?(?:\w+\.)?"?(\w+)"?', item.strip(), re.I | re.S)
            if alias:
                names.add(alias.group(1))
            elif bare:
                names.add(bare.group(1))
    return names


class Unparsed(Exception):
    pass


def resolve(name: str, decls: dict[str, str], seen: frozenset[str]) -> dict[str, str]:
    """Field name → schema text for a declared row schema, overrides applied."""
    if name in seen:
        raise Unparsed(f"cyclic reference through {name}")
    if name not in decls:
        raise Unparsed(f"no top-level declaration of {name}")
    return resolve_expr(decls[name], decls, seen | {name})


def resolve_expr(expr: str, decls: dict[str, str], seen: frozenset[str]) -> dict[str, str]:
    expr = expr.strip()
    steps = []
    while True:
        # The outermost `.mapFields(` is the last one at bracket depth zero.
        outermost = None
        for candidate in re.finditer(r"\.mapFields\(", expr):
            prefix = expr[: candidate.start()]
            if sum(prefix.count(c) for c in "([{") == sum(prefix.count(c) for c in ")]}"):
                outermost = candidate
        if outermost is None:
            break
        steps.insert(0, balanced(expr, outermost.end() - 1).strip())
        expr = expr[: outermost.start()].strip()

    if expr.startswith("Schema.Struct("):
        fields = object_fields(balanced(expr, expr.index("{")))
    elif re.fullmatch(r"\w+", expr):
        fields = dict(resolve(expr, decls, seen))
    else:
        raise Unparsed(f"unsupported schema expression `{expr.splitlines()[0][:60]}`")

    for step in steps:
        if step.startswith("Struct.assign("):
            fields.update(object_fields(balanced(step, step.index("{"))))
        elif step.startswith("Struct.omit("):
            for key in name_list(step):
                fields.pop(key, None)
        elif step.startswith("Struct.pick("):
            keep = name_list(step)
            fields = {k: v for k, v in fields.items() if k in keep}
        elif step.startswith("Struct.evolve("):
            pass  # rewrites field schemas, never their presence
        else:
            raise Unparsed(f"unsupported mapFields step `{step.splitlines()[0][:60]}`")
    return fields


def unwrap(value: str) -> str:
    while True:
        m = re.match(r"Schema\.(?:NullOr|Array|mutable)\((.*)\)\s*$", value, re.S)
        if not m:
            return value.strip()
        value = m.group(1)


def required_columns(
    fields: dict[str, str], decls: dict[str, str], depth: int = 0
) -> list[str]:
    """Required column names, expanding a nested row struct into its own columns.

    A nested struct is never a column: it is assembled by the query's row
    mapping out of the columns it selects (`session: row`), so the columns its
    fields name have to be in the SELECT too. That nesting is exactly where
    `lastErrorClass` went missing.
    """
    columns = []
    for name, value in fields.items():
        if value.startswith(OPTIONAL_PREFIXES):
            continue
        inner = unwrap(value)
        nested = None
        if inner.startswith("Schema.Struct("):
            nested = object_fields(balanced(inner, inner.index("{")))
        elif re.fullmatch(r"\w+", inner) and depth < 3:
            try:
                candidate = resolve(inner, decls, frozenset())
                nested = candidate if candidate else None
            except Unparsed:
                nested = None
        if nested:
            columns.extend(required_columns(nested, decls, depth + 1))
        else:
            columns.append(name)
    return columns


def main() -> int:
    query_file = sys.argv[1] if len(sys.argv) > 1 else QUERY_FILE
    query_src = strip_comments(open(query_file).read())
    # Every module the query file pulls row schemas from, plus contracts.
    sources = subprocess.run(
        [
            "bash",
            "-lc",
            "git ls-files 'packages/contracts/src/**/*.ts' 'apps/server/src/**/*.ts' | grep -v test",
        ],
        capture_output=True,
        text=True,
    ).stdout.split()
    decls = {}
    for path in sources:
        decls.update(declarations(strip_comments(open(path).read())))
    decls.update(declarations(query_src))  # the query file's own names win

    flagged = unparsed = 0
    for m in re.finditer(
        r"const (\w+) = SqlSchema\.(?:findAll|findOneOption|findOne|single)\(\{", query_src
    ):
        name = m.group(1)
        body = balanced(query_src, m.end() - 1)
        entry = next((e for e in split_top_level(body) if e.startswith("Result:")), None)
        if entry is None:
            print(f"UNPARSED {name}: no `Result:` schema found")
            unparsed += 1
            continue
        schema = entry[len("Result:") :].strip()
        if schema == "Schema.Void":
            continue
        label = schema if len(schema) < 40 else schema.splitlines()[0][:40] + "…"
        try:
            columns = required_columns(resolve_expr(schema, decls, frozenset()), decls)
        except (Unparsed, ValueError) as error:
            print(f"UNPARSED {name} (Result {label}): {error}")
            unparsed += 1
            continue
        selected = selected_columns(body)
        missing = [c for c in columns if c not in selected]
        if missing:
            flagged += 1
            print(f"FLAG {name} (Result {label}): SELECT omits {missing}")
    print(f"queries with a missing required column: {flagged}; unreadable schemas: {unparsed}")
    return 1 if flagged or unparsed else 0


if __name__ == "__main__":
    sys.exit(main())
