"""
Decode a capture posted by the phone and store it.

The phone is a dumb pipe: it executes sync_plan.build() and posts back the raw
notification bytes. ALL protocol knowledge stays here, so a decode fix is a
Python edit with no phone-side change -- which is the whole point of splitting
it this way.

Reuses the exact parsers the Mac's own BLE sync uses (colmi_bigdata,
colmi_extra, colmi_r02_client). There is deliberately no second implementation
to drift: the phone contributes bytes, never meaning.

Run:  ingest.py <capture.json>          (needs the pipx venv interpreter)
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import colmi_bigdata as bd
import colmi_extra as ce
import store

def _python_with_pandas() -> str:
    """Find an interpreter that can actually run the analysis stack.

    shutil.which("python3") resolves against the caller's PATH, and a LaunchAgent
    does not inherit a login shell's -- so the server picked a python without
    pandas and every rebuild failed with ModuleNotFoundError. Candidates are
    TESTED rather than assumed.
    """
    seen = []
    for cand in (shutil.which("python3"),
                 "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
                 "/opt/homebrew/bin/python3", "/usr/local/bin/python3",
                 "/usr/bin/python3"):
        if not cand or cand in seen:
            continue
        seen.append(cand)
        try:
            r = subprocess.run([cand, "-c", "import pandas"],
                               capture_output=True, timeout=30)
            if r.returncode == 0:
                return cand
        except Exception:
            continue
    return seen[0] if seen else "/usr/bin/python3"


ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "ring_data.sqlite"
RING_ADDRESS = "B9606358-9C44-11D9-8CF4-7B42D630E23A"
# The analysis stack (pandas/numpy) lives on the system interpreter, NOT the
# pipx venv this module runs under.
PYTHON3 = None  # resolved lazily by _python_with_pandas()


def _ts(dt: datetime) -> str:
    """Match the colmi library's timestamp format exactly.

    It writes microseconds; this module used to write none. Two formats in one
    column made pandas' date inference produce NaT for whichever it did not
    guess, and those rows were then dropped -- losing every phone-captured
    reading. load.py now parses tolerantly as well; this keeps new rows uniform
    so the problem cannot come back by another route.
    """
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")


def _chunks(step: dict) -> list[bytes]:
    return [bytes.fromhex(h) for h in step.get("chunks", []) if h]


def _ring_and_sync(conn: sqlite3.Connection, comment: str) -> tuple[int, int]:
    row = conn.execute("SELECT ring_id FROM rings WHERE address=?",
                       (RING_ADDRESS,)).fetchone()
    if row is None:
        cur = conn.execute("INSERT INTO rings (address) VALUES (?)", (RING_ADDRESS,))
        ring_id = int(cur.lastrowid)
    else:
        ring_id = int(row[0])
    cur = conn.execute(
        "INSERT INTO syncs (comment, ring_id, timestamp) VALUES (?,?,?)",
        (comment, ring_id, datetime.now().isoformat(sep=" ")))
    return ring_id, int(cur.lastrowid)


# --------------------------------------------------------------------- handlers

def _do_battery(conn, step, ctx) -> int:
    for p in _chunks(step):
        if len(p) >= 3 and p[0] == 3:
            store.save_battery(conn, int(p[1]), bool(p[2]))
            return 1
    return 0


def _do_hr(conn, step, ctx) -> int:
    """Replay packets through the library's own state machine."""
    from colmi_r02_client.hr import HeartRateLogParser, HeartRateLog

    parser = HeartRateLogParser()
    log = None
    for p in _chunks(step):
        got = parser.parse(bytearray(p))
        if isinstance(got, HeartRateLog):
            log = got
            break
    if log is None:
        return 0

    ring_id, sync_id = ctx["ids"]
    n = 0
    for reading, ts in log.heart_rates_with_times():
        if not reading:           # 0 means "no sample", not a heart rate of zero
            continue
        conn.execute(
            "INSERT OR IGNORE INTO heart_rates (reading, timestamp, ring_id, sync_id) "
            "VALUES (?,?,?,?)",
            (int(reading), _ts(ts.replace(tzinfo=None)), ring_id, sync_id))
        n += 1
    return n


def _do_steps(conn, step, ctx) -> int:
    from colmi_r02_client.steps import SportDetailParser, SportDetail, NoData

    parser = SportDetailParser()
    details: list = []
    for p in _chunks(step):
        got = parser.parse(bytearray(p))
        if isinstance(got, NoData):
            return 0
        if isinstance(got, list):
            details = got
            break

    ring_id, sync_id = ctx["ids"]
    n = 0
    for d in details:
        if not isinstance(d, SportDetail):
            continue
        # SportDetail.year ALREADY includes the +2000 (steps.py does
        # bcd_to_decimal(packet[1]) + 2000). Adding it again produced year 4026,
        # and every row was then deleted by drop_future_rows -- which is exactly
        # what that guard is for, but it meant steps silently vanished.
        ts = datetime(d.year, d.month, d.day) + timedelta(minutes=15 * d.time_index)
        conn.execute(
            "INSERT OR IGNORE INTO sport_details "
            "(calories, steps, distance, timestamp, ring_id, sync_id) VALUES (?,?,?,?,?,?)",
            (int(d.calories), int(d.steps), int(d.distance),
             _ts(ts), ring_id, sync_id))
        n += 1
    return n


