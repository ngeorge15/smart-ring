from __future__ import annotations

import importlib
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(REPO / "analysis"))


def _install_protocol_stubs() -> None:
    bd = types.ModuleType("colmi_bigdata")
    bd.BIG_DATA_CMD = 0xBC
    bd.parse_sleep = lambda *_args, **_kwargs: []
    bd.parse_spo2 = lambda *_args, **_kwargs: []
    bd.parse_temperature = lambda *_args, **_kwargs: []
    ce = types.ModuleType("colmi_extra")
    ce.CMD_HRV_LOG = 57
    ce.CMD_PRESSURE_LOG = 55
    ce.parse_log = lambda *_args, **_kwargs: None
    sys.modules.setdefault("colmi_bigdata", bd)
    sys.modules.setdefault("colmi_extra", ce)


_install_protocol_stubs()
import ingest
import store


def _init_db(path: Path) -> sqlite3.Connection:
    conn = store.connect(path)
    conn.executescript("""
    CREATE TABLE rings (
        ring_id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT UNIQUE
    );
    CREATE TABLE syncs (
        sync_id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment TEXT,
        ring_id INTEGER,
        timestamp TEXT
    );
    CREATE TABLE heart_rates (
        reading INTEGER,
        timestamp TEXT,
        ring_id INTEGER,
        sync_id INTEGER,
        UNIQUE(ring_id, timestamp)
    );
    CREATE TABLE sport_details (
        calories INTEGER,
        steps INTEGER,
        distance INTEGER,
        timestamp TEXT,
        ring_id INTEGER,
        sync_id INTEGER,
        UNIQUE(ring_id, timestamp)
    );
    """)
    conn.commit()
    return conn


class IngestIntegrityTests(unittest.TestCase):
    def test_capture_day_uses_capture_timezone_not_upload_day(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "ring.sqlite"
            conn = _init_db(db)
            seen: dict[str, str] = {}

            def handler(_conn, _step, ctx):
                seen["day"] = ctx["capture_day"].isoformat()
                store.save_battery(_conn, 71, False, ts="2026-09-05T01:30:00",
                                   commit=False)
                return 1

            captured = 1_788_597_000_000  # 2026-09-05T01:30:00-07:00
            cap = {
                "id": "cap_tz",
                "captured_at": captured,
                "captured_timezone": "America/Los_Angeles",
                "captured_utc_offset_min": -420,
                "source": "manual",
                "steps": [{"id": "battery", "kind": "battery", "chunks": ["030100"]}],
            }

            with mock.patch.object(ingest, "HANDLERS", {"battery": handler}):
                result = ingest.ingest(cap, db=db)

            self.assertTrue(result["acknowledged"])
            self.assertEqual(seen["day"], "2026-09-05")
            self.assertTrue(store.capture_is_acknowledged(conn, "cap_tz"))
            self.assertEqual(
                conn.execute("SELECT level FROM battery_log").fetchone()[0], 71)
            conn.close()

    def test_decode_error_rolls_back_and_does_not_acknowledge(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "ring.sqlite"
            conn = _init_db(db)

            def handler(_conn, _step, _ctx):
                store.save_battery(_conn, 55, False, ts="2026-09-05T01:30:00",
                                   commit=False)
                raise ValueError("broken packet")

            cap = {
                "id": "cap_bad",
                "captured_at": 1_788_597_000_000,
                "captured_utc_offset_min": -420,
                "steps": [{"id": "battery", "kind": "battery", "chunks": ["030100"]}],
            }

            with mock.patch.object(ingest, "HANDLERS", {"battery": handler}):
                result = ingest.ingest(cap, db=db)

            self.assertFalse(result["acknowledged"])
            self.assertIn("broken packet", "; ".join(result["errors"]))
            self.assertFalse(store.capture_is_acknowledged(conn, "cap_bad"))
            self.assertIsNone(conn.execute("SELECT level FROM battery_log").fetchone())
            conn.close()

    def test_empty_step_rolls_back_other_decoded_rows_and_does_not_ack(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "ring.sqlite"
            conn = _init_db(db)

            def battery(_conn, _step, _ctx):
                store.save_battery(_conn, 88, False, ts="2026-09-05T01:30:00",
                                   commit=False)
                return 1

            def hrv(_conn, _step, _ctx):
                raise AssertionError("empty chunk step should not be decoded")

            cap = {
                "id": "cap_empty",
                "captured_at": 1_788_597_000_000,
                "captured_utc_offset_min": -420,
                "steps": [
                    {"id": "battery", "kind": "battery", "chunks": ["030100"]},
                    {"id": "hrv_0", "kind": "hrv", "chunks": []},
                ],
            }

            with mock.patch.object(ingest, "HANDLERS", {"battery": battery, "hrv": hrv}):
                result = ingest.ingest(cap, db=db)

            self.assertFalse(result["acknowledged"])
            self.assertIn("empty response chunks", "; ".join(result["errors"]))
            self.assertFalse(store.capture_is_acknowledged(conn, "cap_empty"))
            self.assertIsNone(conn.execute("SELECT level FROM battery_log").fetchone())
            conn.close()

    def test_protocol_no_data_reply_can_be_acknowledged(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "ring.sqlite"
            conn = _init_db(db)

            def handler(_conn, _step, _ctx):
                return 0

            cap = {
                "id": "cap_nodata",
                "captured_at": 1_788_597_000_000,
                "captured_utc_offset_min": -420,
                "steps": [{"id": "hr", "kind": "hr", "chunks": ["15ff"]}],
            }

            with mock.patch.object(ingest, "HANDLERS", {"hr": handler}):
                result = ingest.ingest(cap, db=db)

            self.assertTrue(result["acknowledged"])
            self.assertTrue(store.capture_is_acknowledged(conn, "cap_nodata"))
            conn.close()


class SnapshotAcknowledgementTests(unittest.TestCase):
    def test_snapshot_acknowledgement_ids_are_exact_capture_ids(self):
        try:
            import pandas  # noqa: F401
        except ModuleNotFoundError:
            self.skipTest("snapshot.py requires pandas")
        from ring_analysis import snapshot

        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "ring.sqlite"
            conn = store.connect(db)
            conn.execute(
                "INSERT INTO capture_imports (capture_id, captured_at, imported_at) "
                "VALUES ('cap_new', '2026-09-05T01:30:00-07:00', '2026-09-05T08:31:00')"
            )
            conn.execute(
                "INSERT INTO capture_imports (capture_id, captured_at, imported_at) "
                "VALUES ('cap_old', '2026-09-04T01:30:00-07:00', '2026-09-04T08:31:00')"
            )
            conn.commit()

            ids, imported_at = snapshot._capture_acknowledgements(conn)

            self.assertEqual(ids, ["cap_new", "cap_old"])
            self.assertEqual(imported_at, "2026-09-05T08:31:00")
            conn.close()


if __name__ == "__main__":
    unittest.main()
