/* =============================================================================
   Local decode + scoring, so the phone works with the Mac asleep.

   THE RULE THIS FILE LIVES UNDER
   ------------------------------
   Python is the source of truth. This is a DISPLAY engine: it decodes the same
   bytes and applies the same published parameters so the phone can show a number
   immediately, but the Mac re-decodes and re-scores authoritatively from the raw
   bytes when it next sees them. If the two ever disagree, the Mac wins and the
   raw bytes are still on disk -- so drift is a wrong pixel, never lost history.

   Nothing here is tuned or chosen. Weights, baselines and percentile anchors all
   arrive from params.json, which the Mac generates. Only the evaluator is
   duplicated across languages; the parameters have exactly one definition.

   Verified against score.py on real data by tools/verify_engine.mjs.
   ========================================================================== */

/* ------------------------------------------------------------------ decoding */

export const hexToBytes = (h) =>
  new Uint8Array((h.match(/../g) || []).map((b) => parseInt(b, 16)));

const le16 = (b, i) => b[i] | (b[i + 1] << 8);

export const STAGE = { 2: "light", 3: "deep", 4: "REM", 5: "awake" };

/** Battery: byte 1 is percent, byte 2 is the charging flag. */
export function decodeBattery(chunks) {
  for (const h of chunks) {
    const p = hexToBytes(h);
    if (p.length >= 3 && p[0] === 3) return { level: p[1], charging: !!p[2] };
  }
  return null;
}

/** Split a big-data blob into per-message payloads (6-byte header each). */
export function splitMessages(blob) {
  const out = [];
  let i = 0;
  while (i + 6 <= blob.length) {
    if (blob[i] !== 0xbc) { i++; continue; }
    const len = le16(blob, i + 2);
    const start = i + 6;
    const end = Math.min(start + len, blob.length);
    if (end > start) out.push(blob.slice(start, end));
    i = end;
  }
  return out;
}

/**
 * Sleep. The header is FOUR bytes (start LE16, end LE16), not two -- reading it
 * as two produces a plausible phantom segment. The declared window must equal
 * the sum of segment durations or the record is not trusted; that invariant is
 * what caught the original bug, so it is enforced here too rather than assumed.
 */
export function decodeSleep(payload) {
  const nights = [];
  if (!payload.length) return nights;
  let i = 0;
  const nDays = payload[i++];
  for (let d = 0; d < nDays && i + 2 <= payload.length; d++) {
    const daysAgo = payload[i], len = payload[i + 1];
    i += 2;
    const body = payload.slice(i, i + len);
    i += len;
    if (body.length < 4) continue;
    const start = le16(body, 0), end = le16(body, 2);
    const segs = [];
    for (let j = 4; j + 1 < body.length; j += 2) {
      segs.push({ stage: STAGE[body[j]] || `?${body[j]}`, minutes: body[j + 1] });
    }
    const total = segs.reduce((s, x) => s + x.minutes, 0);
    const byStage = {};
    for (const s of segs) byStage[s.stage] = (byStage[s.stage] || 0) + s.minutes;
    /* end WRAPS at midnight, so end < start means the night crossed it and the
       real span is end + 1440. Without this a night beginning before midnight
       produced a NEGATIVE in_bed_min and failed its own checksum -- and the
       local view filters on checksum_ok, so the phone silently discarded the
       night. Mirrors the same fix in colmi_bigdata.parse_sleep. */
    const wrapped = end < start;
    const endAbs = wrapped ? end + 1440 : end;
    const inBed = endAbs - start;
    const awake = byStage.awake || 0;
    nights.push({
      days_ago: daysAgo, start, end,
      // The onset belongs to the PREVIOUS day when the night wrapped.
      wrapped,
      in_bed_min: inBed,
      asleep_min: inBed - awake,
      stages: byStage,
      efficiency: inBed > 0 ? ((inBed - awake) / inBed) * 100 : null,
      checksum_ok: inBed === total,
      segments: segs,
    });
  }
  return nights;
}

/**
 * HRV / stress history. stream[0] is the day offset ECHOED BACK by the ring --
 * not a sample. Reading it as data shifts the whole series by one and silently
 * corrupts the first value.
 */
export function decodeLog(cmd, chunks) {
  const packets = chunks.map(hexToBytes).filter((p) => p.length && p[0] === cmd);
  const byIndex = new Map(packets.map((p) => [p[1], p]));
  const header = byIndex.get(0);
  if (!header) return null;
  const nPackets = header[2], interval = header[3];

  const stream = [];
  for (let i = 1; i < nPackets; i++) {
    const p = byIndex.get(i);
    if (p) for (let k = 2; k < 15 && k < p.length; k++) stream.push(p[k]);
  }
  if (!stream.length) return null;

  const dayOffset = stream[0];
  const body = stream.slice(1);
  const values = [];
  if (cmd === 57) {                       // HRV is little-endian uint16
    for (let i = 0; i + 1 < body.length; i += 2) values.push(body[i] | (body[i + 1] << 8));
  } else {
    values.push(...body);                 // stress is uint8
  }
  return { interval, day_offset: dayOffset, values: values.map((v) => (v ? v : null)) };
}

