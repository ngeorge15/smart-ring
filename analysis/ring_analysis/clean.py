"""
Cleaning for sparse physiological series.

Two rules govern this module:

1. We MARK outliers, never silently replace them. A health tool that quietly
   rewrites your data is lying to you. Callers choose whether to drop them.
2. We never interpolate across a real gap. Smoothing a 6-hour hole into a
   confident line invents data. Gaps stay NaN and are reported as coverage.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# Physiological hard limits. Outside these a reading is an artifact, not a value.
LIMITS = {"bpm": (30, 220), "hrv": (5, 250), "spo2": (70, 100), "stress": (0, 100)}


def clip_impossible(df: pd.DataFrame, col: str) -> pd.DataFrame:
    lo, hi = LIMITS.get(col, (-np.inf, np.inf))
    out = df.copy()
    bad = out[col].notna() & ((out[col] < lo) | (out[col] > hi))
    out.loc[bad, col] = pd.NA
    out["dropped_impossible"] = bad
    return out


def hampel(df: pd.DataFrame, col: str, window: int = 7, n_sigmas: float = 3.0) -> pd.DataFrame:
    """
    Flag spikes by median absolute deviation.

    PPG from a finger ring throws isolated spikes when the sensor loses contact.
    A rolling MEAN would be dragged by those spikes; the median is not, which is
    the whole point of using MAD here rather than a standard deviation filter.
    """
    out = df.copy()
    x = out[col].astype("Float64")
    med = x.rolling(window, center=True, min_periods=3).median()
    mad = (x - med).abs().rolling(window, center=True, min_periods=3).median()
    # 1.4826 scales MAD to be a consistent estimator of sigma for normal data
    sigma = 1.4826 * mad
    deviation = (x - med).abs()
    out["is_outlier"] = (sigma > 0) & (deviation > n_sigmas * sigma)
    out["is_outlier"] = out["is_outlier"].fillna(False).astype(bool)
    return out


def resample_gap_aware(
    df: pd.DataFrame, col: str, freq: str = "5min", max_gap_minutes: int = 15
) -> pd.DataFrame:
    """
    Put the series on a uniform grid, interpolating ONLY across short gaps.

    Anything longer than max_gap_minutes stays NaN. `interpolated` marks every
    synthesised point so the UI can render it differently from a measurement --
    interpolation is a drawing aid, never data.
    """
    s = df.set_index("timestamp")[col].astype("Float64").sort_index()
    if s.empty:
        return pd.DataFrame(columns=[col, "interpolated"])

    grid = s.resample(freq).mean()
    measured = grid.notna()

    step = pd.Timedelta(freq).total_seconds() / 60
    limit = max(1, int(max_gap_minutes // step))
    filled = grid.interpolate(method="time", limit=limit, limit_area="inside")

    out = pd.DataFrame({col: filled})
    out["interpolated"] = filled.notna() & ~measured
    return out


def coverage(df: pd.DataFrame, col: str, freq: str = "5min") -> float:
    """Fraction of the span that carries a real measurement (0-1)."""
    if df.empty or df[col].notna().sum() == 0:
        return 0.0
    span = df["timestamp"].max() - df["timestamp"].min()
    expected = max(1, span.total_seconds() / 60 / (pd.Timedelta(freq).total_seconds() / 60))
    return float(min(1.0, df[col].notna().sum() / expected))


def prepare(df: pd.DataFrame, col: str, freq: str = "5min") -> dict:
    """clip -> flag outliers -> resample. Returns frame plus an audit trail."""
    if df.empty:
        return {"data": pd.DataFrame(), "coverage": 0.0, "n_outliers": 0, "n_impossible": 0}

    step1 = clip_impossible(df, col)
    step2 = hampel(step1, col)
    clean = step2.copy()
    clean.loc[clean["is_outlier"], col] = pd.NA

    return {
        "data": resample_gap_aware(clean, col, freq),
        "coverage": coverage(step2, col, freq),
        "n_outliers": int(step2["is_outlier"].sum()),
        "n_impossible": int(step1["dropped_impossible"].sum()),
    }
