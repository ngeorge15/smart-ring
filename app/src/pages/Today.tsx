import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { DATA, band, hm, label, toMiles } from "@/lib/data";
import { Hero, MiniScore } from "@/components/Dials";
import { Section } from "@/components/Charts";
import { HeadroomCard } from "@/components/Headroom";
import { DeviceStrip } from "@/components/DeviceStrip";
import type { Tab } from "@/components/Nav";

/** Ranked by how far a contributor sits from neutral, weighted by its share of
    the score -- so "what's dragging me down" is answered first, not last. */
function impact(c: { score: number | null; weight: number }) {
  return c.score == null ? -1 : Math.abs(50 - c.score) * c.weight;
}

export function Today({ go }: { go: (t: Tab) => void }) {
  const [all, setAll] = useState(false);
  const R = DATA.readiness;
  const available = R.components.filter((c) => c.available);
  const ranked = [...available].sort((a, b) => impact(b) - impact(a));
  const shown = all ? ranked : ranked.slice(0, 3);
  const hidden = ranked.length - shown.length;
  const driver = [...available].sort((a, b) => a.score! - b.score!)[0];

  const sleepComps = available.filter((c) => c.name.startsWith("sleep"));
  const sleepScore = sleepComps.length
    ? sleepComps.reduce((s, c) => s + c.score! * c.weight, 0) /
      sleepComps.reduce((s, c) => s + c.weight, 0) : null;
  const night = DATA.sleep.nights.find((n) => n.night_of === DATA.sleep.latest_night);
  const rhr = R.components.find((c) => c.name === "resting_hr");
  const today = DATA.steps[DATA.steps.length - 1];

  return (
    <>
      <DeviceStrip />
      <Hero score={R.score} confidence={R.confidence} driver={driver} />

      <div className="rise mb-3 flex gap-2.5">
        <MiniScore score={sleepScore} label="Sleep"
                   value={night ? hm(night.asleep_min) : "—"}
                   note={night ? `sleep score ${Math.round(sleepScore ?? 0)}/100` : "no data"} />
        <MiniScore score={rhr?.available ? rhr.score! : null} label="Resting HR"
                   value={rhr?.display || "—"}
                   note={rhr?.delta ? rhr.delta.replace(/ your .*/, " typical") : "no data"} />
      </div>

      <HeadroomCard />

      <Section title="Breakdown">
        {shown.map((c) => {
          const b = band(c.score);
          return (
            <div key={c.name} className="flex items-center gap-3 border-t border-hairline
                                         py-2.5 first:border-t-0 first:pt-0">
              <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: b.color }} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">{label(c.name)}</div>
                <div className="text-[12px] text-ink-3">{c.delta || c.explain}</div>
              </div>
              {/* The measured quantity leads. A bare 0-100 index here read as
                  ambiguous ("10 what?"); it survives only in the detail view. */}
              <span className="tnum shrink-0 text-[15px] font-[660]"
                    style={{ color: b.color }}>{c.display || Math.round(c.score!)}</span>
            </div>
          );
        })}
        {hidden > 0 && !all && (
          <button onClick={() => setAll(true)}
                  className="mt-1 flex min-h-[44px] w-full items-center justify-center gap-1
                             text-[13px] font-medium text-brand active:opacity-60">
            Show all {ranked.length} <ChevronRight size={14} />
          </button>
        )}
        {all && (
          <button onClick={() => setAll(false)}
                  className="mt-1 flex min-h-[44px] w-full items-center justify-center
                             text-[13px] font-medium text-brand active:opacity-60">
            Show less
          </button>
        )}
      </Section>

      {/* jump-offs: everything reachable within three taps */}
      <div className="rise mb-3 flex gap-2.5">
        <button onClick={() => go("activity")}
                className="min-h-[44px] flex-1 rounded-[13px] border border-hairline
                           bg-surface-1 p-3.5 text-left active:opacity-70">
          <div className="text-[10px] font-[660] uppercase tracking-[0.1em] text-ink-3">Steps</div>
          <div className="tnum mt-1.5 text-[24px] font-[640] leading-none tracking-tight">
            {today ? today.steps.toLocaleString() : "—"}</div>
          <div className="mt-1 text-[11.5px] text-ink-3">
            {today ? `${toMiles(today.distance_raw).toFixed(1)} mi` : "no data"}</div>
        </button>
        <button onClick={() => go("sleep")}
                className="min-h-[44px] flex-1 rounded-[13px] border border-hairline
                           bg-surface-1 p-3.5 text-left active:opacity-70">
          <div className="text-[10px] font-[660] uppercase tracking-[0.1em] text-ink-3">Last night</div>
          <div className="tnum mt-1.5 text-[24px] font-[640] leading-none tracking-tight">
            {night ? hm(night.asleep_min) : "—"}</div>
          <div className="mt-1 text-[11.5px] text-ink-3">
            {night ? `${Math.round(night.efficiency)}% efficiency` : "no data"}</div>
        </button>
      </div>
    </>
  );
}
