"""
Readiness score -- transparent by construction.

Every component exposes its input, its baseline, its weight, its contribution
and its confidence. Nothing is a black box, and the whole thing is tunable in
WEIGHTS below. That transparency is the actual advantage over a commercial
score: you can disagree with this one and change it.

Two rules:
  * A component with no data is DROPPED and the remaining weights renormalised.
    It is never silently scored 50, which would fabricate a middling day.
  * The overall score always carries a confidence. A 78 built on two days of
    ring history is not the same claim as a 78 built on two months, and the UI
    must be able to tell them apart.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from ring_analysis.baseline import Baseline, all_baselines

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "ring_data.sqlite"

WEIGHTS = {"sleep_duration": 0.30, "sleep_quality": 0.20,
           "resting_hr": 0.20, "hrv": 0.20, "stress": 0.10}

# Scoring rules, kept as DATA so the phone's JS evaluator reads the same numbers
# instead of hard-coding its own copy (see build_web._emit_params).
RULES = {
    # A 3-day baseline has p10 ~ the minimum, so ANY new low scored exactly 10
    # and any new high exactly 90. Percentiles need real spread before they mean
    # anything; below this the component is dropped and its weight redistributed.
    "min_baseline_n": 7,

    # 100% efficiency means the ring logged NO wake at all. Everyone surfaces
    # overnight, so that is a missed measurement, not a perfect night -- and the
    # Known Limits panel already says so. Scoring it 100/100 contradicted our own
    # documentation.
    "max_scorable_efficiency": 99.0,

    # Pull scores toward 50 in proportion to confidence. A thin baseline should
    # not produce a confident extreme; at full confidence this is a no-op.
    "shrink_toward_mean": True,

    # The ring reads ~0.70x the Watch on sleep, and sleep_min's baseline is
    # Watch-derived. Until calibration measures that offset, claiming full
    # confidence in "you slept 3.9h vs your 7.7h typical" is indefensible: part
    # of the gap is the instrument.
    "cross_device_confidence_cap": 0.5,
}


def _shrink(score: float | None, confidence: float) -> float | None:
    """Scores from thin baselines are pulled toward the neutral midpoint."""
    if score is None or not RULES["shrink_toward_mean"]:
        return score
    return 50.0 + (score - 50.0) * max(0.0, min(1.0, confidence))


@dataclass
class Component:
    name: str
    value: float | None
    score: float | None          # 0-100, higher = better
    weight: float
    confidence: float
    explain: str
    baseline: str = ""
    display: str = ""
    """The measured value, formatted with its unit -- what the UI leads with.

    A bare 0-100 index next to "Sleep duration" reads as ambiguous ("10 what?"),
    so the interface shows the real quantity and uses colour + a word for status.
    The index is kept for ranking and for the detail view."""
    delta: str = ""
    """How far the value sits from this person's own normal, in plain words."""
    headline: str = ""
    """One natural sentence for the hero line. Phrased per metric -- a single
    generic template reads wrong across sleep, heart rate and HRV."""

    @property
    def available(self) -> bool:
        return self.value is not None and self.score is not None


@dataclass
class Readiness:
    day: date
    score: float | None
    confidence: float
    components: list[Component] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)

    def describe(self) -> str:
        if self.score is None:
            return f"{self.day}: no score -- {'; '.join(self.caveats)}"
        band = ("low" if self.confidence < 0.4 else
                "moderate" if self.confidence < 0.75 else "good")
        lines = [f"{self.day}: readiness {self.score:.0f}/100 "
                 f"(confidence {self.confidence:.0%} -- {band})"]
        for c in self.components:
            if c.available:
                lines.append(f"    {c.name:15} {c.score:5.0f}  w={c.weight:.2f} "
                             f"conf={c.confidence:.0%}  {c.explain}")
            else:
                lines.append(f"    {c.name:15}    --  dropped: {c.explain}")
        for w in self.caveats:
            lines.append(f"  ! {w}")
        return "\n".join(lines)


