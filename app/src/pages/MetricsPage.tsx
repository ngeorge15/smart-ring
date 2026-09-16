import { useState } from "react";
import { Activity as ActivityIcon, ChevronLeft, ChevronRight, Droplets, Heart, Moon } from "lucide-react";
import { DATA, hm } from "@/lib/data";
import { Card } from "@/components/ui/card";
import { DayPicker } from "@/components/DayPicker";
import { HeartRateCard } from "@/components/HeartRateCard";
import { SeriesChart } from "@/components/SeriesChart";
import { SleepPage } from "@/pages/SleepPage";
import { ActivityPage } from "@/pages/Activity";

export type MetricDomain = "sleep" | "heart" | "activity" | "body";

const trendLatest = (key: string) => DATA.trends?.metrics?.find((m) => m.key === key)?.latest ?? null;

function DomainCard({ icon: Icon, title, stats, freshness, onClick }: {
  icon: typeof Heart; title: string;
  stats: { label: string; value: string }[];
  freshness?: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick}
            className="rise mb-3 flex w-full items-center gap-3.5 rounded-[18px] border
                       border-hairline bg-surface-1 p-[16px] text-left active:opacity-70">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2">
        <Icon size={19} color="var(--brand)" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[15px] font-[620]">{title}</span>
          {freshness && <span className="shrink-0 text-[11px] text-ink-3">{freshness}</span>}
        </div>
        <div className="mt-1 flex gap-4">
          {stats.map((s) => (
            <div key={s.label} className="min-w-0">
              <span className="tnum block text-[15px] font-[640] leading-tight">{s.value}</span>
              <span className="block truncate text-[10.5px] text-ink-3">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
      <ChevronRight size={17} className="shrink-0 text-ink-3" />
    </button>
  );
}

function DetailHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <button onClick={onBack}
            className="rise mb-3 flex min-h-[36px] items-center gap-1 text-[13.5px]
                       font-[560] text-brand active:opacity-60">
      <ChevronLeft size={17} />
      Metrics
      <span className="ml-1 text-ink-3">/ {title}</span>
    </button>
  );
}

function HeartDetail() {
  const days = [...new Set((DATA.series_detail?.hrv ?? []).map((r) => r.day))].sort();
  const [i, setI] = useState(Math.max(0, days.length - 1));
  const restingHr = DATA.readiness.components.find((c) => c.name === "resting_hr");
  return (
    <>
      <HeartRateCard />
      {restingHr?.available && (
        <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
          <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">Resting HR</h2>
          <div className="mt-1.5 flex items-baseline gap-2">
            <b className="tnum text-[28px] font-[640] leading-none">{restingHr.display}</b>
            {restingHr.delta && <span className="text-[12.5px] text-ink-3">{restingHr.delta}</span>}
          </div>
        </Card>
      )}
      {days.length > 0 && <DayPicker days={days} index={i} onChange={setI} />}
      <SeriesChart kind="hrv" title="HRV" unit=" ms" day={days[i]} />
    </>
  );
}

function BodyDetail() {
  const days = [...new Set(
    Object.values(DATA.series_detail ?? {}).flat().map((r) => r.day)
  )].sort();
  const [i, setI] = useState(Math.max(0, days.length - 1));
  return (
    <>
      {days.length > 0 && <DayPicker days={days} index={i} onChange={setI} />}
      <SeriesChart kind="temp_raw" title="Temperature" unit="°F"
                   decimals={1} day={days[i]} transform={(raw) => (raw / 10 + 20) * 9 / 5 + 32} />
      <SeriesChart kind="spo2" title="Blood oxygen" unit="%" day={days[i]} />
      <SeriesChart kind="stress" title="Stress" unit="" day={days[i]} />
    </>
  );
}

export function MetricsPage({ domain, onDomainChange: setDomain }: {
  domain: MetricDomain | null; onDomainChange: (d: MetricDomain | null) => void;
}) {
  if (domain === "sleep") return <><DetailHeader title="Sleep" onBack={() => setDomain(null)} /><SleepPage /></>;
  if (domain === "heart") return <><DetailHeader title="Heart" onBack={() => setDomain(null)} /><HeartDetail /></>;
  if (domain === "activity") return <><DetailHeader title="Activity" onBack={() => setDomain(null)} /><ActivityPage /></>;
  if (domain === "body") return <><DetailHeader title="Body" onBack={() => setDomain(null)} /><BodyDetail /></>;

  const night = DATA.sleep.nights.find((n) => n.night_of === DATA.sleep.latest_night);
  const today = DATA.steps[DATA.steps.length - 1];
  const en = today ? DATA.energy?.days?.find((e) => e.day === today.day) : null;
  const latestHr = DATA.hr.points[DATA.hr.points.length - 1];
  const restingHr = DATA.readiness.components.find((c) => c.name === "resting_hr");
  const hrv = trendLatest("hrv");
  const spo2 = trendLatest("spo2");
  const stress = trendLatest("stress");
  const tempDays = DATA.series_detail?.temp_raw ?? [];
  const latestTemp = tempDays.length
    ? (tempDays[tempDays.length - 1].value / 10 + 20) * 9 / 5 + 32 : null;

  return (
    <>
      <DomainCard icon={Moon} title="Sleep" onClick={() => setDomain("sleep")}
                  freshness={night ? night.night_of : undefined}
                  stats={[
                    { label: "asleep", value: night ? hm(night.asleep_min) : "—" },
                    { label: "efficiency", value: night ? `${Math.round(night.efficiency)}%` : "—" },
                  ]} />
      <DomainCard icon={Heart} title="Heart" onClick={() => setDomain("heart")}
                  freshness={latestHr ? new Date(latestHr.t).toLocaleDateString(undefined,
                    { month: "short", day: "numeric" }) : undefined}
                  stats={[
                    { label: "latest", value: latestHr ? `${Math.round(latestHr.v)} bpm` : "—" },
                    { label: "resting", value: restingHr?.available ? restingHr.display : "—" },
                    { label: "HRV", value: hrv != null ? `${hrv} ms` : "—" },
                  ]} />
      <DomainCard icon={ActivityIcon} title="Activity" onClick={() => setDomain("activity")}
                  freshness={today ? today.day : undefined}
                  stats={[
                    { label: "steps", value: today ? today.steps.toLocaleString() : "—" },
                    { label: "distance", value: today ? `${(today.distance_raw / 1609.344).toFixed(1)} mi` : "—" },
                    { label: "active", value: en ? `${Math.round(en.active_kcal)} cal` : "—" },
                  ]} />
      <DomainCard icon={Droplets} title="Body" onClick={() => setDomain("body")}
                  stats={[
                    { label: "SpO2", value: spo2 != null ? `${spo2}%` : "—" },
                    { label: "temp", value: latestTemp != null ? `${latestTemp.toFixed(1)}°F` : "—" },
                    { label: "stress", value: stress != null ? `${stress}` : "—" },
                  ]} />
    </>
  );
}
