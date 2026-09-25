#!/usr/bin/env python3
"""Assemble plan.mdx and the standalone mockup from ONE set of HTML fragments.

The plan's <Design> artboards and .artifacts/usage-meter-mockup-v2-20260926/index.html
are generated from the same functions, so the two cannot disagree. Run from this
directory:

    python3 build_plan.py

Geometry is real size: the sidebar footer slot is 248 px wide (16 rem sidebar minus
the content inset); every fragment is laid out at that width in the dark theme.
"""

import json
import pathlib
from dataclasses import dataclass

HERE = pathlib.Path(__file__).parent
ARTIFACT = HERE.parent.parent / ".artifacts" / "usage-meter-mockup-v2-20260926" / "index.html"

# ---------------------------------------------------------------------------
# Theme (apps/web/src/index.css `.dark`, resolved to literals: <Design> fragments
# carry their own styling).
# ---------------------------------------------------------------------------
BG = "#0f0f0f"
FG = "#f5f5f5"
MUTED = "#8a8a8a"
MUTED2 = "rgba(138,138,138,0.75)"
FAINT = "rgba(138,138,138,0.45)"
TRACK = "rgba(255,255,255,0.07)"
FILL = "rgba(160,160,160,0.55)"
AMBER = "#f59e0b"
RED = "#f25c5c"
GREEN = "#5fb98a"
BORDER = "rgba(255,255,255,0.08)"
POP = "#161616"
FONT = "font-variant-numeric:tabular-nums;line-height:1"

def hue(email: str) -> int:
    """Port of accountHue() in apps/web/src/components/usage/UsageLimitsPooled.tsx."""
    h = 0
    for ch in email:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        if h >= 0x80000000:
            h -= 0x100000000
    return abs(h) % 360

def hue_colour(email: str) -> str:
    return f"oklch(0.78 0.12 {hue(email)})"

def dur(minutes: float) -> str:
    m = max(0, int(round(minutes)))
    d, h, mm = m // 1440, (m % 1440) // 60, m % 60
    return f"{d}d {h}h" if d else f"{h}h {mm:02d}m" if h else f"{mm}m"

def clock(minutes: float) -> str:
    m = int(round(minutes)) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"

# ---------------------------------------------------------------------------
# Fixtures. Minutes are minutes-from-midnight local (AEST). `rate` is the burn in
# points of the 5-hour window per hour, as the client ring would derive it from
# the last six 5-minute readings. Weekly resets are hours from `now`.
# ---------------------------------------------------------------------------
@dataclass
class Sub:
    label: str
    email: str
    s_start: int      # 5-hour window start (min)
    s_reset: int      # 5-hour reset (min)
    s_used: int       # 5-hour used %
    rate: float       # 5-hour burn, points/hour (ring)
    wk_used: int
    wk_reset_h: float # hours until the weekly reset
    fable_used: int

@dataclass
class State:
    key: str
    title: str
    when: str
    now: int
    weekday: int      # 0 = Mon, for weekly reset clock times
    subs: list
    codex: Sub        # the one-account Codex pool, read from the pi instance

    @property
    def pool_used(self): return sum(s.s_used for s in self.subs) / len(self.subs)
    @property
    def pool_rate(self): return sum(s.rate for s in self.subs) / len(self.subs)
    @property
    def pool_start(self): return sum(s.s_start for s in self.subs) / len(self.subs)
    @property
    def pool_reset(self): return sum(s.s_reset for s in self.subs) / len(self.subs)
    @property
    def fable_used(self): return sum(s.fable_used for s in self.subs) / len(self.subs)
    @property
    def wk_elapsed(self):
        return 1 - (sum(s.wk_reset_h for s in self.subs) / len(self.subs)) / 168

def wk_elapsed(s: Sub) -> float:
    return max(0.0, min(1.0, 1 - s.wk_reset_h / 168))

CODEX = "codex"

# Real reading, Thu 25 Sep 2026 12:31 AEST, straight from each cli-proxy account's
# Anthropic usage endpoint (the first plan's fixture). All five 5-hour clocks reset
# at 15:00; the weekly clocks are 26 h apart. Codex (pi instance): weekly 100%.
NORMAL = State(
    "normal", "Normal mid-week", "Thu 12:31 — real reading, 25 Sep", 12 * 60 + 31, 3,
    [
        Sub("carl@",   "carl@unseen.id",   600, 900, 2, 0.6, 25, 106, 24),
        Sub("caaarl@", "caaarl@unseen.id", 600, 900, 0, 0.0, 55,  90, 62),
        Sub("carl3@",  "carl3@unseen.id",  600, 900, 9, 2.0, 38, 101, 41),
        Sub("carl4@",  "carl4@unseen.id",  600, 900, 7, 1.5, 54,  89, 77),
        Sub("jacob@",  "jacob@unseen.id",  600, 900, 0, 0.0, 63,  80, 64),
    ],
    Sub("Codex", CODEX, 751, 1051, 0, 0.0, 100, 57.3, 100),
)

