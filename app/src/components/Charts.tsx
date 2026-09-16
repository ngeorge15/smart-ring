import { useState } from "react";
import {
  Line, LineChart, ResponsiveContainer, ReferenceLine, Tooltip, XAxis, YAxis, CartesianGrid,
} from "recharts";
import {
  DATA, STAGE_COLOR, STAGE_ORDER, band, hm, label,
  type Component, type Segment, type SeriesRow,
} from "@/lib/data";
import { Card } from "@/components/ui/card";

export function Section({ title, right, children }: {
  title: string; right?: string; children: React.ReactNode;
}) {
  return (
    <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
      <h2 className="mb-4 flex items-center justify-between text-[13px] font-[660] text-ink-2">
        {title}
        {right && <span className="text-[11.5px] font-medium text-ink-3">{right}</span>}
      </h2>
      {children}
    </Card>
  );
}

/* ---------------- contributors: progressive disclosure ---------------- */
export function Contributors({ components, caveats }: {
  components: Component[]; caveats: string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="Contributors" right="tap for detail">
      {components.map((c) => {
        const b = band(c.score);
        const isOpen = open === c.name;
        if (!c.available) {
          return (
            <div key={c.name} className="border-t border-hairline py-3 opacity-55 first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-2.5">
                <span className="text-[14.5px] font-medium">{label(c.name)}</span>
                <span className="tnum text-[15px] font-[660]">—</span>
              </div>
              <p className="mt-1 text-[12px] text-ink-2">
                dropped: {c.explain} — weight redistributed, never scored 50
              </p>
            </div>
          );
        }
        return (
          <button key={c.name} onClick={() => setOpen(isOpen ? null : c.name)}
                  className="block w-full border-t border-hairline py-3 text-left first:border-t-0 first:pt-0">
            <div className="flex items-baseline justify-between gap-2.5">
              <span className="text-[14.5px] font-medium">{label(c.name)}</span>
              <span className="tnum text-[15px] font-[660]" style={{ color: b.color }}>
                {Math.round(c.score!)}
                <span className={`ml-1 inline-block text-[11px] text-ink-3 transition-transform
                                  ${isOpen ? "rotate-180" : ""}`}>▾</span>
              </span>
            </div>
            <p className="mt-1 text-[12px] text-ink-2">{c.explain}</p>
            <div className="mt-2 h-[7px] overflow-hidden rounded-full bg-raise">
              <div className="barfill h-full rounded-full"
                   style={{ width: `${c.score}%`, background: b.color }} />
            </div>
            <div className={`overflow-hidden text-[11.5px] leading-relaxed text-ink-3 transition-all
                             ${isOpen ? "mt-2 max-h-32" : "max-h-0"}`}>
              Weight {(c.weight * 100).toFixed(0)}% of the total score · confidence{" "}
              {Math.round(c.confidence * 100)}% · scored against your own baseline,
              not a population average.
            </div>
          </button>
        );
      })}
      {caveats.map((w, i) => (
        <p key={i} className="my-2.5 border-l-2 border-warning pl-3 text-[12px] leading-normal text-ink-2">
          {w}
        </p>
      ))}
    </Section>
  );
}

/** One overnight series drawn on the hypnogram's OWN time axis.

    The point is alignment: read on its own a heart-rate trace says little, but
    sitting directly under the stage lanes on the same x-scale you can see the
    dip into deep sleep and the climb before waking. It is bars rather than a
    line because the samples are 5 and 30 minutes apart -- a line would imply a
    continuity between them that was never measured.

    Scaled to its OWN range, not zero-based: overnight SpO2 lives in a 95-99
    band and a zero-based axis flattens it to a straight line. The range is
    printed beside the label so the scale is never implied. */
