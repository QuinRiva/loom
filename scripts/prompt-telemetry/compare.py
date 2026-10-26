#!/usr/bin/env python3
"""Comparison tables for run.sh: this run's census and delegation outputs against baselines/.

Usage: compare.py BASELINE_MD BASELINE_DELEGATION TABLE_MD TRIGGERS_TXT DELEGATION_CUMULATIVE DELEGATION_SINCE_DEPLOY DAYS
"""
import ast, datetime, math, re, sys

# Skills whose catalogue headers were cut on 2026-10-23; their read rate is the thing to watch.
CUT = ["mdx-visual-plan", "mdx-visual-recap", "mdx-visual-explainer", "skill-authoring",
       "llm-instruction-change", "platform-update", "lesson-triage"]
CUT_AT = datetime.datetime(2026, 10, 23, tzinfo=datetime.timezone.utc)
DELEGATION_FOLLOW_UP_BELOW = 3.0  # percent: no better than double the 1.5% baseline
DELEGATION_MIN_CHILDREN = 200  # below this, 0 to 3 delegations cannot tell 1.5% from 3%


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


def below(base, cur):
    """Is cur's rate below base's, and by more than noise (two-proportion z <= -2)?"""
    (bn, bd), (cn, cd) = base, cur
    if not cd:
        return "no data"
    if pct(cn, cd) >= pct(bn, bd):
        return "no"
    p = (bn + cn) / (bd + cd)
    z = (cn / cd - bn / bd) / math.sqrt(p * (1 - p) * (1 / bd + 1 / cd)) if 0 < p < 1 else 0
    return "**yes**" if z <= -2 else "lower, within noise"


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
