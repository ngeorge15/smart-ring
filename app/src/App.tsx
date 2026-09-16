import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, CircleDot, Plug } from "lucide-react";
import { DATA } from "@/lib/data";
import { overlayState } from "@/lib/overlay";
import { fetchJson, rebuildDashboard } from "@/lib/http";
import { useSwipe } from "@/lib/useSwipe";
import { useTheme, type ThemePref } from "@/lib/theme";
import { Nav, TAB_ORDER, type Tab } from "@/components/Nav";
import { DeviceSheet } from "@/components/DeviceSheet";
import { Today } from "@/pages/Today";
import { MetricsPage, type MetricDomain } from "@/pages/MetricsPage";
import { TrendsPage } from "@/pages/TrendsPage";

const TITLES: Record<Tab, string> = { today: "Today", metrics: "Metrics", trends: "Trends" };

/** Battery + a freshness dot, nothing else -- the full picture lives one tap
    away in the device sheet. Deliberately duplicates DeviceStrip's threshold
    logic rather than sharing it: that component now only renders when
    something needs attention, this one is always-on chrome, and the two
    diverging slightly costs less than coupling them. */
function batteryIcon(level: number, charging: boolean) {
  if (charging) return <Plug size={14} color="var(--good)" />;
  const c = level <= 15 ? "var(--critical)" : level <= 30 ? "var(--warning)" : "var(--ink-2)";
  const Icon = level > 66 ? BatteryFull : level > 33 ? BatteryMedium : level > 15 ? BatteryLow : BatteryWarning;
  return <Icon size={15} color={c} />;
}
function freshnessColor(iso: string | null): string {
  if (!iso) return "var(--ink-3)";
  const mins = (Date.now() - new Date(iso.replace(" ", "T")).getTime()) / 60000;
  if (mins < 90) return "var(--good)";
  if (mins < 60 * 12) return "var(--warning)";
  return "var(--critical)";
}

function DeviceStatusButton({ onClick }: { onClick: () => void }) {
  const D = DATA.device;
  return (
    <button onClick={onClick} aria-label="Ring and device settings"
            className="flex h-11 items-center gap-1.5 rounded-full border border-hairline
                       bg-surface-2 px-3 text-ink-2 active:scale-95">
      <CircleDot size={15} className="text-ink-3" />
      {D.battery != null && (
        <span className="flex items-center gap-1">
          {batteryIcon(D.battery, D.charging)}
          <span className="tnum text-[12.5px] font-[600]">{D.battery}%</span>
        </span>
      )}
      <i aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full"
         style={{ background: freshnessColor(D.latest_reading) }} />
    </button>
  );
}