def headroom(result, baselines: dict | None = None) -> dict:
    """Why the score is not 100, in points, split by what would actually fix it.

    A single "you lost 23 points" is useless: some of that gap is the
    MEASUREMENT (sleep short of your best, resting HR above your floor) and some
    is purely the SHRINK -- scores from thin or borrowed baselines are pulled
    toward 50, so a genuinely good night is reported as mediocre until the
    baseline earns confidence. Those two look identical on the dial and have
    opposite remedies: one is behaviour, the other is patience.

    Inverting the shrink recovers the raw score:  raw = 50 + (shown - 50) / conf.
    The distance from raw to shown is the confidence tax; the distance from 100
    to raw is real headroom.

    Locked components are reported separately with what unlocks them, since a
    dropped component costs CONFIDENCE rather than points.
    """
    bl = baselines or {}
    usable = [c for c in result.components if c.score is not None and c.value is not None]
    total_w = sum(c.weight for c in usable)
    if not total_w:
        return {"gap": None, "costs": [], "locked": [], "shrink_points": 0.0,
                "measure_points": 0.0}

    costs, shrink_pts, measure_pts = [], 0.0, 0.0
    for c in usable:
        conf = max(c.confidence, 1e-6)
        raw = 50.0 + (c.score - 50.0) / conf if RULES["shrink_toward_mean"] else c.score
        raw = min(100.0, max(0.0, raw))
        shrink = c.weight * (raw - c.score) / total_w
        measure = c.weight * (100.0 - raw) / total_w
        shrink_pts += shrink
        measure_pts += measure
        costs.append({
            "name": c.name, "points": round(shrink + measure, 1),
            "shrink_points": round(shrink, 1), "measure_points": round(measure, 1),
            "score": round(c.score, 1), "raw_score": round(raw, 1),
            "confidence": round(c.confidence, 3), "display": c.display,
            "baseline": c.baseline,
        })
    costs.sort(key=lambda x: -x["points"])

    from ring_analysis.baseline import MIN_N_SCORABLE
    need = RULES.get("min_baseline_n", MIN_N_SCORABLE)
    locked = []
    for c in result.components:
        if c.score is not None and c.value is not None:
            continue
        b = bl.get({"sleep_duration": "sleep_min", "sleep_quality": "sleep_min"}
                   .get(c.name, c.name))
        have = getattr(b, "n", None)
        locked.append({
            "name": c.name, "weight": c.weight, "explain": c.explain,
            "have": have, "need": need,
            # A baseline short of `need` unlocks itself by waiting; anything else
            # is a measurement problem and saying "wear it longer" would be a lie.
            "nights_needed": (need - have) if (have is not None and have < need) else None,
        })

    return {
        "gap": round(100.0 - result.score, 1) if result.score is not None else None,
        "costs": costs, "locked": locked,
        "shrink_points": round(shrink_pts, 1),
        "measure_points": round(measure_pts, 1),
        "weight_available": round(total_w, 3),
    }


def _fmt_hm(minutes: float) -> str:
    h, m = divmod(int(round(minutes)), 60)
    return f"{h}h {m:02d}m"


def _delta_words(value: float, mean: float, fmt, lower_is_better: bool = False) -> str:
    """Plain-words distance from this person's own normal.

    If the difference disappears at display precision, say so rather than
    printing "0 below your 42 typical", which reads as a bug.
    """
    del lower_is_better  # direction wording is symmetric; colour carries valence
    diff = value - mean
    shown = fmt(abs(diff)).strip()
    if abs(diff) < 1e-9 or shown.lstrip("0") in ("", ".", "h 00m", " ms", " bpm", "%"):
        return f"right on your {fmt(mean)} typical"
    # a formatted delta that reads as zero (e.g. "0 ms") is not worth printing
    if not any(ch.isdigit() and ch != "0" for ch in shown):
        return f"right on your {fmt(mean)} typical"
    return f"{shown} {'above' if diff > 0 else 'below'} your {fmt(mean)} typical"


