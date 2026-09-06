import { useEffect, useState } from "react";
import {
  runSync, idbAll, isStandalone, importJobs, refreshImportJobs, retryImportJob,
  type ImportJob, type LogLevel,
} from "@/lib/capture";
import { summarise, getParams } from "@/lib/summarise";
import { saveOverlayAndReload } from "@/lib/overlay";
import { Section } from "@/components/Charts";
import { Arc } from "@/components/Dials";

type LogLine = { msg: string; level: LogLevel };

const COLOR: Record<string, string> = {
  ok: "var(--good)", warn: "var(--warning)", err: "var(--critical)", dim: "var(--ink-3)",
};

export function SyncCard() {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ text: string; detail?: string }>({ text: "Ready" });
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [queued, setQueued] = useState(0);
  const [jobs, setJobs] = useState<ImportJob[]>(importJobs);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [jobNotice, setJobNotice] = useState<string | null>(null);

  // Read once per mount, not on every render -- standalone-ness cannot change
  // without a full relaunch, and matchMedia is cheap but not free.
  const [standalone] = useState(isStandalone);

  const addLog = (msg: string, level?: LogLevel) =>
    setLog((l) => [...l.slice(-80), { msg, level }]);

  const refreshQueued = () => { idbAll().then((all) => setQueued(all.length)).catch(() => {}); };
  useEffect(refreshQueued, []);
  useEffect(() => {
    let mounted = true;
    const poll = () => refreshImportJobs()
      .then((next) => { if (mounted) setJobs(next); })
      .catch(() => { /* the saved state remains useful while the Mac is offline */ });
    poll();
    const timer = window.setInterval(poll, 5_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  async function retry(job: ImportJob) {
    if (retrying) return;
    setRetrying(job.job_id);
    setJobNotice(null);
    try {
      const next = await retryImportJob(job);
      setJobs((all) => all.map((item) => item.job_id === next.job_id ? next : item));
    } catch (e) {
      setJobNotice(`Retry failed: ${(e as Error).message}`);
    } finally {
      setRetrying(null);
    }
  }

  async function go() {
    if (busy || standalone) return;
    setBusy(true); setLog([]); setProgress(0);
    setState({ text: "Connecting…", detail: "the ring can take 30s — leave this open" });

    const { capture } = await runSync({
      onLog: addLog,
      onState: (text, detail) => setState({ text, detail }),
      onProgress: ({ index, total }) => setProgress(index / total),
    });

    // Decode and apply LOCALLY regardless of whether the upload to the Mac
    // succeeded -- that independence is the entire point of the phone-first
    // design. A capture that only reached IndexedDB still updates what you see.
    if (capture) {
      try {
        const params = await getParams();
        const ov = summarise(capture, params);
        addLog("applying to dashboard…", "ok");
        saveOverlayAndReload(ov);   // reloads; nothing after this line runs
        return;
      } catch (e) {
        addLog(`local decode failed: ${(e as Error).message}`, "err");
      }
    }
    refreshQueued();
    setBusy(false);
  }

  if (standalone) {
    return (
      <Section title="Sync">
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          Bluetooth isn't available from the home-screen icon — Safari
          extensions don't inject into a standalone launch. Open this page in
          a normal Safari tab (not this icon) to sync the ring; this icon
          still works fine for viewing.
        </p>
        <ImportState jobs={jobs} retrying={retrying} notice={jobNotice} onRetry={retry} />
      </Section>
    );
  }

  // Indeterminate (connecting, no step has run yet) breathes; once a real
  // step count exists the same ring fills to it instead -- one visual
  // language for "working" throughout the sync, not a spinner-then-bar swap.
  const indeterminate = busy && progress === 0;

  return (
    <Section title="Sync" right={queued ? `${queued} queued` : undefined}>
      <div className="flex items-center gap-3">
        {busy && (
          <div className={`relative h-9 w-9 shrink-0 ${indeterminate ? "breathe" : ""}`}>
            <Arc score={indeterminate ? 0 : progress * 100} r={15} stroke={3.5} color="var(--brand)" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-[620]">{state.text}</span>
            {busy && !indeterminate && (
              <span className="tnum text-[11px] text-ink-3">{Math.round(progress * 100)}%</span>
            )}
          </div>
          {state.detail && <p className="mt-0.5 text-[12px] text-ink-3">{state.detail}</p>}
        </div>
      </div>

      <button onClick={go} disabled={busy}
              className="mt-3 min-h-[46px] w-full rounded-xl border border-brand-action
                         bg-brand-action font-[560] text-brand-action-foreground
                         active:scale-[.985] disabled:opacity-50">
        {busy ? "Syncing…" : "Sync ring"}
      </button>

      <ImportState jobs={jobs} retrying={retrying} notice={jobNotice} onRetry={retry} />

      {log.length > 0 && (
        <>
          <button onClick={() => setShowLog((s) => !s)}
                  className="mt-2.5 text-[11.5px] text-ink-3 underline decoration-hairline
                             underline-offset-2">
            {showLog ? "hide log" : "show log"}
          </button>
          {showLog && (
            <pre className="mt-2 max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-words
                            rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed">
              {log.map((l, i) => (
                <div key={i} style={{ color: l.level ? COLOR[l.level] : "var(--ink-2)" }}>
                  {l.msg}
                </div>
              ))}
            </pre>
          )}
        </>
      )}
    </Section>
  );
}

function ImportState({ jobs, retrying, notice, onRetry }: {
  jobs: ImportJob[];
  retrying: string | null;
  notice: string | null;
  onRetry: (job: ImportJob) => void;
}) {
  const newest = (state: ImportJob["state"]) =>
    [...jobs].reverse().find((job) => job.state === state);
  const job = newest("running") ?? newest("queued") ?? newest("failed") ?? newest("completed");
  if (!job && !notice) return null;

  const pending = jobs.filter((item) => item.state === "queued" || item.state === "running").length;
  const launchBlocked = job?.state === "queued" &&
    (job.worker?.state === "unavailable" || job.worker?.state === "launch_failed");
  let title = "Import saved";
  let detail = "The capture is safely stored on your Mac.";
  let color = "var(--good)";
  if (launchBlocked) {
    title = "Import worker unavailable";
    detail = job?.worker?.detail || "The capture is safe, but the Mac could not start its decoder.";
    color = "var(--critical)";
  } else if (job?.state === "queued") {
    title = "Waiting to import";
    detail = pending > 1 ? `${pending} captures are waiting on your Mac.` : "The capture is queued on your Mac.";
    color = "var(--warning)";
  } else if (job?.state === "running") {
    title = "Importing capture…";
    detail = pending > 1 ? `${pending} captures are still being processed.` : "Your saved capture is being decoded.";
    color = "var(--brand)";
  } else if (job?.state === "failed") {
    title = "Import failed";
    detail = job.error || job.worker?.detail || "The capture is still saved and can be retried.";
    color = "var(--critical)";
  } else if (job?.rebuild?.state === "failed") {
    title = "Imported; dashboard update failed";
    detail = "Your readings are saved. Use Refresh app to rebuild the dashboard.";
    color = "var(--warning)";
  }

  return (
    <div className="mt-3 border-t border-hairline pt-3" aria-live="polite">
      {job && (
        <div className="flex items-start gap-2.5">
          <i className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-[620]">{title}</div>
            <p className="mt-0.5 break-words text-[11.5px] leading-relaxed text-ink-3">{detail}</p>
          </div>
          {(job.state === "failed" || launchBlocked) && job.retry_url && (
            <button onClick={() => onRetry(job)} disabled={retrying !== null}
                    className="min-h-[36px] shrink-0 rounded-lg border border-hairline px-3
                               text-[12px] font-[600] text-brand disabled:opacity-50">
              {retrying === job.job_id ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}
      {notice && <p className="mt-2 text-[11.5px] text-critical">{notice}</p>}
    </div>
  );
}
