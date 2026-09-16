import { BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, Plug } from "lucide-react";
import { DATA } from "@/lib/data";

function localDayKey(d = new Date()) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")].join("-");
}

/** Plain-words age. "12 minutes ago" beats a timestamp you have to subtract. */
function ago(iso: string | null): { text: string; hours: number } | null {
  if (!iso) return null;
  const then = new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, (Date.now() - then) / 60000);
  const hours = mins / 60;
  if (mins < 1) return { text: "just now", hours };
  if (mins < 60) return { text: `${Math.round(mins)} min ago`, hours };
  if (hours < 24) return { text: `${Math.round(hours)}h ago`, hours };
  return { text: `${Math.round(hours / 24)}d ago`, hours };
}

/* Sync runs every 2h, so anything past ~3h means a cycle was missed --
   out of range, Mac asleep, or QRing holding the connection. */
function freshness(hours: number) {
  if (hours < 3) return { color: "var(--good)", word: "up to date" };
  if (hours < 12) return { color: "var(--warning)", word: "a bit behind" };
  return { color: "var(--critical)", word: "stale" };
}

function BatteryIcon({ level, charging }: { level: number; charging: boolean }) {
  const c = level <= 15 ? "var(--critical)" : level <= 30 ? "var(--warning)" : "var(--ink-2)";
  if (charging) return <Plug size={15} color="var(--good)" />;
  const Icon = level > 66 ? BatteryFull : level > 33 ? BatteryMedium
             : level > 15 ? BatteryLow : BatteryWarning;
  return <Icon size={16} color={c} />;
}

/** Whether the compact strip is worth showing at all. Healthy operation
    shows nothing here -- the header's device-status dot already carries the
    ambient signal; this earns its screen space only when something wants
    action: stale data, a sync that's fallen behind, or a critical battery. */
export function deviceNeedsAttention(): boolean {
  const d = DATA.device;
  const data = ago(d.latest_reading);
  const stale = DATA.readiness.day !== localDayKey();
  const behind = data ? freshness(data.hours).word !== "up to date" : true;
  const criticalBattery = d.battery != null && d.battery <= 15 && !d.charging;
  return stale || behind || criticalBattery;
}

export function DeviceStrip() {
  const d = DATA.device;
  const data = ago(d.latest_reading);
  const charge = ago(d.last_charge);
  const watching = ago((d as { watching_since?: string }).watching_since ?? null);
  const f = data ? freshness(data.hours) : null;
  // is_today describes when the snapshot was built. Recheck against the
  // viewer's local calendar so a cached dashboard does not stay "today".
  const stale = DATA.readiness.day !== localDayKey();

  return (
    <div className="device-strip rise mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[18px]
                    border border-hairline bg-surface-1 px-3.5 py-2.5 text-[12px]">
      <span className="flex items-center gap-1.5">
        <BatteryIcon level={d.battery ?? 0} charging={d.charging} />
        <b className="tnum font-[620]">{d.battery == null ? "—" : `${d.battery}%`}</b>
      </span>

      <span className="h-3.5 w-px bg-hairline" />

      <span className="device-charge min-w-0 flex-1 truncate text-ink-3">
        {d.charging ? "charging now"
          : d.last_charge_seen ? <>charged {charge?.text}</>
          : <>no charge seen{watching ? ` (watching ${watching.text.replace(" ago", "")})` : ""}</>}
      </span>

      {stale && (
        <span className="device-date shrink-0 rounded-full border border-hairline px-2 py-0.5
                         text-[11px] text-warning">
          showing {new Date(DATA.readiness.day + "T12:00")
            .toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </span>
      )}
      {f && data && (
        <span className="device-freshness flex shrink-0 items-center gap-1.5">
          <i className="h-[7px] w-[7px] rounded-full" style={{ background: f.color }} />
          <span style={{ color: f.color }}>{data.text}</span>
        </span>
      )}
    </div>
  );
}