export default function App() {
  const { pref: themePref, setTheme } = useTheme();
  function changeTheme(pref: ThemePref) {
    if (!document.startViewTransition) { setTheme(pref); return; }
    document.startViewTransition(() => flushSync(() => setTheme(pref)));
  }

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; detail: string } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Refresh the dashboard from the Mac's database. Ring capture is a separate
  // action reachable from the device sheet and may be running in a different
  // browser's storage.
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setNote(null);

    /* Check the Mac is actually there BEFORE doing anything.
       Without this, refreshing with Tailscale off hung on a fetch with no
       timeout and then reloaded into a browser error page -- losing the app
       entirely for the sake of a refresh that could never have worked. */
    if (!(await reachable())) {
      setBusy(false);
      setNote({ text: "Mac unreachable", detail: "showing the last data loaded" });
      return;
    }
    try {
      await rebuildDashboard();
    } catch {
      setBusy(false);
      setNote({ text: "Refresh failed", detail: "showing the last data loaded" });
      return;                     // never reload into a page we cannot fetch
    }
    location.reload();
  }

  async function reachable(): Promise<boolean> {
    if (!navigator.onLine) return false;
    try {
      const r = await fetchJson<{ now?: unknown }>(`ping?t=${Date.now()}`, { cache: "no-store" });
      return typeof r.now === "string";
    } catch { return false; }
  }

  const [tab, setTab] = useState<Tab>("today");
  const [metricsDomain, setMetricsDomain] = useState<MetricDomain | null>(null);
  /* Native cross-fade between tabs, no library: startViewTransition needs the
     DOM mutation to land SYNCHRONOUSLY inside its callback to snapshot
     before/after correctly, which React's default batching won't do on its
     own -- hence flushSync. Feature-detected: older WebKit (and any non-Safari
     browser without support) just gets the instant swap it has today. */
  function changeTab(t: Tab) {
    if (!document.startViewTransition) { setTab(t); return; }
    document.startViewTransition(() => flushSync(() => setTab(t)));
  }
  /** Today's jump-off cards used to switch straight to a top-level tab; Sleep
      and Activity are one level deeper now, inside Metrics. */
  function openMetric(domain: MetricDomain) {
    if (!document.startViewTransition) { setTab("metrics"); setMetricsDomain(domain); return; }
    document.startViewTransition(() => flushSync(() => { setTab("metrics"); setMetricsDomain(domain); }));
  }
  // Swipe order matches the nav's left-to-right icon order, so "swipe left"
  // always means the same thing as "the next icon over" -- never surprising.
  const swipe = useSwipe(
    () => { const i = TAB_ORDER.indexOf(tab); if (i < TAB_ORDER.length - 1) changeTab(TAB_ORDER[i + 1]); },
    () => { const i = TAB_ORDER.indexOf(tab); if (i > 0) changeTab(TAB_ORDER[i - 1]); },
  );
  const [fresher, setFresher] = useState(false);

  /* Auto-load a newer build.
     The page bakes its snapshot in, so an app reopened from the home screen
     shows whatever was true when it was last built -- with no hint that the Mac
     has since ingested a phone sync and rebuilt. /ping already reports the Mac's
     current build time for exactly this, and the dashboard was already polling
     it for reachability, so noticing costs nothing.

     Reloading is only done on FOREGROUND, the moment nobody is mid-interaction.
     While you are actually using the page it offers instead -- yanking the view
     out from under a tap is worse than being one sync behind. */
  useEffect(() => {
    let stop = false;
    const check = async (auto: boolean) => {
      if (document.visibilityState !== "visible") return;
      try {
        const { built } = await fetchJson<{ built?: string | null }>(
          `ping?t=${Date.now()}`, { cache: "no-store" });
        if (stop || !built || built <= DATA.meta.generated_at) return;
        /* Reload AT MOST ONCE per build stamp.
           Without this the feature can spin: if the Mac reports a build the
           served page does not actually carry, every reload lands on the same
           old page, sees the same newer stamp, and reloads again -- an infinite
           loop on the user's phone. serve.py now avoids advertising a build the
           page cannot have, but this is the belt: a reload that did not change
           anything must never be retried, only offered. */
        const KEY = "ring-reloaded-for";
        let already: string | null = null;
        try { already = sessionStorage.getItem(KEY); } catch { /* private mode */ }
        if (auto && already !== built) {
          try { sessionStorage.setItem(KEY, built); } catch { /* ignore */ }
          location.reload();
          return;
        }
        setFresher(true);
      } catch { /* Mac unreachable: keep showing what we have */ }
    };
    const onVis = () => { if (document.visibilityState === "visible") check(true); };
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) check(true); };
    document.addEventListener("visibilitychange", onVis);
    addEventListener("pageshow", onPageShow);
    const id = setInterval(() => check(false), 60000);
    check(true);
    return () => { stop = true; clearInterval(id);
                   document.removeEventListener("visibilitychange", onVis);
                   removeEventListener("pageshow", onPageShow); };
  }, []);

  // returning to a tab should start at the top, as it does in Apple's apps
  useEffect(() => { window.scrollTo({ top: 0 }); }, [tab]);

  const when = new Date();
  // Greeting keys off the CURRENT clock, not the sync time -- opening the app at
  // night after a morning sync should not say "good morning".
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Still up?"
    : hour < 12 ? "Good morning"
    : hour < 17 ? "Good afternoon"
    : hour < 22 ? "Good evening"
    : "Winding down";

  return (
    <>
      <main {...swipe} className="mx-auto max-w-[720px] px-[15px] pt-[18px] pb-[84px]">
        <header className="rise mb-4 flex items-start justify-between px-1">
          <div>
            <h1 className="text-[26px] font-[660] leading-tight tracking-[-0.028em]">
              {tab === "today" ? `${greeting}!` : TITLES[tab]}
            </h1>
            {tab === "today" && (
              <p className="mt-1 text-[12px] text-ink-3">
                {when.toLocaleDateString(undefined,
                  { weekday: "long", month: "long", day: "numeric" })}
              </p>
            )}
          </div>
          <DeviceStatusButton onClick={() => setSheetOpen(true)} />
        </header>

        {/* Provenance. These numbers were decoded and scored on the PHONE
            against cached baselines, not by the Mac -- close, but not the same
            computation, and they must never be mistaken for the record. */}
        {overlayState.active && (
          <output className="rise mb-3 block rounded-xl border border-hairline bg-surface-2
                              px-3.5 py-2.5 text-[12px] text-ink-2">
            Showing readings captured on your phone
            <span className="text-ink-3">
              {" · "}captured {overlayState.at
                ? new Date(overlayState.at).toLocaleString(undefined,
                    { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                : "recently"}
              {" · "}import into this dashboard is not yet confirmed
            </span>
          </output>
        )}

        {fresher && !note && (
          <button onClick={() => location.reload()}
                  className="rise mb-3 w-full rounded-xl border border-hairline
                             bg-surface-2 px-3.5 py-2.5 text-left text-[12px] text-ink-2">
            The Mac has newer data <span className="text-ink-3">· tap to load</span>
          </button>
        )}

        {note && (
          <button onClick={() => setNote(null)}
                  className="rise mb-3 w-full rounded-xl border border-hairline
                             bg-surface-2 px-3.5 py-2.5 text-left">
            <span className="text-[12.5px] font-[620] text-ink-2">{note.text}</span>
            <p className="mt-0.5 text-[12px] text-ink-3">{note.detail} · tap to dismiss</p>
          </button>
        )}

        {tab === "today" && <Today onOpenMetric={openMetric} onOpenDevice={() => setSheetOpen(true)} />}
        {tab === "metrics" && <MetricsPage domain={metricsDomain} onDomainChange={setMetricsDomain} />}
        {tab === "trends" && <TrendsPage />}
      </main>
      <Nav tab={tab} onChange={changeTab} />
      <DeviceSheet open={sheetOpen} onOpenChange={setSheetOpen}
                   themePref={themePref} onThemeChange={changeTheme}
                   onRefresh={refresh} refreshing={busy} />
    </>
  );
}