def _band_score(value: float, baseline: Baseline,
                higher_is_better: bool) -> float | None:
    """
    Map a value onto 0-100 against the personal distribution.
    p10 -> 10, p50 -> 50, p90 -> 90, then inverted if lower is better.

    Returns None when the baseline is too thin to place the value. It used to
    return 50.0, which is precisely the "fabricate a middling day" the module
    docstring forbids -- and it hid thin baselines instead of dropping them.
    """
    pct = baseline.pct(value)
    if pct is None:
        return None
    return pct if higher_is_better else 100.0 - pct


def most_recent_scorable_day(db: Path = DB, lookback: int = 7) -> date:
    """The newest day that actually has data.

    Before the first sync of a new day there is nothing to score, and returning
    an empty result made the whole dashboard look broken at 7am. Falling back to
    the last real day is honest as long as the UI says which day it is showing --
    which is why `Readiness.day` is rendered whenever it is not today.
    """
    today = date.today()
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as c:
        for i in range(lookback + 1):
            d = (today - timedelta(days=i)).isoformat()
            has_sleep = c.execute(
                "SELECT 1 FROM sleep_nights WHERE night_of=? LIMIT 1", (d,)).fetchone()
            has_hr = c.execute(
                "SELECT 1 FROM heart_rates WHERE date(timestamp)=? AND reading>0 LIMIT 1",
                (d,)).fetchone()
            if has_sleep or has_hr:
                return today - timedelta(days=i)
    return today


DEFAULT_ZERO_WAKE = (
    "A night showing 100% efficiency means the ring logged no wake at all. "
    "Everyone surfaces briefly overnight, so sleep QUALITY is not scored on "
    "those nights rather than being awarded full marks.")


