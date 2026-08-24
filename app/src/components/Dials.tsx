import { useEffect, useState } from "react";
import { band, confColor, type Component } from "@/lib/data";
import { Card } from "@/components/ui/card";

/** Animated SVG arc. Radius/stroke are props so hero and mini share one path. */
function Arc({ score, r, stroke, color }: {
  score: number | null; r: number; stroke: number; color: string;
}) {
  const [on, setOn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(id); }, []);
  const C = 2 * Math.PI * r;
  const size = (r + stroke / 2) * 2;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke="var(--raise)" strokeWidth={stroke} />
      <circle className="arc" cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={color} strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={on ? C * (1 - pct) : C} />
    </svg>
  );
}

export function Hero({ score, confidence, driver }: {
  score: number | null; confidence: number; driver?: Component;
}) {
  const b = band(score);
  return (
    <Card className="rise relative overflow-hidden border-hairline bg-surface-1 px-5 pt-7 pb-6 mb-3">
      <div aria-hidden className="pointer-events-none absolute left-1/2 -top-[46%] h-[300px] w-[300px]
                                  -translate-x-1/2 rounded-full opacity-20"
           style={{ background: `radial-gradient(circle, ${b.glow} 0%, transparent 68%)` }} />
      <div className="relative mx-auto w-[172px]">
        <Arc score={score} r={76} stroke={11} color={b.color} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <b className="tnum text-[52px] font-[640] leading-none tracking-[-0.045em]">
            {score == null ? "—" : Math.round(score)}
          </b>
          <span className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">
            Readiness
          </span>
        </div>
      </div>
      <div className="relative mt-4 text-center">
        <div className="text-base font-semibold tracking-tight" style={{ color: b.color }}>{b.word}</div>
        <p className="mx-auto mt-1 max-w-[34ch] text-[12.5px] leading-snug text-ink-3">
          {driver?.headline || "Not enough data yet to score today."}
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

export function MiniScore({ score, label: name, value, note }: {
  score: number | null; label: string; value: string; note?: string;
}) {
  const b = band(score);
  return (
    <Card className="flex flex-1 flex-row items-center gap-3 border-hairline bg-surface-1 p-3.5">
      {/* The arc carries the level; the TEXT carries the measurement. Putting a
          bare 0-100 index inside the ring read as "30 what?" -- it looked like a
          heart rate next to the words "Resting HR". */}
      <div className="relative h-11 w-11 shrink-0">
        <Arc score={score} r={19} stroke={4.5} color={b.color} />
      </div>
      <div className="min-w-0">
        <span className="block text-[11px] font-[560] text-ink-3">{name}</span>
        <b className="tnum block text-[17px] font-[640] leading-tight tracking-[-0.02em]">
          {value}
        </b>
        {note && <span className="block truncate text-[11px] text-ink-3">{note}</span>}
      </div>
    </Card>
  );
}
