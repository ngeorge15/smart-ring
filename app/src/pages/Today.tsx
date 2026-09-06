import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { DATA, band, hm, label, toMiles } from "@/lib/data";
import { Hero, MiniScore } from "@/components/Dials";
import { Section } from "@/components/Charts";
import { HeadroomCard } from "@/components/Headroom";
import { DeviceStrip } from "@/components/DeviceStrip";
import type { Tab } from "@/components/Nav";

function localDayKey(d = new Date()) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")].join("-");
}

const shortDate = (day: string) => new Date(day + "T12:00").toLocaleDateString(
  undefined, { month: "short", day: "numeric" });

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
  const currentDay = localDayKey();
  const latestSteps = DATA.steps[DATA.steps.length - 1];
  const stepsAreCurrent = latestSteps?.day === currentDay;
  const sleepIsCurrent = night?.night_of === currentDay;
  const nightScore = night?.night_of === R.day ? sleepScore : null;
  const trendOf = (key: string) =>
    DATA.trends?.metrics?.find((m) => m.key === key)?.weeks
      .map((w) => w.value).filter((v): v is number => v != null);

  return (
    <>
      <DeviceStrip />
      <Hero score={R.score} confidence={R.confidence} driver={driver}
            asOf={R.day === currentDay ? undefined : shortDate(R.day)} />

      <div className="mini-score-grid rise mb-3 grid gap-2.5">
        <MiniScore score={nightScore}
                   label={sleepIsCurrent || !night ? "Sleep" : `Sleep · ${shortDate(night.night_of)}`}
                   value={night ? hm(night.asleep_min) : "—"}
                   note={!night ? "no data"
                     : nightScore == null ? "Not scored for this night"
                     : `sleep score ${Math.round(nightScore)}/100`}
                   spark={trendOf("sleep_min")} />
        <MiniScore score={rhr?.available ? rhr.score! : null}
                   label={R.day === currentDay ? "Resting HR" : `Resting HR · ${shortDate(R.day)}`}
                   value={rhr?.display || "—"}
                   note={rhr?.delta ? rhr.delta.replace(/ your .*/, " typical") : "no data"}
                   spark={trendOf("resting_hr")} />
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
      <div className="today-jump-grid rise mb-3 grid gap-2.5">
        <button onClick={() => go("activity")}
                style={{ viewTransitionName: "vt-steps" }}
                className="min-h-[44px] flex-1 rounded-[13px] border border-hairline
                           bg-surface-1 p-3.5 text-left active:opacity-70">
          <div className="text-[10px] font-[660] uppercase leading-tight tracking-[0.1em] text-ink-3">
            {stepsAreCurrent ? "Steps today" : latestSteps ? `Steps · ${shortDate(latestSteps.day)}` : "Steps"}
          </div>
          <div className="tnum mt-1.5 text-[24px] font-[640] leading-none tracking-tight">
            {latestSteps ? latestSteps.steps.toLocaleString() : "—"}</div>
          <div className="mt-1 text-[11.5px] leading-snug text-ink-3">
            {latestSteps
              ? `${toMiles(latestSteps.distance_raw).toFixed(1)} mi${stepsAreCurrent ? "" : " · no data today"}`
              : "no data today"}</div>
        </button>
        <button onClick={() => go("sleep")}
                style={{ viewTransitionName: "vt-sleep" }}
                className="min-h-[44px] flex-1 rounded-[13px] border border-hairline
                           bg-surface-1 p-3.5 text-left active:opacity-70">
          <div className="text-[10px] font-[660] uppercase leading-tight tracking-[0.1em] text-ink-3">
            {sleepIsCurrent ? "Last night" : night ? `Sleep · ${shortDate(night.night_of)}` : "Last night"}
          </div>
          <div className="tnum mt-1.5 text-[24px] font-[640] leading-none tracking-tight">
            {night ? hm(night.asleep_min) : "—"}</div>
          <div className="mt-1 text-[11.5px] leading-snug text-ink-3">
            {night
              ? `${Math.round(night.efficiency)}%${night.awake_min === 0 ? " may be high · zero wakes" : " efficiency"}${sleepIsCurrent ? "" : ` · no data ${shortDate(currentDay)}`}`
              : `no data ${shortDate(currentDay)}`}</div>
        </button>
      </div>
    </>
  );
}
