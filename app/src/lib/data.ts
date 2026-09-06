import raw from "@/snapshot.json";

export type Component = {
  name: string; value: number | null; score: number | null;
  weight: number; confidence: number; explain: string; available: boolean;
  display: string; delta: string; headline: string;
};
export type HeadroomCost = {
  name: string; points: number; shrink_points: number; measure_points: number;
  score: number; raw_score: number; confidence: number; display: string; baseline: string;
};
export type HeadroomLock = {
  name: string; weight: number; explain: string;
  have: number | null; need: number; nights_needed: number | null;
};
export type Headroom = {
  gap: number | null; costs: HeadroomCost[]; locked: HeadroomLock[];
  shrink_points: number; measure_points: number; weight_available: number;
};

export type Night = {
  night_of: string; onset: string; in_bed_min: number; asleep_min: number;
  light_min: number; deep_min: number; rem_min: number; awake_min: number;
  efficiency: number;
};
export type Segment = { night_of: string; start_ts: string; stage: string; minutes: number };
export type HrPoint = { t: string; v: number; i: boolean };
export type SeriesRow = { day: string; mean: number; min: number; max: number; n: number };
export type DebtNight = {
  night: string; asleep_min: number | null; delta: number | null;
  cumulative: number; source: string | null;
};
export type SleepDebtT = {
  target_min: number; window: number; debt_min: number;
  covered: number; missing: number; nights: DebtNight[];
  target_note: string; target_source: string;
  personal: { n: number; median: number; p25: number; p75: number } | null;
  sources: string[]; mixed_sources: boolean;
};
export type TrendWeek = {
  // null = the week has no data. Empty weeks are EMITTED so every metric shares
  // one x-axis; dropping them collapsed a five-week gap to a single bar-width.
  week: string; value: number | null; n: number; delta: number | null; thin: boolean;
};
export type TrendMetric = {
  key: string; title: string; unit: string; better: "up" | "down";
  weeks: TrendWeek[]; latest: number; delta: number | null;
  comparable: boolean; n_weeks: number;
};
export type TrendsT = { weeks: number; metrics: TrendMetric[]; generated_for: string };

export type BaselineT = {
  mean: number | null; sd: number | null; n: number;
  source: string; confidence: number; note: string;
};

export type Snapshot = {
  meta: { generated_at: string; ring: string; note: string;
          /** Exact captures committed by the authoritative importer. */
          capture_ack_ids?: string[]; capture_ack_at?: string | null;
          span: { first: string | null; last: string | null; days: number; hr_samples: number } };
  readiness: { day: string; is_today: boolean; score: number | null; confidence: number;
               components: Component[]; caveats: string[]; headroom: Headroom };
  sleep: { nights: Night[]; latest_night: string | null; latest_segments: Segment[] };
  sleep_debt: SleepDebtT;
  trends: TrendsT;
  hr: { points: HrPoint[]; coverage: number | null; n_outliers: number | null };
  series: Record<string, SeriesRow[]>;
  series_detail: Record<string, { day: string; minute: number; value: number }[]>;
  steps: { day: string; steps: number; hours: number; partial: boolean;
           calories_raw: number; distance_raw: number }[];
  activity_hourly: { t: string; hour: number; day: string; steps: number;
                     calories_raw: number; distance_raw: number }[];
  baselines: Record<string, BaselineT>;
  calibration: {
    steps: { ready: boolean; n: number; required: number; days: number;
             note: string; scale: number | null; median_ratio: number | null };
    sleep: { ready: boolean; n: number; required: number; note: string };
  };
  gaps: Record<string, string>;
  energy: {
    days: { day: string; active_kcal: number; total_kcal: number;
             hr_kcal: number; coverage: number; steps_calibrated: boolean }[];
    rmr_kcal: number | null;
    calibration: Record<string, unknown>;
    profile: { weight_kg: number; age: number } | null;
  };
  ring_status: {
    battery_life: {
      pct_per_day: number | null; full_charge_days?: number | null;
      days_remaining?: number | null; basis: string;
      observed_hours?: number; observed_drop?: number; segments: number;
    };
    battery_history: { ts: string; level: number; charging: boolean }[];
    last_sync_mac: string | null;
    last_sync_phone: string | null;
    recent_syncs: { id: number; at: string; source: string }[];
    counts: Record<string, number>;
  };
  device: {
    battery: number | null; charging: boolean; battery_at?: string | null;
    last_charge: string | null; last_charge_seen: boolean;
    last_sync: string | null; latest_reading: string | null;
    watching_since?: string;
  };
};

