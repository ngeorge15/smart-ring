"""
Sleep debt and week-over-week trends.

TWO RULES GOVERN THIS MODULE, and both exist because the naive version lies.

1. A NIGHT IS NOT A CALENDAR DAY.
   This user falls asleep after midnight, so a night's samples happen to share
   one date -- but a 23:40 bedtime would split one night across two dates and
   halve it. Every source is bucketed by NIGHT_CUTOFF_HOUR: sleep starting at or
   after 18:00 belongs to the NEXT morning's night. That reproduces the ring's
   own `night_of` (onset 02:39 on the 23rd -> night_of 2026-08-23) while staying
   correct for an early bedtime.

2. A MISSING NIGHT IS NOT A ZERO.
   Nights with no data are EXCLUDED and counted, never charged as a full night's
   shortfall. Two unworn nights would otherwise manufacture ~16h of debt out of
   nothing. Debt is always reported alongside how many nights it actually covers.

Cross-device merging is legal here only because sleep minutes are a SEEDABLE
quantity under baseline.py's rule -- both devices estimate minutes asleep. Every
night carries the source that produced it, so the UI can show the mix.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "ring_data.sqlite"

# Sleep beginning at/after this hour belongs to the following morning's night.
NIGHT_CUTOFF_HOUR = 18

# Stages that count as asleep. 'in_bed' and 'awake' are time in bed, not sleep.
ASLEEP_STAGES = ("light", "deep", "REM", "asleep")

# Sleep need cannot be measured by this hardware -- it takes a sleep-extension
# study -- so the target is DECLARED, not inferred, and the user can change it.
#
# The tempting alternative was this person's own 75th-percentile night, on the
# theory that unconstrained nights reveal need. Measured against real data it
# came out at 9h12m, because a high-variance sleeper's long nights are mostly
# RECOVERY from prior debt -- the effect being measured, fed back in as the
# baseline. It would have reported ~5h of debt after two ordinary nights. The
# median has the opposite flaw: debt against your own median is ~0 by
# construction. So the default is the standard adult recommendation, stated
# plainly as such, with the personal distribution shown next to it as context.
DEFAULT_TARGET_MIN = 8 * 60
TARGET_FLOOR_MIN = 5 * 60
TARGET_CEIL_MIN = 12 * 60

DEBT_WINDOW_NIGHTS = 14
TARGET_LOOKBACK_DAYS = 120
TREND_WEEKS = 8


def _conn(db: Path):
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def _night_of(ts: str) -> str | None:
    """Map a sample's start timestamp to the night it belongs to.

    Accepts both stored shapes: the ring's naive ISO ('2026-08-23T02:39:00') and
    Apple's offset-bearing form ('2026-08-23 01:31:57 -0700'). Only the local
    wall clock matters for a night boundary, so the offset is deliberately
    ignored rather than converted -- the whole database is local time by
    convention (see snapshot meta).
    """
    if not ts or len(ts) < 13:
        return None
    try:
        day = date.fromisoformat(ts[:10])
        hour = int(ts[11:13])
    except ValueError:
        return None
    if hour >= NIGHT_CUTOFF_HOUR:
        day += timedelta(days=1)
    return day.isoformat()


@dataclass
class NightRow:
    night: str
    asleep_min: float
    source: str
    in_bed_min: float | None = None
    efficiency: float | None = None


def sleep_timeline(db: Path = DB, days: int = 120) -> list[NightRow]:
    """Merged per-night sleep minutes, oldest first. Ring wins where it exists."""
    with _conn(db) as c:
        ring = pd.read_sql_query(
            "SELECT night_of, onset, asleep_min, in_bed_min, efficiency FROM sleep_nights", c)
        watch = pd.read_sql_query(
            "SELECT start_ts, stage, value FROM reference_samples "
            f"WHERE kind='sleep' AND stage IN ({','.join('?' * len(ASLEEP_STAGES))})",
            c, params=ASLEEP_STAGES)

    out: dict[str, NightRow] = {}

    if not watch.empty:
        watch["night"] = watch["start_ts"].map(_night_of)
        agg = watch.dropna(subset=["night"]).groupby("night")["value"].sum()
        for night, mins in agg.items():
            # A handful of stray minutes is a stale reading, not a night's sleep.
            if mins >= 120:
                out[str(night)] = NightRow(str(night), float(mins), "watch")

    for r in ring.itertuples():
        # Trust the ring's own night_of, but re-derive from onset when present so
        # a firmware quirk in that field cannot silently misfile a night.
        night = _night_of(str(r.onset)) or str(r.night_of)
        out[night] = NightRow(night, float(r.asleep_min), "ring",
                              float(r.in_bed_min), float(r.efficiency))

    rows = sorted(out.values(), key=lambda n: n.night)
    if days:
        cutoff = (date.today() - timedelta(days=days)).isoformat()
        rows = [r for r in rows if r.night >= cutoff]
    return rows


def _configured_target() -> int | None:
    """`sleep.target_min` from config.json, if the user has set one."""
    try:
        import json
        cfg = json.loads((ROOT / "config.json").read_text())
        v = cfg.get("sleep", {}).get("target_min")
    except (OSError, ValueError):
        return None
    if not isinstance(v, (int, float)):
        return None
    v = int(v)
    return v if TARGET_FLOOR_MIN <= v <= TARGET_CEIL_MIN else None


def sleep_target(db: Path = DB) -> dict:
    """The nightly target debt is measured against, plus your own distribution.

    Returns `personal` purely as CONTEXT for the UI -- it is deliberately not
    used as the target. See the DEFAULT_TARGET_MIN comment for why.
    """
    rows = sleep_timeline(db, days=TARGET_LOOKBACK_DAYS)
    vals = pd.Series([r.asleep_min for r in rows], dtype="float64")
    personal = None
    if len(vals) >= 5:
        personal = {"n": int(len(vals)),
                    "median": round(float(vals.median())),
                    "p25": round(float(vals.quantile(0.25))),
                    "p75": round(float(vals.quantile(0.75)))}

    chosen = _configured_target()
    if chosen is not None:
        return {"minutes": chosen, "source": "you", "personal": personal,
                "note": "your target, set in config.json"}
    return {"minutes": DEFAULT_TARGET_MIN, "source": "default", "personal": personal,
            "note": ("the standard adult recommendation — sleep need can't be "
                     "measured from a ring, so change it in config.json if 8h "
                     "isn't yours")}


@dataclass
class SleepDebt:
    target_min: int
    window: int
    nights: list = field(default_factory=list)
    debt_min: float = 0.0
    covered: int = 0
    missing: int = 0
    target_note: str = ""
    target_source: str = "default"
    personal: dict | None = None
    sources: list = field(default_factory=list)
    mixed_sources: bool = False


def sleep_debt(db: Path = DB, window: int = DEBT_WINDOW_NIGHTS) -> SleepDebt:
    """Rolling cumulative shortfall against the personal target.

    Surplus pays debt DOWN but never banks credit: the running total is floored
    at zero. You cannot sleep 10h tonight and be owed sleep by the universe.
    """
    tgt = sleep_target(db)
    target = int(tgt["minutes"])
    have = {r.night: r for r in sleep_timeline(db, days=window + 2)}

    today = date.today()
    nights: list[dict] = []
    running = 0.0
    covered = missing = 0
    for i in range(window - 1, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        r = have.get(d)
        if r is None:
            # Not charged. Carries the running total forward untouched.
            missing += 1
            nights.append({"night": d, "asleep_min": None, "delta": None,
                           "cumulative": round(running), "source": None})
            continue
        covered += 1
        delta = r.asleep_min - target
        # delta<0 adds to the debt, delta>0 pays it down; the floor stops surplus
        # from becoming credit.
        running = max(0.0, running - delta)
        nights.append({"night": d, "asleep_min": round(r.asleep_min),
                       "delta": round(delta), "cumulative": round(running),
                       "source": r.source})

    # Which device produced the window. On the one night both measured, the ring
    # read 0.70x the Watch, so a window built from BOTH estimators carries a step
    # change that is an artefact of the switch, not of sleep. Surfaced rather
    # than hidden -- there is no scale factor to correct it with yet.
    srcs = {n["source"] for n in nights if n["source"]}
    return SleepDebt(target_min=target, window=window, nights=nights,
                     debt_min=round(running), covered=covered, missing=missing,
                     target_note=tgt["note"], target_source=tgt["source"],
                     personal=tgt["personal"], sources=sorted(srcs),
                     mixed_sources=len(srcs) > 1)


# ---------------------------------------------------------------- weekly trends

def _week_start(day: str) -> str:
    d = date.fromisoformat(day)
    return (d - timedelta(days=d.weekday())).isoformat()


def _daily_steps(db: Path) -> pd.DataFrame:
    """Daily step totals for the trend line.

    STEPS ARE NOT MERGED ACROSS DEVICES UNTIL CALIBRATION IS READY. baseline.py
    forbids it, and the data shows why: on 2026-08-22 the ring read 0.51x the
    Watch, on 2026-08-23 it read 2.23x. Swapping estimators mid-series would put
    a step change in the trend that looks exactly like a change in behaviour --
    the one thing a trend line exists to detect. So the Watch, which has years of
    continuous history, is the sole source until calibrate.py produces a scale
    factor; after that the ring is scaled onto the Watch's footing and preferred
    for the days it fully covered.
    """
    from ring_analysis import calibrate

    with _conn(db) as c:
        ring = pd.read_sql_query(
            "SELECT date(timestamp) day, SUM(steps) steps, COUNT(*) hours "
            "FROM sport_details GROUP BY day", c)
        watch = pd.read_sql_query(
            "SELECT substr(start_ts,1,10) day, SUM(value) steps "
            "FROM reference_samples WHERE kind='steps' GROUP BY day", c)

    rows: dict[str, dict] = {}
    for r in watch.itertuples():
        rows[str(r.day)] = {"day": str(r.day), "steps": float(r.steps), "source": "watch"}

    cal = calibrate.calibrate_steps(db)
    if cal.ready and cal.scale:
        for r in ring.itertuples():
            # A partial ring day would read as a collapse in activity beside a
            # full Watch day, so the ring only supersedes the Watch once it
            # covered most of the waking day.
            if int(r.hours) >= 12:
                rows[str(r.day)] = {"day": str(r.day),
                                    "steps": float(r.steps) * cal.scale,
                                    "source": "ring"}
    return pd.DataFrame(sorted(rows.values(), key=lambda x: x["day"]))


def _daily_resting_hr(db: Path) -> pd.DataFrame:
    with _conn(db) as c:
        df = pd.read_sql_query(
            "SELECT substr(start_ts,1,10) day, AVG(value) v "
            "FROM reference_samples WHERE kind='resting_hr' GROUP BY day", c)
    return df.rename(columns={"v": "value"})


def _daily_series(db: Path, kind: str) -> pd.DataFrame:
    with _conn(db) as c:
        df = pd.read_sql_query(
            "SELECT day, AVG(value) value FROM series_samples WHERE kind=? GROUP BY day",
            c, params=(kind,))
    return df


def _weekly_agg(daily: pd.DataFrame, value_col: str, weeks: int,
                round_to: int = 0) -> list[dict]:
    """Collapse a day-indexed frame into the last `weeks` ISO weeks."""
    if daily.empty:
        return []
    df = daily.copy()
    df["week"] = df["day"].map(_week_start)
    g = df.groupby("week")[value_col].agg(["mean", "count"]).reset_index()

    this_week = _week_start(date.today().isoformat())
    keep = [(date.fromisoformat(this_week) - timedelta(weeks=i)).isoformat()
            for i in range(weeks - 1, -1, -1)]
    g = g[g["week"].isin(keep)].sort_values("week")

    have = {str(r.week): r for r in g.itertuples()}

    out: list[dict] = []
    for i, wk in enumerate(keep):
        r = have.get(wk)
        if r is None:
            # EMITTED, not skipped. Dropping empty weeks collapsed the x-axis:
            # a five-week silence rendered the same width as one week, and the
            # last bar meant a different week in every chart on the page. Every
            # metric now spans the identical `weeks` slots so the charts can
            # actually be read against each other.
            out.append({"week": wk, "value": None, "n": 0,
                        "delta": None, "thin": True})
            continue
        val = round(float(r.mean), round_to) if round_to else round(float(r.mean))
        # Delta ONLY against the immediately preceding week.
        #
        # This used to compare against the previous ROW, and weeks with no data
        # are not rows -- so a gap from 07-13 to 08-17 was reported as a
        # week-over-week change of -375 minutes. Five weeks of silence rendered
        # as one bad week. A delta across a gap is not a delta; it is null.
        prev_wk = keep[i - 1] if i > 0 else None
        prev = have.get(prev_wk) if prev_wk else None
        if prev is None:
            delta = None
        else:
            pv = round(float(prev.mean), round_to) if round_to else round(float(prev.mean))
            delta = round(val - pv, round_to or None)
        out.append({
            "week": wk,
            "value": val,
            "n": int(r.count),
            "delta": delta,
            # A week built from one or two days is not a week; say so rather than
            # letting a single outlier day draw a trend line.
            "thin": int(r.count) < 3,
        })
    return out


TREND_SPECS = [
    ("sleep_min", "Sleep", "min", "up"),
    ("steps", "Steps", "", "up"),
    ("resting_hr", "Resting HR", "bpm", "down"),
    ("hrv", "HRV", "ms", "up"),
    ("efficiency", "Sleep efficiency", "%", "up"),
]


def weekly_trends(db: Path = DB, weeks: int = TREND_WEEKS) -> dict:
    """Week-over-week means for the metrics with enough history to mean anything.

    `better` records which direction is an improvement so the UI never has to
    guess that a falling resting heart rate is good news.
    """
    timeline = sleep_timeline(db, days=weeks * 7 + 14)
    sleep_daily = pd.DataFrame([{"day": r.night, "sleep_min": r.asleep_min}
                                for r in timeline])
    eff_daily = pd.DataFrame([{"day": r.night, "efficiency": r.efficiency}
                              for r in timeline if r.efficiency is not None])

    series: dict[str, list[dict]] = {
        "sleep_min": _weekly_agg(sleep_daily, "sleep_min", weeks),
        "steps": _weekly_agg(_daily_steps(db), "steps", weeks),
        "resting_hr": _weekly_agg(_daily_resting_hr(db), "value", weeks, round_to=1),
        "hrv": _weekly_agg(_daily_series(db, "hrv"), "value", weeks, round_to=1),
        "efficiency": _weekly_agg(eff_daily, "efficiency", weeks, round_to=1),
    }

    metrics = []
    for key, title, unit, better in TREND_SPECS:
        rows = series.get(key) or []
        if not any(r["value"] is not None for r in rows):
            continue
        present = [r for r in rows if r["value"] is not None]
        solid = [r for r in rows if not r["thin"]]
        this_week = _week_start(date.today().isoformat())
        metrics.append({
            "key": key, "title": title, "unit": unit, "better": better,
            "weeks": rows,
            # The newest week that HAS data -- rows[-1] is now always the current
            # week and is frequently empty.
            "latest": present[-1]["value"],
            # WHICH week that number is for. Steps stop at the Watch's last day,
            # so "latest" was reporting a week-old figure with nothing to say so
            # -- next to Sleep, which was current. A headline number has to carry
            # its own date or it is read as today's.
            "latest_week": present[-1]["week"],
            "stale": present[-1]["week"] != this_week,
            "delta": present[-1]["delta"],
            # Comparable only when both this week and the one before are real
            # weeks; two thin weeks next to each other is noise, not a trend.
            "comparable": (present[-1]["delta"] is not None
                           and not present[-1]["thin"]),
            "n_weeks": len(solid),
        })
    return {"weeks": weeks, "metrics": metrics,
            "generated_for": _week_start(date.today().isoformat())}


def daily_inputs(db: Path = DB, weeks: int = TREND_WEEKS) -> dict:
    """The per-day numbers `_weekly_agg` consumes, shipped alongside the result.

    Without these the phone can only *patch* a weekly average -- add a day to a
    mean it cannot see the terms of -- which is arithmetic on a rounded number
    and drifts. With them the phone appends its new day and re-runs the same
    aggregation the Mac ran, so an offline trend is not an approximation of the
    Mac's trend; it is the Mac's trend with one more day in it.

    Small: eight weeks of five metrics is a few hundred numbers.
    """
    timeline = sleep_timeline(db, days=weeks * 7 + 14)
    # Trimmed to the trend window. _daily_steps and _daily_resting_hr return the
    # whole Watch archive -- 2,500 rows of history the weekly aggregation then
    # discards. Shipping it would have added ~80KB to a snapshot the phone caches.
    cutoff = (date.today() - timedelta(days=weeks * 7 + 14)).isoformat()

    def rows(df, col):
        if df.empty:
            return []
        return [{"day": str(r.day), "value": float(getattr(r, col))}
                for r in df.itertuples() if str(r.day) >= cutoff]
    return {
        "sleep_min": [{"day": r.night, "value": r.asleep_min, "source": r.source}
                      for r in timeline],
        "efficiency": [{"day": r.night, "value": r.efficiency} for r in timeline
                       if r.efficiency is not None],
        "steps": rows(_daily_steps(db), "steps"),
        "resting_hr": rows(_daily_resting_hr(db), "value"),
        "hrv": rows(_daily_series(db, "hrv"), "value"),
    }


def build(db: Path = DB) -> dict:
    d = sleep_debt(db)
    return {
        "daily": daily_inputs(db),
        "sleep_debt": {
            "target_min": d.target_min, "window": d.window,
            "debt_min": d.debt_min, "covered": d.covered, "missing": d.missing,
            "nights": d.nights, "target_note": d.target_note,
            "target_source": d.target_source, "personal": d.personal,
            "sources": d.sources, "mixed_sources": d.mixed_sources,
        },
        "trends": weekly_trends(db),
    }


if __name__ == "__main__":
    from datetime import datetime as _dt

    d = sleep_debt()
    print(f"target {d.target_min // 60}h{d.target_min % 60:02d}  ({d.target_note})")
    print(f"debt {d.debt_min / 60:.1f}h over {d.covered}/{d.window} nights "
          f"({d.missing} missing)")
    for n in d.nights:
        if n["asleep_min"] is None:
            print(f"  {n['night']}  --")
        else:
            print(f"  {n['night']}  {n['asleep_min']:>4}m  "
                  f"{n['delta']:+5}  cum {n['cumulative']:>4}  {n['source']}")
    print()
    for m in weekly_trends()["metrics"]:
        print(f"{m['title']:>16}  latest {m['latest']}{m['unit']} "
              f"delta {m['delta']} comparable={m['comparable']} weeks={len(m['weeks'])}")
    del _dt
