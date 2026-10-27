#!/usr/bin/env python3
"""Comparison tables for run.sh: this run's census and delegation outputs against baselines/.

Usage: compare.py BASELINE_MD BASELINE_DELEGATION TABLE_MD TRIGGERS_TXT DELEGATION_CUMULATIVE DELEGATION_SINCE_DEPLOY DAYS \
                  BASELINE_CAPABILITIES CAPABILITIES_MD BASELINE_TESTING TESTING_MD
"""
import ast, datetime, math, re, sys

# Skills whose catalogue headers were cut on 2026-10-23; their read rate is the thing to watch.
CUT = ["mdx-visual-plan", "mdx-visual-recap", "mdx-visual-explainer", "skill-authoring",
       "llm-instruction-change", "platform-update", "lesson-triage"]
CUT_AT = datetime.datetime(2026, 10, 23, tzinfo=datetime.timezone.utc)
DELEGATION_FOLLOW_UP_BELOW = 3.0  # percent: no better than double the 1.5% baseline
DELEGATION_MIN_CHILDREN = 200  # below this, 0 to 3 delegations cannot tell 1.5% from 3%
TESTING_MIN_WRITERS = 20  # test-writing sessions; about a week of them
TESTING_READ_FIRST_BELOW = 50.0  # percent of test writers that read docs/internals/testing.md before their first test edit
TESTING_LINT_HIT_ABOVE = 5.0  # percent with a test-lint hit on their own test; the baseline is too thin for z alone


def census(text):
    """{skill: (declared, read)} from the first `| skill | source | declared since |` table."""
    rows, on = {}, False
    for line in text.splitlines():
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        if c[:3] == ["skill", "source", "declared since"]:
            on = True
        elif on and line.startswith("|") and not set(line) <= set("|-: "):
            rows[c[0]] = (int(c[3]), int(c[4]))
        elif on and rows and not line.startswith("|"):
            break
    return rows


def delegation(text):
    rows = {}
    for line in text.splitlines()[1:]:
        if line.strip():
            role, children, delegated = line.rsplit("|", 2)
            rows[role] = (int(children), int(delegated or 0))
    return rows


def pct(n, d):
    return 100 * n / d if d else 0.0


def cell(pair):
    return f"{pair[1]}/{pair[0]} ({pct(pair[1], pair[0]):.1f}%)" if pair and pair[0] else "–"


def z(base, cur):
    """Two-proportion z of cur's rate against base's; (count, total) pairs."""
    (bn, bd), (cn, cd) = base, cur
    p = (bn + cn) / (bd + cd)
    return (cn / cd - bn / bd) / math.sqrt(p * (1 - p) * (1 / bd + 1 / cd)) if 0 < p < 1 else 0


def below(base, cur):
    """Is cur's rate below base's, and by more than noise (z <= -2)?"""
    if not cur[1]:
        return "no data"
    if pct(*cur) >= pct(*base):
        return "no"
    return "**yes**" if z(base, cur) <= -2 else "lower, within noise"


def follow_up(base, cur, better):
    """'**yes**' unless cur moved the `better` way (+1 higher, -1 lower) by one standard error; 'no' needs two."""
    if not cur[1]:
        return "no data"
    s = better * z(base, cur)
    return "no" if s >= 2 else "**yes**" if s < 1 else "better, within noise: re-run later"


def capabilities(text):
    """(sessions, days, {row label: count}) from capabilities.py's output."""
    head = re.search(r"^(\d+) sessions .*? last ([\d.]+) days", text, re.M)
    rows = dict(re.findall(r"^\|\s*(.+?)\s*\|\s*(\d+)", text, re.M))
    get = lambda prefix: int(next(v for k, v in rows.items() if k.startswith(prefix)))
    return int(head[1]), float(head[2]), get


