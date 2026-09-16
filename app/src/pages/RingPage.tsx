import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DATA } from "@/lib/data";
import { fetchJson } from "@/lib/http";
import { KnownLimits, Section } from "@/components/Charts";
import { Card } from "@/components/ui/card";
import { SyncCard } from "@/components/SyncCard";

/** Plain-words age. "12 min ago" beats a timestamp you have to subtract. */
function ago(iso: string | null | undefined) {
  if (!iso) return null;
  const t = new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return null;
  const mins = (Date.now() - t) / 60000;
  const text = mins < 1 ? "just now"
    : mins < 60 ? `${Math.round(mins)} min ago`
    : mins < 1440 ? `${Math.round(mins / 60)}h ago`
    : `${Math.round(mins / 1440)}d ago`;
  return { text, mins };
}

const clock = (iso: string) =>
  new Date(iso.replace(" ", "T")).toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/* Staleness is judged against the ring's own 5-minute sampling: an hour without
   a reading is normal if nothing synced, a day means something is broken. */
function freshness(mins: number | undefined) {
  if (mins == null) return { color: "var(--ink-3)", word: "unknown" };
  if (mins < 90) return { color: "var(--good)", word: "fresh" };
  if (mins < 60 * 12) return { color: "var(--warning)", word: "getting stale" };
  return { color: "var(--critical)", word: "stale" };
}

const REACHED_KEY = "ring-last-reached";

/**
 * Live reachability of the Mac over the tailnet.
 *
 * This CANNOT come from the snapshot: the snapshot is generated on the Mac and
 * baked into the page, so any value inside it describes build time, not now.
 * The page has to ask. The last success is mirrored into localStorage so that
 * when the Mac is unreachable the answer is "last reached 20 min ago" rather
 * than a bare "offline".
 */
function useMacReachable() {
  const [state, setState] = useState<{ ok: boolean | null; last: string | null }>(
    { ok: null, last: (() => { try { return localStorage.getItem(REACHED_KEY); } catch { return null; } })() });

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        // Unique URL per attempt: `cache: no-store` governs the HTTP cache but
        // NOT a service worker, which happily replayed a cached 200 and made
        // this report "reachable" with the network switched off.
        // Require the ping contract too: Vite's HTML fallback is also a 200,
        // but parsing it as JSON (or a payload without `now`) must fail closed.
        const payload = await fetchJson<{ now?: unknown }>(
          `ping?t=${Date.now()}`, { cache: "no-store" });
        if (typeof payload.now !== "string") throw new Error("Invalid ping response");
        const now = new Date().toISOString();
        try { localStorage.setItem(REACHED_KEY, now); } catch { /* private mode */ }
        if (!cancelled) setState({ ok: true, last: now });
      } catch {
        if (!cancelled) setState((s) => ({ ok: false, last: s.last }));
      }
    };
    check();
    const id = setInterval(check, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return state;
}