export const DATA = raw as unknown as Snapshot;

/* Semantic state. Colour NEVER travels without the word -- three bands only,
   deliberately omitting 'serious' because it and 'warning' are the one
   confusable status pair. */
export type Band = { color: string; word: string; glow: string };
export function band(score: number | null | undefined): Band {
  if (score == null) return { color: "var(--ink-3)", word: "No data", glow: "transparent" };
  if (score >= 70) return { color: "var(--good)", word: "Good", glow: "#0ca30c" };
  if (score >= 40) return { color: "var(--warning)", word: "Fair", glow: "#fab219" };
  return { color: "var(--critical)", word: "Needs recovery", glow: "#d03b3b" };
}

export const confWord = (c: number) => (c < 0.4 ? "low" : c < 0.75 ? "moderate" : "good");
export const confColor = (c: number) =>
  c < 0.4 ? "var(--critical)" : c < 0.75 ? "var(--warning)" : "var(--good)";

export const hm = (m: number) =>
  `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;

/* Compact duration for deltas and debt, where "0h 44m" reads as noise.
   Always signed when `sign` is set, because a delta's direction is the point. */
export const hmShort = (m: number, sign = false) => {
  const a = Math.abs(Math.round(m));
  const s = sign ? (m < 0 ? "-" : "+") : "";
  return a < 60 ? `${s}${a}m` : a % 60 === 0 ? `${s}${a / 60}h` : `${s}${Math.floor(a / 60)}h ${a % 60}m`;
};

/* Direction-aware verdict for a week-over-week delta. Colour NEVER travels
   alone here -- callers pair it with the arrow and the word. */
export function trendVerdict(delta: number | null, better: "up" | "down") {
  if (delta == null || delta === 0)
    return { color: "var(--ink-3)", word: "flat", arrow: "→" };
  const improving = better === "up" ? delta > 0 : delta < 0;
  return improving
    ? { color: "var(--good)", word: "improving", arrow: delta > 0 ? "↑" : "↓" }
    : { color: "var(--critical)", word: "slipping", arrow: delta > 0 ? "↑" : "↓" };
}

export const STAGE_COLOR: Record<string, string> = {
  deep: "var(--deep)", light: "var(--light-stage)",
  REM: "var(--rem)", awake: "var(--awake)",
};
export const STAGE_ORDER = ["awake", "REM", "light", "deep"];

/* CSS `capitalize` turns "hrv" into "Hrv" and "resting hr" into "Resting Hr".
   Acronyms need an explicit map; everything else falls back to word-casing. */
const LABELS: Record<string, string> = {
  hrv: "HRV", resting_hr: "Resting HR", spo2: "SpO2", stress: "Stress",
  sleep_duration: "Sleep duration", sleep_quality: "Sleep quality",
  sleep_stages: "Sleep stages", spo2_timestamps: "SpO2 timestamps",
  temperature: "Temperature",
};
export const label = (k: string) =>
  LABELS[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());


/* Units resolved 2026-08-23 against the ring's own data -- see load.py.
   distance = metres (0.75 m/stride, stable across every hour).
   calories = milli-kcal; firmware estimates these from steps alone, so they are
   an index rather than a budget. Conversions stay explicit here. */
export const toKm = (metres: number) => metres / 1000;
export const toMiles = (metres: number) => metres / 1609.344;
/* Food "Calories" (capital C) ARE kilocalories -- same number, different name.
   Apple Fitness labels this "CAL", so we match that. */
export const toKcal = (milli: number) => milli / 1000;
