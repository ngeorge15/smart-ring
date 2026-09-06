import { Heart } from "lucide-react";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DATA } from "@/lib/data";
import { Card } from "@/components/ui/card";

/** Latest contiguous stretch of wear -- a gap over an hour means the ring was
    off, out of range, or unsynced. */
function latestRun(points: typeof DATA.hr.points, gapMinutes = 60) {
  if (points.length < 2) return points;
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = (new Date(points[i].t).getTime() -
                 new Date(points[i - 1].t).getTime()) / 60000;
    if (gap > gapMinutes) start = i;
  }
  return points.slice(start);
}

const clockOf = (iso: string) => {
  const d = new Date(iso);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
};

export function HeartRateCard() {
  const run = latestRun(DATA.hr.points);
  if (!run.length) {
    return (
      <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
        <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">Heart rate</h2>
        <p className="mt-2 text-[12.5px] text-ink-3">Not enough heart-rate data yet.</p>
      </Card>
    );
  }
  // the newest MEASURED point -- an interpolated one is not a reading
  const measured = run.filter((p) => !p.i);
  const latest = measured[measured.length - 1] ?? run[run.length - 1];
  const vals = run.map((p) => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const rows = run.map((p) => ({ ...p, ms: new Date(p.t).getTime() }));

  if (run.length === 1) {
    return (
      <Card className="rise mb-3 border-hairline bg-surface-1 px-[18px] py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">
              Heart rate
            </h2>
            <p className="mt-1 text-[11.5px] text-ink-3">One reading · {clockOf(latest.t)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Heart size={18} strokeWidth={0} fill="var(--critical)" />
            <b className="tnum text-[28px] font-[640] leading-none tracking-[-0.03em]">
              {Math.round(latest.v)}
            </b>
            <span className="text-[13px] font-medium text-ink-3">bpm</span>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">Heart rate</h2>
        <span className="text-[11px] text-ink-3">{run.length} readings</span>
      </div>

      <div className="mt-2 flex items-center gap-2.5">
        <Heart className="heartbeat" size={26} strokeWidth={0} fill="var(--critical)" />
        <b className="tnum text-[36px] font-[640] leading-none tracking-[-0.035em]">
          {Math.round(latest.v)}
        </b>
        <span className="text-[14px] font-medium text-ink-3">bpm</span>
        <span className="ml-auto text-right text-[11.5px] leading-tight text-ink-3">
          most recent<br />{clockOf(latest.t)}
        </span>
      </div>

      <div className="mt-3 h-[110px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}
                     accessibilityLayer={false}>
            <defs>
              <linearGradient id="fill-hr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.34} />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="ms" type="number" domain={["dataMin", "dataMax"]}
                   tick={{ fontSize: 10.5, fill: "var(--ink-3)" }} tickLine={false}
                   axisLine={false} minTickGap={44}
                   tickFormatter={(ms) => {
                     const d = new Date(ms); const h = d.getHours();
                     return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
                   }} />
            <YAxis domain={[Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10]} width={34}
                   tickCount={3} tick={{ fontSize: 10.5, fill: "var(--ink-3)" }}
                   tickLine={false} axisLine={false} />
            <ReferenceLine y={avg} stroke="var(--ink-3)" strokeDasharray="3 4" />
            <Tooltip content={({ active, payload }: any) => active && payload?.length ? (
              <div className="rounded-lg bg-ink px-2.5 py-1.5 text-[11.5px] font-medium text-plane">
                {clockOf(payload[0].payload.t)} · {payload[0].payload.v} bpm
                {payload[0].payload.i ? " · estimated" : ""}
              </div>) : null} />
            <Area type="monotone" dataKey="v" stroke="var(--brand)" strokeWidth={2}
                  fill="url(#fill-hr)" dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-1 text-[11px] text-ink-3">
        {lo}–{hi} bpm over this stretch · avg {Math.round(avg)} ·
        {" "}{DATA.hr.n_outliers} odd spike{DATA.hr.n_outliers === 1 ? "" : "s"} excluded
      </p>
    </Card>
  );
}
