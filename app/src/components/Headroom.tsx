import { ChevronDown } from "lucide-react";
import { DATA, label } from "@/lib/data";
import { Card } from "@/components/ui/card";

/**
 * What is between this score and 100 -- and, crucially, which half of it you
 * can do anything about.
 *
 * A bare "77" invites the wrong question. The gap splits in two:
 *
 *   MEASUREMENT   how last night actually scored against your own range.
 *   CONFIDENCE    the discount applied to scores from short or borrowed
 *                 baselines. Nothing you did; it retires as data accumulates.
 *
 * They look identical on the dial and have opposite remedies, so they are never
 * shown as one number. Locked components are listed separately again, because a
 * dropped component costs CONFIDENCE, not points -- telling someone to "improve
 * their HRV" when the truth is "the baseline needs three more nights" would be
 * advice they cannot act on.
 */
export function HeadroomCard() {
  const H = DATA.readiness?.headroom;
  if (!H || H.gap == null || H.gap <= 0) return null;

  const waiting = H.locked.filter((l) => l.nights_needed != null);
  const stuck = H.locked.filter((l) => l.nights_needed == null);

  return (
    <Card className="rise mb-3 border-hairline bg-surface-1 px-[18px] py-1">
      <details className="group">
        <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3
                            rounded-lg py-2 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">
              Why this score
            </span>
            <span className="mt-0.5 block text-[12px] text-ink-2">
              {Math.round(H.gap)} points below 100
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-3">
            Details
            <ChevronDown size={15} className="transition-transform group-open:rotate-180" />
          </span>
        </summary>

        <div className="border-t border-hairline pt-3 pb-[14px]">
          <div className="grid grid-cols-2 gap-2">
            <Half n={H.measure_points} title="recorded measurements"
                  note="how you scored against your own range" />
            <Half n={H.shrink_points} title="baseline maturity"
                  note="a discount on short or borrowed baselines" />
          </div>

          {H.costs.map((c) => (
            <div key={c.name} className="mt-2.5 border-t border-hairline pt-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-medium">{label(c.name)}</span>
                <span className="tnum shrink-0 text-[13px] text-ink-2">
                  {c.display} <span className="text-ink-3">· −{c.points.toFixed(1)} pts</span>
                </span>
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
                Scored <b className="font-[620] text-ink-2">{Math.round(c.raw_score)}/100</b> against
                your own range{c.shrink_points >= 0.5 && <>
                  , then held to {Math.round(c.score)} because the baseline is{" "}
                  {c.baseline === "apple_watch" ? "your Watch's, not the ring's" : "still thin"}
                  {" "}({Math.round(c.confidence * 100)}% confidence)</>}.
              </p>
            </div>
          ))}

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
                These carry {Math.round((1 - H.weight_available) * 100)}% of the score’s
                weight. Until they can be scored, confidence stays capped — which is
                why the number is {Math.round((DATA.readiness.confidence) * 100)}% confident
                rather than wrong.
              </p>
            </div>
          )}
        </div>
      </details>
    </Card>
  );
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