def testing(text):
    """{regime: (test writers, read the doc first, lint hit on own test)} from testing-doc.py's output."""
    rows = {c[0]: list(map(int, c[1:])) for c in ([x.strip() for x in l.strip().strip("|").split("|")]
            for l in text.splitlines() if l.startswith("| ")) if len(c) == 4 and c[1].isdigit()}
    get = lambda prefix: next(v for k, v in rows.items() if k.startswith(prefix))
    cols = zip(get("wrote a loom test"), get("of those, read `docs/internals/testing.md` before"),
               get("of those, a later test-lint diagnostic on a test file"))
    return dict(zip(["inline", "pointer", "neither"], cols))


def instruction_before_baseline(text):
    """(read first, sessions) for llm-instruction-change from the baseline's missed-fire table."""
    line = next(l for l in text.splitlines() if re.match(r"\| `llm-instruction-change` +\| edit", l))
    first, after, never = (int(re.match(r"\d+", c.strip()).group()) for c in line.strip("|").split("|")[2:5])
    return first, first + after + never


def instruction_before_now(text):
    line = next(l for l in text.splitlines() if l.startswith("llm-instruction-change "))
    counts = ast.literal_eval(re.match(r"\S+ (\{.*?\})", line).group(1))
    return counts.get("decl:read before", 0), sum(v for k, v in counts.items() if k.startswith("decl:"))


base_md, base_del, table, triggers, del_cum, del_dep = (open(p).read() for p in sys.argv[1:7])
base_cap, cap = (capabilities(open(p).read()) for p in sys.argv[8:10])
base_test, test = (testing(open(p).read()) for p in sys.argv[10:12])
start = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=float(sys.argv[7]))
then, now = census(base_md), census(table)
b_del, n_cum, n_dep = delegation(base_del), delegation(del_cum), delegation(del_dep)

print("### Delegation: children that spawned a child (delegated/children)\n")
print("| role | baseline: 13 Oct to 22 Oct 06:18Z | now: since 13 Oct | now: since deploy 22 Oct 23:04Z |")
print("|---|--:|--:|--:|")
main = [r for r in sorted(set(b_del) | set(n_cum), key=lambda r: -n_cum.get(r, b_del.get(r, (0, 0)))[0])
        if max(b_del.get(r, (0, 0))[0], n_cum.get(r, (0, 0))[0]) >= 10]
total = lambda rows: tuple(map(sum, zip(*rows.values()))) if rows else (0, 0)
other = lambda rows: total({r: v for r, v in rows.items() if r not in main})
for role in main:
    print(f"| {role} | {cell(b_del.get(role))} | {cell(n_cum.get(role))} | {cell(n_dep.get(role))} |")
print(f"| other roles | {cell(other(b_del))} | {cell(other(n_cum))} | {cell(other(n_dep))} |")
print(f"| **all** | {cell(total(b_del))} | {cell(total(n_cum))} | {cell(total(n_dep))} |")
dep = total(n_dep)
rate = pct(dep[1], dep[0])
verdict = (f"Inconclusive: {dep[0]} children since deploy, fewer than {DELEGATION_MIN_CHILDREN}; re-run later"
           if dep[0] < DELEGATION_MIN_CHILDREN else
           f"**Follow-up:** since-deploy rate {rate:.1f}% over {dep[0]} children, under "
           f"{DELEGATION_FOLLOW_UP_BELOW:.0f}%: the wording alone did not move delegation"
           if rate < DELEGATION_FOLLOW_UP_BELOW else
           f"Since-deploy rate {rate:.1f}% over {dep[0]} children, at or above {DELEGATION_FOLLOW_UP_BELOW:.0f}%: no follow-up")
print(f"\n{verdict}.\n")

print("### Cut skill headers: sessions that read the skill (read/declared)\n")
if start < CUT_AT:
    print(f"Window starts {start:%Y-%m-%d %H:%MZ}, before the header cut on {CUT_AT:%Y-%m-%d}: "
          "pre-cut sessions dilute 'now'. Read this table as provisional.\n")