function NightSeries({ label, pts, t0, total, fmt }: {
  label: string;
  pts: { at: Date; v: number }[];
  t0: Date; total: number;
  fmt: (v: number) => string;
}) {
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const H = 40;
  const pct = (d: Date) => ((d.getTime() - t0.getTime()) / 6e4 / total) * 100;
  // Median gap between samples sets the bar width, so a 30-minute series draws
  // wide bars and a 5-minute one draws thin ones without either being told.
  const gaps = pts.slice(1).map((p, i) => p.at.getTime() - pts[i].at.getTime())
                  .sort((a, b) => a - b);
  const step = gaps[Math.floor(gaps.length / 2)] / 6e4;
  const w = Math.max(1.2, (step / total) * 100 * 0.8);

  return (
    <div className="mt-1.5 flex items-start gap-2">
      <span className="w-11 shrink-0 pt-[12px] text-right text-[10.5px] leading-tight text-ink-3">
        {label}
        {/* Range lives with the LABEL, not floating over the plot. Drawn inside
            it, it sat on top of the data it was describing. */}
        <span className="block text-[9.5px] leading-tight opacity-80">
          {fmt(lo)}–{fmt(hi)}
        </span>
      </span>
      <div className="relative flex-1" style={{ height: H }}>
        {/* Marks sit AT the value; they are not bars growing from a baseline.
            A bottom-anchored bar asserts a meaningful zero, and neither series
            has one -- overnight SpO2 spans 96-99%, so a 96 drawn as a quarter
            the height of a 99 claims a fourfold difference that is not there. */}
        {pts.map((p, i) => (
          <i key={i} className="absolute rounded-[1px]"
             title={`${fmt(p.v)} · ${p.at.toTimeString().slice(0, 5)}`}
             style={{ left: `${pct(p.at)}%`, width: `${w}%`, height: 3,
                      top: (1 - (p.v - lo) / span) * (H - 3),
                      background: "var(--brand)", opacity: 0.9 }} />
        ))}
      </div>
    </div>
  );
}

/* ---------------- hypnogram ----------------
   HTML/CSS rather than SVG: text inside a viewBox-scaled SVG shrinks with the
   box (11.5px in a 1000-unit box renders ~5px at phone width), so labels live
   outside as real text. Bars are positioned by percentage.                    */
