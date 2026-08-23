"""
Import Apple Health export as a REFERENCE track for calibrating the ring.

The Watch is not ground truth -- it's a second estimate. We store it separately
and never merge it into ring tables, so every comparison stays honest.

Usage:
    python import_apple_health.py ~/Downloads/export.zip
    python import_apple_health.py ~/Downloads/apple_health_export/export.xml

Export from iPhone: Health app -> profile picture -> Export All Health Data.

NOTE: HKQuantityTypeIdentifierAppleSleepingWristTemperature exists on Apple
Watch Series 8+. If present it fills the one gap the ring can't cover, since no
temperature command is documented for the Colmi hardware.
"""
from __future__ import annotations

import sqlite3
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

DB = Path(__file__).resolve().parents[1] / "data" / "ring_data.sqlite"

WANTED = {
    "HKQuantityTypeIdentifierStepCount": "steps",
    "HKQuantityTypeIdentifierHeartRate": "hr",
    "HKQuantityTypeIdentifierOxygenSaturation": "spo2",
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": "hrv",
    "HKQuantityTypeIdentifierAppleSleepingWristTemperature": "wrist_temp",
    "HKQuantityTypeIdentifierRestingHeartRate": "resting_hr",
    "HKCategoryTypeIdentifierSleepAnalysis": "sleep",
}

SLEEP_STAGE = {
    "HKCategoryValueSleepAnalysisInBed": "in_bed",
    "HKCategoryValueSleepAnalysisAwake": "awake",
    "HKCategoryValueSleepAnalysisAsleepREM": "REM",
    "HKCategoryValueSleepAnalysisAsleepDeep": "deep",
    "HKCategoryValueSleepAnalysisAsleepCore": "light",
    "HKCategoryValueSleepAnalysisAsleepUnspecified": "asleep",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS reference_samples (
    source   TEXT NOT NULL,
    kind     TEXT NOT NULL,
    start_ts TEXT NOT NULL,
    end_ts   TEXT,
    value    REAL,
    stage    TEXT,
    unit     TEXT,
    PRIMARY KEY (source, kind, start_ts, stage)
);
CREATE INDEX IF NOT EXISTS ix_ref_kind_ts ON reference_samples(kind, start_ts);
"""


def parse_ts(s: str | None):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")
    except ValueError:
        return None


def open_xml(path: Path):
    if path.suffix == ".zip":
        z = zipfile.ZipFile(path)
        name = next((n for n in z.namelist() if n.endswith("export.xml")), None)
        if not name:
            sys.exit("No export.xml inside the zip.")
        print(f"reading {name} from zip")
        return z.open(name)
    return open(path, "rb")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1]).expanduser()
    if not src.exists():
        sys.exit(f"Not found: {src}")

    conn = sqlite3.connect(DB)
    conn.executescript(SCHEMA)

    counts: dict[str, int] = {}
    rows = []
    seen_types: set[str] = set()

    with open_xml(src) as fh:
        for event, el in ET.iterparse(fh, events=("end",)):
            if el.tag != "Record":
                continue
            rtype = el.get("type", "")
            seen_types.add(rtype)
            kind = WANTED.get(rtype)
            if kind:
                start, end = el.get("startDate"), el.get("endDate")
                raw = el.get("value")
                stage = ""
                value = None
                if kind == "sleep":
                    stage = SLEEP_STAGE.get(raw or "", raw or "")
                    st, en = parse_ts(start), parse_ts(end)
                    value = (en - st).total_seconds() / 60 if st and en else None
                else:
                    try:
                        value = float(raw)
                    except (TypeError, ValueError):
                        value = None
                if value is not None:
                    rows.append((el.get("sourceName", "?"), kind, start, end,
                                 value, stage, el.get("unit", "")))
                    counts[kind] = counts.get(kind, 0) + 1
            el.clear()

            if len(rows) >= 20000:
                conn.executemany("INSERT OR REPLACE INTO reference_samples "
                                 "(source,kind,start_ts,end_ts,value,stage,unit) "
                                 "VALUES (?,?,?,?,?,?,?)", rows)
                conn.commit(); rows.clear()

    if rows:
        conn.executemany("INSERT OR REPLACE INTO reference_samples "
                         "(source,kind,start_ts,end_ts,value,stage,unit) "
                         "VALUES (?,?,?,?,?,?,?)", rows)
    conn.commit()

    print("\n=== imported ===")
    for k, v in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {k:12} {v:>8,}")
    if "wrist_temp" in counts:
        print("\n  wrist temperature FOUND -- this covers the ring's missing sensor.")
    else:
        print("\n  no wrist temperature (needs Apple Watch Series 8+).")
    conn.close()


if __name__ == "__main__":
    main()