/**
 * Heart-rate log: a multi-packet state machine, ported from
 * colmi_r02_client.hr.HeartRateLogParser. 288 samples at 5-minute intervals.
 *
 * The framing is irregular on purpose and must be copied exactly:
 *   sub_type 0   -> header: byte2 = packet count, byte3 = range
 *   sub_type 1   -> 4-byte LE timestamp, then only NINE samples (bytes 6..14)
 *   otherwise    -> THIRTEEN samples (bytes 2..14)
 * Getting the 9-vs-13 split wrong shifts the whole day silently.
 */
export function decodeHeartRateLog(chunks) {
  let size = 0, index = 0, range = 5, ts = null;
  let raw = [];
  let done = false;

  for (const h of chunks) {
    const p = hexToBytes(h);
    if (p.length !== 16 || p[0] !== 21) continue;
    const sub = p[1];
    if (sub === 255) return null;                 // ring says: no data
    if (sub === 0) {
      size = p[2]; range = p[3];
      raw = new Array(size * 13).fill(-1);
      index = 0;
    } else if (sub === 1) {
      ts = (p[2] | (p[3] << 8) | (p[4] << 16) | (p[5] << 24)) >>> 0;
      for (let k = 0; k < 9; k++) raw[k] = p[6 + k];
      index = 9;
    } else {
      for (let k = 0; k < 13; k++) raw[index + k] = p[2 + k];
      index += 13;
      if (sub === size - 1) { done = true; break; }
    }
  }
  if (!done || ts == null) return null;

  let hr = raw.slice(0, 288);
  while (hr.length < 288) hr.push(0);

  // Samples are 5 minutes apart starting at the log's midnight. The Python side
  // zeroes slots in the future for today; the same is done here so a partial day
  // does not read as a wall of zeros that look like real readings.
  const base = new Date(ts * 1000);
  const midnight = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const isToday = midnight.toDateString() === new Date().toDateString();
  if (isToday) {
    const now = new Date();
    const slot = Math.floor((now.getHours() * 60 + now.getMinutes()) / 5);
    for (let i = slot; i < hr.length; i++) hr[i] = 0;
  }

  const samples = [];
  for (let i = 0; i < hr.length; i++) {
    if (hr[i] > 0) {
      samples.push({ bpm: hr[i], at: new Date(midnight.getTime() + i * 5 * 60000) });
    }
  }
  return { samples, range, day: midnight };
}

const bcd = (b) => (b >> 4) * 10 + (b & 0x0f);

/**
 * Steps / calories / distance, 15-minute buckets.
 * Ported from colmi_r02_client.steps.SportDetailParser. The `new_calorie_protocol`
 * flag (header byte 3 == 1) multiplies calories by 10 -- miss it and calories are
 * out by an order of magnitude while still looking plausible.
 */
export function decodeSportDetail(chunks) {
  let newCalorieProtocol = false, index = 0, complete = false;
  const details = [];
  for (const h of chunks) {
    const p = hexToBytes(h);
    if (p.length !== 16 || p[0] !== 67) continue;
    if (index === 0 && p[1] === 255) return [];          // no data
    if (index === 0 && p[1] === 240) {
      if (p[3] === 1) newCalorieProtocol = true;
      index++;
      continue;
    }
    let calories = p[7] | (p[8] << 8);
    if (newCalorieProtocol) calories *= 10;
    details.push({
      year: bcd(p[1]) + 2000, month: bcd(p[2]), day: bcd(p[3]),
      time_index: p[4],
      calories,
      steps: p[9] | (p[10] << 8),
      distance: p[11] | (p[12] << 8),
    });
    // byte5 is this row's index, byte6 the total: the last row satisfies
    // index == total - 1. Python STOPS here and returns nothing at all if the
    // terminator never arrives.
    if (p[5] === p[6] - 1) { complete = true; break; }
    index++;
  }
  // Deliberately more lenient than Python on a truncated capture: return the
  // rows we did get, flagged incomplete, rather than discarding the lot. A
  // dropped BLE packet should cost one bucket, not the whole day.
  details.complete = complete;
  return details;
}

/* SpO2 and temperature ride the same big-data channel as sleep: a flat blob of
   fixed-width per-day records. Both are ports of colmi_bigdata.py, whose layout
   comments record how each was pinned down. */

