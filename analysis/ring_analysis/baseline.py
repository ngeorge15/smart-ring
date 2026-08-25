"""
Personal baselines. "Is this normal FOR YOU", never a population norm.

CROSS-DEVICE SEEDING RULE
-------------------------
A baseline may only be seeded from the Watch when the Watch measures THE SAME
QUANTITY. Verified 2026-08-23 against real data:

  resting_hr  SEEDABLE   both count/min, directly comparable
  sleep_min   SEEDABLE   both minutes asleep (different estimators, same quantity)
  hrv         FORBIDDEN  Apple records SDNN (mean 68.9ms); the ring reports an
                         RMSSD-like value (mean 40.5ms). Different metrics ~1.7x
                         apart -- seeding would read as chronically low HRV.
  steps       FORBIDDEN  until calibration produces a scale factor (see calibrate.py)
  spo2/stress FORBIDDEN  no comparable Watch metric

Metrics that cannot be seeded build their own baseline from ring data and are
simply LOW CONFIDENCE until enough nights accumulate. That is the honest answer;
borrowing an incompatible baseline is not.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "ring_data.sqlite"

SEEDABLE = {"resting_hr", "sleep_min"}
MIN_N_CONFIDENT = 14
# Below this, percentile scoring is degenerate -- see Baseline.pct.
MIN_N_SCORABLE = 7


@dataclass
class Baseline:
    metric: str
    source: str
    n: int
    mean: float
    sd: float
    p10: float
    p50: float
    p90: float
    note: str = ""

    @property
    def confidence(self) -> float:
        """0-1. Ramps with sample count; never claims certainty from thin data."""
        return float(min(1.0, self.n / MIN_N_CONFIDENT))

    def z(self, value: float | None) -> float | None:
        if value is None or self.sd in (0, None) or np.isnan(self.sd):
            return None
        return float((value - self.mean) / self.sd)

    def pct(self, value: float | None, min_n: int = MIN_N_SCORABLE) -> float | None:
        """Where value falls in your own distribution (0-100).

        Below `min_n` this returns None rather than a number. With three samples
        p10 is essentially the minimum, so every new low scored exactly 10 and
        every new high exactly 90 -- two nearly identical deviations landing at
        opposite extremes. That is not a measurement, and the honest answer is to
        decline to score and let the weight redistribute.
        """
        if value is None or self.n < min_n:
            return None
        lo, mid, hi = self.p10, self.p50, self.p90
        if value <= lo:
            return 10.0
        if value >= hi:
            return 90.0
        if value < mid:
            return 10 + 40 * (value - lo) / (mid - lo) if mid > lo else 50.0
        return 50 + 40 * (value - mid) / (hi - mid) if hi > mid else 50.0

    def describe(self) -> str:
        return (f"{self.metric}: {self.mean:.1f} +/- {self.sd:.1f} "
                f"(n={self.n}, {self.source}, conf {self.confidence:.0%}) {self.note}")


def _stats(metric: str, source: str, values: pd.Series, note: str = "") -> Baseline:
    v = pd.to_numeric(values, errors="coerce").dropna()
    if v.empty:
        return Baseline(metric, source, 0, float("nan"), float("nan"),
                        float("nan"), float("nan"), float("nan"), "no data")
    return Baseline(metric, source, len(v), float(v.mean()), float(v.std(ddof=0)),
                    float(v.quantile(0.10)), float(v.quantile(0.50)),
                    float(v.quantile(0.90)), note)


def _conn(db: Path):
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def resting_hr_baseline(db: Path = DB, days: int = 90) -> Baseline:
    """Seeded from Watch history -- same quantity, same units."""
    with _conn(db) as c:
        df = pd.read_sql_query(
            "SELECT value FROM reference_samples WHERE kind='resting_hr' "
            "AND start_ts >= date('now', ?) ", c, params=(f"-{days} day",))
    return _stats("resting_hr", "apple_watch", df["value"],
                  f"last {days}d of Watch history")


def sleep_baseline(db: Path = DB, days: int = 90) -> Baseline:
    """Seeded from Watch: different estimator, but the same quantity (minutes asleep)."""
    with _conn(db) as c:
        df = pd.read_sql_query(
            "SELECT substr(start_ts,1,10) AS day, SUM(value) AS mins "
            "FROM reference_samples WHERE kind='sleep' "
            "AND stage IN ('light','deep','REM','asleep') "
            "AND start_ts >= date('now', ?) GROUP BY day", c, params=(f"-{days} day",))
    df = df[df["mins"] > 120]
    return _stats("sleep_min", "apple_watch", df["mins"],
                  "Watch estimator; ring will diverge until calibrated")


def ring_series_baseline(kind: str, db: Path = DB) -> Baseline:
    """
    Ring-only baseline. NOT seedable from the Watch -- see module docstring.
    Low confidence until ~14 days accumulate, and says so.
    """
    with _conn(db) as c:
        df = pd.read_sql_query(
            "SELECT day, AVG(value) AS v FROM series_samples WHERE kind=? GROUP BY day",
            c, params=(kind,))
    note = "ring-only" if kind not in SEEDABLE else ""
    b = _stats(kind, "ring", df["v"], note)
    if b.n < MIN_N_CONFIDENT:
        b.note = (f"ring-only, {b.n}/{MIN_N_CONFIDENT} days -- cannot be seeded "
                  f"from Watch (different metric)")
    return b


def all_baselines(db: Path = DB) -> dict[str, Baseline]:
    return {
        "resting_hr": resting_hr_baseline(db),
        "sleep_min": sleep_baseline(db),
        "hrv": ring_series_baseline("hrv", db),
        "stress": ring_series_baseline("stress", db),
        "spo2": ring_series_baseline("spo2", db),
    }


if __name__ == "__main__":
    for b in all_baselines().values():
        print(" ", b.describe())