# The brief's danger case: 10 am, half the pool gone, slightly over pace, and one
# orchestrator has pulled carl@ far ahead of its siblings. Clocks 90 min apart.
DANGER = State(
    "danger", "Danger", "Tue 10:00 — 50% left, slightly over pace", 10 * 60, 1,
    [
        Sub("carl@",   "carl@unseen.id",   430, 730, 78, 34, 40, 74, 35),
        Sub("caaarl@", "caaarl@unseen.id", 460, 760, 58, 20, 52, 80, 44),
        Sub("carl3@",  "carl3@unseen.id",  480, 780, 44, 18, 31, 98, 28),
        Sub("carl4@",  "carl4@unseen.id",  500, 800, 38, 16, 47, 86, 41),
        Sub("jacob@",  "jacob@unseen.id",  520, 820, 32, 12, 44, 92, 42),
    ],
    Sub("Codex", CODEX, 528, 828, 12, 6, 40, 50, 40),
)

# The brief's counter-case: 4:30 pm, 70% left, well over pace. The meter shows when
# the burn empties the window; whether that matters is the human's evening plan.
LATE_DAY = State(
    "lateday", "Late afternoon", "Thu 16:30 — 70% left, well over pace", 16 * 60 + 30, 3,
    [
        Sub("carl@",   "carl@unseen.id",   930, 1230, 34, 24, 40, 52, 35),
        Sub("caaarl@", "caaarl@unseen.id", 930, 1230, 30, 24, 52, 58, 44),
        Sub("carl3@",  "carl3@unseen.id",  930, 1230, 28, 24, 31, 76, 28),
        Sub("carl4@",  "carl4@unseen.id",  930, 1230, 32, 24, 47, 64, 41),
        Sub("jacob@",  "jacob@unseen.id",  930, 1230, 26, 24, 44, 70, 42),
    ],
    Sub("Codex", CODEX, 930, 1230, 20, 10, 40, 30, 40),
)

# The last 36 hours of the week: two subs reset within hours, two in 1.5 days.
LAST36 = State(
    "last36", "Last 36 hours", "Fri 09:30 — weeklies reset 4 h to 38 h from now", 9 * 60 + 30, 4,
    [
        Sub("carl@",   "carl@unseen.id",   420, 720, 31,  8, 66, 20, 60),
        Sub("caaarl@", "caaarl@unseen.id", 450, 750, 12,  4, 35,  9, 30),
        Sub("carl3@",  "carl3@unseen.id",  390, 690, 55, 14, 52, 38, 49),
        Sub("carl4@",  "carl4@unseen.id",  480, 780, 20,  6, 88, 36, 84),
        Sub("jacob@",  "jacob@unseen.id",  510, 810, 44, 12, 91,  4, 95),
    ],
    Sub("Codex", CODEX, 450, 750, 25, 8, 40, 100, 40),
)

STATES = [NORMAL, DANGER, LAST36]

# ---------------------------------------------------------------------------
# Rules (the thresholds are questions at the bottom of the plan).
# ---------------------------------------------------------------------------
RISK_MAX = 85          # weekly/Fable used % that is "near max"
RISK_OVER_PACE = 20    # points ahead of the elapsed share that projects to max before reset
OPP_MIN_LEFT = 20      # weekly % still left...
OPP_RESET_H = 24       # ...with the reset this close: spend it before then without stranding yourself

def weekly_mark(s: Sub):
    """('risk'|'opp'|None, window name) for the two-sided exception mark."""
    e = wk_elapsed(s) * 100
    for name, used in (("weekly", s.wk_used), ("Fable weekly", s.fable_used)):
        if used >= RISK_MAX or used - e >= RISK_OVER_PACE:
            return "risk", name
    if 100 - s.wk_used >= OPP_MIN_LEFT and s.wk_reset_h <= OPP_RESET_H:
        return "opp", "weekly"
    return None, None

def empty_at(now: float, used: float, rate: float):
    """Projected clock minute the window hits 100% at the ring's burn, or None."""
    return None if rate <= 0 else now + (100 - used) / rate * 60

def danger_of(now, used, rate, reset):
    """amber when the projected empty lands before the reset; what that means against the
    rest of the day is the human's call — the meter carries no working-day assumption."""
    t = empty_at(now, used, rate)
    return (None if t is None or t >= reset else "amber"), t

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

