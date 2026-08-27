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
 * and the moment `meta.generated_at` passes the overlay's timestamp the overlay
 * is dropped, because by then the Mac has re-decoded the same night with full
 * history, cleaning and calibration behind it.
 */
const KEY = "ring-overlay-v1";

export type Overlay = {
  v: number; at: number; params_at: string | null;
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

/** Newest-wins merge on a day-like key, keeping the cached history intact. */
function mergeBy<T>(base: T[], add: T[], key: (x: T) => string, desc = false): T[] {
  const m = new Map(base.map((x) => [key(x), x]));
  for (const x of add) m.set(key(x), x);          // the phone's day replaces the Mac's
  const out = [...m.values()].sort((a, b) => key(a) < key(b) ? -1 : 1);
  return desc ? out.reverse() : out;
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

  // The Mac has caught up: its build is newer than this capture, and it decoded
  // the same bytes with the full history behind it. Drop the overlay entirely.
  const built = Date.parse(DATA.meta.generated_at);
  if (Number.isFinite(built) && built >= ov.at) {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    return;
  }

  const merged: Partial<Snapshot> = {};

  if (ov.nights?.length) {
    const nights = mergeBy(DATA.sleep.nights, ov.nights, (n) => n.night_of, true);
    merged.sleep = {
      nights,
      latest_night: nights.length ? nights[0].night_of : DATA.sleep.latest_night,
      latest_segments: ov.segments?.length ? ov.segments : DATA.sleep.latest_segments,
    };
  }
  if (ov.hr?.length) {
    merged.hr = { ...DATA.hr, points: mergeBy(DATA.hr.points, ov.hr, (p) => p.t) };
  }
  if (ov.steps?.length) {
    merged.steps = mergeBy(DATA.steps, ov.steps, (s) => s.day);
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
                      battery_at: new Date(ov.at).toISOString().slice(0, 19),
                      latest_reading: ov.hr?.length ? ov.hr[ov.hr.length - 1].t
                                                    : DATA.device.latest_reading };
  }
  if (ov.readiness && ov.readiness.score != null) {
    merged.readiness = {
      ...DATA.readiness,
      score: Math.round(ov.readiness.score * 10) / 10,
      confidence: ov.readiness.confidence,
      components: ov.readiness.components.map((c) => {
        const prev = DATA.readiness.components.find((x) => x.name === c.name);
        return { ...(prev ?? {}), ...c,
                 // Presentation strings are built by score.py and the phone does
                 // not reproduce them. `explain` is the one line both engines
                 // produce, so it stands in rather than showing the Mac's
                 // sentence about a different night.
                 display: prev?.display ?? "", delta: "", headline: c.explain };
      }) as Snapshot["readiness"]["components"],
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