def _do_log(cmd: int, kind: str):
    def handler(conn, step, ctx) -> int:
        series = ce.parse_log(cmd, _chunks(step))
        if not any(v for v in series.values):
            return 0
        # The ring echoes the requested offset back, so the day is read, never
        # assumed -- a request that silently returns a different day is caught.
        day = (date.today() - timedelta(days=series.day_offset)).isoformat()
        return store.save_series(conn, kind, day, series.interval_minutes, series.values)
    return handler


def _do_sleep(conn, step, ctx) -> int:
    blob = b"".join(_chunks(step))
    total = 0
    for msg in bd.split_messages(blob):
        nights = bd.parse_sleep(msg)
        total += store.save_sleep(conn, nights)
    return total


def _do_series_bigdata(kind: str, parser):
    def handler(conn, step, ctx) -> int:
        blob = b"".join(_chunks(step))
        n = 0
        for msg in bd.split_messages(blob):
            for rec in parser(msg):
                if kind == "temp_raw":
                    days_ago, interval, values = rec
                else:
                    days_ago, values = rec
                    interval = 30
                day = (date.today() - timedelta(days=days_ago)).isoformat()
                n += store.save_series(conn, kind, day, interval, values)
        return n
    return handler


HANDLERS = {
    "battery": _do_battery,
    "hr": _do_hr,
    "steps": _do_steps,
    "hrv": _do_log(ce.CMD_HRV_LOG, "hrv"),
    "stress": _do_log(ce.CMD_PRESSURE_LOG, "stress"),
    "sleep": _do_sleep,
    "spo2": _do_series_bigdata("spo2", bd.parse_spo2),
    "temp": _do_series_bigdata("temp_raw", bd.parse_temperature),
}


def ingest(capture: dict, db: Path = DB) -> dict:
    conn = store.connect(db)
    summary: dict[str, int] = {}
    errors: list[str] = []
    ctx = {"ids": _ring_and_sync(conn, f"phone {capture.get('source', '?')}")}

    for step in capture.get("steps", []):
        kind = step.get("kind")
        fn = HANDLERS.get(kind)
        if fn is None:
            errors.append(f"{step.get('id')}: no handler for kind {kind!r}")
            continue
        if not step.get("chunks"):
            continue                      # nothing came back; not an error
        try:
            summary[kind] = summary.get(kind, 0) + fn(conn, step, ctx)
        except Exception as e:            # one bad decode must not lose the rest
            errors.append(f"{step.get('id')}: {type(e).__name__}: {e}")

    summary["normalised_timestamps"] = store.normalise_timestamps(conn)
    summary["dropped_future_rows"] = store.drop_future_rows(conn)
    conn.commit()
    conn.close()
    return {"stored": summary, "errors": errors}


def rebuild() -> subprocess.CompletedProcess:
    """Regenerate the snapshot and dashboard after storing.

    Without this the pipeline stopped at the database: a phone sync landed new
    readings but the dashboard kept serving whatever snapshot happened to be
    built last, so the app looked stale even though the data had arrived.

    Runs in a SUBPROCESS, not in-process. This module runs under the pipx venv
    (it needs colmi_r02_client), and that venv has no pandas -- so importing
    build_web here raised ModuleNotFoundError, which the caller's except caught
    and turned into a silent no-op. The analysis stack lives on the system
    interpreter; call that one explicitly.
    """
    return subprocess.run(
        [_python_with_pandas(), "-m", "ring_analysis.build_web"],
        cwd=str(ROOT / "analysis"), capture_output=True, text=True, timeout=300)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: ingest.py <capture.json>")
    path = Path(sys.argv[1])
    result = ingest(json.loads(path.read_text()))
    print(json.dumps(result, indent=1))
    for e in result["errors"]:
        print("  ERROR", e, file=sys.stderr)

    if "--no-rebuild" not in sys.argv:
        try:
            r = rebuild()
            if r.returncode == 0:
                print("  rebuilt dashboard")
            else:
                # Loud, not swallowed: a silent rebuild failure is exactly how
                # the dashboard went stale while the data was arriving fine.
                print(f"  REBUILD FAILED (exit {r.returncode})", file=sys.stderr)
                print((r.stderr or r.stdout)[-500:], file=sys.stderr)
        except Exception as e:      # storing succeeded; a failed rebuild is not fatal
            print(f"  REBUILD FAILED: {type(e).__name__}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
