import { useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { DATA, hm } from "@/lib/data";
import { Hero } from "@/components/Dials";
import { Card } from "@/components/ui/card";
import { WhyThisScore } from "@/components/WhyThisScore";
import { DeviceStrip, deviceNeedsAttention } from "@/components/DeviceStrip";
import type { MetricDomain } from "@/pages/MetricsPage";

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

function MetricCell({ label, value, note, onClick, vtName }: {
  label: string; value: string; note: string; onClick: () => void; vtName?: string;
}) {
  return (
    <button onClick={onClick} style={vtName ? { viewTransitionName: vtName } : undefined}
            className="min-w-0 flex-1 px-2.5 py-3 text-left first:pl-3.5 last:pr-3.5 active:opacity-60">
      <div className="truncate text-[10.5px] font-[660] uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className="tnum mt-1 truncate text-[18px] font-[640] leading-tight tracking-tight">{value}</div>
      <div className="mt-0.5 truncate text-[10.5px] text-ink-3">{note}</div>
    </button>
  );
}

export function Today({ onOpenMetric, onOpenDevice }: {
  onOpenMetric: (d: MetricDomain) => void;
  onOpenDevice: () => void;
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const whyRef = useRef<HTMLDivElement>(null);
  const R = DATA.readiness;
  const available = R.components.filter((c) => c.available);
  const driver = [...available].sort((a, b) => impact(b) - impact(a))[0];

  const sleepComps = available.filter((c) => c.name.startsWith("sleep"));
  const sleepScore = sleepComps.length
    ? sleepComps.reduce((s, c) => s + c.score! * c.weight, 0) /
      sleepComps.reduce((s, c) => s + c.weight, 0) : null;
  const night = DATA.sleep.nights.find((n) => n.night_of === DATA.sleep.latest_night);
  const currentDay = localDayKey();
  const nightScore = night?.night_of === R.day ? sleepScore : null;

  const hrvMetric = DATA.trends?.metrics?.find((m) => m.key === "hrv");
  const hrvBaseline = DATA.baselines?.hrv;
  const hrvDelta = hrvMetric?.latest != null && hrvBaseline?.mean != null
    ? hrvMetric.latest - hrvBaseline.mean : null;

  const latestSteps = DATA.steps[DATA.steps.length - 1];
  const stepsAreCurrent = latestSteps?.day === currentDay;

  function seeWhy() {
    setWhyOpen(true);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    whyRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }

  return (
    <>
      {deviceNeedsAttention() && (
        <button onClick={onOpenDevice} className="block w-full text-left">
          <DeviceStrip />
        </button>
      )}

      <Hero score={R.score} driver={driver}
            asOf={R.day === currentDay ? undefined : shortDate(R.day)} />

      <Card className="rise mb-3 flex flex-row gap-0 divide-x divide-hairline border-hairline bg-surface-1 p-0">
        <MetricCell label="Sleep" onClick={() => onOpenMetric("sleep")} vtName="vt-sleep"
                    value={night ? hm(night.asleep_min) : "—"}
                    note={!night ? "no data" : nightScore == null ? "not scored" : `score ${Math.round(nightScore)}`} />
        <MetricCell label="HRV" onClick={() => onOpenMetric("heart")}
                    value={hrvMetric?.latest != null ? `${hrvMetric.latest} ms` : "—"}
                    note={hrvDelta == null ? "no baseline" : `${hrvDelta > 0 ? "+" : ""}${hrvDelta.toFixed(0)} vs usual`} />
        <MetricCell label="Steps" onClick={() => onOpenMetric("activity")} vtName="vt-steps"
                    value={latestSteps ? latestSteps.steps.toLocaleString() : "—"}
                    note={!latestSteps ? "no data" : stepsAreCurrent ? "today" : shortDate(latestSteps.day)} />
      </Card>

      {driver?.headline && (
        <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
          <p className="text-[14px] leading-snug">{driver.headline}</p>
          <button onClick={seeWhy}
                  className="mt-2.5 flex min-h-[32px] items-center gap-1 text-[12.5px]
                             font-medium text-brand active:opacity-60">
            See why <ChevronRight size={13} />
          </button>
        </Card>
      )}

      <div ref={whyRef}>
        <WhyThisScore open={whyOpen} onOpenChange={setWhyOpen} />
      </div>
    </>
  );
}
