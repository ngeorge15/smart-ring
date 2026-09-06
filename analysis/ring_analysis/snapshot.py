"""
Build the self-contained JSON the dashboard renders.

The phone cannot reach the ring (iOS Safari has no Web Bluetooth), so the Mac
collects and bakes a snapshot; the page carries its own data and works offline.

Everything that could mislead is carried EXPLICITLY: per-point `interpolated`
flags, coverage fractions, baseline sample counts, and calibration readiness.
The UI is expected to render those, not hide them.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

from ring_analysis import baseline, calibrate, clean, energy, load, score, trends
from ring_analysis.baseline import all_baselines

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "ring_data.sqlite"
OUT = ROOT / "web" / "snapshot.json"


def _sleep(conn, days: int = 30) -> dict:
    nights = pd.read_sql_query(
        "SELECT * FROM sleep_nights ORDER BY night_of DESC LIMIT ?", conn, params=(days,))
    segs = pd.read_sql_query(
        "SELECT night_of, start_ts, stage, minutes FROM sleep_segments ORDER BY start_ts",
        conn)
    latest = nights.iloc[0]["night_of"] if not nights.empty else None
    return {
        "nights": nights.to_dict("records"),
        "latest_night": latest,
        # every night's segments, so past nights are browsable -- the key name
        # is kept for compatibility with the existing UI contract
        "latest_segments": segs.to_dict("records"),
    }


def _hr(days: int = 3) -> dict:
    hr = load.load_heart_rate(DB)
    if hr.empty:
        return {"points": [], "coverage": 0.0, "n_outliers": 0}
    cutoff = hr["timestamp"].max() - timedelta(days=days)
    recent = hr[hr["timestamp"] >= cutoff]
    prepared = clean.prepare(recent, "bpm")
    d = prepared["data"].reset_index()
    d = d[d["bpm"].notna()]
    return {
        "points": [
            {"t": r.timestamp.isoformat(timespec="minutes"),
             "v": round(float(r.bpm), 1),
             "i": bool(r.interpolated)}
            for r in d.itertuples()
        ],
        "coverage": round(prepared["coverage"], 3),
        "n_outliers": prepared["n_outliers"],
    }


def _series(conn) -> dict:
    df = pd.read_sql_query(
        "SELECT kind, day, idx, interval_min, value FROM series_samples ORDER BY day, idx",
        conn)
    out: dict[str, list] = {}
    for kind, g in df.groupby("kind"):
        # NB: rename off "min"/"max"/"count" -- those collide with namedtuple
        # attributes on itertuples().
        daily = (g.groupby("day")["value"].agg(["mean", "min", "max", "count"])
                 .rename(columns={"mean": "avg", "min": "lo", "max": "hi", "count": "n"})
                 .reset_index())
        out[kind] = [
            {"day": r.day, "mean": round(r.avg, 1), "min": round(r.lo, 1),
             "max": round(r.hi, 1), "n": int(r.n)}
            for r in daily.itertuples()
        ]
    return out


def _series_detail(conn, days: int = 3) -> dict:
    """Individual samples for the most recent days, with an inferred clock time.

    These series carry no timestamps of their own -- only an index and an
    interval -- so minute-of-day is derived. Kept separate from the daily means
    so nothing downstream mistakes a derived time for a measured one.
    """
    df = pd.read_sql_query(
        "SELECT kind, day, idx, interval_min, value FROM series_samples "
        "ORDER BY day DESC, idx", conn)
    if df.empty:
        return {}
    keep = sorted(df["day"].unique())[-days:]
    df = df[df["day"].isin(keep)]
    out: dict[str, list] = {}
    for kind, g in df.groupby("kind"):
        out[str(kind)] = [
            {"day": r.day, "minute": int(r.idx) * int(r.interval_min),
             "value": float(r.value)}
            for r in g.sort_values(["day", "idx"]).itertuples()
        ]
    return out


def _steps(conn) -> list:
    df = pd.read_sql_query(
        "SELECT date(timestamp) day, SUM(steps) steps, COUNT(*) hours, "
        "SUM(calories) cal, SUM(distance) dist "
        "FROM sport_details GROUP BY day ORDER BY day", conn)
    return [{"day": r.day, "steps": int(r.steps), "hours": int(r.hours),
             "calories_raw": int(r.cal), "distance_raw": int(r.dist),
             "partial": bool(r.hours < 12)} for r in df.itertuples()]


def _activity_hourly(conn, days: int = 2) -> list:
    """Hour-by-hour buckets for the Activity page."""
    df = pd.read_sql_query(
        "SELECT timestamp, steps, calories AS calories_raw, distance AS distance_raw FROM sport_details "
        "ORDER BY timestamp DESC LIMIT ?", conn, params=(days * 24,))
    df = df.sort_values("timestamp")
    return [{"t": str(r.timestamp), "hour": int(str(r.timestamp)[11:13]),
             "day": str(r.timestamp)[:10], "steps": int(r.steps),
             "calories_raw": int(r.calories_raw), "distance_raw": int(r.distance_raw)}
            for r in df.itertuples()]


def _device(conn) -> dict:
    """Battery, inferred last charge, and how stale the data is.

    The ring exposes no charge history, so "last charge" is inferred from our own
    battery_log: the most recent sample that was either actively charging or whose
    level jumped upward. Before a charge has been observed we say so rather than
    guessing.
    """
    from datetime import datetime

    rows = pd.read_sql_query(
        "SELECT ts, level, charging FROM battery_log ORDER BY ts", conn)

    latest_reading = pd.read_sql_query(
        "SELECT MAX(timestamp) AS t FROM heart_rates", conn)["t"].iloc[0]

    out: dict = {
        "battery": None, "charging": False,
        "last_charge": None, "last_charge_seen": False,
        "last_sync": None, "latest_reading": latest_reading,
    }
    if rows.empty:
        return out

    last = rows.iloc[-1]
    out["battery"] = int(last["level"])
    out["charging"] = bool(last["charging"])
    out["last_sync"] = str(last["ts"])
    # WHEN that level was measured. The battery step can come back empty -- the
    # ring occasionally misses the first command after connect -- and the level
    # then simply stops updating while everything else keeps flowing. On
    # 2026-08-26 that left a 23-hour-old 31% displayed as current straight
    # through a charge. A battery percentage without its age cannot be judged.
    out["battery_at"] = str(last["ts"])

    charge_ts = None
    prev = None
    for r in rows.itertuples():
        if r.charging or (prev is not None and r.level > prev + 2):
            charge_ts = r.ts
        prev = r.level
    if charge_ts:
        out["last_charge"] = str(charge_ts)
        out["last_charge_seen"] = True
    else:
        # not yet observed -- report how long we have been watching instead
        out["watching_since"] = str(rows.iloc[0]["ts"])
    del datetime
    return out


def battery_life(rows) -> dict:
    """Drain rate and expected life, measured across DISCHARGE SEGMENTS.

    The drain curve on the Ring page starts at the last charge, so that a
    recharge does not draw a vertical cliff. The side effect is that right after
    charging there is exactly one point and the page said "not enough data" --
    while sitting on 45 hours of perfectly good discharge history from the cycle
    before. Expectancy does not need the CURRENT cycle; it needs ANY cycle.

    So: split the log wherever the level jumps up, measure each falling segment
    independently, and prefer the current one only when it has enough span to
    beat the ones already completed.

    A +1 or +2 wobble is sensor noise, not a charge -- the ring reported
    61,62,62,60 inside one continuous discharge -- so the split threshold is
    strictly greater than 2, matching the drain curve's own rule.
    """
    if len(rows) < 2:
        return {"pct_per_day": None, "basis": "no readings", "segments": 0}

    segs, cur = [], [rows[0]]
    for prev, r in zip(rows, rows[1:]):
        if r["charging"] or r["level"] > prev["level"] + 2:
            segs.append(cur)
            cur = [r]
        else:
            cur.append(r)
    segs.append(cur)

    def rate(seg):
        """%/day over a segment, or None if it is too short to mean anything."""
        if len(seg) < 2:
            return None
        hours = (pd.Timestamp(seg[-1]["ts"]) - pd.Timestamp(seg[0]["ts"])).total_seconds() / 3600
        drop = seg[0]["level"] - seg[-1]["level"]
        # Under two hours the quantised 1% steps dominate: a single tick across
        # 40 minutes extrapolates to 36%/day and is pure noise.
        if hours < 2 or drop <= 0:
            return None
        return {"pct_per_day": (drop / hours) * 24, "hours": hours, "drop": drop}

    measured = [(i, rate(sg)) for i, sg in enumerate(segs)]
    measured = [(i, m) for i, m in measured if m]
    if not measured:
        return {"pct_per_day": None, "basis": "no complete discharge yet",
                "segments": len(segs)}

    current = measured[-1][0] == len(segs) - 1
    if current:
        chosen, basis = measured[-1][1], "this charge"
    else:
        # Median across completed cycles: one unusually heavy day should not set
        # the expectation for every day after it.
        vals = sorted(m["pct_per_day"] for _, m in measured)
        mid = vals[len(vals) // 2] if len(vals) % 2 else (
            vals[len(vals) // 2 - 1] + vals[len(vals) // 2]) / 2
        chosen = {"pct_per_day": mid,
                  "hours": sum(m["hours"] for _, m in measured),
                  "drop": sum(m["drop"] for _, m in measured)}
        # Phrased to read naturally after "measured over 45h of ...".
        basis = ("the previous charge" if len(measured) == 1
                 else f"{len(measured)} previous charges")

    per_day = chosen["pct_per_day"]
    level = rows[-1]["level"]
    return {
        "pct_per_day": round(per_day, 1),
        "full_charge_days": round(100 / per_day, 1) if per_day > 0 else None,
        "days_remaining": round(level / per_day, 1) if per_day > 0 else None,
        "basis": basis,
        "observed_hours": round(chosen["hours"], 1),
        "observed_drop": int(chosen["drop"]),
        "segments": len(segs),
    }


def _ring_status(conn, days: int = 7) -> dict:
    """Device and pipeline health: batteries, syncs, and what arrived when.

    Two sync SOURCES now write to this database -- the Mac's own BLE agent and
    the phone posting captures to /ingest -- and they fail independently. Being
    able to see which one last worked is the difference between "the ring is
    dead" and "the Mac has been asleep since Tuesday".
    """
    batt = pd.read_sql_query(
        "SELECT ts, level, charging FROM battery_log ORDER BY ts", conn)
    # Only the last week; a drain curve older than that says nothing useful.
    if not batt.empty:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        batt = batt[batt["ts"] >= cutoff]

    syncs = pd.read_sql_query(
        "SELECT sync_id, comment, timestamp FROM syncs ORDER BY sync_id DESC LIMIT 40",
        conn)
    syncs["source"] = syncs["comment"].fillna("").map(
        lambda c: "phone" if str(c).startswith("phone") else "mac")

    def _last(src):
        m = syncs[syncs["source"] == src]
        return None if m.empty else str(m.iloc[0]["timestamp"])

    counts = {}
    for name, sql in (
        ("heart_rates", "SELECT COUNT(*) n FROM heart_rates"),
        ("sport_details", "SELECT COUNT(*) n FROM sport_details"),
        ("sleep_nights", "SELECT COUNT(*) n FROM sleep_nights"),
        ("series_samples", "SELECT COUNT(*) n FROM series_samples"),
    ):
        counts[name] = int(pd.read_sql_query(sql, conn)["n"].iloc[0])

    return {
        # Expectancy survives a recharge: measured across discharge segments,
        # not only the current one. See battery_life.
        "battery_life": battery_life(
            [{"ts": str(r.ts), "level": int(r.level), "charging": bool(r.charging)}
             for r in batt.itertuples()]),
        "battery_history": [
            {"ts": str(r.ts), "level": int(r.level), "charging": bool(r.charging)}
            for r in batt.itertuples()
        ],
        "last_sync_mac": _last("mac"),
        "last_sync_phone": _last("phone"),
        "recent_syncs": [
            {"id": int(r.sync_id), "at": str(r.timestamp), "source": r.source}
            for r in syncs.head(12).itertuples()
        ],
        "counts": counts,
    }


def _capture_acknowledgements(conn, limit: int = 100) -> tuple[list[str], str | None]:
    try:
        rows = pd.read_sql_query(
            "SELECT capture_id, imported_at FROM capture_imports "
            "ORDER BY imported_at DESC LIMIT ?", conn, params=(limit,))
    except pd.errors.DatabaseError as exc:
        # Older/private databases may not have seen a phone import yet. The
        # absence of the table means no exact capture can be acknowledged.
        if "no such table: capture_imports" in str(exc):
            return [], None
        raise
    if rows.empty:
        return [], None
    return [str(r.capture_id) for r in rows.itertuples()], str(rows.iloc[0]["imported_at"])


def build(db: Path = DB) -> dict:
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        sleep = _sleep(conn)
        series = _series(conn)
        steps = _steps(conn)
        activity_hourly = _activity_hourly(conn)
        device = _device(conn)
        series_detail = _series_detail(conn)
        ring_status = _ring_status(conn)
        capture_ack_ids, capture_ack_at = _capture_acknowledgements(conn)

    en = energy.daily_energy(db)
    prof = energy.load_profile()
    r = score.compute(db=db)
    bl = all_baselines(db)
    tr = trends.build(db)
    cal_steps = calibrate.calibrate_steps(db)
    cal_sleep = calibrate.sleep_agreement(db)

    return {
        "meta": {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "ring": "COLMI R02_C302",
            "span": load.data_span(db),
            "capture_ack_ids": capture_ack_ids,
            "capture_ack_at": capture_ack_at,
            "note": "Timestamps are naive LOCAL time.",
        },
        "readiness": {
            "day": r.day.isoformat(),
            "is_today": r.day == date.today(),
            "score": None if r.score is None else round(r.score, 1),
            "confidence": round(r.confidence, 3),
            "components": [
                {"name": c.name, "value": c.value, "score": c.score,
                 "weight": c.weight, "confidence": round(c.confidence, 3),
                 "explain": c.explain, "available": c.available,
                 "display": c.display, "delta": c.delta,
                 "headline": c.headline}
                for c in r.components
            ],
            "caveats": r.caveats,
            # Why the score is not 100, split into what behaviour can move and
            # what only more data can. See score.headroom.
            "headroom": score.headroom(r, baseline.all_baselines(db)),
        },
        "sleep": sleep,
        "sleep_debt": tr["sleep_debt"],
        "trends": tr["trends"],
        # Shipped so the phone can re-run the aggregation rather than patch its
        # output -- see trends.daily_inputs.
        "daily": tr["daily"],
        "hr": _hr(),
        "series": series,
        "series_detail": series_detail,
        "device": device,
        "ring_status": ring_status,
        "steps": steps,
        "energy": {
            "days": en.to_dict("records"),
            "rmr_kcal": None if prof is None else round(prof.rmr_kcal_day),
            "calibration": energy.CALIBRATION,
            "profile": None if prof is None else {
                "weight_kg": prof.weight_kg, "age": prof.age},
        },
        "activity_hourly": activity_hourly,
        "baselines": {
            k: {"mean": None if pd.isna(b.mean) else round(b.mean, 1),
                "sd": None if pd.isna(b.sd) else round(b.sd, 1),
                "n": b.n, "source": b.source,
                "confidence": round(b.confidence, 3), "note": b.note}
            for k, b in bl.items()
        },
        "calibration": {
            "steps": {"ready": cal_steps.ready, "n": cal_steps.n,
                      "required": cal_steps.required, "days": cal_steps.distinct_days,
                      "note": cal_steps.note,
                      "scale": cal_steps.scale, "median_ratio": cal_steps.median_ratio},
            "sleep": {"ready": cal_sleep.ready, "n": cal_sleep.n,
                      "required": cal_sleep.required, "note": cal_sleep.note},
        },
        "gaps": {
            "sleep_stages": "Your ring decides deep vs REM using software nobody can "
                            "inspect. Trust asleep vs awake; treat the stage split as "
                            "a rough guide.",
            "zero_wake": "A night showing 100% efficiency means the ring logged no "
                         "wake at all. Everyone surfaces briefly overnight, so read "
                         "that as the ring missing them, not a perfect night.",
            "spo2_timestamps": "Blood oxygen readings arrive without timestamps, so their "
                                 "times are estimated.",
            "temperature": "Sampled every 30 min. Absolute readings from a finger "
                           "sensor are rough -- the useful signal is a shift from "
                           "YOUR own normal, which needs about two weeks of nights "
                           "to establish.",
            "calories": "Active calories combine heart rate with step count, "
                        "weighted by your height, weight, age and sex. Both terms "
                        "were fitted against 868 days of Apple Watch data, which "
                        "recorded heart rate and its own energy figure on the same "
                        "wrist: heart rate alone was 50% off on a typical day, steps "
                        "alone 26%, the blend 15% -- and that held up out of sample. "
                        "Ring step counts are not yet calibrated against the Watch "
                        "(measured ratios of 0.51x and 2.23x so far), so the step "
                        "term is on an unverified scale. Good for comparing days; "
                        "not a number to eat against.",
        },
    }


def main() -> None:
    snap = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snap, indent=1, default=str))
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")
    print(f"  readiness {snap['readiness']['score']} "
          f"conf {snap['readiness']['confidence']:.0%}")
    sd = snap["sleep_debt"]
    print(f"  sleep debt {sd['debt_min'] / 60:.1f}h vs {sd['target_min']}m target "
          f"({sd['covered']}/{sd['window']} nights)")
    print(f"  trends {[m['key'] for m in snap['trends']['metrics']]}")
    print(f"  hr points {len(snap['hr']['points'])} | nights {len(snap['sleep']['nights'])} "
          f"| series {list(snap['series'])}")


if __name__ == "__main__":
    main()
