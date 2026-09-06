/**
 * Decode a freshly captured set of BLE chunks into the shape the dashboard's
 * own DATA object already uses — ported from sync.html's buildHandoff().
 *
 * Unlike sync.html, this never needs to ENCODE the result: producer and
 * consumer are now the same page, so the object is applied directly rather
 * than gzipped, base64url'd, and carried through a URL fragment. That codec
 * (@handoff) still exists for sync.html's Bluefy fallback path, which is a
 * genuinely different origin and still needs it.
 */
import {
  hexToBytes, splitMessages, decodeBattery, decodeSleep, decodeLog,
  decodeHeartRateLog, decodeSportDetail, decodeSpo2, decodeTemperature,
  readiness, cleanSeries,
} from "@ring-engine";
import { HANDOFF_VERSION } from "@handoff";
import type { Overlay } from "@/lib/overlay";
import type { Capture } from "@/lib/capture";

const PARAMS_KEY = "ring-params-v1";

/** Mirrored into localStorage: tiny (~1KB), changes rarely, and is what makes
    scoring work if the Mac is unreachable right after a capture. */
export async function getParams(): Promise<unknown | null> {
  try {
    const res = await fetch("params.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const p = await res.json();
    try { localStorage.setItem(PARAMS_KEY, JSON.stringify(p)); } catch { /* full */ }
    return p;
  } catch {
    const cached = localStorage.getItem(PARAMS_KEY);
    return cached ? JSON.parse(cached) : null;
  }
}

const stepsOf = (cap: Capture, kind: string) => cap.steps.filter((s) => s.kind === kind);
const chunksOf = (cap: Capture, kind: string) => stepsOf(cap, kind).flatMap((s) => s.chunks);

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4)
  .toISOString().slice(0, 16);