def wk_clock(st, hours: float) -> str:
    """`Sat 05:30`: the weekday and time a weekly clock resets."""
    m = st.now + hours * 60
    return f"{WEEKDAYS[(st.weekday + int(m // 1440)) % 7]} {clock(m)}"

def tone_for(used: float, danger: str | None) -> str:
    return RED if used >= 100 else AMBER if (used >= 80 or danger == "amber") else FILL

MARK_GLYPH = {"risk": ("▲", AMBER), "opp": ("▽", GREEN)}

# ---------------------------------------------------------------------------
# SVG primitives (inline <svg> passes the wireframe sanitiser; position:absolute
# does not, so every marker is drawn, not overlaid).
# ---------------------------------------------------------------------------
def svg(w, h, body, extra=""):
    return f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="display:block;flex:none;overflow:visible;{extra}">{body}</svg>'

def rect(x, y, w, h, fill, rx=0, op=None):
    o = f' opacity="{op}"' if op is not None else ""
    return f'<rect x="{x:.1f}" y="{y}" width="{max(0.0, w):.1f}" height="{h}" rx="{rx}" fill="{fill}"{o}/>'

def vline(x, y0, y1, colour, width=1, dash=None, op=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    o = f' opacity="{op}"' if op is not None else ""
    return f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{y0}" y2="{y1}" stroke="{colour}" stroke-width="{width}"{d}{o}/>'

def tri_down(x, y, size, colour, hollow=False):
    pts = f"{x - size / 2:.1f},{y} {x + size / 2:.1f},{y} {x:.1f},{y + size * 0.9:.1f}"
    return (f'<polygon points="{pts}" fill="none" stroke="{colour}" stroke-width="1"/>' if hollow
            else f'<polygon points="{pts}" fill="{colour}"/>')

def timebar(W, H, bar_h, start, reset, used, rate, now, x0, x1, *, now_line=True):
    """A window drawn on a shared wall-clock axis [x0, x1] → [0, W].

    fill = used share of the window; a 1 px now-line through the whole row (fill past
    it = over pace); an amber ▼ at the projected empty when it lands before the reset.
    Its distance from the now-line is the time to empty; from the bar end, the gap
    the human would sit out.
    """
    x = lambda t: (t - x0) / (x1 - x0) * W
    danger, t_empty = danger_of(now, used, rate, reset)
    colour = tone_for(used, danger)
    y = (H - bar_h) / 2
    body = rect(x(start), y, x(reset) - x(start), bar_h, TRACK, rx=bar_h / 2)
    body += rect(x(start), y, (x(reset) - x(start)) * min(used, 100) / 100, bar_h, colour, rx=bar_h / 2)
    if now_line:
        body += vline(x(now), 0, H, FG, 1, op=0.7)
    if danger is not None and t_empty is not None:
        body += tri_down(x(t_empty), 0, 5, AMBER)
    return svg(W, H, body)

def pacebar(W, H, bar_h, used, elapsed, colour=None):
    """A normalised 0–100 bar with the pace tick at the elapsed share (the week, for Fable)."""
    y = (H - bar_h) / 2
    c = colour or tone_for(used, None)
    body = rect(0, y, W, bar_h, TRACK, rx=bar_h / 2) + rect(0, y, W * min(used, 100) / 100, bar_h, c, rx=bar_h / 2)
    body += vline(W * elapsed, 0, H, FG, 1, op=0.7)
    return svg(W, H, body)

def dot(email, size=6):
    return f'<span style="display:inline-block;flex:none;width:{size}px;height:{size}px;border-radius:99px;background:{hue_colour(email)}"></span>'

def txt(s, colour=MUTED, size=10, weight=400, extra=""):
    return f'<span style="font-size:{size}px;color:{colour};font-weight:{weight};white-space:nowrap;{FONT};{extra}">{s}</span>'

# ---------------------------------------------------------------------------
# Approach A — Timeline. One wall-clock axis for the pool and the five subs.
# Columns: [dot+label 54][axis 128][glyph+reset 50], 4 px gaps → 240 inner.
# ---------------------------------------------------------------------------
LABEL_W, AXIS_W, RIGHT_W = 54, 128, 50
ROW_H, HEAD_H = 11, 12

def axis_of(st: State):
    return min(s.s_start for s in st.subs), max(s.s_reset for s in st.subs)

def grid_row(left, middle, right, height):
    return (f'<div style="display:grid;grid-template-columns:{LABEL_W}px {AXIS_W}px {RIGHT_W}px;column-gap:4px;align-items:center;height:{height}px">'
            f'<div style="display:flex;align-items:center;gap:4px;min-width:0;height:{height}px">{left}</div>'
            f'<div style="height:{height}px">{middle}</div>'
            f'<div style="display:flex;align-items:center;justify-content:flex-end;gap:3px;height:{height}px">{right}</div></div>')

def pool_text(st: State):
    danger, t = danger_of(st.now, st.pool_used, st.pool_rate, st.pool_reset)
    reset = f"↻ {dur(st.pool_reset - st.now)}"
    if t is None or t >= st.pool_reset:
        return txt(reset, MUTED2)
    c = AMBER if danger == "amber" else MUTED2
    return txt(f"empty ~{dur(t - st.now)}", c, weight=500) + txt(" · " + reset, MUTED2)

def account_row(st: State, s: Sub, x0, x1, hover):
    """One account on the axis: the same path draws a pool member and a one-account pool."""
    mark, _ = weekly_mark(s)
    glyph, gcol = MARK_GLYPH.get(mark, ("", MUTED))
    name_c = RED if max(s.wk_used, s.fable_used) >= 100 else gcol if mark else MUTED
    bg = f"background:rgba(255,255,255,0.05);border-radius:4px;" if hover == s.label else ""
    ident = (f'<span style="display:inline-block;flex:none;width:6px;height:6px;border-radius:2px;background:{MUTED}"></span>'
             if s.email == CODEX else dot(s.email))
    return f'<div style="{bg}">' + grid_row(
        ident + txt(s.label, name_c, 10, 500 if (mark or name_c == RED) else 400, "overflow:hidden;text-overflow:ellipsis"),
        timebar(AXIS_W, ROW_H, 4, s.s_start, s.s_reset, s.s_used, s.rate, st.now, x0, x1),
        (txt(glyph, gcol, 9, 700) if glyph else "") + txt(f"↻ {dur(s.s_reset - st.now)}", MUTED2 if not mark else MUTED, 10),
        ROW_H,
    ) + "</div>"

def approach_a(st: State, *, hover: str | None = None):
    x0, x1 = axis_of(st)
    used = st.pool_used
    head = (f'<div style="display:flex;align-items:center;gap:4px;height:{HEAD_H}px">'
            f'{txt("5-hour", FG, 11, 500)}{txt(f"{used:.0f}%", MUTED, 11)}<div style="flex:1"></div>{pool_text(st)}</div>')
    # Pool row: label cell carries "pool", the bar sits on the shared axis.
    pool_bar = grid_row(
        txt("pool", FAINT, 9),
        timebar(AXIS_W, 12, 6, st.pool_start, st.pool_reset, used, st.pool_rate, st.now, x0, x1),
        "", 12,
    )
    fable = grid_row(
        txt("Fable wk", MUTED, 10),
        pacebar(AXIS_W, HEAD_H, 4, st.fable_used, st.wk_elapsed),
        txt(f"{st.fable_used:.0f}%", MUTED, 10), HEAD_H,
    )
    rows = "".join(account_row(st, s, x0, x1, hover) for s in st.subs)
    # A one-account pool (Codex, from the pi instance) is its own row on its own axis.
    codex = (f'<div style="height:1px;background:{BORDER};margin:2px 0"></div>'
             + account_row(st, st.codex, st.codex.s_start, st.codex.s_reset, hover))
    return (f'<div style="width:248px;box-sizing:border-box;padding:3px 4px;background:{BG};display:flex;flex-direction:column;gap:1px">'
            f'{head}{pool_bar}<div style="height:2px"></div>{fable}<div style="height:4px"></div>'
            f'<div style="display:flex;flex-direction:column;gap:1px">{rows}</div>{codex}</div>')

def height_a(st: State) -> int:
    return 6 + HEAD_H + 1 + 12 + 1 + 2 + 1 + HEAD_H + 1 + 4 + 5 * ROW_H + 4 + 1 + 5 + ROW_H

# ---------------------------------------------------------------------------
# Approach B — Budget as hours. The headline is a figure, bars shrink to glyphs,
# subs are a strip of five columns.
# ---------------------------------------------------------------------------
def approach_b(st: State):
    danger, t = danger_of(st.now, st.pool_used, st.pool_rate, st.pool_reset)
    left = "—" if t is None else dur(t - st.now)
    lc = AMBER if danger == "amber" else FG
    reset = st.pool_reset - st.now
    elapsed = 1 - reset / 300
    line1 = (f'<div style="display:flex;align-items:center;gap:6px;height:14px">'
             f'{txt("5-hour", FG, 11, 500)}{pacebar(28, 10, 4, st.pool_used, elapsed)}{txt(f"{st.pool_used:.0f}%", MUTED, 10)}'
             f'<div style="flex:1"></div>{txt(left, lc, 12, 600)}{txt("left · ↻ " + dur(reset), MUTED2, 10)}</div>')
    line2 = (f'<div style="display:flex;align-items:center;gap:6px;height:14px">'
             f'{txt("Fable wk", MUTED, 10)}{pacebar(28, 10, 4, st.fable_used, st.wk_elapsed)}{txt(f"{st.fable_used:.0f}%", MUTED, 10)}'
             f'<div style="flex:1"></div>{txt("resets " + dur(min(s.wk_reset_h for s in st.subs) * 60) + " – " + dur(max(s.wk_reset_h for s in st.subs) * 60), MUTED2, 10)}</div>')
    cols = ""
    for s in st.subs:
        mark, _ = weekly_mark(s)
        glyph, gcol = MARK_GLYPH.get(mark, ("", MUTED))
        d, _t = danger_of(st.now, s.s_used, s.rate, s.s_reset)
        c = tone_for(s.s_used, d)
        col = svg(14, 20, rect(0, 0, 14, 20, TRACK, rx=2) + rect(0, 20 - 20 * s.s_used / 100, 14, 20 * s.s_used / 100, c, rx=2))
        cols += (f'<div style="display:flex;flex-direction:column;align-items:center;gap:2px;width:40px">'
                 f'<div style="height:9px">{txt(glyph, gcol, 9, 700)}</div>{col}'
                 f'<div style="display:flex;align-items:center;gap:3px">{dot(s.email, 5)}{txt(s.label, gcol if mark else MUTED2, 9)}</div></div>')
    strip = f'<div style="display:flex;justify-content:space-between;padding:0 4px">{cols}</div>'
    cx = st.codex
    cd, ct = danger_of(st.now, cx.s_used, cx.rate, cx.s_reset)
    cc = RED if cx.wk_used >= 100 else MUTED
    codex = (f'<div style="height:1px;background:{BORDER};margin:2px 0"></div><div style="display:flex;align-items:center;gap:6px;height:12px">'
             f'{txt("Codex", cc, 10, 500)}{pacebar(28, 10, 4, cx.s_used, 1 - (cx.s_reset - st.now) / 300)}{txt(f"{cx.s_used}%", MUTED, 10)}<div style="flex:1"></div>'
             f'{txt(("—" if ct is None or ct >= cx.s_reset else dur(ct - st.now)) + " left · ↻ " + dur(cx.s_reset - st.now), MUTED2, 10)}</div>')
    return (f'<div style="width:248px;box-sizing:border-box;padding:3px 4px;background:{BG};display:flex;flex-direction:column;gap:2px">'
            f'{line1}{line2}<div style="height:2px"></div>{strip}{codex}</div>')

HEIGHT_B = 6 + 14 + 2 + 14 + 2 + 2 + 9 + 2 + 20 + 2 + 10 + 5 + 12  # ≈ 100

# ---------------------------------------------------------------------------
# Approach C — Weighted rows. Normalised bars; each sub row is quiet (6 px),
# raised (12 px) or loud (21 px) by rule, so the footer grows only when a sub
# needs attention.
# ---------------------------------------------------------------------------
RAISE_DIVERGE = 15    # points from the pool mean
RAISE_RESET_MIN = 30  # 5-hour reset this close

def row_weight(st: State, s: Sub):
    mark, _ = weekly_mark(s)
    if mark:
        return "loud"
    d, _t = danger_of(st.now, s.s_used, s.rate, s.s_reset)
    if abs(s.s_used - st.pool_used) >= RAISE_DIVERGE or (s.s_reset - st.now) <= RAISE_RESET_MIN or d == "amber":
        return "raised"
    return "quiet"

def approach_c(st: State):
    reset = st.pool_reset - st.now
    elapsed = 1 - reset / 300
    head = (f'<div style="display:flex;align-items:center;gap:6px;height:11px">{txt("5-hour", FG, 11, 500)}{txt(f"{st.pool_used:.0f}%", MUTED, 11)}'
            f'<div style="flex:1"></div>{pool_text(st)}</div>'
            f'{pacebar(240, 8, 5, st.pool_used, elapsed, tone_for(st.pool_used, danger_of(st.now, st.pool_used, st.pool_rate, st.pool_reset)[0]))}')
    fable = (f'<div style="display:flex;align-items:center;gap:6px;height:11px">{txt("Fable wk", MUTED, 10)}'
             f'<div style="flex:1">{pacebar(160, 11, 4, st.fable_used, st.wk_elapsed)}</div>{txt(f"{st.fable_used:.0f}%", MUTED, 10)}</div>')
    rows = ""
    for s in st.subs:
        w = row_weight(st, s)
        el = 1 - (s.s_reset - st.now) / 300
        d, _t = danger_of(st.now, s.s_used, s.rate, s.s_reset)
        c = tone_for(s.s_used, d)
        if w == "quiet":
            rows += (f'<div style="display:flex;align-items:center;gap:4px;height:6px">{dot(s.email, 4)}'
                     f'<div style="width:52px"></div><div style="flex:1">{pacebar(120, 6, 3, s.s_used, el, c)}</div></div>')
            continue
        mark, win = weekly_mark(s)
        glyph, gcol = MARK_GLYPH.get(mark, ("", MUTED))
        rows += (f'<div style="display:flex;flex-direction:column;gap:1px">'
                 f'<div style="display:flex;align-items:center;gap:4px;height:12px">{dot(s.email)}'
                 f'<div style="width:46px">{txt(s.label, gcol if mark else MUTED, 10, 500)}</div>'
                 f'<div style="flex:1">{pacebar(120, 12, 4, s.s_used, el, c)}</div>{txt(f"{s.s_used}%", MUTED, 10)}{txt("↻ " + dur(s.s_reset - st.now), MUTED2, 10)}</div>')
        if w == "loud":
            wk_used = s.fable_used if win == "Fable weekly" else s.wk_used
            note = ("hits max first" if mark == "risk" else f"{100 - wk_used}% left by " + wk_clock(st, s.wk_reset_h).split()[0])
            rows += (f'<div style="display:flex;align-items:center;gap:4px;height:8px;padding-left:60px">'
                     f'{txt(glyph, gcol, 9, 700)}{txt(f"{"Fable wk" if "Fable" in win else "wk"} {wk_used}% · ↻ {dur(s.wk_reset_h * 60)} · {note}", gcol, 9)}</div>')
        rows += "</div>"
    cx = st.codex
    codex = (f'<div style="height:1px;background:{BORDER};margin:2px 0"></div><div style="display:flex;align-items:center;gap:4px;height:12px">'
             f'<span style="display:inline-block;width:6px;height:6px;border-radius:2px;background:{MUTED}"></span><div style="width:46px">{txt("Codex", RED if cx.wk_used >= 100 else MUTED, 10, 500)}</div>'
             f'<div style="flex:1">{pacebar(120, 12, 4, cx.s_used, 1 - (cx.s_reset - st.now) / 300)}</div>{txt(f"{cx.s_used}%", MUTED, 10)}{txt("↻ " + dur(cx.s_reset - st.now), MUTED2, 10)}</div>')
    return (f'<div style="width:248px;box-sizing:border-box;padding:3px 4px;background:{BG};display:flex;flex-direction:column;gap:2px">'
            f'{head}{fable}<div style="height:2px"></div><div style="display:flex;flex-direction:column;gap:2px">{rows}</div>{codex}</div>')

def height_c(st: State) -> int:
    weights = {"quiet": 6, "raised": 12, "loud": 21}
    return 6 + 11 + 2 + 8 + 2 + 11 + 2 + 2 + sum(weights[row_weight(st, s)] for s in st.subs) + 2 * 4 + 5 + 12

# ---------------------------------------------------------------------------
# Recommended approach only: popover and header chip.
# ---------------------------------------------------------------------------
def popover(st: State, s: Sub):
    d, t = danger_of(st.now, s.s_used, s.rate, s.s_reset)
    mark, win = weekly_mark(s)
    def line(name, used, elapsed, reset_txt, extra=""):
        return (f'<div style="display:flex;flex-direction:column;gap:4px">'
                f'<div style="display:flex;justify-content:space-between;align-items:baseline">{txt(name, MUTED2, 11)}{txt(f"{used}% used", FG if used < 80 else (RED if used >= 100 else AMBER), 11, 500)}</div>'
                f'{pacebar(232, 8, 5, used, elapsed)}'
                f'{txt(reset_txt, FAINT, 10)}' + (f'{txt(extra, GREEN if extra.startswith("▽") else AMBER, 10)}' if extra else "") + '</div>')
    s_el = 1 - (s.s_reset - st.now) / 300
    five = line("5-hour", s.s_used, s_el, f"resets {clock(s.s_reset)} · in {dur(s.s_reset - st.now)}",
                f"empty ~{clock(t)} at {s.rate:.0f} pts/h" if d else "")
    wk_e = wk_elapsed(s)
    when = f"resets {wk_clock(st, s.wk_reset_h)} · in {dur(s.wk_reset_h * 60)}"
    wk_extra = ("▲ hits max before reset" if mark == "risk" and win == "weekly"
                else f"▽ {100 - s.wk_used}% left to spend by then" if mark == "opp" else "")
    week = line("Weekly", s.wk_used, wk_e, when, wk_extra)
    fable = line("Fable weekly", s.fable_used, wk_e, when,
                 "▲ hits max before reset" if mark == "risk" and win == "Fable weekly" else "")
    later = (f'<div style="display:flex;justify-content:space-between;border-top:1px solid {BORDER};padding-top:8px">'
             f'{txt("3 live threads · served 2 m ago", FAINT, 10)}{txt("slice 2 · hub", FAINT, 9, extra="border:1px solid " + BORDER + ";border-radius:4px;padding:1px 4px")}</div>')
    action = (f'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">'
              f'{txt("Pin a thread here:", FAINT, 10)}'
              f'<span style="font-size:10px;white-space:nowrap;padding:3px 7px;border:1px solid {BORDER};border-radius:6px;color:{MUTED}">Model picker · Claude — {s.label}</span></div>')
    return (f'<div style="width:256px;box-sizing:border-box;padding:12px;background:{POP};border:1px solid {BORDER};border-radius:10px;display:flex;flex-direction:column;gap:10px">'
            f'<div style="display:flex;justify-content:space-between;align-items:center"><span style="display:flex;align-items:center;gap:6px">{dot(s.email, 8)}{txt(s.label, FG, 12, 500)}</span>{txt(s.email, FAINT, 10)}</div>'
            f'{five}{week}{fable}{later}{action}</div>')

def chip(st: State):
    danger, t = danger_of(st.now, st.pool_used, st.pool_rate, st.pool_reset)
    x0, x1 = axis_of(st)
    label = (txt(f"empty ~{dur(t - st.now)}", AMBER if danger == "amber" else MUTED, 10, 500)
             if t is not None and t < st.pool_reset else txt(f"↻ {dur(st.pool_reset - st.now)}", MUTED, 10))
    return (f'<div style="display:flex;gap:6px;padding:6px;background:{BG}">'
            f'<span style="display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 7px;border:1px solid {BORDER};border-radius:6px">'
            f'{txt("5h", MUTED2, 10)}{timebar(56, 12, 6, st.pool_start, st.pool_reset, st.pool_used, st.pool_rate, st.now, x0, x1)}{label}'
            f'<span style="width:1px;height:12px;background:{BORDER}"></span>'
            f'{txt("F", MUTED2, 10)}{pacebar(28, 12, 6, st.fable_used, st.wk_elapsed)}</span></div>')

def in_place(st: State):
    thread = lambda t, c=MUTED: f'<div style="padding:5px 8px;border-radius:6px;color:{c};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px">{t}</div>'
    return (f'<div style="display:flex;min-height:420px;background:#0a0a0a;color:{FG}">'
            f'<div style="width:256px;flex:0 0 256px;display:flex;flex-direction:column;background:{BG};border-right:1px solid {BORDER}">'
            f'<div style="padding:10px 12px;font-weight:500;font-size:12px;border-bottom:1px solid {BORDER}">loom</div>'
            f'<div style="flex:1;padding:6px 4px;display:flex;flex-direction:column;gap:1px">'
            f'<div style="padding:4px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:{FAINT}">Today</div>'
            + thread("Usage meter mockup, second attempt", FG) + thread("Usage visibility — orchestrator") + thread("Consult-card polish") + thread("Deploy bridge contracts")
            + f'</div><div style="border-top:1px solid {BORDER};padding:4px">{approach_a(st)}</div></div>'
            f'<div style="flex:1;display:flex;align-items:center;justify-content:center;color:{FAINT};font-size:13px">chat</div></div>')

# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------
def frame(html, pad=14):
    """Root inset so the 248 px footer reads as a slot, not flush against the artboard."""
    return f'<div style="box-sizing:border-box;padding:{pad}px;background:#0a0a0a;display:flex;justify-content:center"><div style="border:1px solid {BORDER};border-radius:6px;overflow:hidden">{html}</div></div>'

def design(surface, caption, html):
    return f'<Design surface="{surface}" caption={json.dumps(caption, ensure_ascii=False)} html={{{json.dumps(html, ensure_ascii=False)}}} />'

def states_block(render, heights):
    return "<Columns>\n" + "\n".join(
        f'  <Column label="{st.title} · {heights(st)} px">{design("panel", st.when, frame(render(st)))}</Column>' for st in STATES
    ) + "\n</Columns>"

FRAGMENTS = {
    "@@IN_PLACE@@": design("desktop", "Where it lives: the left sidebar footer (SidebarChrome → SidebarFooter), the slot the shipped meter occupies. Timeline approach, danger state.", in_place(DANGER)),
    "@@A_STATES@@": states_block(approach_a, height_a),
    "@@A_PAIR@@": "<Columns>\n" + "\n".join(
        f'  <Column label="{st.title}">{design("panel", st.when, frame(approach_a(st)))}</Column>' for st in (DANGER, LATE_DAY)
    ) + "\n</Columns>",
    "@@B_STATES@@": states_block(approach_b, lambda st: HEIGHT_B),
    "@@C_STATES@@": states_block(approach_c, height_c),
    "@@POPOVER@@": design("popover", "Hover on carl@ in the last-36-hours state: every window as a bar with its pace tick, the 5-hour projection as a clock time, the weekly reset as weekday + time with the ▽ reason (what is left to spend by then), the source-specific slice-2 line, and the only action loom has.", popover(LAST36, LAST36.subs[0])),
    "@@HOVER_ROW@@": design("panel", "The hovered row highlights; the rest of the footer does not move.", frame(approach_a(LAST36, hover="carl@"))),
    "@@CHIP@@": design("popover", "Header chip while the sidebar is closed (danger state): tier 1 only — the 5-hour pool bar on its axis with the now-line and empty marker, the time-to-empty, and the Fable pace bar. Hover opens the whole footer.", chip(DANGER)),
}

body = (HERE / "plan.body.mdx").read_text()
for k, v in FRAGMENTS.items():
    body = body.replace(k, v)
assert "@@" not in body, "unreplaced placeholder in plan.body.mdx"
out = HERE / "plan.mdx"
if out.exists() and out.read_text().startswith("---\n"):
    front = out.read_text().split("\n---\n", 1)[0] + "\n---\n"
    body = front + body
out.write_text(body)

def panel(title, html, note=""):
    return f'<section><h2>{title}</h2>{f"<p>{note}</p>" if note else ""}<div class="frame">{html}</div></section>'

ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
ARTIFACT.write_text(f"""<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><title>Usage meter mockup v2 — Timeline approach, real size</title>
<style>
  body{{margin:0;padding:32px;background:#0a0a0a;color:#f5f5f5;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif}}
  h1{{font-size:18px;font-weight:600;margin:0 0 4px}} h2{{font-size:13px;font-weight:500;color:#8a8a8a;margin:28px 0 8px}}
  p{{font-size:12px;color:#8a8a8a;max-width:720px;margin:0 0 10px;line-height:1.5}}
  .frame{{display:inline-block;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;vertical-align:top}}
  .row{{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}}
</style></head><body>
<h1>Usage meter — Timeline approach, real size (248 px footer)</h1>
<p>Everything sits on one wall-clock axis: the pool's 5-hour window and each sub's. The vertical white line is <em>now</em>; fill past it is over pace. An amber ▼ marks where the current burn empties the window when that lands before the reset; how far it sits from now, and how far from the bar end, is the whole message — the meter assumes nothing about when the day ends. Row names colour and gain a ▲ (risk: near max or ≥20 pts over pace) or ▽ (opportunity: ≥20% left and resets within 24 h) mark only when a weekly or Fable-weekly clock is exceptional; hover for the numbers. Codex, a one-account pool, is the last row through the same path. Footer height: {height_a(DANGER)} px in every state.</p>
<div class="row">
{"".join(panel(f"{st.title} — {st.when}", approach_a(st)) for st in STATES)}
</div>
<div class="row">
{panel("The pair the brief asks to distinguish — 10:00", approach_a(DANGER), "50% left, slightly over pace: the ▼ lands 2.5 h from now, well short of the reset.")}
{panel("— and 16:30", approach_a(LATE_DAY), "70% left, well over pace: the ▼ lands 3 h from now, at 19:25. Whether that is a stop depends on the evening the human has planned — the meter says when, not whether.")}
</div>
<div class="row">
{panel("Row hovered (carl@, last 36 hours)", approach_a(LAST36, hover="carl@"))}
{panel("Popover for carl@", popover(LAST36, LAST36.subs[0]))}
{panel("Header chip, sidebar closed (danger state)", chip(DANGER))}
</div>
<div class="row">
{panel("In place", in_place(DANGER))}
</div>
</body></html>
""")
print("wrote", out, "and", ARTIFACT)
print("heights A:", {st.key: height_a(st) for st in STATES + [LATE_DAY]}, "B:", HEIGHT_B, "C:", {st.key: height_c(st) for st in STATES})
