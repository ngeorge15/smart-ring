"""Generate deterministic comparison fixtures without reading personal data."""
from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import asdict
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[2])
sys.path[:0] = [str(ROOT / "analysis"), str(ROOT / "tools")]


def emit(name, value):
    (OUT / name).write_text(json.dumps(value, allow_nan=False))


def analysis():
    import pandas as pd
    from ring_analysis import baseline, clean, score, snapshot

    # Exercise the real Python scorer's DB reads with a private synthetic DB;
    # only baseline/calibration providers are fixed to known distributions.
    db = OUT / "score.sqlite"
    with sqlite3.connect(db) as conn:
        conn.executescript("""
            CREATE TABLE sleep_nights (night_of TEXT, asleep_min REAL, efficiency REAL);
            CREATE TABLE series_samples (day TEXT, kind TEXT, value REAL);
            CREATE TABLE heart_rates (timestamp TEXT, reading REAL);
        """)
    day = date(2024, 1, 15)
    cases = []
    for name, n, efficiency, missing, calibrated in [
        ("full baseline", 28, 92, False, True),
        ("thin baseline", 8, 90, False, False),
        ("unscorable baseline", 3, 100, False, False),
        ("zero wake", 28, 100, False, True),
        ("no readings", 28, None, True, False),
    ]:
        bl = {
            key: baseline.Baseline(key, source, n, mid, (hi-lo)/3, lo, mid, hi)
            for key, source, lo, mid, hi in [
                ("sleep_min", "apple_watch", 360, 450, 540),
                ("resting_hr", "apple_watch", 50, 60, 70),
                ("hrv", "ring", 25, 45, 65),
                ("stress", "ring", 20, 40, 60),
            ]
        }
        inputs = {"day": day.isoformat(), "asleep_min": None if missing else 420,
                  "efficiency": efficiency, "resting_hr": None if missing else 64,
                  "hrv": None if missing else 51, "stress": None if missing else 48,
                  "sleep_calibrated": calibrated}
        with sqlite3.connect(db) as conn:
            for table in ("sleep_nights", "series_samples", "heart_rates"):
                conn.execute(f"DELETE FROM {table}")
            if not missing:
                conn.execute("INSERT INTO sleep_nights VALUES (?,?,?)",
                             (day.isoformat(), inputs["asleep_min"], efficiency))
                conn.execute("INSERT INTO heart_rates VALUES (?,?)",
                             (day.isoformat()+" 03:00:00", inputs["resting_hr"]))
                for kind in ("hrv", "stress"):
                    conn.execute("INSERT INTO series_samples VALUES (?,?,?)",
                                 (day.isoformat(), kind, inputs[kind]))
        with patch.object(score, "all_baselines", return_value=bl), \
             patch("ring_analysis.calibrate.sleep_agreement", return_value=SimpleNamespace(ready=calibrated)):
            result = score.compute(day, db)
        expected = {"score": result.score, "confidence": result.confidence,
                    "components": [{**asdict(c), "available": c.available} for c in result.components]}
        params = {"weights": score.WEIGHTS, "rules": score.RULES,
                  "baselines": {k: {**asdict(v), "confidence": v.confidence} for k, v in bl.items()}}
        cases.append(dict(name=name, inputs=inputs, params=params, expected=expected))

        h = score.headroom(result, bl)
        if result.score is not None:
            assert abs(h["gap"] - h["shrink_points"] - h["measure_points"]) < .2, name
            assert abs(sum(c["points"] for c in h["costs"]) - h["gap"]) < .3, name
            # Shrink moves scores on BOTH sides of 50 toward neutral.
            for c in h["costs"]:
                if c["name"] == "sleep_quality":
                    continue  # fixed-scale component is not confidence-shrunk
                assert abs(c["score"] - 50) <= abs(c["raw_score"] - 50) + .1, name
            assert all(l["nights_needed"] is None or l["have"] < l["need"] for l in h["locked"])
    emit("scoring_cases.json", cases)

    vals = json.loads((ROOT / "tools/fixtures/hr_noisy.json").read_text())
    df = pd.DataFrame({"timestamp": pd.date_range("2024-01-15", periods=len(vals), freq="5min"), "bpm": vals})
    clipped = clean.clip_impossible(df, "bpm")
    filtered = clean.hampel(clipped, "bpm")
    emit("python_clean.json", {
        "clipped": [None if pd.isna(v) else float(v) for v in clipped["bpm"]],
        "cleaned": [None if pd.isna(v) or o else float(v)
                    for v, o in zip(clipped["bpm"], filtered["is_outlier"])],
    })

    mk = lambda rows: [{"ts": t, "level": level, "charging": charge} for t, level, charge in rows]
    wobble = mk([("2024-01-24T00:00", 80, 0), ("2024-01-24T06:00", 74, 0),
                 ("2024-01-24T12:00", 75, 0), ("2024-01-24T18:00", 68, 0),
                 ("2024-01-25T00:00", 62, 0)])
    r = snapshot.battery_life(wobble)
    assert r["segments"] == 1 and abs(r["pct_per_day"] - 18) < .6
    r = snapshot.battery_life(wobble + mk([("2024-01-25T01:00", 100, 0), ("2024-01-25T13:00", 88, 0)]))
    assert r["segments"] == 2 and r["basis"] == "this charge" and abs(r["pct_per_day"] - 24) < .6
    r = snapshot.battery_life(wobble + mk([("2024-01-25T01:00", 100, 0)]))
    assert r["pct_per_day"] is not None and r["days_remaining"] is not None
    r = snapshot.battery_life(mk([("2024-01-26T10:00", 50, 0), ("2024-01-26T10:40", 49, 0)]))
    assert r["pct_per_day"] is None
    print("PASS deterministic scoring/headroom cases, cleaning, battery properties")


