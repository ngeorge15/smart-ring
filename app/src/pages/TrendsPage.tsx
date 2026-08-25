import { useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { DATA, hm, hmShort, trendVerdict, type TrendMetric } from "@/lib/data";
import { SleepDebtCard } from "@/components/SleepDebtCard";
import { Section } from "@/components/Charts";

const weekLabel = (w: string) =>
  new Date(w + "T12:00").toLocaleDateString(undefined, { month: "numeric", day: "numeric" });

/* Sleep is stored in minutes but reads as hours; everything else is its own
   unit. "%" sits tight against the number, word units take a space. */
const withUnit = (v: string, unit: string) =>
  !unit ? v : unit === "%" ? `${v}%` : `${v} ${unit}`;

const fmt = (m: TrendMetric, v: number) =>
  m.key === "sleep_min" ? hm(v)
  : m.key === "steps" ? Math.round(v).toLocaleString()
  : withUnit(String(v), m.unit);

const fmtDelta = (m: TrendMetric, v: number) =>
  m.key === "sleep_min" ? hmShort(v, true)
  : m.key === "steps" ? `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString()}`
  : withUnit(`${v > 0 ? "+" : ""}${v}`, m.unit);

function MetricBlock({ m, thisWeek, sel, onSelect }: {
  m: TrendMetric; thisWeek: string;
  sel: number | null; onSelect: (i: number | null) => void;
}) {
  /* Selection is owned by the PAGE, not by each chart.
     Per-chart state let several charts look selected at once, and the "latest"
     bar used the same brand fill as a real selection -- so there was no way to
     tell a default highlight from something you had tapped. Now: exactly one
     selection exists across the page, the latest bar is only faintly tinted,
     and a selected bar is solid with a marker beneath it. */
  const v = trendVerdict(m.comparable ? m.delta : null, m.better);
  /* BRAND MEANS SELECTED. Nothing else.
     The previous scheme gave the latest bar a faint brand tint and a selected
     bar a solid one -- the same hue doing two jobs, which is precisely the
     ambiguity that made it unreadable. Recency is carried by the subtitle
     ("this week" / "week of 8/17"), which is unambiguous and costs no colour.
     Every unselected bar is therefore the same neutral, at one opacity. */
  const lastIdx = m.weeks.reduce(
    (best, w, i) => (w.value != null ? i : best), -1);
  const last = lastIdx >= 0 ? m.weeks[lastIdx] : null;

  return (
    <div className="border-t border-hairline py-3.5 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[14.5px] font-medium">{m.title}</span>
        <span className="tnum text-[15px] font-[660]">
          {sel !== null && m.weeks[sel].value == null
            ? <span className="text-[13px] font-normal text-ink-3">no data</span>
            : fmt(m, sel !== null ? m.weeks[sel].value! : m.latest)}
        </span>
      </div>

      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        {/* A metric whose newest week is an older one -- steps, until today's
            hours land -- must not have last week's number labelled "this week". */}
        <span className="text-[11.5px] text-ink-3">
          {sel !== null
            ? `week of ${weekLabel(m.weeks[sel].week)} · ${m.weeks[sel].n} day${m.weeks[sel].n === 1 ? "" : "s"}`
            : last?.week === thisWeek ? "this week"
            : last ? `week of ${weekLabel(last.week)}` : "no weeks yet"}
        </span>
        {m.comparable && m.delta != null ? (
          <span className="tnum text-[11.5px] font-medium" style={{ color: v.color }}>
            {v.arrow} {fmtDelta(m, m.delta)} <span className="font-normal">{v.word}</span>
          </span>
        ) : (
          <span className="text-[11.5px] text-ink-3">
            {last?.thin ? `only ${last.n} day${last.n === 1 ? "" : "s"} so far`
                        : "no comparable week yet"}
          </span>
        )}
      </div>

      <div className="relative mt-2 h-[64px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={m.weeks} margin={{ top: 4, right: 2, bottom: 0, left: 0 }}
                    barCategoryGap="22%">
            <XAxis dataKey="week" tickFormatter={weekLabel} tickLine={false}
                   axisLine={false} interval={0} minTickGap={0}
                   tick={{ fontSize: 9.5, fill: "var(--ink-3)" }} />
            <YAxis hide domain={[0, "dataMax"]} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}
                 onClick={(_: unknown, i: number) =>
                   onSelect(sel === i ? null : i)}
                 style={{ cursor: "pointer" }}>
              {m.weeks.map((w, i) => {
                const isSel = sel === i;
                /* Opacity is NOT the place to encode thinness here.
                   With this much missing history nearly every week is thin, so
                   the fade applied almost everywhere and simply dimmed the whole
                   chart -- paying full legibility for a signal that was already
                   in the subtitle ("only 2 days so far") and in the selected
                   week's day count. Bars stay readable; recency and thinness are
                   carried by text. */
                const opacity = isSel ? 1 : w.thin ? 0.72 : 1;
                return (
                  <Cell key={w.week} fill={isSel ? "var(--brand)" : "var(--bar)"}
                        fillOpacity={opacity} />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        {/* Two markers on one row, both anchored to the baseline:
              a week with NO DATA gets a hairline stub, so an empty slot reads as
              "not recorded" rather than as a value of zero;
              the SELECTED week gets a solid brand underline. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-[18px] flex">
          {/* px in PIXELS, not per cent. A percentage pad resolves against the
              ROW width, so on a flex-1 item (flex-basis 0) it exceeded the slot
              and collapsed every marker to zero width -- present in the DOM,
              measurable, and invisible. */}
          {m.weeks.map((w, i) => (
            <span key={w.week} className="flex-1 px-[3px]">
              <i className="block h-[2px] w-full rounded-full"
                 style={{ background: i === sel ? "var(--brand)"
                        : w.value == null ? "var(--ink-3)" : "transparent",
                          opacity: i === sel || w.value != null ? 1 : 0.45 }} />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TrendsPage() {
  // One selection for the whole page: tapping in one chart clears any other.
  const [sel, setSel] = useState<{ key: string; i: number } | null>(null);
  const T = DATA.trends;
  const metrics = T?.metrics ?? [];

  return (
    <>
      <SleepDebtCard />

      {metrics.length ? (
        <Section title="Week over week"
                 right={sel ? "tap again to clear" : `last ${T.weeks} weeks`}>
          {metrics.map((m) => (
            <MetricBlock key={m.key} m={m} thisWeek={T.generated_for}
                         sel={sel?.key === m.key ? sel.i : null}
                         onSelect={(i) => setSel(i === null ? null : { key: m.key, i })} />
          ))}
        </Section>
      ) : (
        <Section title="Week over week">
          <p className="py-1.5 text-[12.5px] text-ink-3">Not enough history yet.</p>
        </Section>
      )}

    </>
  );
}
