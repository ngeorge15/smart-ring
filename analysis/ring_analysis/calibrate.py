"""
Ring-vs-reference calibration.

Only SYSTEMATIC bias is correctable. If the ring reads a consistent +20% on
steps, that's a scale factor. Random per-activity error (typing counted as
walking, hand in a pocket) is not recoverable from a finished step count -- that
needs raw accelerometer data and our own counter.

The Watch is a second estimate, not ground truth. Neither device saw
polysomnography. Disagreement locates a discrepancy; it does not adjudicate one.

COVERAGE
--------
We compare MATCHED HOURS, never daily totals. Partial wear days are the norm
(the ring's first day starts at 17:30) and a daily total silently compares 6
hours of ring against 24 hours of Watch, which reads as a huge fake undercount.
Hourly matching uses only intervals where BOTH devices were recording, so
partial days contribute their good hours instead of poisoning the fit.

Both sources are local wall-clock: ring timestamps are naive local, Apple Health
strings carry a local offset we slice off. Hours therefore align directly.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "ring_data.sqlite"
CONFIG = ROOT / "config.json"

MIN_MATCHED_HOURS = 120      # ~14 days x ~9 active hours
MIN_DISTINCT_DAYS = 7        # guard against one freak day dominating
ACTIVE_HOUR_FLOOR = 50       # steps; below this an hour is sedentary noise


def _cfg() -> dict:
    return json.loads(CONFIG.read_text()) if CONFIG.exists() else {}


def _has_reference(conn) -> bool:
    return conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='reference_samples'"
    ).fetchone() is not None


@dataclass
class Calibration:
    metric: str
    n: int
    required: int
    ready: bool
    scale: float | None = None
    median_ratio: float | None = None
    r2: float | None = None
    distinct_days: int = 0
    coverage: dict = field(default_factory=dict)
    note: str = ""

    def describe(self) -> str:
        if not self.ready:
            return (f"{self.metric}: {self.n}/{self.required} matched "
                    f"({self.distinct_days} days). {self.note}")
        return (f"{self.metric}: scale={self.scale:.3f} median_ratio={self.median_ratio:.3f} "
                f"r2={self.r2:.3f} (n={self.n} hours over {self.distinct_days} days). {self.note}")


def hourly_steps(db: Path = DB) -> pd.DataFrame:
    """Ring vs Watch steps per local clock-hour, inner-joined on coverage."""
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        ring = pd.read_sql_query(
            "SELECT substr(timestamp,1,13) AS hour, SUM(steps) AS ring_steps "
            "FROM sport_details GROUP BY hour", conn)
        if not _has_reference(conn):
            return pd.DataFrame(columns=["hour", "ring_steps", "watch_steps"])
        watch = pd.read_sql_query(
            "SELECT substr(start_ts,1,13) AS hour, SUM(value) AS watch_steps "
            "FROM reference_samples WHERE kind='steps' GROUP BY hour", conn)

    if ring.empty or watch.empty:
        return pd.DataFrame(columns=["hour", "ring_steps", "watch_steps"])

    # Apple slices as "YYYY-MM-DD HH"; ring as "YYYY-MM-DDTHH" or "YYYY-MM-DD HH".
    for df in (ring, watch):
        df["hour"] = df["hour"].str.replace("T", " ", regex=False)

    return ring.merge(watch, on="hour", how="inner").sort_values("hour")


def calibrate_steps(db: Path = DB) -> Calibration:
    m = hourly_steps(db)
    if m.empty:
        return Calibration("steps", 0, MIN_MATCHED_HOURS, False,
                           note="No overlapping hours yet -- run tools/import_apple_health.py.")

    days = sorted({h[:10] for h in m["hour"]})
    cov = {"first_hour": m["hour"].iloc[0], "last_hour": m["hour"].iloc[-1],
           "matched_hours": len(m), "days": len(days)}

    # Sedentary hours are mostly zeros on both devices; they inflate agreement
    # without carrying information about walking bias.
    active = m[(m["ring_steps"] >= ACTIVE_HOUR_FLOOR) | (m["watch_steps"] >= ACTIVE_HOUR_FLOOR)]
    n = len(active)

    if n < MIN_MATCHED_HOURS or len(days) < MIN_DISTINCT_DAYS:
        return Calibration("steps", n, MIN_MATCHED_HOURS, False, distinct_days=len(days),
                           coverage=cov, note="Accumulating (wear both).")

    x = active["ring_steps"].to_numpy(float)
    y = active["watch_steps"].to_numpy(float)
    # Through-origin scale: zero ring steps must mean zero Watch steps.
    scale = float((x * y).sum() / (x * x).sum())
    pred = scale * x
    ss_res = float(((y - pred) ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - ss_res / ss_tot if ss_tot else float("nan")
    ratios = y[x > 0] / x[x > 0]

    return Calibration("steps", n, MIN_MATCHED_HOURS, True, scale=scale,
                       median_ratio=float(np.median(ratios)) if len(ratios) else None,
                       r2=r2, distinct_days=len(days), coverage=cov,
                       note="scale is through-origin; prefer median_ratio if r2 is weak.")


def sleep_agreement(db: Path = DB) -> Calibration:
    required = int(_cfg().get("calibration", {}).get("min_paired_nights_sleep", 7))
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        ring = pd.read_sql_query(
            "SELECT night_of AS day, asleep_min AS ring_asleep, in_bed_min "
            "FROM sleep_nights", conn)
        if not _has_reference(conn):
            return Calibration("sleep", 0, required, False,
                               note="No reference sleep yet -- import Apple Health.")
        watch = pd.read_sql_query(
            "SELECT substr(start_ts,1,10) AS day, SUM(value) AS watch_asleep "
            "FROM reference_samples WHERE kind='sleep' "
            "AND stage IN ('light','deep','REM','asleep') GROUP BY day", conn)

    if ring.empty or watch.empty:
        return Calibration("sleep", 0, required, False,
                           note="No overlapping nights yet.")

    paired = ring.merge(watch, on="day", how="inner")
    # A night the ring only half-recorded (fell off, died) is not comparable.
    paired = paired[(paired["ring_asleep"] > 120) & (paired["watch_asleep"] > 120)]
    n = len(paired)
    if n < required:
        return Calibration("sleep", n, required, False, distinct_days=n,
                           note="Accumulating (wear both overnight).")

    diff = paired["ring_asleep"] - paired["watch_asleep"]
    return Calibration("sleep", n, required, True, scale=1.0,
                       median_ratio=float((paired["ring_asleep"] / paired["watch_asleep"]).median()),
                       r2=float(paired["ring_asleep"].corr(paired["watch_asleep"])),
                       distinct_days=n,
                       note=f"ring reads {diff.mean():+.0f} min vs Watch (sd {diff.std():.0f}); "
                            f"r2 here is correlation, not a fit.")


def coverage_report(db: Path = DB) -> str:
    """What the ring actually recorded per day -- exposes partial-wear days."""
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        df = pd.read_sql_query(
            "SELECT date(timestamp) AS day, COUNT(*) AS hours, "
            "MIN(time(timestamp)) AS first, MAX(time(timestamp)) AS last, "
            "SUM(steps) AS steps FROM sport_details GROUP BY day ORDER BY day", conn)
    if df.empty:
        return "no ring activity data"
    df["partial"] = np.where(df["hours"] < 12, "PARTIAL", "")
    return df.to_string(index=False)


if __name__ == "__main__":
    print("=== ring coverage per day ===")
    print(coverage_report())
    print()
    print(calibrate_steps().describe())
    print(sleep_agreement().describe())
