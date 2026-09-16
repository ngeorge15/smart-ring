import { useEffect, useState, useSyncExternalStore } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { band, type Component } from "@/lib/data";
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

/**
 * Readiness Spotlight: a compact horizontal card, not the old full-width
 * centered dial. The ring is always BRAND blue now, not the good/warning/
 * critical band colour -- that colour-coding moved to the status WORD only,
 * so the word (not a colour alone) is what carries "how am I doing," and a
 * colourblind reader loses nothing. Confidence is deliberately absent here;
 * it lives in "Why this score?" now, where it belongs next to the reasoning
 * that explains it rather than competing with the score for the first glance.
 */
export function Hero({ score, driver, asOf }: {
  score: number | null; driver?: Component; asOf?: string;
}) {
  const b = band(score);
  const shown = useCountUp(score == null ? null : Math.round(score));
  return (
    <Card className="rise mb-3 flex flex-row items-center gap-4 rounded-[22px] border-hairline bg-surface-1 p-[18px]">
      <div className="relative h-[100px] w-[100px] shrink-0">
        <Arc score={score} r={42} stroke={9} color="var(--brand)" />
        <div className="absolute inset-0 flex items-center justify-center">
          <b className="tnum text-[30px] font-[640] leading-none tracking-[-0.03em]">
            {shown == null ? "—" : shown}
          </b>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-[660] uppercase tracking-[0.09em] text-ink-3">
          Readiness
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span className="text-[15px] font-[660]" style={{ color: b.color }}>{b.word}</span>
          {asOf && <span className="text-[12px] text-ink-3">· {asOf}</span>}
        </div>
        <p className="mt-1 text-[12.5px] leading-snug text-ink-2">
          {driver?.headline || "Not enough data yet to calculate readiness."}
        </p>
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
