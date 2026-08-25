import { useState } from "react";
import { Bar, BarChart, Rectangle, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { DATA, hm, hmShort } from "@/lib/data";
import { Card } from "@/components/ui/card";

const dayLabel = (d: string) =>
  new Date(d + "T12:00").toLocaleDateString(undefined, { weekday: "narrow" });
const fullDate = (d: string) =>
  new Date(d + "T12:00").toLocaleDateString(undefined,
    { weekday: "short", month: "short", day: "numeric" });

/** A night with no data is drawn as a faint full-height band.
    Two rejected alternatives: a zero-height bar with a stroke renders nothing at
    all, and a small tick sitting ON the target line reads as "hit the target
    exactly" -- the precise misreading this whole treatment exists to prevent. A
    band occupies the slot without touching the value axis. */
function DebtBar(props: any) {
  const { x, width, payload, background, sel } = props;
  const isSel = sel === payload.night;
  if (payload.missing) {
    return background ? (
      <rect x={x} y={background.y} width={width} height={background.height} rx={3}
            fill="var(--ink-3)" fillOpacity={isSel ? 0.22 : 0.09} />
    ) : null;
  }
  /* Selection is signalled by OPACITY plus the underline marker, never by hue.
     Trends can paint a selected bar brand-blue because its bars are one neutral
     colour; here blue already means "surplus", so recolouring a selection would
     collide head-on with the diverging encoding. The marker beneath the slot is
     the part that is shared, and it is what actually tells you which bar is
     selected. */
  return <Rectangle {...props} radius={4}
                    fill={payload.plot < 0 ? "var(--deficit)" : "var(--surplus)"}
                    fillOpacity={sel == null ? 1 : isSel ? 1 : 0.4} />;
}

/**
 * Cumulative shortfall against the nightly target.
 *
 * The bars are a DIVERGING encoding around zero: short nights below the line in
 * red, long nights above it in blue, with the surface itself as the neutral
 * midpoint. Nights with no data are drawn as a hollow tick at the baseline, not
 * as a zero -- a night you didn't wear the ring is unknown, not sleepless, and
 * the two must never look alike.
 */
export function SleepDebtCard() {
  // Same interaction as Trends: tap a bar to inspect it, tap again to clear.
  // Keyed by night rather than index so it cannot survive onto a different bar.
  const [sel, setSel] = useState<string | null>(null);
  const D = DATA.sleep_debt;
  if (!D) return null;

  const nights = D.nights;
  const covered = nights.filter((n) => n.delta != null);
  const hasData = covered.length > 0;

  // Chart rows carry the missing nights too, so the gaps keep their position on
  // the axis instead of silently closing up.
  const rows = nights.map((n) => ({
    ...n,
    plot: n.delta ?? 0,
    missing: n.delta == null,
  }));
  // Rounded up to a whole hour: "+4h 4m" wrapped onto two lines in a 38px axis
  // and shoved the plot sideways. Whole hours also make the scale easier to read.
  const peak = Math.max(60, ...covered.map((n) => Math.abs(n.delta!)));
  const extent = Math.ceil(peak / 60) * 60;

  const behind = D.debt_min > 0;
  const picked = sel ? rows.find((r) => r.night === sel) ?? null : null;

  return (
    <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">
          Sleep debt
        </h2>
        <span className="text-[11px] text-ink-3">{hm(D.target_min)} target</span>
      </div>

      {hasData ? (
        <>
          <div className="mt-2 flex items-baseline gap-2">
            <b className="tnum text-[32px] font-[640] leading-none tracking-[-0.03em]"
               style={{ color: picked
                 ? (picked.missing ? "var(--ink-3)"
                    : picked.plot < 0 ? "var(--deficit)" : "var(--surplus)")
                 : behind ? "var(--deficit)" : "var(--good)" }}>
              {picked
                ? (picked.missing ? "—" : hm(picked.asleep_min!))
                : behind ? hmShort(D.debt_min) : "None"}
            </b>
            <span className="text-[14px] font-medium text-ink-3">
              {picked
                ? (picked.missing ? "not recorded" : hmShort(picked.plot, true) + " vs target")
                : behind ? "behind" : "caught up"}
            </span>
          </div>
          <p className="mt-1.5 text-[12px] text-ink-2">
            {picked ? fullDate(picked.night) : <>
              over {D.covered} of the last {D.window} nights
              {D.missing > 0 && (
                <span className="text-ink-3"> · {D.missing} not recorded</span>
              )}
            </>}
          </p>

          <div className="relative mt-3 h-[104px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 4, right: 2, bottom: 0, left: 0 }}
                        barCategoryGap="18%">
                <XAxis dataKey="night" tickFormatter={dayLabel} tickLine={false}
                       axisLine={false} interval={0}
                       tick={{ fontSize: 10, fill: "var(--ink-3)" }} />
                {/* explicit ticks -- Recharts' "nice" rounding put the middle
                    tick at +6m, so the target line was labelled as a surplus */}
                <YAxis domain={[-extent, extent]} width={38} ticks={[-extent, 0, extent]}
                       tick={{ fontSize: 10.5, fill: "var(--ink-3)" }}
                       tickLine={false} axisLine={false}
                       tickFormatter={(v: number) => (v === 0 ? "target" : hmShort(v, true))} />
                <ReferenceLine y={0} stroke="var(--ink-3)" strokeWidth={1} />
                {/* `background` is what hands the shape the full plot height it
                    needs to draw a missing-night band; the fill stays invisible.
                    The floating tooltip is gone: Trends commits to a tapped
                    selection that stays put and swaps the headline, and a hover
                    bubble that vanishes is a different interaction wearing the
                    same chart. */}
                <Bar dataKey="plot" shape={<DebtBar sel={sel} />}
                     isAnimationActive={false} style={{ cursor: "pointer" }}
                     onClick={(d: any) =>
                       setSel((c) => (c === d?.payload?.night ? null : d?.payload?.night ?? null))}
                     background={{ fill: "transparent" }} />
              </BarChart>
            </ResponsiveContainer>
            {/* The shared selection marker -- identical rule to Trends: a brand
                underline in the selected slot, anchored above the day labels. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-[16px] flex pl-[38px]">
              {rows.map((r) => (
                <span key={r.night} className="flex-1 px-[2px]">
                  <i className="block h-[2px] w-full rounded-full"
                     style={{ background: r.night === sel ? "var(--brand)" : "transparent" }} />
                </span>
              ))}
            </div>
          </div>


        </>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-3">
          No sleep recorded in the last {D.window} nights.
        </p>
      )}

      {D.mixed_sources && (
        <p className="mt-2 border-l-2 border-warning pl-3 text-[11.5px] leading-relaxed text-ink-2">
          These nights come from both the ring and your Watch, which measure
          sleep differently — the ring read 30% shorter on the one night both
          recorded. Part of any change here is the device, not your sleep.
        </p>
      )}

      {D.personal && (
        <div className="mt-3 flex items-baseline justify-between border-t border-hairline pt-2.5">
          <span className="text-[11.5px] text-ink-3">your usual range</span>
          <span className="tnum text-[11.5px] text-ink-2">
            {hm(D.personal.p25)}–{hm(D.personal.p75)} · median {hm(D.personal.median)}
          </span>
        </div>
      )}
    </Card>
  );
}
