import { useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis } from "recharts";
import { DATA, toKcal, toMiles } from "@/lib/data";
import { Section } from "@/components/Charts";
import { Card } from "@/components/ui/card";

function localDayKey(d = new Date()) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")].join("-");
}

const displayDate = (day: string, weekday = false) =>
  new Date(day + "T12:00").toLocaleDateString(undefined,
    { weekday: weekday ? "short" : undefined, month: "short", day: "numeric" });

function Stat({ k, v, unit, d, vtName }: {
  k: string; v: string; unit?: string; d?: string; vtName?: string;
}) {
  return (
    <Card className="min-w-0 flex-1 border-hairline bg-surface-1 p-3.5"
          style={vtName ? { viewTransitionName: vtName } : undefined}>
      <div className="text-[10px] font-[660] uppercase tracking-[0.1em] text-ink-3">{k}</div>
      <div className="tnum mt-1.5 flex flex-wrap items-baseline text-[26px] font-[640] leading-none tracking-tight">
        {v}{unit && <span className="ml-0.5 text-[14px] font-medium text-ink-3">{unit}</span>}
      </div>
      {d && <div className="mt-1 text-[11.5px] text-ink-3">{d}</div>}
    </Card>
  );
}

const hourLabel = (h: number) =>
  `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`;

export function ActivityPage() {
  const [sel, setSel] = useState<number | null>(null);
  const days = DATA.steps;
  const todayKey = localDayKey();
  const today = days.find((d) => d.day === todayKey) ?? null;
  const latest = days[days.length - 1] ?? null;
  // Keep the latest historical record useful, but name its date everywhere.
  const shown = today ?? latest;
  const shownIsToday = shown?.day === todayKey;
  const hourly = DATA.activity_hourly.filter((h) => h.day === shown?.day);
  const best = Math.max(...days.map((d) => d.steps), 1);
  const en = DATA.energy?.days?.find((e) => e.day === shown?.day) ?? null;

  if (!shown) {
    return <Section title="Activity">
      <p className="py-1.5 text-[12.5px] text-ink-3">No activity data yet.</p></Section>;
  }

  return (
    <>
      {!shownIsToday && (
        <p className="rise mb-3 rounded-[18px] border border-hairline bg-surface-2 px-3.5 py-2.5
                      text-[12px] text-ink-2">
          No activity recorded today
          <span className="text-ink-3"> · showing the latest day, {displayDate(shown.day)}</span>
        </p>
      )}
      <div className="rise mb-3 flex gap-2.5">
        <Stat k={shownIsToday ? "Steps today" : `Steps · ${displayDate(shown.day)}`}
              v={shown.steps.toLocaleString()} vtName="vt-steps"
              d={shownIsToday
                ? (shown.partial ? `${shown.hours}h recorded` : undefined)
                : `Latest recorded · ${shown.partial ? `${shown.hours}h partial` : "full day"}`} />
        <Stat k="Distance" v={toMiles(shown.distance_raw).toFixed(2)} unit="mi"
              d={shownIsToday ? undefined : displayDate(shown.day)} />
      </div>
      <div className="rise mb-3 flex gap-2.5">
        {/* This blended estimator is fitted against 868 Watch days. The ring's
            firmware value in Recent days comes from steps alone. */}
        <Stat k="Active" v={en ? Math.round(en.active_kcal).toString() : "—"} unit="CAL" />
        <Stat k="Total burn" v={en ? Math.round(en.total_kcal).toLocaleString() : "—"} unit="CAL" />
      </div>

      <p className="rise -mt-1 mb-3 px-1 text-[11.5px] leading-relaxed text-ink-3">
        Active is energy above rest; total burn adds
        {DATA.energy?.rmr_kcal ? ` ${Math.round(DATA.energy.rmr_kcal).toLocaleString()} resting CAL` : " resting energy"}.
        Both use the heart-rate + steps estimate. Recent-day CAL below is the ring firmware’s
        steps-only estimate, so it will differ.
      </p>

      <Section title={shownIsToday ? "Today by hour" : `${displayDate(shown.day, true)} by hour`}
               right={shownIsToday ? undefined : "latest recorded day"}>
        {hourly.length ? (
          <>
            {/* Selection readout sits ABOVE the chart: a hover tooltip is
                unreliable on touch, and a tapped bar should stay readable
                after your finger lifts. */}
            <div className="mb-2 flex items-baseline gap-2">
              <b className="tnum text-[26px] font-[640] leading-none tracking-tight">
                {(sel !== null ? hourly[sel].steps : shown.steps).toLocaleString()}
              </b>
              <span className="text-[13px] text-ink-3">
                {sel !== null
                  ? `steps at ${hourLabel(hourly[sel].hour)}`
                  : shownIsToday ? "steps today" : `steps on ${displayDate(shown.day)}`}
              </span>
              {sel !== null && (
                <button onClick={() => setSel(null)}
                        className="ml-auto min-h-[32px] text-[12px] font-medium text-brand
                                   active:opacity-60">
                  clear
                </button>
              )}
            </div>

            <div className="h-[170px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourly} margin={{ top: 6, right: 4, bottom: 0, left: -20 }}
                          accessibilityLayer={false}>
                  <XAxis dataKey="hour" tick={{ fontSize: 10.5, fill: "var(--ink-3)" }}
                         tickLine={false} axisLine={false} interval={0}
                         tickFormatter={(h) => hourLabel(Number(h))} />
                  <Bar dataKey="steps" radius={[4, 4, 0, 0]} isAnimationActive={false}
                       cursor="pointer"
                       onClick={(_d: unknown, i: number) => setSel(i === sel ? null : i)}>
                    {hourly.map((_, i) => (
                      <Cell key={i}
                            fill={sel === null
                              ? "var(--brand)"
                              : i === sel ? "var(--brand)" : "var(--raise)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {sel !== null && (
              <p className="mt-2 tnum text-[11.5px] text-ink-3">
                {toMiles(hourly[sel].distance_raw).toFixed(2)} mi this hour
              </p>
            )}
          </>
        ) : <p className="py-1.5 text-[12.5px] text-ink-3">
          {shownIsToday ? "No hourly detail for today yet." : `No hourly detail for ${displayDate(shown.day)}.`}
        </p>}
      </Section>

      <Section title="Recent days">
        {days.slice().reverse().map((d) => (
          <div key={d.day} className="border-t border-hairline py-2.5 first:border-t-0 first:pt-0">
            <div className="flex items-baseline justify-between">
              <span className="text-[13.5px] font-medium">
                {displayDate(d.day, true)}
                {d.partial && <span className="ml-1.5 text-[11px] text-ink-3">partial</span>}
              </span>
              <span className="tnum text-[14px] font-[660]">{d.steps.toLocaleString()}</span>
            </div>
            <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-raise">
              <div className="h-full rounded-full bg-brand"
                   style={{ width: `${(d.steps / best) * 100}%` }} />
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">
              {toMiles(d.distance_raw).toFixed(2)} mi · {Math.round(toKcal(d.calories_raw))} CAL
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}