export function RingPage() {
  const mac2 = useMacReachable();
  const R = DATA.ring_status;
  const D = DATA.device;
  if (!R) return <Section title="Ring"><p className="text-[12.5px] text-ink-3">
    No device data yet.</p></Section>;

  const data = ago(D.latest_reading);
  const mac = ago(R.last_sync_mac);
  const phone = ago(R.last_sync_phone);
  const f = freshness(data?.mins);

  // Charging resets the curve, so the drain view starts at the last charge --
  // otherwise a recharge draws a vertical cliff that reads like a data error.
  const hist = R.battery_history ?? [];
  let start = 0;
  for (let i = hist.length - 1; i > 0; i--) {
    if (hist[i].charging || hist[i].level > hist[i - 1].level + 2) { start = i; break; }
  }
  const curve = hist.slice(start).map((h) => ({
    t: new Date(h.ts.replace(" ", "T")).getTime(),
    level: h.level,
  }));

  /* Drain rate comes from the SNAPSHOT, not from the visible curve.
     The curve deliberately starts at the last charge, so computing the rate
     from it meant that five minutes after unplugging there was nothing to
     divide and the page reported "drain unknown" -- while 45 hours of usable
     discharge history sat one cycle back. battery_life measures every discharge
     segment and says which one it used. */
  const L = R.battery_life;
  const perDay = L?.pct_per_day ?? null;
  const daysLeft = L?.days_remaining ?? null;

  return (
    <>
      <SyncCard />

      <Card className="rise mb-3 border-hairline bg-surface-1 p-[18px]">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[11px] font-[660] uppercase tracking-[0.11em] text-ink-3">
            Battery
          </h2>
          {D.charging && <span className="text-[11px] text-good">charging</span>}
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <b className="tnum text-[34px] font-[640] leading-none tracking-[-0.03em]">
            {D.battery ?? "—"}<span className="text-[18px] text-ink-3">%</span>
          </b>
          {/* The level's OWN age, not the sync's. Everything else can be
              current while this one is a day old, because the battery step can
              come back empty on its own. */}
          {(() => {
            const b = ago(D.battery_at);
            if (!b) return null;
            const stale = b.mins > 6 * 60;
            return (
              <span className="text-[12px]" style={{ color: stale ? "var(--warning)" : "var(--ink-3)" }}>
                {stale ? `as of ${b.text}` : b.text}
              </span>
            );
          })()}
          <span className="ml-auto text-right text-[12px] text-ink-3">
            {perDay ? `${perDay.toFixed(1)}%/day` : "drain not measured yet"}
            {daysLeft ? ` · ~${daysLeft.toFixed(1)}d left` : ""}
          </span>
        </div>

        {curve.length >= 2 ? (
          <div className="mt-3 h-[96px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={curve} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                         accessibilityLayer={false}>
                <defs>
                  <linearGradient id="battfill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]}
                       tick={{ fontSize: 10, fill: "var(--ink-3)" }} tickLine={false}
                       axisLine={false} minTickGap={44}
                       tickFormatter={(v: number) => new Date(v).toLocaleTimeString(
                         undefined, { hour: "numeric" })} />
                <YAxis width={30} domain={[0, 100]} ticks={[0, 50, 100]}
                       tick={{ fontSize: 10, fill: "var(--ink-3)" }}
                       tickLine={false} axisLine={false} />
                <Tooltip content={({ active, payload }: any) => active && payload?.length ? (
                  <div className="rounded-lg bg-ink px-2.5 py-1.5 text-[11.5px] font-medium text-plane">
                    {payload[0].payload.level}% · {clock(new Date(
                      payload[0].payload.t).toISOString())}
                  </div>) : null} />
                <Area type="monotone" dataKey="level" stroke="var(--brand)" strokeWidth={2}
                      fill="url(#battfill)" dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-ink-3">
            {/* The CURVE needs points since the last charge; the ESTIMATE above
                does not. Say which one is missing rather than implying both. */}
            No readings since the last charge yet — the curve starts filling in
            on the next sync.
          </p>
        )}
        {/* What the estimate is BUILT from. "3.4 days" with no provenance is
            indistinguishable from a guess; "measured over 45h of the previous
            charge" can be judged. */}
        {L?.pct_per_day != null && (
          <div className="mt-2 flex items-baseline justify-between border-t border-hairline pt-2">
            <span className="text-[12px] text-ink-2">
              {L.full_charge_days}d on a full charge
            </span>
            <span className="text-[11.5px] text-ink-3">
              measured over {L.observed_hours}h of {L.basis}
            </span>
          </div>
        )}
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
          {D.last_charge_seen
            ? `Last charge ${ago(D.last_charge)?.text ?? "—"}.`
            : "No charge observed yet — the ring reports no charge history, so this is inferred from readings we've taken."}
        </p>
      </Card>

      <Section title="Data freshness">
        <div className="flex items-baseline justify-between border-b border-hairline pb-2.5">
          <span className="text-[13.5px] font-medium">Dashboard built</span>
          <span className="tnum text-[13.5px]">
            {ago(DATA.meta.generated_at)?.text ?? "—"}</span>
        </div>
        <div className="flex items-baseline justify-between border-b border-hairline py-2.5">
          <span className="text-[13.5px] font-medium">Newest reading</span>
          <span className="tnum text-[13.5px] font-[660]" style={{ color: f.color }}>
            {data?.text ?? "—"} <span className="font-normal text-ink-3">{f.word}</span>
          </span>
        </div>
        <div className="flex items-baseline justify-between border-b border-hairline py-2.5">
          <span className="text-[13.5px] font-medium">Last phone sync</span>
          <span className="tnum text-[13.5px]">{phone?.text ?? "never"}</span>
        </div>
        <div className="flex items-baseline justify-between border-b border-hairline py-2.5">
          <span className="text-[13.5px] font-medium">Last ring sync by Mac</span>
          <span className="tnum text-[13.5px]">{mac?.text ?? "never"}</span>
        </div>
        <div className="flex items-baseline justify-between py-2.5">
          <span className="text-[13.5px] font-medium">Mac over Tailscale</span>
          <span className="tnum text-[13.5px] font-[660]" style={{
            color: mac2.ok == null ? "var(--ink-3)"
                 : mac2.ok ? "var(--good)" : "var(--critical)" }}>
            {mac2.ok == null ? "checking…"
              : mac2.ok ? "reachable now"
              : `unreachable · last ${ago(mac2.last)?.text ?? "unknown"}`}
          </span>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
          Three separate things: the ring measuring, the Mac collecting from it,
          and this phone being able to reach the Mac. They fail independently,
          so each is shown on its own.
        </p>
      </Section>

      <Card className="rise mb-3 border-hairline bg-surface-1 px-[18px] py-1">
        <details className="group">
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3
                              rounded-lg py-2 [&::-webkit-details-marker]:hidden">
            <span className="text-[13px] font-[660] text-ink-2">Advanced diagnostics</span>
            <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-3">
              Details
              <ChevronDown size={15} className="transition-transform group-open:rotate-180" />
            </span>
          </summary>

          <div className="border-t border-hairline pt-1 pb-[14px]">
            <p className="border-t border-hairline pt-2.5 text-[11px] font-[660] uppercase
                          tracking-[0.09em] text-ink-3 first:border-t-0 first:pt-0">
              Recent syncs
            </p>
            {R.recent_syncs.map((s) => (
              <div key={s.id} className="flex items-baseline justify-between border-t
                                         border-hairline py-2">
                <span className="text-[12.5px]">{clock(s.at)}</span>
                <span className="text-[11px] font-[620] uppercase tracking-[0.08em]"
                      style={{ color: s.source === "phone" ? "var(--brand)" : "var(--ink-3)" }}>
                  {s.source}
                </span>
              </div>
            ))}

            <p className="mt-2.5 border-t border-hairline pt-2.5 text-[11px] font-[660]
                          uppercase tracking-[0.09em] text-ink-3">
              Stored records
            </p>
            {Object.entries(R.counts).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between border-t
                                      border-hairline py-2">
                <span className="text-[12.5px]">{k.replace(/_/g, " ")}</span>
                <span className="tnum text-[13px] font-[660]">{v.toLocaleString()}</span>
              </div>
            ))}
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
              Span {DATA.meta.span.days} days · {DATA.meta.span.hr_samples.toLocaleString()} heart-rate samples.
            </p>

            <div className="mt-2.5 border-t border-hairline pt-2.5">
              <KnownLimits />
            </div>
          </div>
        </details>
      </Card>
    </>
  );
}