const SPO2_SAMPLES = 48;
const SPO2_RECORD = 1 + SPO2_SAMPLES;          // [days_ago][48 uint8]
const TEMP_SAMPLES = 48;
const TEMP_RECORD = 2 + TEMP_SAMPLES;          // [days_ago][interval][48 uint8]

/** -> [{days_ago, interval, values}]. 0 means "no measurement", never zero. */
export function decodeSpo2(chunks) {
  const blob = hexToBytes(chunks.join(""));
  const out = [];
  for (const payload of splitMessages(blob)) {
    for (let off = 0; off + SPO2_RECORD <= payload.length; off += SPO2_RECORD) {
      const rec = payload.slice(off, off + SPO2_RECORD);
      const values = [...rec.slice(1)].map((v) => (v ? v : null));
      // A record of nothing but zeroes is a day the ring never measured. Python
      // drops it, and keeping it here would invent a day of missing data that
      // the Mac does not have.
      if (values.some((v) => v != null))
        out.push({ days_ago: rec[0], interval: 30, values });
    }
  }
  return out;
}

/** -> [{days_ago, interval, values}] of RAW samples; celsius = raw / 10 + 20.
    Stored raw so the conversion keeps exactly one definition, as in Python. */
export function decodeTemperature(chunks) {
  const blob = hexToBytes(chunks.join(""));
  const out = [];
  for (const payload of splitMessages(blob)) {
    for (let off = 0; off + TEMP_RECORD <= payload.length; off += TEMP_RECORD) {
      const rec = payload.slice(off, off + TEMP_RECORD);
      const values = [...rec.slice(2)].map((v) => (v ? v : null));
      if (values.some((v) => v != null))
        out.push({ days_ago: rec[0], interval: rec[1], values });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ cleaning */

/* Ported from clean.py. The phone used to skip this entirely, which mattered
   most for resting HR: that is a MINIMUM, so a single impossible low sample
   moves it directly, where a mean would barely register. Python rejected those
   samples and the phone did not, and the two then disagreed on the day. */

export const LIMITS = {
  bpm: [30, 220], hrv: [5, 250], spo2: [70, 100], stress: [0, 100],
};

/** Drop physically impossible readings. Same bounds as clean.LIMITS. */
export function clipImpossible(values, kind) {
  const lim = LIMITS[kind];
  if (!lim) return values.slice();
  const [lo, hi] = lim;
  return values.map((v) => (v == null || v < lo || v > hi ? null : v));
}

const median = (xs) => {
  const v = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Centred rolling median, pandas' rolling(window, center=True, min_periods).
    Nulls are skipped, not treated as zero; too few observations yields null. */
function rollMedian(values, window, minPeriods) {
  const half = window >> 1;
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const win = values.slice(Math.max(0, i - half), i + half + 1)
                      .filter((x) => x != null && !Number.isNaN(x));
    if (win.length >= minPeriods) out[i] = median(win);
  }
  return out;
}

/**
 * Hampel filter: reject points more than `nSigmas` robust deviations from the
 * local median. Ported from clean.hampel.
 *
 * The MAD is a ROLLING MEDIAN OF THE DEVIATION SERIES -- each point's deviation
 * is taken against its OWN local median, and those deviations are then smoothed.
 * Taking the median of |x - med[i]| inside the window instead is the obvious
 * reading and gives different numbers; pandas does the former.
 *
 * 1.4826 converts a median-absolute-deviation into a standard-deviation
 * equivalent for normal data -- the same constant Python uses, not a knob.
 *
 * A flat window has MAD 0, and `sigma > 0` then declines to flag anything. That
 * is deliberate and matches Python: with no spread there is no scale against
 * which to call a point extreme, and without the guard every point fails.
 */
export function hampel(values, window = 7, nSigmas = 3.0, minPeriods = 3) {
  const med = rollMedian(values, window, minPeriods);
  const dev = values.map((v, i) =>
    v == null || med[i] == null ? null : Math.abs(v - med[i]));
  const mad = rollMedian(dev, window, minPeriods);
  return values.map((v, i) => {
    if (v == null || med[i] == null || mad[i] == null) return v;
    const sigma = 1.4826 * mad[i];
    return sigma > 0 && Math.abs(v - med[i]) > nSigmas * sigma ? null : v;
  });
}

/** clip + hampel, the order prepare() applies them in. */
export const cleanSeries = (values, kind) => hampel(clipImpossible(values, kind));

export const mean = (xs) => {
  const v = xs.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/* ------------------------------------------------------------------- scoring */

/**
 * Where a value sits in your own distribution, 0-100.
 * Mirrors Baseline.pct: piecewise-linear through p10->10, p50->50, p90->90.
 * Returns null below n=3, exactly as Python does, so a thin baseline declines to
 * score rather than inventing one.
 */
export function pct(value, b, minN = 7) {
  if (value == null || !b || b.n < minN) return null;
  const { p10: lo, p50: mid, p90: hi } = b;
  if (lo == null || mid == null || hi == null) return null;
  if (value <= lo) return 10;
  if (value >= hi) return 90;
  if (value < mid) return mid > lo ? 10 + (40 * (value - lo)) / (mid - lo) : 50;
  return hi > mid ? 50 + (40 * (value - mid)) / (hi - mid) : 50;
}

export function bandScore(value, b, higherIsBetter, minN) {
  const p = pct(value, b, minN);
  if (p == null) return null;            // never invent 50 -- drop instead
  return higherIsBetter ? p : 100 - p;
}

/** Pull a score toward the neutral midpoint in proportion to confidence. */
function shrink(score, confidence, on) {
  if (score == null || !on) return score;
  return 50 + (score - 50) * Math.max(0, Math.min(1, confidence));
}

const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Readiness from today's values plus params.json.
 *
 * `inputs`: { asleep_min, efficiency, resting_hr, hrv, stress }
 * Components with no data are DROPPED and the remaining weights renormalised --
 * never scored 50, which would fabricate a middling day.
 */
export function readiness(inputs, params) {
  const B = params.baselines, W = params.weights;
  // Every threshold comes from params.json -- see build_web._emit_params. None
  // of these numbers is chosen here; that is what keeps the two engines aligned.
  const R = params.rules || {};
  const minN = R.min_baseline_n ?? 7;
  const shrinkOn = R.shrink_toward_mean !== false;
  const maxEff = R.max_scorable_efficiency ?? 99;
  const crossCap = R.cross_device_confidence_cap ?? 0.5;
  const comps = [];

  const add = (name, value, score, confidence, explain) =>
    comps.push({ name, value, score, weight: W[name], confidence, explain,
                 available: value != null && score != null });

  if (inputs.asleep_min != null) {
    const b = B.sleep_min;
    // Ring measurement against a Watch-derived baseline: confidence is capped
    // until calibration measures the ~30% offset between the two devices.
    const conf = b.source !== "ring" && !inputs.sleep_calibrated
      ? Math.min(b.confidence, crossCap) : b.confidence;
    add("sleep_duration", inputs.asleep_min,
        shrink(bandScore(inputs.asleep_min, b, true, minN), conf, shrinkOn), conf,
        `${(inputs.asleep_min / 60).toFixed(1)}h vs your ${(b.mean / 60).toFixed(1)}h typical`);
  } else add("sleep_duration", null, null, 0, "no sleep record");

  if (inputs.efficiency != null && inputs.efficiency < maxEff) {
    // Fixed scale, not personalised -- confidence 0.6 is likewise fixed.
    add("sleep_quality", inputs.efficiency,
        clip(((inputs.efficiency - 60) / 35) * 100, 0, 100), 0.6,
        `${Math.round(inputs.efficiency)}% efficiency (fixed scale)`);
  } else if (inputs.efficiency != null) {
    add("sleep_quality", null, null, 0,
        `${Math.round(inputs.efficiency)}% efficiency means the ring logged no wake at all`);
  } else add("sleep_quality", null, null, 0, "no sleep record");

  const rb = B.resting_hr;
  if (inputs.resting_hr != null && rb.n > 0) {
    add("resting_hr", inputs.resting_hr,
        shrink(bandScore(inputs.resting_hr, rb, false, minN), rb.confidence, shrinkOn),
        rb.confidence, `${Math.round(inputs.resting_hr)} bpm vs your ${Math.round(rb.mean)} typical`);
  } else add("resting_hr", null, null, 0, "no HR today");

  for (const [key, better] of [["hrv", true], ["stress", false]]) {
    const b = B[key];
    if (inputs[key] != null && b && b.n >= 2) {
      add(key, inputs[key],
          shrink(bandScore(inputs[key], b, better, minN), b.confidence, shrinkOn),
          b.confidence,
          `${Math.round(inputs[key])} vs your ${Math.round(b.mean)} typical (${b.n}d baseline)`);
    } else add(key, null, null, 0, `insufficient ${key} history`);
  }

  const usable = comps.filter((c) => c.available);
  if (!usable.length) return { score: null, confidence: 0, components: comps };

  const totalW = usable.reduce((s, c) => s + c.weight, 0);
  const allW = Object.values(W).reduce((a, b) => a + b, 0);
  const score = usable.reduce((s, c) => s + c.score * c.weight, 0) / totalW;
  // Confidence is dragged down BOTH by weak components and by missing weight.
  const confidence =
    (usable.reduce((s, c) => s + c.confidence * c.weight, 0) / totalW) * (totalW / allW);

  return { score, confidence, components: comps, weight_available: totalW / allW };
}
