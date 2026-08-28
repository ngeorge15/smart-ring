#!/bin/bash
# Regenerate fixtures from the CURRENT database, then compare JS against Python.
#
# The fixtures must be rebuilt every run. They were static once, and the moment
# new data changed the baselines the comparison ran new params against a stale
# expected-output file and reported two false failures. A regression test that
# rots is worse than none.
set -e
cd "$(dirname "$0")/.."
PY="$HOME/Library/Application Support/pipx/venvs/colmi-r02-client/bin/python"

python3 - <<'PYEOF'
import sqlite3, json, sys
sys.path.insert(0, 'analysis')
c = sqlite3.connect('file:data/ring_data.sqlite?mode=ro', uri=True)
day = c.execute("SELECT MAX(night_of) FROM sleep_nights").fetchone()[0]
night = c.execute("SELECT asleep_min, efficiency FROM sleep_nights WHERE night_of=?", (day,)).fetchone()
rhr = c.execute("SELECT MIN(reading) FROM heart_rates WHERE date(timestamp)=? AND reading>0", (day,)).fetchone()[0]
series = dict(c.execute("SELECT kind, AVG(value) FROM series_samples WHERE day=? GROUP BY kind", (day,)).fetchall())
json.dump({"day": day, "asleep_min": night[0], "efficiency": night[1], "resting_hr": rhr,
           "hrv": series.get("hrv"), "stress": series.get("stress")},
          open('/tmp/engine_inputs.json', 'w'))

from ring_analysis import score
# --- cleaning. hampel is the filter resting HR is most exposed to: it is a
# MINIMUM, so a single impossible low moves it directly.
from ring_analysis import clean
import pandas as _pd
_vals = json.load(open('tools/fixtures/hr_noisy.json'))
_df = _pd.DataFrame({"timestamp": _pd.date_range("2026-08-24", periods=len(_vals), freq="5min"),
                     "bpm": _vals})
_c = clean.clip_impossible(_df, "bpm")
_h = clean.hampel(_c, "bpm")
json.dump({
    "clipped": [None if _pd.isna(v) else float(v) for v in _c["bpm"]],
    "cleaned": [None if (_pd.isna(v) or o) else float(v)
                for v, o in zip(_c["bpm"], _h["is_outlier"])],
}, open('/tmp/python_clean.json', 'w'))

r = score.compute()
json.dump({"score": r.score, "confidence": r.confidence,
           "components": [{"name": x.name, "score": x.score} for x in r.components]},
          open('/tmp/python_readiness.json', 'w'))
PYEOF

/usr/bin/arch -arm64 "$PY" - <<'PYEOF'
import json, sys
sys.path.insert(0, 'tools')
import colmi_bigdata as bd
# Repo-tracked, and deliberately the 2026-08-25 capture: it contains a night
# that CROSSES MIDNIGHT (23:27 -> 11:07). That case was broken in both engines
# and invisible for weeks, because every earlier night began after midnight.
blob = bytes.fromhex(open('tools/fixtures/sleep_wrapped.hex').read().strip())
out = []
for msg in bd.split_messages(blob):
    for n in bd.parse_sleep(msg):
        out.append({"in_bed_min": n.time_in_bed, "asleep_min": n.asleep,
                    "n_segs": len(n.segments), "checksum_ok": n.checksum_ok,
                    "wrapped": n.onset.date() != n.night_of})
json.dump(out, open('/tmp/python_sleep.json', 'w'))

# --- SpO2 and temperature: same big-data channel as sleep, same real capture.
json.dump([{"days_ago": d, "interval": 30, "values": v}
           for d, v in bd.parse_spo2(b"".join(
               bd.split_messages(bytes.fromhex(
                   open('tools/fixtures/spo2.hex').read().strip()))))],
          open('/tmp/python_spo2.json', 'w'))
json.dump([{"days_ago": d, "interval": i, "values": v}
           for d, i, v in bd.parse_temperature(b"".join(
               bd.split_messages(bytes.fromhex(
                   open('tools/fixtures/temp.hex').read().strip()))))],
          open('/tmp/python_temp.json', 'w'))

from colmi_r02_client.hr import HeartRateLogParser, HeartRateLog
from colmi_r02_client.steps import SportDetailParser
d = json.load(open('/tmp/synth_packets.json'))
p = HeartRateLogParser(); log = None
for h in d["hr"]:
    r = p.parse(bytearray(bytes.fromhex(h)))
    if isinstance(r, HeartRateLog): log = r; break