/** Civil day at capture time, independent of when/where this queue is read. */
export function captureDayISO(cap: Pick<Capture, "captured_at" | "captured_timezone" |
  "captured_utc_offset_min">): string {
  const at = new Date(cap.captured_at);
  if (!Number.isFinite(at.getTime())) throw new Error("invalid capture timestamp");
  if (cap.captured_timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: cap.captured_timezone, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(at);
      const get = (kind: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === kind)?.value;
      const y = get("year"), m = get("month"), d = get("day");
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch { /* old/invalid zone: use the captured fixed offset */ }
  }
  if (Number.isFinite(cap.captured_utc_offset_min)) {
    return new Date(cap.captured_at + cap.captured_utc_offset_min! * 6e4)
      .toISOString().slice(0, 10);
  }
  return iso(at).slice(0, 10); // legacy queued capture
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const minuteISO = (day: string, minute: number) => {
  const date = addDays(day, Math.floor(minute / 1440));
  const m = ((minute % 1440) + 1440) % 1440;
  return `${date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

function agg(day: string, values: (number | null)[]) {
  const v = values.filter((x): x is number => x != null);
  if (!v.length) return null;
  return { day, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2),
           min: Math.min(...v), max: Math.max(...v), n: v.length };
}

function seriesMeanForDay(out: Overlay, kind: string, day: string): number | null {
  return out.series[kind]?.find((r) => r.day === day)?.mean ?? null;
}

/** Everything one capture carries, decoded into the dashboard's own
    vocabulary — DECODED, never raw hex, matching the same "display shortcut,
    never a second source of truth" contract sync.html's handoff used. */
export function summarise(cap: Capture, params: unknown): Overlay {
  const captureDay = captureDayISO(cap);
  const out: Overlay = {
    v: HANDOFF_VERSION, at: cap.captured_at,
    capture_id: cap.id, capture_day: captureDay,
    params_at: (params as { generated_at?: string } | null)?.generated_at ?? null,
    nights: [], segments: [], hr: [], steps: [],
    series: {}, series_detail: {}, battery: null, readiness: null,
  };

  const bat = decodeBattery(chunksOf(cap, "battery"));
  if (bat) out.battery = bat;

  // --- sleep: every night the capture carried, not just the newest
  // efficiency is only null for a degenerate record (in_bed_min === 0) --
  // not a real night, so it is dropped rather than forced into a type that
  // promises a number. Same posture as checksum_ok: never trust a record that
  // fails its own basic sanity check.
  const nights = splitMessages(hexToBytes(chunksOf(cap, "sleep").join("")))
    .flatMap(decodeSleep).filter((n) => n.checksum_ok && n.efficiency != null);
  for (const n of nights) {
    const nightOf = addDays(captureDay, -n.days_ago);
    const startDay = n.wrapped ? addDays(nightOf, -1) : nightOf;
    const onset = minuteISO(startDay, n.start);
    out.nights.push({
      night_of: nightOf, onset,
      in_bed_min: n.in_bed_min, asleep_min: n.asleep_min,
      light_min: n.stages.light || 0, deep_min: n.stages.deep || 0,
      rem_min: n.stages.REM || 0, awake_min: n.stages.awake || 0,
      // Non-null by construction: filtered above.
      efficiency: +n.efficiency!.toFixed(2),
    });
    if (n.days_ago === 0) {
      let minute = n.start;
      for (const sg of n.segments) {
        out.segments.push({ night_of: nightOf, start_ts: minuteISO(startDay, minute),
                            stage: sg.stage, minutes: sg.minutes });
        minute += sg.minutes;
      }
    }
  }
  out.nights.sort((a, b) => (a.night_of < b.night_of ? 1 : -1));

  // --- heart rate
  const hrLog = decodeHeartRateLog(chunksOf(cap, "hr"));
  if (hrLog) {
    for (const p of hrLog.samples) {
      if (p.bpm > 0) out.hr.push({ t: iso(p.at), v: p.bpm, i: false });
    }
  }

  // --- steps, summed per day the way load.py does
  const byDay: Record<string, { day: string; steps: number; calories_raw: number;
                                distance_raw: number; hours: number; partial: boolean }> = {};
  for (const r of decodeSportDetail(chunksOf(cap, "steps"))) {
    const d = `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`;
    const b = byDay[d] || (byDay[d] = { day: d, steps: 0, calories_raw: 0,
                                        distance_raw: 0, hours: 0, partial: true });
    b.steps += r.steps; b.calories_raw += r.calories; b.distance_raw += r.distance;
    b.hours += 0.25;
  }
  out.steps = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));

  // --- the 30-minute series, cleaned with the SAME filters Python applies
  const putSeries = (kind: string, day: string, values: (number | null)[], interval: number) => {
    const a = agg(day, values);
    if (!a) return;
    (out.series[kind] = out.series[kind] || []).push(a);
    const det = (out.series_detail[kind] = out.series_detail[kind] || []);
    values.forEach((v, i) => { if (v != null) det.push({ day, minute: i * interval, value: v }); });
  };
  for (const [kind, cmd, clean] of [["hrv", 57, "hrv"], ["stress", 55, "stress"]] as const) {
    for (const st of stepsOf(cap, kind)) {
      const log = decodeLog(cmd, st.chunks || []);
      if (!log) continue;
      putSeries(kind, addDays(captureDay, -log.day_offset),
                cleanSeries(log.values, clean), log.interval || 30);
    }
  }
  for (const r of decodeSpo2(chunksOf(cap, "spo2"))) {
    putSeries("spo2", addDays(captureDay, -r.days_ago), cleanSeries(r.values, "spo2"), r.interval);
  }
  for (const r of decodeTemperature(chunksOf(cap, "temp"))) {
    putSeries("temp_raw", addDays(captureDay, -r.days_ago), r.values, r.interval);
  }

  // --- the score, computed here because only here are params and data together
  if (params) {
    const n0 = out.nights.find((n) => n.night_of === captureDay);
    const hrToday = out.hr.filter((p) => p.t.slice(0, 10) === captureDay).map((p) => p.v);
    out.readiness = readiness({
      asleep_min: n0 ? n0.asleep_min : null,
      efficiency: n0 ? n0.efficiency : null,
      resting_hr: hrToday.length ? Math.min(...hrToday) : null,
      hrv: seriesMeanForDay(out, "hrv", captureDay),
      stress: seriesMeanForDay(out, "stress", captureDay),
    }, params);
  }
  return out;
}