export function Hypnogram({ segments, night, title = "Sleep" }:
  { segments: Segment[]; night: string | null; title?: string }) {
  if (!segments.length) {
    return <Section title={title}><p className="py-1.5 text-[12.5px] text-ink-3">
      No sleep recorded yet. Wear the ring overnight.</p></Section>;
  }
  const total = segments.reduce((s, x) => s + x.minutes, 0);
  const t0 = new Date(segments[0].start_ts);
  const end = new Date(t0.getTime() + total * 6e4);
  const fmt = (d: Date) => d.toTimeString().slice(0, 5);
  const totals: Record<string, number> = {};
  segments.forEach((s) => (totals[s.stage] = (totals[s.stage] || 0) + s.minutes));

  const placed = segments.reduce<{ rows: (Segment & { left: number; width: number })[];
                                    elapsed: number }>((state, sg) => ({
    rows: [...state.rows, { ...sg, left: (state.elapsed / total) * 100,
                            width: (sg.minutes / total) * 100 }],
    elapsed: state.elapsed + sg.minutes,
  }), { rows: [], elapsed: 0 }).rows;

  /* ---- level geometry, shared by the SVG trace and the label column below ----
     One continuous path now, not four lane tracks: each stage is a LEVEL the
     line sits at, not a row it lives in. LABEL_W has to agree with the label
     column's real rendered width (w-11 + the gap beside it) or the hour
     ticks/time-range text below drift out of alignment with the trace. */
  const LEVEL_H = 20, LABEL_W = 52;
  const svgH = STAGE_ORDER.length * LEVEL_H;
  const yOf = (stage: string) => STAGE_ORDER.indexOf(stage) * LEVEL_H + LEVEL_H / 2;
  const pctOf = (d: Date) => ((d.getTime() - t0.getTime()) / 6e4 / total) * 100;

  /* Wall-clock ticks on even hours, the way a clock reads -- not evenly spaced
     from whenever you happened to fall asleep. Without a time axis you could see
     THAT deep sleep happened but never WHEN, which is most of what a hypnogram
     is for. Interval is the smallest that keeps the labels from colliding. */
  const spanH = total / 60;
  const stepH = [1, 2, 3, 4, 6].find((h) => spanH / h <= 5) ?? 6;
  const ticks: Date[] = [];
  const first = new Date(t0);
  first.setMinutes(0, 0, 0);
  while (first.getHours() % stepH !== 0) first.setHours(first.getHours() + 1);
  for (let d = first; d <= end; d = new Date(d.getTime() + stepH * 36e5)) {
    if (d >= t0) ticks.push(new Date(d));
  }

  /* A night that crosses midnight belongs to two dates, and saying only the
     later one hides half of it -- the same confusion that let a 23:27 onset be
     filed a day forward in the decoder. */
  const md = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const nightLabel = t0.toDateString() === end.toDateString()
    ? md(t0)
    : `${md(t0)}\u2013${end.getDate()}`;

  /* Overnight HR and SpO2, clipped to THIS night's window.
     Both are stored differently -- HR as absolute timestamps, SpO2 as
     (day, minute-of-day) -- so both are normalised to instants here and the
     rest of the drawing code never has to know the difference. */
  const inWindow = (d: Date) => d >= t0 && d <= end;
  const hrPts = DATA.hr.points
    .map((p) => ({ at: new Date(p.t), v: p.v }))
    .filter((p) => inWindow(p.at));
  const spo2Pts = (DATA.series_detail?.spo2 ?? [])
    .map((r) => ({ at: new Date(`${r.day}T00:00`), v: r.value, m: r.minute }))
    .map((r) => ({ at: new Date(r.at.getTime() + r.m * 6e4), v: r.v }))
    .filter((p) => inWindow(p.at))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <Section title={title} right={night ? nightLabel : undefined}>
      <div className="relative">
        <div className="flex gap-2">
          <div className="flex w-11 shrink-0 flex-col text-right text-[10.5px] text-ink-3"
               style={{ height: svgH }}>
            {STAGE_ORDER.map((stage) => (
              <span key={stage} className="flex flex-1 items-center justify-end">{stage}</span>
            ))}
          </div>
          {/* One continuous trace, not four lane tracks: each stage is a LEVEL
              the line sits AT, stepping up and down as the night moves through
              them, rounded caps at every join so it reads as one flowing shape
              instead of separate floating bars. */}
          <svg viewBox={`0 0 1000 ${svgH}`} width="100%" height={svgH}
               preserveAspectRatio="none" className="block flex-1" role="img"
               aria-label={`Sleep stages over the night, from ${fmt(t0)} to ${fmt(end)}`}>
            {ticks.map((d, i) => (
              <line key={`g${i}`} x1={pctOf(d) * 10} x2={pctOf(d) * 10} y1={0} y2={svgH}
                    stroke="var(--ink-3)" strokeOpacity={0.16} strokeWidth={1} />
            ))}
            {placed.slice(0, -1).map((p, i) => {
              const next = placed[i + 1];
              if (next.stage === p.stage) return null;
              const x = (p.left + p.width) * 10;
              return (
                <line key={`c${i}`} x1={x} x2={x} y1={yOf(p.stage)} y2={yOf(next.stage)}
                      stroke={STAGE_COLOR[next.stage] ?? "var(--ink-3)"}
                      strokeWidth={6} strokeLinecap="round" />
              );
            })}
            {placed.map((p, i) => (
              <line key={`s${i}`} x1={p.left * 10} x2={(p.left + p.width) * 10}
                    y1={yOf(p.stage)} y2={yOf(p.stage)}
                    stroke={STAGE_COLOR[p.stage] ?? "var(--ink-3)"}
                    strokeWidth={6} strokeLinecap="round">
                <title>{`${p.stage} · ${p.minutes} min · from ${p.start_ts.slice(11, 16)}`}</title>
              </line>
            ))}
          </svg>
        </div>

        <NightSeries label="heart rate" pts={hrPts} t0={t0} total={total}
                     fmt={(v) => `${Math.round(v)}`} />
        <NightSeries label="SpO2" pts={spo2Pts} t0={t0} total={total}
                     fmt={(v) => `${Math.round(v)}%`} />
      </div>

      <div className="relative mt-1.5 h-[14px]" style={{ marginLeft: LABEL_W }}>
        {ticks.map((d, i) => (
          <span key={i} className="tnum absolute top-0 -translate-x-1/2 text-[10.5px] text-ink-3"
                style={{ left: `${pctOf(d)}%` }}>{fmt(d)}</span>
        ))}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-3" style={{ marginLeft: LABEL_W }}>
        {fmt(t0)} – {fmt(end)}
      </p>
      <div className="mt-3 flex flex-wrap gap-3.5 text-[11.5px] text-ink-2">
        {STAGE_ORDER.map((r) => (
          <span key={r} className="inline-flex items-center">
            <i className="mr-1.5 h-2.5 w-2.5 rounded-[3px]" style={{ background: STAGE_COLOR[r] }} />
            {r}
          </span>
        ))}
      </div>
      {/* table view = the relief the light-mode contrast WARN requires */}
      <table className="mt-3.5 w-full border-collapse text-[12.5px]">
        <thead><tr className="text-ink-3">
          <th className="border-t border-hairline py-1.5 text-left text-[10.5px] font-[660] uppercase tracking-wider">Stage</th>
          <th className="border-t border-hairline py-1.5 text-right text-[10.5px] font-[660] uppercase tracking-wider">Time</th>
          <th className="border-t border-hairline py-1.5 text-right text-[10.5px] font-[660] uppercase tracking-wider">Share</th>
        </tr></thead>
        <tbody className="text-ink-2">
          {STAGE_ORDER.filter((r) => totals[r]).map((r) => (
            <tr key={r}>
              <td className="border-t border-hairline py-1.5">{r}</td>
              <td className="tnum border-t border-hairline py-1.5 text-right font-[620] text-ink">{hm(totals[r])}</td>
              <td className="tnum border-t border-hairline py-1.5 text-right font-[620] text-ink">
                {Math.round((totals[r] / total) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/* ---------------- heart rate (Recharts) ---------------- */
function TipBox({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg bg-ink px-2.5 py-1.5 text-[11.5px] font-medium text-plane">
      {p.v} bpm · {String(label).slice(5).replace("T", " ")}{p.i ? " · interpolated" : ""}
    </div>
  );
}

/** The latest contiguous stretch of wear.

    Showing three days compressed a night's detail into a few pixels. A gap
    longer than an hour means the ring was off, out of range, or unsynced, so
    that is where one wear period ends and the next begins. */
function latestRun(points: typeof DATA.hr.points, gapMinutes = 60) {
  if (points.length < 2) return points;
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = (new Date(points[i].t).getTime() -
                 new Date(points[i - 1].t).getTime()) / 60000;
    if (gap > gapMinutes) start = i;
  }
  return points.slice(start);
}

export function HrChart() {
  const pts = latestRun(DATA.hr.points);
  if (pts.length < 2) {
    return <Section title="Heart rate"><p className="py-1.5 text-[12.5px] text-ink-3">
      Not enough heart-rate data yet.</p></Section>;
  }
  // Two series over one axis: a synthesised line must never look measured.
  // Boundary points appear in both so the line stays visually continuous.
  const rows = pts.map((p, i) => {
    const prev = pts[i - 1], next = pts[i + 1];
    const edge = (prev && prev.i !== p.i) || (next && next.i !== p.i);
    return {
      t: p.t, v: p.v, i: p.i,
      measured: !p.i || edge ? (p.i && !edge ? null : p.v) : null,
      interp: p.i || edge ? p.v : null,
    };
  });
  const vals = pts.map((p) => p.v);
  const lo = Math.floor(Math.min(...vals) / 10) * 10 - 5;
  const hi = Math.ceil(Math.max(...vals) / 10) * 10 + 5;

  return (
    <Section title="Heart rate" right={`${pts.length} readings`}>
      <div className="h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="var(--hairline)" vertical={false} />
            <XAxis dataKey="t" tick={{ fontSize: 11, fill: "var(--ink-3)" }}
                   tickLine={false} axisLine={false} minTickGap={46}
                   tickFormatter={(t) => {
                     const d = new Date(String(t));
                     const h = d.getHours();
                     return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
                   }} />
            <YAxis domain={[lo, hi]} tick={{ fontSize: 11, fill: "var(--ink-3)" }}
                   tickLine={false} axisLine={false} width={44} />
            <Tooltip content={<TipBox />} cursor={{ stroke: "var(--ink-3)", strokeWidth: 1 }} />
            <Line type="monotone" dataKey="interp" stroke="var(--brand)" strokeWidth={2.2}
                  strokeDasharray="4 5" strokeOpacity={0.4} dot={false} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="measured" stroke="var(--brand)" strokeWidth={2.2}
                  dot={false} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-3.5 text-[11.5px] text-ink-2">
        <span className="inline-flex items-center">
          <i className="mr-1.5 h-2.5 w-2.5 rounded-[3px] bg-brand" />measured</span>
        <span className="inline-flex items-center">
          <i className="mr-1.5 h-2.5 w-2.5 rounded-[3px] bg-brand opacity-40" />
          estimated between readings</span>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
        {new Date(pts[0].t).toLocaleString(undefined, { weekday: "short", hour: "numeric",
          minute: "2-digit" })} → {new Date(pts[pts.length - 1].t).toLocaleTimeString(
          undefined, { hour: "numeric", minute: "2-digit" })} ·
        {" "}{DATA.hr.n_outliers} odd spike{DATA.hr.n_outliers === 1 ? "" : "s"} removed
        {" "}across all data · long gaps left blank
      </p>
    </Section>
  );
}

/* ---------------- trends ---------------- */
const TREND_META: Record<string, { t: string; u: string }> = {
  hrv: { t: "HRV", u: " ms" }, stress: { t: "Stress", u: "" }, spo2: { t: "Blood oxygen", u: "%" },
};

export function Trends() {
  const entries = Object.entries(TREND_META)
    .filter(([k]) => DATA.series[k]?.length) as [string, { t: string; u: string }][];
  if (!entries.length) {
    return <Section title="Trends"><p className="py-1.5 text-[12.5px] text-ink-3">
      No trend data yet.</p></Section>;
  }
  return (
    <Section title="Trends" right="vs your baseline">
      {entries.map(([k, m]) => {
        const rows: SeriesRow[] = DATA.series[k];
        const b = DATA.baselines[k] ?? {};
        return (
          <div key={k} className="mb-4 last:mb-0">
            <div className="flex items-baseline justify-between">
              <span className="text-[13.5px] font-medium">{m.t}</span>
              <span className="tnum text-[15px] font-[660]">{rows[rows.length - 1].mean}{m.u}</span>
            </div>
            {rows.length >= 3 ? (
              <div className="mt-1 h-[52px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 6, right: 4, bottom: 4, left: 4 }}>
                    {b.mean != null && (
                      <ReferenceLine y={b.mean} stroke="var(--ink-3)" strokeDasharray="3 4" />
                    )}
                    <Tooltip content={({ active, payload }: any) =>
                      active && payload?.length ? (
                        <div className="rounded-lg bg-ink px-2.5 py-1.5 text-[11.5px] font-medium text-plane">
                          {payload[0].payload.day} · mean {payload[0].payload.mean}{m.u}
                          {" "}({payload[0].payload.n} samples)
                        </div>) : null} />
                    <Line type="monotone" dataKey="mean" stroke="var(--brand)" strokeWidth={2.4}
                          dot={{ r: 4, fill: "var(--brand)", strokeWidth: 0 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-ink-3">
                <span className="inline-flex gap-1">
                  {rows.map((r, i) => (
                    <i key={i} className="h-1.5 w-1.5 rounded-full bg-brand" title={`${r.day}: ${r.mean}`} />
                  ))}
                </span>
                {rows.length} day{rows.length === 1 ? "" : "s"} recorded — {3 - rows.length} more
                needed before a trend is meaningful
              </div>
            )}
            <p className="text-[11.5px] leading-relaxed text-ink-3">
              your typical: {b.mean ?? "—"}{m.u} · {b.note || b.source}
            </p>
          </div>
        );
      })}
    </Section>
  );
}

/* ---------------- tiles + limits ---------------- */
export function Tiles() {
  const st = DATA.steps;
  if (!st.length) return null;
  const last = st[st.length - 1], cal = DATA.calibration.steps;
  return (
    <div className="rise mb-3 flex gap-2.5">
      <Card className="flex-1 border-hairline bg-surface-1 p-3.5">
        <div className="text-[10px] font-[660] uppercase tracking-[0.1em] text-ink-3">Steps today</div>
        <div className="tnum mt-1.5 text-[27px] font-[640] leading-none tracking-tight">
          {last.steps.toLocaleString()}</div>
        <div className="mt-1 text-[11.5px] text-ink-3">
          {last.partial ? `partial — ${last.hours}h recorded` : `${last.hours}h recorded`}</div>
      </Card>
      <Card className="flex-1 border-hairline bg-surface-1 p-3.5">
        <div className="text-[10px] font-[660] uppercase tracking-[0.1em] text-ink-3">Calibration</div>
        <div className="tnum mt-1.5 text-[27px] font-[640] leading-none tracking-tight">
          {cal.ready ? (cal.scale?.toFixed(2) ?? "ready")
                     : <>{cal.n}<span className="text-[15px] text-ink-3">/{cal.required}</span></>}
        </div>
        <div className="mt-1 text-[11.5px] text-ink-3">
          {cal.ready ? "scale vs Watch" : "matched hours vs Watch"}</div>
      </Card>
    </div>
  );
}

export function KnownLimits() {
  return (
    <Section title="Known limits">
      {Object.entries(DATA.gaps).map(([k, v]) => (
        <div key={k} className="border-t border-hairline py-2.5 text-[12px] leading-relaxed
                                text-ink-2 first:border-t-0 first:pt-0">
          <b className="mb-0.5 block text-[12.5px] font-[620] text-ink">{label(k)}</b>{v}
        </div>
      ))}
      <div className="border-t border-hairline py-2.5 text-[12px] leading-relaxed text-ink-2">
        <b className="mb-0.5 block text-[12.5px] font-[620] text-ink">Step calibration</b>
        {DATA.calibration.steps.note}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
        These limits are listed on purpose. Knowing where the data is weak is
        what lets you trust the rest of it.
      </p>
    </Section>
  );
}
