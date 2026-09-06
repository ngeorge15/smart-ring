import { decodeHandoff } from "@handoff";
import { DATA, type Snapshot } from "@/lib/data";

/**
 * Apply a capture handed over from Bluefy.
 *
 * The dashboard holds the HISTORY (the Mac's snapshot, service-worker cached);
 * the phone holds the NEWEST DAY and nothing else. So this never rebuilds
 * anything -- it merges one capture onto the cached history, keyed by day, and
 * lets everything downstream carry on as if the Mac had built it.
 *
 * The Mac stays authoritative. The same raw bytes upload by the normal path,
 * and the overlay is dropped only when snapshot metadata acknowledges that
 * exact capture ID. A newer build can be unrelated or can race the decoder.
 */
const KEY = "ring-overlay-v1";

export type Overlay = {
  v: number; at: number; params_at: string | null;
  /** Optional only so already-stored v2 overlays remain readable. Legacy
      overlays cannot be retired without an exact acknowledgement. */
  capture_id?: string; capture_day?: string;
  readiness: { score: number | null; confidence: number;
               components: { name: string; value: number | null; score: number | null;
                             weight: number; confidence: number; explain: string;
                             available: boolean }[] } | null;
  nights: Snapshot["sleep"]["nights"];
  segments: Snapshot["sleep"]["latest_segments"];
  hr: Snapshot["hr"]["points"];
  steps: Snapshot["steps"];
  series: Snapshot["series"];
  series_detail: Snapshot["series_detail"];
  battery: { level: number; charging: boolean } | null;
};

export const overlayState: { active: boolean; at: number | null; paramsAt: string | null } =
  { active: false, at: null, paramsAt: null };

const read = (): Overlay | null => {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
};

/**
 * Apply a just-decoded capture directly, no fragment/codec round-trip needed.
 *
 * The hash-based path below exists because Bluefy and Safari cannot share
 * storage — the payload has to travel through a URL, so it has to be encoded.
 * A capture decoded by the dashboard's OWN capture engine (lib/capture.ts +
 * lib/summarise.ts) is already in this process; writing it to the same
 * localStorage key `read()` already consumes is the entire integration.
 * Reloading re-enters the normal boot path in main.tsx, which applies it
 * exactly as a Bluefy handoff would have.
 */
export function saveOverlayAndReload(ov: Overlay): void {
  try { localStorage.setItem(KEY, JSON.stringify(ov)); } catch { /* quota */ }
  location.reload();
}

/** Newest-wins merge on a day-like key, keeping the cached history intact. */
function mergeBy<T>(base: T[], add: T[], key: (x: T) => string, desc = false): T[] {
  const m = new Map(base.map((x) => [key(x), x]));
  for (const x of add) m.set(key(x), x);          // the phone's day replaces the Mac's
  const out = [...m.values()].sort((a, b) => key(a) < key(b) ? -1 : 1);
  return desc ? out.reverse() : out;
}

function componentDisplay(name: string, value: number | null): string {
  if (value == null) return "";
  if (name === "sleep_duration") {
    const mins = Math.round(value);
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
  }
  if (name === "sleep_quality") return `${Math.round(value)}%`;
  if (name === "resting_hr") return `${Math.round(value)} bpm`;
  if (name === "hrv") return `${Math.round(value)} ms`;
  return String(Math.round(value));
}

function overlaySleepDebt(nights: Snapshot["sleep"]["nights"], captureDay: string) {
  const base = DATA.sleep_debt;
  const byDay = new Map(base.nights.map((n) => [n.night, n]));
  for (const n of nights) {
    byDay.set(n.night_of, { night: n.night_of, asleep_min: n.asleep_min,
      delta: n.asleep_min - base.target_min, cumulative: 0, source: "ring" });
  }
  const end = new Date(`${captureDay}T00:00:00Z`);
  const rows: Snapshot["sleep_debt"]["nights"] = [];
  let running = 0;
  for (let i = base.window - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const existing = byDay.get(day);
    const asleep = existing?.asleep_min ?? null;
    const delta = asleep == null ? null : asleep - base.target_min;
    if (delta != null) running = Math.max(0, running - delta);
    rows.push({ night: day, asleep_min: asleep, delta,
      cumulative: Math.round(running), source: existing?.source ?? null });
  }
  const sources = [...new Set(rows.flatMap((n) => n.source ? [n.source] : []))].sort();
  return { ...base, nights: rows, debt_min: Math.round(running),
    covered: rows.filter((n) => n.asleep_min != null).length,
    missing: rows.filter((n) => n.asleep_min == null).length,
    sources, mixed_sources: sources.length > 1 };
}

/* A fragment-only navigation does NOT reload the page.
   If Safari already has the dashboard open, opening
   `.../index.html#h=...` changes the fragment in place: main.tsx never re-runs
   and initOverlay never sees the payload. Since DATA is patched once before
   render, the cheapest correct answer is to store the payload and reload -- the
   normal boot path then applies it exactly as it would on a cold open. */
addEventListener("hashchange", () => { void adoptFromHash(true); });

