"""Load raw ring data out of the colmi_r02_client sqlite database.

Timestamps in that DB are naive LOCAL time (verified against the ring clock),
which is what we want -- sleep analysis is inherently circadian, so local time
is the correct frame. We never silently coerce to UTC.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pandas as pd

DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "ring_data.sqlite"


def _read(db: Path, sql: str) -> pd.DataFrame:
    """Read a query, parsing `timestamp` tolerantly.

    Rows arrive from two writers with DIFFERENT string formats: the colmi
    library stores microseconds ('...13:05:00.000000'), tools/ingest.py did not
    ('...20:25:00'). pandas' parse_dates= infers ONE format from the leading
    rows and yields NaT for the rest -- which dropna() then silently deleted.
    That quietly discarded every heart-rate and step row captured by the phone.

    format="mixed" parses each value on its own terms. Anything genuinely
    unparseable still becomes NaT and is dropped by the callers, but a mere
    difference in precision no longer loses data.
    """
    if not db.exists():
        raise FileNotFoundError(f"No ring database at {db}. Run tools/sync_noscan.py first.")
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        df = pd.read_sql_query(sql, conn)
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], format="mixed", errors="coerce")
    return df


def load_heart_rate(db: Path = DEFAULT_DB) -> pd.DataFrame:
    """Raw periodic HR log. Columns: timestamp, bpm."""
    df = _read(db, "SELECT timestamp, reading AS bpm FROM heart_rates ORDER BY timestamp")
    # reading == 0 is the ring's "no measurement" sentinel, not a real 0 bpm.
    df.loc[df["bpm"] <= 0, "bpm"] = pd.NA
    df["bpm"] = df["bpm"].astype("Float64")
    return df.dropna(subset=["timestamp"]).reset_index(drop=True)


def load_activity(db: Path = DEFAULT_DB) -> pd.DataFrame:
    """Hourly activity buckets. Columns: timestamp, steps, calories_raw, distance_raw.

    UNITS (resolved 2026-08-23):
      distance -> METRES. distance/steps holds at 0.68-0.82 across every hour with
        >100 steps (mean 0.754), which is a normal walking stride. An earlier call
        that it "does not match metres" was made on a single partial day.
      calories -> MILLI-kcal (divide by 1000). ~45 raw units/step = 0.045 kcal/step.
        Less firmly pinned than distance; treat kcal as approximate.
    The _raw suffix is kept so the conversion stays explicit at the point of use.
    """
    return _read(
        db,
        "SELECT timestamp, steps, calories AS calories_raw, distance AS distance_raw "
        "FROM sport_details ORDER BY timestamp",
    ).reset_index(drop=True)


def data_span(db: Path = DEFAULT_DB) -> dict:
    hr = load_heart_rate(db)
    if hr.empty:
        return {"first": None, "last": None, "days": 0, "hr_samples": 0}
    first, last = hr["timestamp"].min(), hr["timestamp"].max()
    return {
        "first": first.isoformat(),
        "last": last.isoformat(),
        "days": round((last - first).total_seconds() / 86400, 2),
        "hr_samples": int(hr["bpm"].notna().sum()),
    }
