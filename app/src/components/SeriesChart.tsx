import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DATA } from "@/lib/data";
import { Card } from "@/components/ui/card";

const clock = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
};

const clockExact = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  const mins = Math.floor(m % 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mins).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
};

export function SeriesChart({ kind, title, unit, decimals = 0, day: pinned, transform }: {
  kind: string; title: string; unit: string; decimals?: number; day?: string;
  /** Convert stored units for display. Values are stored raw so the conversion
      lives in exactly one place -- e.g. temperature is kept as the ring's byte
      and turned into degrees here. */
  transform?: (v: number) => number;
}) {
  const all = DATA.series_detail?.[kind] ?? [];
  const hasPinned = !pinned || all.some((r) => r.day === pinned);

  if (!all.length || !hasPinned) {
    return (
      <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
        <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">{title}</h2>
        <p className="mt-2 text-[12.5px] text-ink-3">
          {all.length ? "No readings on this day." : "No readings yet."}</p>
      </Card>
    );
  }

  const day = pinned ?? all[all.length - 1].day;
  const rows = all.filter((r) => r.day === day)
    .sort((a, b) => a.minute - b.minute)
    .map((r) => (transform ? { ...r, value: transform(r.value) } : r));
  const vals = rows.map((r) => r.value);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  // pad the axis so a flat series doesn't render as a line pinned to an edge
  const pad = Math.max((hi - lo) * 0.25, hi - lo < 2 ? 1.5 : 0);

  if (rows.length === 1) {
    return (
      <Card className="rise mb-3 border-hairline bg-surface-1 px-[18px] py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">{title}</h2>
            <p className="mt-1 text-[11.5px] text-ink-3">One reading · {clockExact(rows[0].minute)}</p>
          </div>
          <div className="flex shrink-0 items-baseline">
            <b className="tnum text-[28px] font-[640] leading-none tracking-[-0.03em]">
              {rows[0].value.toFixed(decimals)}
            </b>
            <span className="ml-1 text-[13px] font-medium text-ink-3">{unit.trim()}</span>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">{title}</h2>
        <span className="text-[11px] text-ink-3">{rows.length} readings</span>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <b className="tnum text-[32px] font-[640] leading-none tracking-[-0.03em]">
          {avg.toFixed(decimals)}
        </b>
        <span className="text-[14px] font-medium text-ink-3">{unit.trim() || "avg"}</span>

      </div>

      <div className="mt-2 h-[92px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}
                     accessibilityLayer={false}>
            <defs>
              <linearGradient id={`fill-${kind}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="minute" type="number" domain={["dataMin", "dataMax"]}
                   tick={{ fontSize: 10.5, fill: "var(--ink-3)" }} tickLine={false}
                   axisLine={false} tickFormatter={clock} minTickGap={38} />
            <YAxis domain={[lo - pad, hi + pad]} width={34} tickCount={3}
                   tick={{ fontSize: 10.5, fill: "var(--ink-3)" }}
                   tickLine={false} axisLine={false}
                   tickFormatter={(v) => v.toFixed(decimals)} />
            {/* the average, so each point reads as above or below your day */}
            <ReferenceLine y={avg} stroke="var(--ink-3)" strokeDasharray="3 4" />
            <Tooltip content={({ active, payload }: any) => active && payload?.length ? (
              <div className="rounded-lg bg-ink px-2.5 py-1.5 text-[11.5px] font-medium text-plane">
                {clock(payload[0].payload.minute)} ·{" "}
                {payload[0].payload.value.toFixed(decimals)}{unit}
              </div>) : null} />
            <Area type="monotone" dataKey="value" stroke="var(--brand)" strokeWidth={2}
                  fill={`url(#fill-${kind})`} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