def protocol():
    import colmi_bigdata as bd
    from colmi_r02_client.hr import HeartRateLogParser, HeartRateLog
    from colmi_r02_client.steps import SportDetailParser

    blob = bytes.fromhex((ROOT / "tools/fixtures/sleep_wrapped.hex").read_text().strip())
    nights = [n for msg in bd.split_messages(blob) for n in bd.parse_sleep(msg, date(2024, 1, 15))]
    emit("python_sleep.json", [{"in_bed_min": n.time_in_bed, "asleep_min": n.asleep,
         "n_segs": len(n.segments), "checksum_ok": n.checksum_ok, "wrapped": n.onset.date() != n.night_of} for n in nights])
    for name, parser, temp in [("spo2", bd.parse_spo2, False), ("temp", bd.parse_temperature, True)]:
        payload = b"".join(bd.split_messages(bytes.fromhex((ROOT / f"tools/fixtures/{name}.hex").read_text().strip())))
        rows = []
        for rec in parser(payload):
            d, interval, vals = rec if temp else (rec[0], 30, rec[1])
            rows.append({"days_ago": d, "interval": interval, "values": vals})
        emit(f"python_{name}.json", rows)

    def packet(data):
        p = bytearray(data)
        p.extend([0] * (15-len(p)))
        p.append(sum(p) & 255)
        return p.hex()

    stamp = int(datetime(2024, 1, 15, 12, tzinfo=timezone.utc).timestamp())
    hr = [packet([21, 0, 3, 5]),
          packet([21, 1, *stamp.to_bytes(4, "little"), 60, 0, 62, 63, 64, 65, 66, 67, 68]),
          packet([21, 2, *range(70, 83)])]
    steps = [packet([67, 240, 2, 1]),
             packet([67, 0x24, 0x01, 0x15, 16, 0, 2, 200, 0, 48, 0, 27, 0]),
             packet([67, 0x24, 0x01, 0x15, 20, 1, 2, 182, 24, 170, 4, 105, 3])]
    emit("synth_packets.json", {"hr": hr, "steps": steps})
    parser = HeartRateLogParser()
    log = None
    for raw in hr:
        result = parser.parse(bytearray.fromhex(raw))
        if isinstance(result, HeartRateLog):
            log = result
    assert log is not None
    vals = [v for v, _ in log.heart_rates_with_times() if v > 0]
    parser = SportDetailParser()
    details = None
    for raw in steps:
        result = parser.parse(bytearray.fromhex(raw))
        if isinstance(result, list):
            details = result
    assert details is not None
    emit("python_hr_steps.json", {"hr_count": len(vals), "hr_values": vals,
         "steps": [{"steps": r.steps, "calories": r.calories, "distance": r.distance,
                    "time_index": r.time_index} for r in details]})


if __name__ == "__main__":
    {"analysis": analysis, "protocol": protocol}[sys.argv[1]]()