print(f"| skill | baseline: 30 days to 23 Oct | now: since {start:%Y-%m-%d} | below baseline? |")
print("|---|--:|--:|---|")
for s in CUT:
    b, n = then.get(s), now.get(s)
    print(f"| {s} | {cell(b)} | {cell(n)} | {below(b[::-1], n[::-1]) if n else 'not declared'} |")
b, n = instruction_before_baseline(base_md), instruction_before_now(triggers)
print(f"| llm-instruction-change read before editing an instruction file (read first/editors) "
      f"| {b[0]}/{b[1]} ({pct(*b):.1f}%) | {n[0]}/{n[1]} ({pct(*n):.1f}%) | {below(b, n)} |")

print("\n### Capabilities: threads that substituted for what loom provides\n")
print("The deferred-capabilities line, the guards' browser and bounded-search notes and the `lint-doc.sh` "
      "wrapper reach threads only from the first release carrying PR #450; sessions before that promote dilute 'now'.\n")
print(f"| measure | baseline: {base_cap[1]:g} days to 26 Oct | now: since {start:%Y-%m-%d} | target | follow up? |")
print("|---|--:|--:|---|---|")
b_cap, n_cap = ((s, d, g("of those, outside a loom checkout"), g("of those, called `tool_search` before"),
                 g("linted via ~/loom"), g("needed a browser"), g("used a browser tool")) for s, d, g in (base_cap, cap))
share = lambda c: f"{c[2]} ({c[2] / c[1]:.1f}/day, {pct(c[2], c[0]):.1f}% of sessions)"
print(f"| hand-rolled a browser outside a loom checkout | {share(b_cap)} | {share(n_cap)} | fewer "
      f"| {follow_up((b_cap[2], b_cap[0]), (n_cap[2], n_cap[0]), -1)} |")
print(f"| of those, called `tool_search` before substituting | {cell(b_cap[2:4])} | {cell(n_cap[2:4])} | more "
      f"| {follow_up(b_cap[3:1:-1], n_cap[3:1:-1], 1)} |")
print(f"| MDX lints from `~/loom` (sessions outside a loom checkout) | {b_cap[4]} ({b_cap[4] / b_cap[1]:.1f}/day) "
      f"| {n_cap[4]} ({n_cap[4] / n_cap[1]:.1f}/day) | 0 | {'**yes**' if n_cap[4] else 'no'} |")
print(f"| needed a browser and used a browser tool (context) | {cell(b_cap[5:7])} | {cell(n_cap[5:7])} | more | – |")

print("\n### Testing conventions behind a pointer (PR #460): sessions that wrote a loom test\n")
print("Each session is classed by the AGENTS.md in its own prompt: the conventions inline (baseline) or the pointer to "
      "`docs/internals/testing.md` (PR #460, from checkouts made after it merges). Sessions with neither predate the test "
      "lints and are left out.\n")
print("| measure | baseline: inline, to 27 Oct | now: inline | now: pointer | follow up when (pointer) | follow up? |")
print("|---|--:|--:|--:|---|---|")
b_t, n_in, n_t = base_test["inline"], test["inline"], test["pointer"]
few = n_t[0] < TESTING_MIN_WRITERS
read_low = pct(n_t[1], n_t[0]) < TESTING_READ_FIRST_BELOW
print(f"| read the doc before the first test edit | {cell(b_t[:2])} | {cell(n_in[:2])} | {cell(n_t[:2])} "
      f"| under {TESTING_READ_FIRST_BELOW:.0f}% | {'too few writers' if few else '**yes**' if read_low else 'no'} |")
hit = not few and (pct(n_t[2], n_t[0]) > TESTING_LINT_HIT_ABOVE or z((b_t[2], b_t[0]), (n_t[2], n_t[0])) >= 2)
print(f"| test-lint hit on a test it edited | {cell(b_t[::2])} | {cell(n_in[::2])} | {cell(n_t[::2])} "
      f"| over {TESTING_LINT_HIT_ABOVE:.0f}%, or above baseline by z ≥ 2 | {'too few writers' if few else '**yes**' if hit else 'no'} |")
