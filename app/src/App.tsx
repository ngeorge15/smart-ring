import { useEffect, useState } from "react";
import { Moon, RefreshCw, Sun } from "lucide-react";
import { DATA } from "@/lib/data";
import { overlayState } from "@/lib/overlay";
import { Nav, type Tab } from "@/components/Nav";
import { Today } from "@/pages/Today";
import { SleepPage } from "@/pages/SleepPage";
import { ActivityPage } from "@/pages/Activity";
import { Vitals } from "@/pages/Vitals";
import { TrendsPage } from "@/pages/TrendsPage";
import { RingPage } from "@/pages/RingPage";

const TITLES: Record<Tab, string> = {
  today: "Today", sleep: "Sleep", activity: "Activity", vitals: "Vitals",
  trends: "Trends", ring: "Ring",
};

export default function App() {
  const [dark, setDark] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /* Pull everything already captured into the dashboard.
        1. upload any captures sitting in the phone's queue
        2. ask the Mac to regenerate the snapshot from the database
        3. reload

     What this CANNOT do is pull new readings off the ring: that needs Web
     Bluetooth, which exists only in Bluefy, not in whatever browser is showing
     this page. So it surfaces everything captured so far -- it is not a sync. */
  async function refresh() {
    if (busy) return;
    setBusy(true);

    /* Check the Mac is actually there BEFORE doing anything.
       Without this, refreshing with Tailscale off hung on a fetch with no
       timeout and then reloaded into a browser error page -- losing the app
       entirely for the sake of a refresh that could never have worked. */
    if (!(await reachable())) {
      setBusy(false);
      setNote("Mac unreachable — showing the last data loaded");
      return;
    }
    try {
      /* Rebuild only. There is deliberately no queue drain here: the capture
         queue lives in Bluefy's IndexedDB, and Safari -- where this runs --
         cannot see another iOS app's storage. The drain that used to sit here
         was a permanent no-op that read an always-empty store, and it implied
         the dashboard contributed to uploading when it structurally cannot.
         sync.html drains its own queue, in the app that owns it. */
      await withTimeout(fetch("rebuild", { method: "POST" }), 120000);
    } catch {
      setBusy(false);
      setNote("Refresh failed — showing the last data loaded");
      return;                     // never reload into a page we cannot fetch
    }
    location.reload();
  }

  /** Reject rather than hang: an unreachable host otherwise pends forever. */
  function withTimeout<T>(pr: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      pr,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
    ]);
  }

  async function reachable(): Promise<boolean> {
    if (!navigator.onLine) return false;
    try {
      const r = await withTimeout(
        fetch(`ping?t=${Date.now()}`, { cache: "no-store" }), 4000);
      return r.ok;
    } catch { return false; }
  }

  const [tab, setTab] = useState<Tab>("today");
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
        const r = await withTimeout(
          fetch(`ping?t=${Date.now()}`, { cache: "no-store" }), 4000);
        if (!r.ok) return;
        const { built } = await r.json();
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
    document.addEventListener("visibilitychange", onVis);
    addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) check(true); });
    const id = setInterval(() => check(false), 60000);
    check(true);
    return () => { stop = true; clearInterval(id); clearTimeout(id);
                   document.removeEventListener("visibilitychange", onVis); };
  }, []);

  useEffect(() => {
    try { const s = localStorage.getItem("ring-theme"); if (s) setDark(s === "dark"); } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("ring-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
  }, [dark]);
  // returning to a tab should start at the top, as it does in Apple's apps
  useEffect(() => { window.scrollTo({ top: 0 }); }, [tab]);

  const when = new Date(DATA.meta.generated_at);
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
      <div className="mx-auto max-w-[720px] px-[15px] pt-[18px] pb-[84px]">
        <header className="rise mb-4 flex items-start justify-between px-1">
          <div>
            <h1 className="text-[26px] font-[660] leading-tight tracking-[-0.028em]">
              {tab === "today" ? `${greeting}!` : TITLES[tab]}
            </h1>
            {/* Only Today carries a subtitle. "synced HH:MM" used to sit under
                every other tab, which was both redundant and misleading -- it
                is the snapshot BUILD time, not data freshness. The Ring tab now
                shows build time, reading age, and per-source sync times
                properly, so one honest place beats five ambiguous ones. */}
            {tab === "today" && (
              <p className="mt-1 text-[12px] text-ink-3">
                {when.toLocaleDateString(undefined,
                  { weekday: "long", month: "long", day: "numeric" })}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button onClick={refresh} disabled={busy} aria-label="Refresh data"
                    className="flex h-11 w-11 items-center justify-center rounded-full
                               border border-hairline bg-surface-2 text-ink-2
                               active:scale-95 disabled:opacity-50">
              <RefreshCw size={16} className={busy ? "animate-spin" : undefined} />
            </button>
            <button onClick={() => setDark(!dark)} aria-label="Toggle light or dark theme"
                    className="flex h-11 w-11 items-center justify-center rounded-full
                               border border-hairline bg-surface-2 text-ink-2 active:scale-95">
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        {/* Provenance. These numbers were decoded and scored on the PHONE
            against cached baselines, not by the Mac -- close, but not the same
            computation, and they must never be mistaken for the record. */}
        {overlayState.active && (
          <div className="rise mb-3 rounded-xl border border-hairline bg-surface-2
                          px-3.5 py-2.5 text-[12px] text-ink-2" role="status">
            Showing last night from your phone
            <span className="text-ink-3">
              {" · "}synced {overlayState.at
                ? new Date(overlayState.at).toLocaleTimeString(undefined,
                    { hour: "numeric", minute: "2-digit" })
                : "recently"}
              {" · "}the Mac hasn’t seen it yet
            </span>
          </div>
        )}

        {fresher && !note && (
          <button onClick={() => location.reload()}
                  className="rise mb-3 w-full rounded-xl border border-hairline
                             bg-surface-2 px-3.5 py-2.5 text-left text-[12px] text-ink-2">
            The Mac has newer data <span className="text-ink-3">· tap to load</span>
          </button>
        )}

        {note && (
          <div className="rise mb-3 rounded-xl border border-hairline bg-surface-2
                          px-3.5 py-2.5 text-[12px] text-ink-2"
               onClick={() => setNote(null)} role="status">
            {note} <span className="text-ink-3">· tap to dismiss</span>
          </div>
        )}

        {tab === "today" && <Today go={setTab} />}
        {tab === "sleep" && <SleepPage />}
        {tab === "activity" && <ActivityPage />}
        {tab === "vitals" && <Vitals />}
        {tab === "trends" && <TrendsPage />}
        {tab === "ring" && <RingPage />}
      </div>
      <Nav tab={tab} onChange={setTab} />
    </>
  );
}
