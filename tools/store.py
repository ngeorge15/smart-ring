"""
Extra tables alongside the colmi_r02_client schema, for data that library
doesn't capture: sleep stages, SpO2, HRV and stress.

Stdlib sqlite3 only -- this runs inside the pipx venv (bleak/colmi), which has
no pandas. The analysis package reads these tables separately.

Timestamp honesty: sleep segments carry true timestamps decoded from the ring.
SpO2/HRV/stress arrive as bare index-based series with an interval field and no
absolute clock, so we store index + interval and mark ts_inferred = 1. Nothing
downstream may treat those as measured times.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "data" / "ring_data.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sleep_nights (
    night_of   TEXT PRIMARY KEY,
    onset      TEXT NOT NULL,
    in_bed_min INTEGER NOT NULL,
    asleep_min INTEGER NOT NULL,
    light_min  INTEGER DEFAULT 0,
    deep_min   INTEGER DEFAULT 0,
    rem_min    INTEGER DEFAULT 0,
    awake_min  INTEGER DEFAULT 0,
    efficiency REAL,
    synced_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sleep_segments (
    night_of TEXT NOT NULL,
    start_ts TEXT NOT NULL,
    stage    TEXT NOT NULL,
    minutes  INTEGER NOT NULL,
    PRIMARY KEY (night_of, start_ts)
);
CREATE TABLE IF NOT EXISTS battery_log (
    ts       TEXT PRIMARY KEY,
    level    INTEGER NOT NULL,
    charging INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS series_samples (
    kind        TEXT NOT NULL,      -- 'spo2' | 'hrv' | 'stress'
    day         TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    interval_min INTEGER NOT NULL,
    value       REAL NOT NULL,
    ts_inferred INTEGER DEFAULT 1,
    PRIMARY KEY (kind, day, idx)
);
"""


def connect(db: Path = DB) -> sqlite3.Connection:
    conn = sqlite3.connect(db)
    conn.executescript(SCHEMA)
    return conn


def save_sleep(conn, nights) -> int:
    n = 0
    for night in nights:
        t = night.totals
        conn.execute(
            "INSERT OR REPLACE INTO sleep_nights "
            "(night_of,onset,in_bed_min,asleep_min,light_min,deep_min,rem_min,awake_min,efficiency)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (night.night_of.isoformat(), night.onset.isoformat(), night.time_in_bed,
             night.asleep, t.get("light", 0), t.get("deep", 0), t.get("REM", 0),
             t.get("awake", 0), round(night.efficiency, 2)),
        )
        # Replace the night wholesale. The primary key is (night_of, start_ts),
        # so if a parser change shifts segment times the old rows are NOT
        # overwritten -- they accumulate alongside the new ones and silently
        # double every stage total. Clear first.
        conn.execute("DELETE FROM sleep_segments WHERE night_of = ?",
                     (night.night_of.isoformat(),))
        for s in night.segments:
            conn.execute(
                "INSERT OR REPLACE INTO sleep_segments (night_of,start_ts,stage,minutes)"
                " VALUES (?,?,?,?)",
                (night.night_of.isoformat(), s.start.isoformat(), s.stage, s.minutes),
            )
        n += 1
    conn.commit()
    return n


def save_series(conn, kind: str, day: str, interval_min: int, values) -> int:
    n = 0
    for i, v in enumerate(values):
        if v is None:
            continue
        conn.execute(
            "INSERT OR REPLACE INTO series_samples (kind,day,idx,interval_min,value)"
            " VALUES (?,?,?,?,?)",
            (kind, day, i, interval_min, float(v)),
        )
        n += 1
    conn.commit()
    return n


def normalise_timestamps(conn) -> int:
    """Force one timestamp spelling, and drop rows duplicated across spellings.

    Timestamps are TEXT, and two writers used different precision: the colmi
    library writes microseconds, an earlier version of tools/ingest.py did not.
    UNIQUE(ring_id, timestamp) compares strings, so the same reading stored both
    ways was NOT caught as a duplicate -- it silently DOUBLED step totals, and
    pandas' date inference then dropped whichever format it did not guess.

    Canonical form is with microseconds, matching the library. Runs on every
    ingest so drift is corrected as it appears rather than accumulating.
    """
    changed = 0
    for tbl in ("heart_rates", "sport_details"):
        changed += conn.execute(
            f"DELETE FROM {tbl} WHERE timestamp NOT LIKE '%.%' AND EXISTS ("
            f"  SELECT 1 FROM {tbl} b WHERE b.ring_id = {tbl}.ring_id"
            f"    AND b.timestamp = {tbl}.timestamp || '.000000')").rowcount
        changed += conn.execute(
            f"UPDATE {tbl} SET timestamp = timestamp || '.000000' "
            f"WHERE timestamp NOT LIKE '%.%'").rowcount
    return changed


def drop_future_rows(conn) -> int:
    """
    Delete ring rows timestamped in the future -- physically impossible, and the
    unambiguous signature of a ring clock running ahead of local time.

    Kept as a routine post-sync step: it is idempotent, and it self-limits once
    the clock is correct (a correct clock never produces future rows). Guards
    against any future clock drift silently corrupting the series.
    """
    from datetime import datetime
    now = datetime.now().isoformat(sep=" ")
    n = 0
    for table in ("heart_rates", "sport_details"):
        cur = conn.execute(f"DELETE FROM {table} WHERE timestamp > ?", (now,))
        n += cur.rowcount
    conn.commit()
    return n


def save_battery(conn, level: int, charging: bool) -> None:
    """One row per sync. A charge is later inferred from this series -- the ring
    reports no charge history, so the only way to know when it was last topped
    up is to have been watching."""
    from datetime import datetime
    conn.execute("INSERT OR REPLACE INTO battery_log (ts, level, charging) VALUES (?,?,?)",
                 (datetime.now().isoformat(timespec="seconds"), int(level), int(charging)))
    conn.commit()
