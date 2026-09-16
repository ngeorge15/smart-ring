import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DATA, band, confColor, label, type Component } from "@/lib/data";
import { Card } from "@/components/ui/card";

/**
 * Replaces the old, separately-shown HeadroomCard + Breakdown Section with
 * one disclosure. Both told the same underlying story -- which components
 * cost you points, and why -- from two different angles (ranked list vs.
 * measurement/confidence split); showing both by default was the dense,
 * dashboard-like clutter the redesign is about. Now: one collapsed line by
 * default, the full technical picture one tap away, nothing lost.
 */
export function WhyThisScore({ open, onOpenChange }: {
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const R = DATA.readiness;
  const H = R.headroom;
  const available = R.components.filter((c) => c.available);
  const ranked = [...available].sort((a, b) => impact(b) - impact(a));
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? ranked : ranked.slice(0, 3);
  const hidden = ranked.length - shown.length;
  const leader = ranked[0];

  const waiting = H?.locked.filter((l) => l.nights_needed != null) ?? [];
  const stuck = H?.locked.filter((l) => l.nights_needed == null) ?? [];

  return (
    <Card className="rise mb-3 border-hairline bg-surface-1 px-[18px] py-1">
      <details className="group" open={open}
                onToggle={(e) => onOpenChange?.(e.currentTarget.open)}>
        <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3
                            rounded-lg py-2 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-[14px] font-[620]">Why this score?</span>
            <span className="mt-0.5 block truncate text-[12px] text-ink-2">
              {leader ? `${label(leader.name)} had the largest impact` : "Not enough data yet"}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-3">
            Details
            <ChevronDown size={15} className="transition-transform group-open:rotate-180" />
          </span>
        </summary>

        <div className="border-t border-hairline pt-2.5 pb-[14px]">
          {R.score != null && (
            <div className="mb-2.5 flex items-center gap-1.5 text-[11.5px] text-ink-2">
              <i className="h-[7px] w-[7px] shrink-0 rounded-full"
                 style={{ background: confColor(R.confidence) }} />
              {Math.round(R.confidence * 100)}% confidence
            </div>
          )}
          {shown.map((c) => {
            const b = band(c.score);
            return (
              <div key={c.name} className="flex items-center gap-3 border-t border-hairline
                                           py-2.5 first:border-t-0 first:pt-0">
                <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: b.color }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{label(c.name)}</div>
                  <div className="text-[11.5px] text-ink-3">{c.delta || c.explain}</div>
                </div>
                <span className="tnum shrink-0 text-[14px] font-[660]"
                      style={{ color: b.color }}>{c.display || Math.round(c.score!)}</span>
              </div>
            );
          })}
          {hidden > 0 && !showAll && (
            <button onClick={() => setShowAll(true)}
                    className="mt-1 flex min-h-[40px] w-full items-center justify-center gap-1
                               text-[12.5px] font-medium text-brand active:opacity-60">
              Show all {ranked.length} <ChevronRight size={13} />
            </button>
          )}

          {H && H.gap != null && H.gap > 0 && (
            <div className="mt-3 border-t border-hairline pt-3">
              {/* MEASUREMENT vs CONFIDENCE: same-looking gap, opposite remedies --
                  see Headroom.tsx's original note. Kept as two explicit numbers
                  rather than folded into the list above, since collapsing them
                  is exactly the ambiguity this split exists to prevent. */}
              <div className="grid grid-cols-2 gap-2">
                <Half n={H.measure_points} title="recorded measurements"
                      note="how last night scored against your own range" />
                <Half n={H.shrink_points} title="baseline maturity"
                      note="a discount on short or borrowed baselines" />
              </div>

              {(waiting.length > 0 || stuck.length > 0) && (
                <div className="mt-2.5 border-t border-hairline pt-2.5">
                  <p className="text-[11px] font-[660] uppercase tracking-[0.09em] text-ink-3">
                    Not scored yet
                  </p>
                  {waiting.map((l) => (
                    <div key={l.name} className="mt-1.5 flex items-baseline justify-between gap-3">
                      <span className="text-[12.5px]">{label(l.name)}</span>
                      <span className="tnum shrink-0 text-[12px] text-good">
                        {l.nights_needed} more night{l.nights_needed === 1 ? "" : "s"}
                      </span>
                    </div>
                  ))}
                  {stuck.map((l) => (
                    <div key={l.name} className="mt-1.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[12.5px]">{label(l.name)}</span>
                        <span className="shrink-0 text-[12px] text-ink-3">not measurable</span>
                      </div>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{l.explain}</p>
                    </div>
                  ))}
                  <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
                    These carry {Math.round((1 - H.weight_available) * 100)}% of the score's
                    weight. Until they can be scored, confidence stays capped — which is
                    why the number is {Math.round(R.confidence * 100)}% confident rather
                    than wrong.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}

/** Ranked by how far a contributor sits from neutral, weighted by its share
    of the score -- "what's dragging me down" answered first, not last. */
function impact(c: Pick<Component, "score" | "weight">) {
  return c.score == null ? -1 : Math.abs(50 - c.score) * c.weight;
}

function Half({ n, title, note }: { n: number; title: string; note: string }) {
  return (
    <div className="flex-1 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5">
      <b className="tnum text-[20px] font-[640] leading-none">{n.toFixed(1)}</b>
      <span className="ml-1 text-[11px] text-ink-3">pts</span>
      <p className="mt-1 text-[12px] font-medium">{title}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-ink-3">{note}</p>
    </div>
  );
}