def compute(day: date | None = None, db: Path = DB) -> Readiness:
    day = day or most_recent_scorable_day(db)
    bl = all_baselines(db)
    from ring_analysis import calibrate
    calibrated_sleep = calibrate.sleep_agreement(db).ready
    comps: list[Component] = []
    caveats: list[str] = []

    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as c:
        night = pd.read_sql_query(
            "SELECT * FROM sleep_nights WHERE night_of=?", c, params=(day.isoformat(),))
        series = pd.read_sql_query(
            "SELECT kind, AVG(value) v, COUNT(*) n FROM series_samples "
            "WHERE day=? GROUP BY kind", c, params=(day.isoformat(),))
        hr = pd.read_sql_query(
            "SELECT MIN(reading) rhr FROM heart_rates WHERE date(timestamp)=? "
            "AND reading > 0", c, params=(day.isoformat(),))

    svals = {r.kind: (r.v, r.n) for r in series.itertuples()}

    # --- sleep duration
    if not night.empty:
        mins = float(night["asleep_min"].iloc[0])
        b = bl["sleep_min"]
        sleep_conf = b.confidence
        if b.source != "ring" and not calibrated_sleep:
            sleep_conf = min(sleep_conf, RULES["cross_device_confidence_cap"])
            caveats.append(
                "Sleep is measured by the ring but compared against an Apple Watch "
                "baseline, and the two disagree by about 30% on the one night both "
                "recorded. Confidence is capped until enough paired nights measure "
                "that offset.")
        comps.append(Component(
            "sleep_duration", mins, _shrink(_band_score(mins, b, True), sleep_conf),
            WEIGHTS["sleep_duration"], sleep_conf,
            f"{mins/60:.1f}h vs your {b.mean/60:.1f}h typical", b.source,
            display=_fmt_hm(mins),
            delta=_delta_words(mins, b.mean, _fmt_hm) if b.n else "no baseline yet",
            headline=(f"You slept {_fmt_hm(abs(mins - b.mean))} "
                      f"{'less' if mins < b.mean else 'more'} than usual"
                      if b.n else "First night recorded")))
        eff = float(night["efficiency"].iloc[0])
        if eff >= RULES["max_scorable_efficiency"]:
            comps.append(Component(
                "sleep_quality", None, None, WEIGHTS["sleep_quality"], 0.0,
                f"{eff:.0f}% efficiency means the ring logged no wake at all -- "
                f"a missed measurement, not a perfect night"))
            caveats.append(DEFAULT_ZERO_WAKE)
        else:
            comps.append(Component(
                "sleep_quality", eff, float(np.clip((eff - 60) / 35 * 100, 0, 100)),
                WEIGHTS["sleep_quality"], 0.6,
                f"{eff:.0f}% efficiency (fixed scale, not personalised)", "fixed",
                display=f"{eff:.0f}%",
                delta="% of time in bed asleep",
                headline=f"You were asleep for {eff:.0f}% of your time in bed"))
        caveats.append("Sleep STAGES (deep/REM) are firmware-computed by a black box; "
                       "treat the split as directional. Sleep/wake is more trustworthy.")
    else:
        for k in ("sleep_duration", "sleep_quality"):
            comps.append(Component(k, None, None, WEIGHTS[k], 0.0, "no sleep record"))

    # --- resting HR (lowest reading of the day is the standard proxy)
    rhr = hr["rhr"].iloc[0] if not hr.empty else None
    b = bl["resting_hr"]
    if rhr is not None and not pd.isna(rhr) and b.n > 0:
        comps.append(Component(
            "resting_hr", float(rhr), _shrink(_band_score(float(rhr), b, False),
                                              b.confidence),
            WEIGHTS["resting_hr"], b.confidence,
            f"{rhr:.0f} bpm vs your {b.mean:.0f} typical (lower is better)", b.source,
            display=f"{rhr:.0f} bpm",
            delta=_delta_words(float(rhr), b.mean, lambda v: f"{v:.0f} bpm",
                               lower_is_better=True),
            headline=(f"Your resting heart rate is {abs(rhr - b.mean):.0f} bpm "
                      f"{'above' if rhr > b.mean else 'below'} usual"
                      if b.n else "No resting heart rate baseline yet")))
    else:
        comps.append(Component("resting_hr", None, None, WEIGHTS["resting_hr"], 0.0,
                               "no HR today"))

    # --- HRV and stress (ring-only baselines, honestly low confidence early on)
    for key, better in (("hrv", True), ("stress", False)):
        b = bl[key]
        if key in svals and b.n >= 2:
            v = float(svals[key][0])
            unit = " ms" if key == "hrv" else ""
            comps.append(Component(
                key, v, _shrink(_band_score(v, b, better), b.confidence),
                WEIGHTS[key], b.confidence,
                f"{v:.0f} vs your {b.mean:.0f} typical ({b.n}d baseline)", b.source,
                display=f"{v:.0f}{unit}",
                delta=_delta_words(v, b.mean, lambda x: f"{x:.0f}{unit}",
                                   lower_is_better=not better),
                headline=(f"Your {'HRV' if key == 'hrv' else 'stress'} is "
                          f"{abs(v - b.mean):.0f}{unit} "
                          f"{'above' if v > b.mean else 'below'} usual"
                          if abs(v - b.mean) >= 0.5
                          else f"Your {'HRV' if key == 'hrv' else 'stress'} is right at usual")))
            if b.confidence < 0.5:
                pretty = {"hrv": "HRV", "stress": "Stress"}.get(key, key)
                caveats.append(f"{pretty} baseline is only {b.n} days -- "
                               f"'typical' is not yet established.")
        else:
            comps.append(Component(key, None, None, WEIGHTS[key], 0.0,
                                   f"insufficient {key} history"))

    usable = [c for c in comps if c.available]
    if not usable:
        return Readiness(day, None, 0.0, comps, ["no usable components"])

    total_w = sum(c.weight for c in usable)
    score = sum(c.score * c.weight for c in usable) / total_w
    # Confidence is dragged down both by weak components and by missing weight.
    conf = sum(c.confidence * c.weight for c in usable) / total_w * (total_w / sum(WEIGHTS.values()))

    if total_w < sum(WEIGHTS.values()):
        missing = [c.name for c in comps if not c.available]
        caveats.append(f"missing components ({', '.join(missing)}) -- "
                       f"{total_w/sum(WEIGHTS.values()):.0%} of weight available")

    return Readiness(day, float(score), float(conf), comps, caveats)


if __name__ == "__main__":
    print(compute().describe())
