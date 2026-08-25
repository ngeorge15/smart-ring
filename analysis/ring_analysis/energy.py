"""
Energy expenditure from HEART RATE rather than step count.

WHY
---
The ring's firmware reports calories derived from steps alone -- it knows
nothing about your mass or how hard your heart is working, so a hard cycling
hour and an idle hour with the same step count score the same. That figure is an
index, useful for ranking days against each other and nothing more.

Heart rate is the signal the Watch actually uses. With mass, height, age and sex
(read from the Apple Health export by tools/import_profile.py) the standard
equations apply.

METHOD
------
* Resting metabolic rate: Mifflin-St Jeor, the current default for RMR.
* Active energy: heart-rate reserve -> MET, then the standard
  kcal/min = (MET - 1) * 3.5 * kg / 200.

Keytel et al. (2005) was tried first and rejected. It is fitted on EXERCISING
subjects and treats a seated heart rate of 80 as real exertion, producing 3,700
active kcal for an ordinary day against a measured ~110-280. The %HRR model with
an intensity FLOOR behaves correctly at rest.

THE FLOOR IS FITTED, NOT CHOSEN
-------------------------------
Below some intensity, heart rate reflects posture, caffeine and stress rather
than work, and counting it inflates everything. That cutoff was fitted against
868 days where the Watch recorded BOTH heart rate and its own
ActiveEnergyBurned -- same wrist, same day, one measuring what the other should
predict:

    floor 20% HRR -> median ratio 2.38   (over by 138%)
    floor 25% HRR -> median ratio 1.65
    floor 30% HRR -> median ratio 1.08   <- adopted
    floor 40% HRR -> median ratio 0.51   (under by half)

At 30% the estimator is essentially unbiased. Day-to-day error is still large --
median |error| 46% -- so it is honest for comparing days and for trends, and not
a number to eat against. That figure is REPORTED rather than hidden.

Steps-based firmware calories have no validation at all; this at least has a
measured error bar.

LIMITS
------
PPG from a finger is noisier than a wrist, unworn stretches read as gaps rather
than rest, and the fit is against one person's Watch, which is itself an
estimate. Coverage is reported alongside so a half-worn day is not read as a
lazy one.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "ring_data.sqlite"
KJ_PER_KCAL = 4.184
SAMPLE_MINUTES = 5          # the ring's HR log interval

# Fitted against 868 Watch days -- see the module docstring. Not a guess.
HRR_FLOOR = 0.30
# Peak METs for the %HRR -> MET mapping. 12 corresponds to a VO2max around
# 42 ml/kg/min, typical for an untrained adult; it scales the whole curve, and
# the floor above was fitted with this value held fixed.
MET_MAX = 12.0
# HR alone turned out to be the WEAKER predictor. Measured on the same 868 days:
#
#   HR only              median |err| 49.9%   corr 0.696
#   steps only           median |err| 26.0%   corr 0.897
#   HR + steps (fitted)  median |err| 14.7%   corr 0.908
#   ... out of sample                  14.6%   (fit on half, tested on the rest)
#
# Movement carries most of the signal for a mostly-sedentary day; heart rate adds
# the intensity that steps cannot see. Neither alone is as good as both, and the
# blend survives out-of-sample testing, so it is not just curve-fitting.
BLEND = {"hr": 0.084, "steps": 0.0204, "intercept": 106.6}

CALIBRATION = {
    "floor_hrr": HRR_FLOOR,
    "fitted_on_days": 868,
    "hr_only_median_pct_error": 49.9,
    "blended_median_pct_error": 14.6,
    "blend": BLEND,
}


@dataclass
class Profile:
    weight_kg: float
    height_cm: float
    age: int
    sex: str

    @property
    def rmr_kcal_day(self) -> float:
        """Mifflin-St Jeor."""
        base = 10 * self.weight_kg + 6.25 * self.height_cm - 5 * self.age
        return base + (5 if self.sex == "male" else -161)

    @property
    def rmr_kcal_min(self) -> float:
        return self.rmr_kcal_day / 1440

    @property
    def hr_max(self) -> float:
        return 220.0 - self.age

    def active_kcal_min(self, hr: pd.Series, resting: float) -> pd.Series:
        """kcal/min ABOVE rest, from heart-rate reserve. Zero below the floor."""
        reserve = max(self.hr_max - resting, 1.0)
        pct = ((hr - resting) / reserve).clip(lower=0, upper=1)
        met = 1 + pct * (MET_MAX - 1)
        kcal_min = (met - 1) * 3.5 * self.weight_kg / 200
        return kcal_min.where(hr >= resting + HRR_FLOOR * reserve, 0.0)


def load_profile(cfg: Path | None = None) -> Profile | None:
    """Read the body profile written by tools/import_profile.py."""
    path = cfg or (ROOT / "config.json")
    try:
        body = json.loads(path.read_text()).get("body", {})
    except (OSError, ValueError):
        return None
    if not all(k in body for k in ("weight_kg", "height_cm", "dob", "sex")):
        return None
    try:
        born = date.fromisoformat(body["dob"])
    except ValueError:
        return None
    today = date.today()
    age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
    return Profile(float(body["weight_kg"]), float(body["height_cm"]), age, body["sex"])


def resting_reference(db: Path = DB) -> float | None:
    """The resting-HR anchor the %HRR model measures against.

    The 5th percentile of EVERY reading, not of one day. A single day's low is
    noisy and a day the ring was worn for four busy hours has no low at all, so
    anchoring per-day would make the same heart rate score differently depending
    on how long the ring was worn.

    Exposed rather than inlined because the phone has to use the identical
    anchor: it holds one capture, so computing this locally would give it a
    different -- and always higher -- resting value than the Mac.
    """
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as c:
        hr = pd.read_sql_query(
            "SELECT reading FROM heart_rates WHERE reading > 0", c)
    if hr.empty:
        return None
    return float(hr["reading"].quantile(0.05))


def daily_energy(db: Path = DB, profile: Profile | None = None) -> pd.DataFrame:
    """Per-day active and total kcal estimated from the ring's heart-rate log.

    `coverage` is the fraction of the day actually sampled. A day the ring was
    worn for six hours cannot be compared with a full one, and reporting the
    number without that context is how the steps-based figure misled in the
    first place.
    """
    p = profile or load_profile()
    if p is None:
        return pd.DataFrame(columns=["day", "active_kcal", "total_kcal", "coverage"])

    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as c:
        hr = pd.read_sql_query(
            "SELECT timestamp, reading FROM heart_rates WHERE reading > 0", c)
    if hr.empty:
        return pd.DataFrame(columns=["day", "active_kcal", "total_kcal", "coverage"])

    hr["timestamp"] = pd.to_datetime(hr["timestamp"], format="mixed", errors="coerce")
    hr = hr.dropna(subset=["timestamp"])
    hr["day"] = hr["timestamp"].dt.date.astype(str)

    # Resting HR is read from the data, not assumed: the floor is relative to
    # THIS person's reserve, and a wrong resting value shifts every day.
    resting = resting_reference(db)
    if resting is None:
        return pd.DataFrame(columns=["day", "active_kcal", "total_kcal", "coverage"])
    hr["active"] = p.active_kcal_min(hr["reading"], resting) * SAMPLE_MINUTES

    g = hr.groupby("day").agg(hr_kcal=("active", "sum"),
                              samples=("reading", "count")).reset_index()
    slots_per_day = 24 * 60 / SAMPLE_MINUTES
    g["coverage"] = (g["samples"] / slots_per_day).clip(upper=1.0)

    # Blend in steps -- the stronger of the two predictors.
    #
    # IMPORTANT: the coefficients were fitted on WATCH steps, and the ring counts
    # differently (measured ratios of 0.51x and 2.23x on the two paired days so
    # far). Ring steps are therefore put on the Watch's footing first, using the
    # scale factor from calibrate.py once it exists. Until then the step term is
    # on an unverified scale and `steps_calibrated` says so rather than quietly
    # pretending otherwise.
    from ring_analysis import calibrate
    cal = calibrate.calibrate_steps(db)
    scale = cal.scale if (cal.ready and cal.scale) else 1.0

    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as c:
        st = pd.read_sql_query(
            "SELECT date(timestamp) day, SUM(steps) steps FROM sport_details "
            "GROUP BY day", c)
    g = g.merge(st, on="day", how="left")
    g["steps"] = g["steps"].fillna(0) * scale
    g["active_kcal"] = (BLEND["hr"] * g["hr_kcal"]
                        + BLEND["steps"] * g["steps"]
                        + BLEND["intercept"]).clip(lower=0)
    g["steps_calibrated"] = bool(cal.ready and cal.scale)
    # RMR is charged for the WHOLE day; you burn it whether or not the ring saw
    # it. Only the active component depends on having heart-rate samples.
    g["total_kcal"] = g["active_kcal"] + p.rmr_kcal_day
    for col in ("active_kcal", "total_kcal", "hr_kcal"):
        g[col] = g[col].round(1)
    g["coverage"] = g["coverage"].round(3)
    return g[["day", "active_kcal", "total_kcal", "hr_kcal", "coverage",
              "steps_calibrated"]]


def compare_to_apple(db: Path = DB) -> dict:
    """Check the HR estimate against the Watch on days both measured.

    Apple's ActiveEnergyBurned is the same quantity (energy above resting) from a
    device with a better sensor position, so it is the closest thing to ground
    truth available here.
    """
    ours = daily_energy(db)
    if ours.empty:
        return {"n": 0, "note": "no profile or no heart-rate data"}
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as c:
        ref = pd.read_sql_query(
            "SELECT substr(start_ts,1,10) day, value AS apple_kcal "
            "FROM reference_samples WHERE kind='active_energy'", c)
    m = ours.merge(ref, on="day")
    # Partial days would dominate the error; require most of the day sampled.
    m = m[(m["coverage"] >= 0.5) & (m["apple_kcal"] > 50)]
    if m.empty:
        return {"n": 0, "note": "no days with both good ring coverage and Watch data"}
    m["ratio"] = m["active_kcal"] / m["apple_kcal"]
    return {
        "n": int(len(m)),
        "median_ratio": round(float(m["ratio"].median()), 3),
        "mean_abs_pct_error": round(float(((m["ratio"] - 1).abs() * 100).mean()), 1),
        "days": [{"day": r.day, "ring": r.active_kcal, "apple": r.apple_kcal,
                  "ratio": round(r.ratio, 2), "coverage": r.coverage}
                 for r in m.sort_values("day").tail(10).itertuples()],
    }


if __name__ == "__main__":
    p = load_profile()
    print("profile:", p)
    if p:
        print(f"RMR: {p.rmr_kcal_day:.0f} kcal/day  ({p.rmr_kcal_min:.3f}/min)")
    print(daily_energy().tail(8).to_string(index=False))
    print()
    print(json.dumps(compare_to_apple(), indent=1, default=str))