async function adoptFromHash(reload: boolean): Promise<Overlay | null> {
  const m = location.hash.match(/[#&]h=([^&]+)/);
  if (!m) return null;
  const ov = (await decodeHandoff(decodeURIComponent(m[1]))) as Overlay | null;
  if (ov) {
    try { localStorage.setItem(KEY, JSON.stringify(ov)); } catch { /* quota */ }
  }
  // Strip it either way. A payload left in the address bar gets bookmarked,
  // shared, and re-applied long after it stopped being true.
  history.replaceState(null, "", location.pathname + location.search);
  if (ov && reload) location.reload();
  return ov;
}

export async function initOverlay(): Promise<void> {
  let ov: Overlay | null = null;

  // A fragment beats whatever is stored: it is the reason this page was opened.
  // No reload on this path -- nothing has rendered yet.
  ov = await adoptFromHash(false);
  if (!ov) ov = read();
  if (!ov || !ov.at) return;

  // Build timestamps prove only that a build happened. An unrelated rebuild or
  // a rebuild racing the async decoder must not discard fresh phone readings.
  if (ov.capture_id && DATA.meta.capture_ack_ids?.includes(ov.capture_id)) {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    return;
  }
  if (!ov.capture_id) {
    // Legacy v2 overlays predate capture IDs, so no future snapshot can ever
    // acknowledge them exactly. Keep them only while they are demonstrably
    // newer than the baked snapshot; otherwise they would override that day
    // forever. New overlays never use this timestamp fallback.
    const built = Date.parse(DATA.meta.generated_at);
    if (!Number.isFinite(built) || built >= ov.at) {
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      return;
    }
  }

  const merged: Partial<Snapshot> = {};

  if (ov.nights?.length) {
    const nights = mergeBy(DATA.sleep.nights, ov.nights, (n) => n.night_of, true);
    const days = new Set(ov.nights.map((n) => n.night_of));
    merged.sleep = {
      nights,
      latest_night: nights.length ? nights[0].night_of : DATA.sleep.latest_night,
      latest_segments: [
        ...DATA.sleep.latest_segments.filter((s) => !days.has(s.night_of)),
        ...(ov.segments ?? []),
      ].sort((a, b) => a.start_ts.localeCompare(b.start_ts)),
    };
    if (ov.capture_day) merged.sleep_debt = overlaySleepDebt(ov.nights, ov.capture_day);
  }
  if (ov.hr?.length) {
    merged.hr = { points: mergeBy(DATA.hr.points, ov.hr, (p) => p.t),
      // Coverage/outliers require the Mac's complete window and cleaning pass.
      // null suppresses the old snapshot's unrelated derived values.
      coverage: null, n_outliers: null };
  }
  if (ov.steps?.length) {
    merged.steps = mergeBy(DATA.steps, ov.steps, (s) => s.day);
    const days = new Set(ov.steps.map((s) => s.day));
    // These are computed on the Mac from inputs the local capture does not
    // carry. Remove the superseded day rather than pairing old derivatives
    // with new totals.
    merged.activity_hourly = DATA.activity_hourly.filter((r) => !days.has(r.day));
    merged.energy = { ...DATA.energy,
      days: DATA.energy.days.filter((r) => !days.has(r.day)) };
  }
  if (ov.series) {
    const series = { ...DATA.series };
    for (const [k, rows] of Object.entries(ov.series)) {
      series[k] = mergeBy(series[k] ?? [], rows, (r) => r.day);
    }
    merged.series = series;
  }
  if (ov.series_detail) {
    const detail = { ...DATA.series_detail };
    for (const [k, rows] of Object.entries(ov.series_detail)) {
      // Replace WHOLE DAYS rather than merging point-by-point: a partial day
      // spliced into a fuller one produces a curve that never existed.
      const days = new Set(rows.map((r) => r.day));
      detail[k] = [...(detail[k] ?? []).filter((r) => !days.has(r.day)), ...rows];
    }
    merged.series_detail = detail;
  }
  if (ov.battery) {
    merged.device = { ...DATA.device, battery: ov.battery.level,
                      charging: ov.battery.charging,
                      battery_at: new Date(ov.at).toISOString(),
                      latest_reading: ov.hr?.length ? ov.hr[ov.hr.length - 1].t
                                                    : DATA.device.latest_reading };
  }
  if (ov.readiness) {
    const now = new Date();
    const currentDay = new Date(now.getTime() - now.getTimezoneOffset() * 6e4)
      .toISOString().slice(0, 10);
    merged.readiness = {
      ...DATA.readiness,
      day: ov.capture_day ?? DATA.readiness.day,
      is_today: ov.capture_day
        ? ov.capture_day === currentDay
        : DATA.readiness.is_today,
      score: ov.readiness.score == null ? null : Math.round(ov.readiness.score * 10) / 10,
      confidence: ov.readiness.confidence,
      components: ov.readiness.components.map((c) => ({ ...c,
        display: componentDisplay(c.name, c.value), delta: "", headline: c.explain,
      })) as Snapshot["readiness"]["components"],
      caveats: [],
      // headroom is a Python computation over full baselines; it cannot be
      // recomputed here, and pairing the Mac's breakdown with the phone's score
      // would describe a gap that does not match the number above it.
      headroom: { gap: null, costs: [], locked: [],
                  shrink_points: 0, measure_points: 0, weight_available: 0 },
    };
  }

  Object.assign(DATA, merged);
  overlayState.active = true;
  overlayState.at = ov.at;
  overlayState.paramsAt = ov.params_at;
}
