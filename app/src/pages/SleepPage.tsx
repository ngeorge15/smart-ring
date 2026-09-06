import { useState } from "react";
import { DATA, STAGE_COLOR, band, hm } from "@/lib/data";
import { DayPicker } from "@/components/DayPicker";
import { MiniScore } from "@/components/Dials";
import { Hypnogram, Section } from "@/components/Charts";
import { SleepDebtCard } from "@/components/SleepDebtCard";
import { Card } from "@/components/ui/card";

export function SleepPage() {
  const R = DATA.readiness;
  const comps = R.components.filter((c) => c.name.startsWith("sleep") && c.available);
  const score = comps.length
    ? comps.reduce((s, c) => s + c.score! * c.weight, 0) /
      comps.reduce((s, c) => s + c.weight, 0) : null;
  // nights arrive newest-first; the picker wants oldest-first
  const nights = [...DATA.sleep.nights].sort((a, b) => a.night_of.localeCompare(b.night_of));
  const [i, setI] = useState(Math.max(0, nights.length - 1));
  const night = nights[i];
  const segments = DATA.sleep.latest_segments.filter(
    (sg) => sg.night_of === night?.night_of);
  const base = DATA.baselines.sleep_min;
  const b = band(score);

  return (
    <>
      <DayPicker days={nights.map((n) => n.night_of)} index={i} onChange={setI} />
      {night && (
        <Card style={{ viewTransitionName: "vt-sleep" }}
              className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
          <div className="sleep-summary flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">
                Time asleep
              </div>
              <div className="tnum mt-1 text-[34px] font-[640] leading-none tracking-[-0.03em]">
                {hm(night.asleep_min)}
              </div>
              <div className="mt-1.5 text-[12.5px]" style={{ color: b.color }}>
                {score == null ? "Not scored" : b.word}
                <span className="text-ink-3">
                  {" "}· {base?.mean ? `${hm(Math.round(base.mean))} typical` : "no baseline"}
                </span>
              </div>
            </div>
            <div className="sleep-efficiency shrink-0">
              <MiniScore score={night.efficiency} label="Efficiency"
                         value={`${Math.round(night.efficiency)}%`}
                         note={night.awake_min === 0
                           ? "Zero wakes logged; likely overstated"
                           : "of time in bed"} />
            </div>
          </div>
        </Card>
      )}

      <SleepDebtCard />

      <Hypnogram segments={segments} night={night?.night_of ?? null} title="Stages" />

      {DATA.sleep.nights.length > 1 && (
        <Section title="Night by night">
          {/* Each night is one composition bar, WIDTH-SCALED to the longest
              night in view. Efficiency alone said almost nothing -- and on a
              ring that misses brief wakes it is the least trustworthy number
              here. Stage mix at least shows whether a long night was actually
              restful. Bars share one scale so lengths are comparable. */}
          {DATA.sleep.nights.map((n) => {
            const longest = Math.max(...DATA.sleep.nights.map((x) => x.in_bed_min), 1);
            const parts: [string, number][] = [
              ["deep", n.deep_min], ["REM", n.rem_min],
              ["light", n.light_min], ["awake", n.awake_min],
            ];
            const span = parts.reduce((a, [, v]) => a + v, 0) || 1;
            return (
              <div key={n.night_of} className="border-t border-hairline py-2.5
                                               first:border-t-0 first:pt-0">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-medium">
                    {new Date(n.night_of + "T12:00").toLocaleDateString(undefined,
                      { weekday: "short", month: "short", day: "numeric" })}
                  </span>
                  <span className="tnum text-[13.5px] font-[660]">{hm(n.asleep_min)}</span>
                </div>
                <div className="mt-1.5 flex h-[10px] gap-[2px] overflow-hidden rounded-[3px]"
                     style={{ width: `${(span / longest) * 100}%` }}>
                  {parts.filter(([, v]) => v > 0).map(([stage, v]) => (
                    <i key={stage} title={`${stage} ${hm(v)}`}
                       style={{ flexGrow: v, background: STAGE_COLOR[stage] }} />
                  ))}
                </div>
              </div>
            );
          })}
          <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-ink-2">
            {["deep", "REM", "light", "awake"].map((r) => (
              <span key={r} className="inline-flex items-center">
                <i className="mr-1 h-2 w-2 rounded-[2px]"
                   style={{ background: STAGE_COLOR[r] }} />{r}
              </span>
            ))}
          </div>
        </Section>
      )}

    </>
  );
}
