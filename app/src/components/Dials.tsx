import { useEffect, useState, useSyncExternalStore } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { band, confColor, type Component } from "@/lib/data";
import { Card } from "@/components/ui/card";

const MINI_SCORE_BREAKPOINT = "(max-width: 430px)";

function getCompactMiniLayout() {
  return typeof matchMedia !== "undefined" && matchMedia(MINI_SCORE_BREAKPOINT).matches;
}

function subscribeCompactMiniLayout(onChange: () => void) {
  if (typeof matchMedia === "undefined") return () => {};
  const media = matchMedia(MINI_SCORE_BREAKPOINT);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useCompactMiniLayout() {
  return useSyncExternalStore(
    subscribeCompactMiniLayout,
    getCompactMiniLayout,
    () => false,
  );
}

/** Counts up from 0 to `value` on mount, same trigger as Arc's fill (one
    rAF-deferred flip of a boolean, CSS transition does the rest) so the
    number and the ring land together. Respects prefers-reduced-motion via
    the same .tnum-adjacent CSS rule Arc already relies on -- see .rise. */
function useCountUp(value: number | null, ms = 900) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (value == null) return;
    let raf = 0;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      raf = requestAnimationFrame(() => setDisplay(value));
      return () => cancelAnimationFrame(raf);
    }
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      // Same ease-out shape as .arc's cubic-bezier(.2,.72,.28,1): fast start,
      // long settle -- a linear count reads as mechanical next to the ring.
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return value == null ? null : display;
}

/** Animated SVG arc. Radius/stroke are props so hero, mini, and the sync
    progress ring all share one path -- the ring "filling" reads the same way
    everywhere in the app rather than a bar meaning one thing on this screen
    and a ring another. */
export function Arc({ score, r, stroke, color }: {
  score: number | null; r: number; stroke: number; color: string;
}) {
  const [on, setOn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(id); }, []);
  const C = 2 * Math.PI * r;
  const size = (r + stroke / 2) * 2;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}
         aria-hidden="true" focusable="false" className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke="var(--raise)" strokeWidth={stroke} />
      <circle className="arc" cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={color} strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={on ? C * (1 - pct) : C} />
    </svg>
  );
}

export function Hero({ score, confidence, driver, asOf }: {
  score: number | null; confidence: number; driver?: Component; asOf?: string;
}) {
  const b = band(score);
  const shown = useCountUp(score == null ? null : Math.round(score));
  return (
    <Card className="rise relative overflow-hidden border-hairline bg-surface-1 px-5 pt-7 pb-6 mb-3">
      <div aria-hidden className="pointer-events-none absolute left-1/2 -top-[46%] h-[300px] w-[300px]
                                  -translate-x-1/2 rounded-full opacity-20"
           style={{ background: `radial-gradient(circle, ${b.glow} 0%, transparent 68%)` }} />
      <div className="relative mx-auto w-[172px]">
        <Arc score={score} r={76} stroke={11} color={b.color} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <b className="tnum text-[52px] font-[640] leading-none tracking-[-0.045em]">
            {shown == null ? "—" : shown}
          </b>
          <span className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">
            Readiness{asOf ? ` · ${asOf}` : ""}
          </span>
        </div>
      </div>
      <div className="relative mt-4 text-center">
        <div className="text-base font-semibold tracking-tight" style={{ color: b.color }}>{b.word}</div>
        <p className="mx-auto mt-1 max-w-[34ch] text-[12.5px] leading-snug text-ink-3">
          {driver?.headline || "Not enough data yet to calculate readiness."}
        </p>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-hairline
                        bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-2">
          <i className="h-[7px] w-[7px] shrink-0 rounded-full"
             style={{ background: confColor(confidence) }} />
          {Math.round(confidence * 100)}% confidence
        </div>
      </div>
    </Card>
  );
}

export function MiniScore({ score, label: name, value, note, spark }: {
  score: number | null; label: string; value: string; note?: string;
  /** Weekly trend values, oldest first -- purely decorative context (shape,
      not axes/labels), so a short or missing series just omits it rather
      than rendering an empty or misleading chart. */
  spark?: number[];
}) {
  const b = band(score);
  const sparkData = spark?.filter((v) => v != null);
  const compact = useCompactMiniLayout();
  return (
    <Card className="mini-score flex min-w-0 flex-1 flex-row items-center gap-2.5 border-hairline bg-surface-1 p-3.5">
      {/* The arc carries the level; the TEXT carries the measurement. Putting a
          bare 0-100 index inside the ring read as "30 what?" -- it looked like a
          heart rate next to the words "Resting HR". */}
      <div className="relative h-11 w-11 shrink-0">
        <Arc score={score} r={19} stroke={4.5} color={b.color} />
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-[560] text-ink-3">{name}</span>
        <b className="tnum block text-[17px] font-[640] leading-tight tracking-[-0.02em]">
          {value}
        </b>
        {note && <span className="mini-score-note block text-[11px] leading-snug text-ink-3">{note}</span>}
      </div>
      {!compact && sparkData && sparkData.length >= 3 && (
        <div aria-hidden className="mini-score-spark h-6 w-10 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData.map((v, i) => ({ i, v }))}
                       margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
                       accessibilityLayer={false}>
              <Area type="monotone" dataKey="v" stroke="var(--ink-3)" strokeWidth={1.5}
                    fill="none" dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
