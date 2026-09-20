#!/usr/bin/env python3
"""Find SQL projection queries whose SELECT omits a column its Result schema
requires — merge damage that typecheck cannot see and only a runtime decode
error reveals (pull 7 lost `unsettledAt` and five message columns this way).

Run from the repo root:  python3 docs/upstream-sync/pull7-tools/sqlcolsweep.py
"""

import re
import subprocess
import sys

QUERY_FILE = "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts"


def balanced(src: str, start: int) -> str:
    """Text inside the bracket that opens at/after `start`."""
    i = src.index("{", start)
    depth = 0
    for j in range(i, len(src)):
        if src[j] in "([{":
            depth += 1
        elif src[j] in ")]}":
            depth -= 1
            if depth == 0:
                return src[i + 1 : j]
    raise ValueError("unbalanced")


def struct_fields(src: str, name: str):
    """Required (non-optional) top-level field names of `export const <name> = Schema.Struct({…})`."""
    m = re.search(r"export const %s = Schema\.Struct\(\{" % re.escape(name), src)
    if not m:
        return None
    fields, depth = [], 0
    for line in balanced(src, m.end() - 1).split("\n"):
        mm = re.match(r"\s*(\w+):", line)
        if mm and depth == 0 and "Schema.optional" not in line:
            fields.append(mm.group(1))
        depth += line.count("{") + line.count("(") - line.count("}") - line.count(")")
    return fields


def main() -> int:
    query_src = open(QUERY_FILE).read()
    # Every module the query file pulls row schemas from, plus contracts.
    sources = subprocess.run(
        ["bash", "-lc", "git ls-files 'packages/contracts/src/*.ts' 'apps/server/src/persistence/**/*.ts' | grep -v test"],
        capture_output=True,
        text=True,
    ).stdout.split()
    schema_src = query_src + "".join(open(f).read() for f in sources)

    # `const XDbRowSchema = Base.mapFields(…)` — resolve to the base struct.
    bases = dict(re.findall(r"const (\w+)\s*=\s*(\w+)(?:\.mapFields)?", query_src))

    problems = 0
    for m in re.finditer(r"const (\w+) = SqlSchema\.(?:findAll|findOneOption|findOne|single)\(\{", query_src):
        name = m.group(1)
        body = balanced(query_src, m.end() - 1)
        result = re.search(r"Result:\s*(\w+)", body)
        if not result:
            continue
        schema = result.group(1)
        fields = struct_fields(schema_src, schema) or struct_fields(schema_src, bases.get(schema, ""))
        if fields is None:
            continue
        # `col,` and `alias.col,` both select a field under its own name.
        selected = set(re.findall(r'AS "(\w+)"', body)) | set(
            re.findall(r"^\s+(?:\w+\.)?(\w+),\s*$", body, re.M)
        )
        missing = [f for f in fields if f not in selected]
        if missing:
            problems += 1
            print(f"{name} (Result {schema}): SELECT omits {missing}")
    print(f"queries with a missing required column: {problems}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