samples = [(v, t) for v, t in log.heart_rates_with_times() if v > 0]
sp = SportDetailParser(); details = []
for h in d["steps"]:
    r = sp.parse(bytearray(bytes.fromhex(h)))
    if isinstance(r, list): details = r; break
json.dump({"hr_count": len(samples), "hr_values": [v for v, _ in samples],
           "steps": [{"steps": x.steps, "calories": x.calories,
                      "distance": x.distance, "time_index": x.time_index} for x in details]},
          open('/tmp/python_hr_steps.json', 'w'))
PYEOF

# ---------------------------------------------------------------- python-only
# battery_life and headroom have no JS twin, so there is nothing to compare
# them against. They get PROPERTY tests instead: the invariants that would be
# violated by the mistakes they are actually prone to.
python3 - <<'PYEOF'
import sys
sys.path.insert(0, 'analysis')
from ring_analysis import snapshot, score

fails = []
def ok(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label:<34}{detail}")
    if not cond:
        fails.append(label)

print("\nBATTERY LIFE (properties)")
mk = lambda rows: [{"ts": t, "level": l, "charging": c} for t, l, c in rows]

# A +1/+2 wobble is sensor noise, not a charge. The ring really did report
# 61,62,62,60 inside one continuous discharge; splitting there would report two
# useless stubs instead of one good cycle.
wobble = mk([("2026-08-24T00:00", 80, 0), ("2026-08-24T06:00", 74, 0),
             ("2026-08-24T12:00", 75, 0), ("2026-08-24T18:00", 68, 0),
             ("2026-08-25T00:00", 62, 0)])
r = snapshot.battery_life(wobble)
ok("noise wobble does not split", r["segments"] == 1, f"segments={r['segments']}")
ok("rate from the whole cycle", abs(r["pct_per_day"] - 18.0) < 0.6, f"{r['pct_per_day']}%/day")

# A real recharge must split, and the CURRENT cycle wins when it qualifies.
charged = wobble + mk([("2026-08-25T01:00", 100, 0), ("2026-08-25T13:00", 88, 0)])
r = snapshot.battery_life(charged)
ok("recharge splits", r["segments"] == 2, f"segments={r['segments']}")
ok("current cycle preferred", r["basis"] == "this charge", r["basis"])
ok("uses only the new cycle", abs(r["pct_per_day"] - 24.0) < 0.6, f"{r['pct_per_day']}%/day")

# One point after a charge is what the Ring page used to choke on: it must fall
# back to the completed cycle rather than reporting "not enough data".
r = snapshot.battery_life(wobble + mk([("2026-08-25T01:00", 100, 0)]))
ok("falls back after a charge", r["pct_per_day"] is not None, r["basis"])
ok("remaining scales with level", r["days_remaining"] is not None,
   f"{r['days_remaining']}d at {100}%")

# Sub-2h segments are noise: one 1% tick in 40 minutes extrapolates to 36%/day.
r = snapshot.battery_life(mk([("2026-08-26T10:00", 50, 0), ("2026-08-26T10:40", 49, 0)]))
ok("sub-2h segment ignored", r["pct_per_day"] is None, r["basis"])

print("\nHEADROOM (properties)")
res = score.compute()
from ring_analysis import baseline
h = score.headroom(res, baseline.all_baselines())
if h["gap"] is None:
    ok("gap computable", False, "no scorable components")
else:
    ok("gap == shrink + measure",
       abs(h["gap"] - (h["shrink_points"] + h["measure_points"])) < 0.2,
       f"{h['gap']} vs {h['shrink_points']}+{h['measure_points']}")
    ok("costs sum to the gap",
       abs(sum(c["points"] for c in h["costs"]) - h["gap"]) < 0.2,
       f"{sum(c['points'] for c in h['costs']):.1f}")
    # Inverting the shrink must never invent a score above the raw one.
    ok("raw >= shown for every cost",
       all(c["raw_score"] >= c["score"] - 1e-6 for c in h["costs"]))
    ok("shrink is zero at full confidence",
       all(abs(c["shrink_points"]) < 0.05 for c in h["costs"] if c["confidence"] >= 0.999))
    # A locked component may only be sold as "wait N nights" when waiting fixes
    # it; a zero-wake night never will, and saying so would be advice you cannot
    # act on.
    ok("nights_needed only when the baseline is short",
       all((l["nights_needed"] is None) or (l["have"] < l["need"]) for l in h["locked"]))

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
PYEOF
PYSTATUS=$?

node tools/verify_engine.mjs
JSSTATUS=$?
exit $(( PYSTATUS != 0 || JSSTATUS != 0 ))
