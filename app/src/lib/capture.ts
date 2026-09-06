/// <reference types="web-bluetooth" />
/**
 * BLE capture engine, ported from web/sync.html.
 *
 * Runs in the SAME origin/process as the dashboard now (beacio polyfills
 * navigator.bluetooth into real Safari), so this file owns exactly what
 * sync.html owned: write bytes, collect bytes, queue them, upload them. The
 * protocol itself still arrives from /sync-plan at runtime — a decode fix
 * stays a Python edit with no change here, same as before.
 *
 * State is module-level, not component-level, on purpose: the GATT link and
 * the abort flag are tied to the PAGE's lifetime (pagehide must release the
 * ring regardless of which component is mounted), not to any one React
 * component instance. sync.html made the same choice for the same reason.
 */

const PLAN_KEY = "ring-plan-v1";
const LAST_KEY = "ring-last-sync";
const IMPORT_JOBS_KEY = "ring-import-jobs-v1";
const INGEST_TIMEOUT_MS = 15_000;

export type LogLevel = "ok" | "warn" | "err" | "dim" | undefined;
export type SyncListener = (msg: string, level?: LogLevel) => void;

export type Capture = {
  id: string;
  captured_at: number;
  /** IANA zone and minutes east of UTC at collection time. Relative day
      markers must keep this clock even if upload/display happens later. */
  captured_timezone?: string;
  captured_utc_offset_min?: number;
  source: "auto" | "manual";
  plan_version: string;
  steps: { id: string; kind: string; day?: string; day_offset?: number; chunks: string[] }[];
};

type PlanStep = {
  id: string; kind: string; day?: string; day_offset?: number;
  service: string; write: string; notify: string; hex: string; collect_ms: number;
};
type Plan = { version: string; steps: PlanStep[] };
export type ImportJob = {
  capture_id: string; job_id: string; status_url: string; retry_url?: string;
  state: "queued" | "running" | "completed" | "failed";
  accepted?: boolean; steps?: number; attempts?: number; retryable?: boolean;
  error?: string; detail?: string;
  result?: { acknowledged?: boolean; errors?: string[]; stored?: Record<string, number> };
  rebuild?: { state: "completed" | "failed"; exit_code?: number; detail?: string };
  worker?: { state?: string; detail?: string; pid?: number };
};
const IMPORT_STATES = new Set<ImportJob["state"]>(["queued", "running", "completed", "failed"]);

export function importJobs(): ImportJob[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(IMPORT_JOBS_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((job): job is ImportJob => validStoredImportJob(job as Partial<ImportJob>))
      : [];
  }
  catch { return []; }
}

function rememberImportJob(job: ImportJob): void {
  try {
    const jobs = importJobs().filter((j) => j.capture_id !== job.capture_id);
    localStorage.setItem(IMPORT_JOBS_KEY, JSON.stringify([...jobs, job].slice(-20)));
  } catch { /* private mode/full storage: overlay still tracks the capture */ }
}

function validImportJob(next: Partial<ImportJob>, expected?: ImportJob | Capture): next is ImportJob {
  if (typeof next.capture_id !== "string" || typeof next.job_id !== "string" ||
      typeof next.status_url !== "string" || typeof next.retry_url !== "string" ||
      !IMPORT_STATES.has(next.state as ImportJob["state"])) return false;
  if (!expected) return true;
  return next.capture_id === ("id" in expected ? expected.id : expected.capture_id) &&
    (!("job_id" in expected) || next.job_id === expected.job_id);
}

function validStoredImportJob(next: Partial<ImportJob>): next is ImportJob {
  return typeof next.capture_id === "string" && typeof next.job_id === "string" &&
    typeof next.status_url === "string" &&
    (next.retry_url == null || typeof next.retry_url === "string") &&
    IMPORT_STATES.has(next.state as ImportJob["state"]);
}

export async function refreshImportJobs(): Promise<ImportJob[]> {
  const jobs = importJobs();
  const refreshed = await Promise.all(jobs.map(async (job) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
    try {
      const res = await fetch(job.status_url, { cache: "no-store", signal: controller.signal });
      const next = await res.json() as Partial<ImportJob>;
      if (!res.ok || !validImportJob(next, job)) return job;
      return { ...job, ...next } as ImportJob;
    } catch { return job; }
    finally { clearTimeout(timeout); }
  }));
  try { localStorage.setItem(IMPORT_JOBS_KEY, JSON.stringify(refreshed.slice(-20))); }
  catch { /* status remains usable for this render */ }
  return refreshed;
}

export async function retryImportJob(job: ImportJob): Promise<ImportJob> {
  if (!job.retry_url) throw new Error("retry endpoint is not available yet");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
  try {
    const res = await fetch(job.retry_url, {
      method: "POST", cache: "no-store", signal: controller.signal,
    });
    const next = await res.json() as Partial<ImportJob>;
    if (res.status !== 202 || next.accepted !== true || !validImportJob(next, job)) {
      throw new Error(`invalid retry acknowledgement (HTTP ${res.status})`);
    }
    const merged = { ...job, ...next } as ImportJob;
    rememberImportJob(merged);
    return merged;
  } finally {
    clearTimeout(timeout);
  }
}

async function stableCaptureId(capture: Omit<Capture, "id">): Promise<string> {
  const payload = JSON.stringify(capture);
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return `cap_${hex(digest).slice(0, 32)}`;
  }
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `cap_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (dv: DataView | ArrayBuffer) =>
  [...new Uint8Array((dv as DataView).buffer ?? (dv as ArrayBuffer))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

/** A Safari extension polyfill (or Bluefy) rejects with values that are not
    real Errors -- reading .name/.message off them can itself throw. */
function describeErr(e: unknown): string {
  if (e == null) return `empty rejection (${typeof e})`;
  const err = e as { name?: string; message?: string };
  if (err.name || err.message) return `${err.name || "Error"}: ${err.message || "(no message)"}`;
  if (typeof e === "string") return `string: ${e}`;
  try { return `${typeof e}: ${JSON.stringify(e)}`; } catch { return `${typeof e}: ${String(e)}`; }
}

/** Safari extensions attach to Safari tabs, not the isolated WKWebView process
    a standalone home-screen launch runs in -- confirmed empirically 2026-09-04:
    navigator.bluetooth is undefined there even with beacio enabled and granted.
    Checked before touching Bluetooth at all, so the failure is explained rather
    than surfacing as a bare "requestDevice is not a function". */
export function isStandalone(): boolean {
  return (window.navigator as { standalone?: boolean }).standalone === true ||
    matchMedia("(display-mode: standalone)").matches;
}

/* ------------------------------------------------------------------ IndexedDB */
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open("ring", 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains("captures")) {
        r.result.createObjectStore("captures", { keyPath: "id" });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbAll(): Promise<Capture[]> {
  const db = await idb();
  return new Promise((res, rej) => {
    const req = db.transaction("captures").objectStore("captures").getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
async function idbPut(rec: Capture): Promise<void> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("captures", "readwrite");
    tx.objectStore("captures").put(rec);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function idbDel(id: string): Promise<void> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("captures", "readwrite");
    tx.objectStore("captures").delete(id);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

/* ------------------------------------------------------------------ the plan */
async function getPlan(log: SyncListener): Promise<Plan> {
  try {
    const res = await fetch("/sync-plan", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const plan = await res.json();
    localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    log(`plan: ${plan.steps.length} steps (fresh)`);
    return plan;
  } catch {
    const cached = localStorage.getItem(PLAN_KEY);
    if (!cached) throw new Error("no plan available and Mac unreachable");
    const plan = JSON.parse(cached);
    log(`plan: ${plan.steps.length} steps (cached — Mac unreachable)`, "warn");
    return plan;
  }
}

/* --------------------------------------------------------------- bluetooth */
const UART_SVC = "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e";
const V2_SVC = "de5bf728-d711-4e47-af26-65e3012a5dc7";

function askForRing(): Promise<BluetoothDevice> {
  return navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: "COLMI" }, { namePrefix: "R02" }],
    optionalServices: [UART_SVC, V2_SVC],
  });
}

async function getRing(log: SyncListener): Promise<BluetoothDevice> {
  if (!navigator.bluetooth) {
    throw new Error(isStandalone()
      ? "Bluetooth isn't available from the home-screen icon — open this in a Safari tab instead"
      : "no Web Bluetooth — is the beacio extension enabled for this site?");
  }
  if (navigator.bluetooth.getDevices) {
    const devs = await navigator.bluetooth.getDevices();
    const ring = devs.find((d) => /COLMI|R02/i.test(d.name || ""));
    if (ring) return ring;
  }
  log("no remembered device — asking for permission (needs a tap)", "warn");
  return askForRing();
}

/** Re-establish a live sighting of the ring. A device handed back by
    getDevices() carries a permission grant, not a current advertisement --
    without this, connect() can fail immediately after a fresh page load even
    though the ring is right there. */
async function waitForAdvertisement(device: BluetoothDevice, ms: number,
                                     log: SyncListener): Promise<boolean> {
  if (typeof device.watchAdvertisements !== "function") return false;
  let ac: AbortController | null = null;
  try {
    ac = new AbortController();
    await device.watchAdvertisements({ signal: ac.signal });
  } catch (e) {
    log(`watchAdvertisements unavailable: ${describeErr(e)}`);
    return false;
  }
  log("waiting for the ring to advertise…");
  return new Promise((resolve) => {
    const done = (found: boolean) => {
      clearTimeout(timer);
      try { ac?.abort(); } catch { /* already stopped */ }
      resolve(found);
    };
    const timer = setTimeout(() => done(false), ms);
    device.addEventListener("advertisementreceived", () => {
      log("ring seen advertising", "ok");
      done(true);
    }, { once: true });
  });
}

/** Connect with retries, tracking the abort flag through EVERY attempt.
    A connect that resolves after the sync was abandoned is worse than one
    that fails outright — it hands back a live link nothing is tracking, on a
    ring that accepts exactly one connection at a time. Seen for real on
    2026-08-25: a connect resolved 1862s (31 min) after the page backgrounded. */
async function connectWithRetry(device: BluetoothDevice, log: SyncListener,
                                 isAborted: () => boolean,
                                 attempts = 3): Promise<BluetoothRemoteGATTServer> {
  const t0 = Date.now();
  let last: unknown = null;
  let sawAdvertisement: boolean | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const server = await device.gatt!.connect();
      if (isAborted()) {
        try { device.gatt!.disconnect(); } catch { /* already gone */ }
        log(`connect resolved after abort (${((Date.now() - t0) / 1000).toFixed(0)}s) — released`, "warn");
        throw new Error("aborted while connecting");
      }
      return server;
    } catch (e) {
      if (isAborted()) throw e;
      last = e;
      log(`connect attempt ${i + 1} failed: ${describeErr(e)}`, "warn");
      if (i === attempts - 1) break;
      if (i === 0) sawAdvertisement = await waitForAdvertisement(device, 8000, log);
      else await sleep(1500);
    }
  }
  if (sawAdvertisement === false) {
    log("the ring never advertised — it only does that when nothing is connected to it.", "err");
    log("something else is holding it: force-quit QRing, or toggle iPhone Bluetooth off/on.", "dim" as LogLevel);
  }
  throw last;
}

async function runStep(server: BluetoothRemoteGATTServer, step: PlanStep,
                        cache: Record<string, unknown>): Promise<string[]> {
  const key = step.service;
  if (!cache[key]) cache[key] = await server.getPrimaryService(step.service);
  const svc = cache[key] as BluetoothRemoteGATTService;

  const chunks: string[] = [];
  const nk = key + step.notify;
  const sinks = (cache.sinks ?? (cache.sinks = {})) as Record<string, string[] | null>;
  if (!cache[nk]) {
    const ch = await svc.getCharacteristic(step.notify);
    await ch.startNotifications();
    cache[nk] = ch;
    ch.addEventListener("characteristicvaluechanged", (ev) => {
      const sink = sinks[step.notify];
      const target = ev.target as BluetoothRemoteGATTCharacteristic;
      if (sink && target.value) sink.push(hex(target.value));
    });
  }
  sinks[step.notify] = chunks;

  const wc = await svc.getCharacteristic(step.write);
  const bytes = new Uint8Array((step.hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  if (wc.properties.writeWithoutResponse) {
    await wc.writeValueWithoutResponse(bytes);
  } else {
    await wc.writeValue(bytes);
  }
  await sleep(step.collect_ms);
  sinks[step.notify] = null;
  return chunks;
}

/* ------------------------------------------------------------------- upload */
const memoryQueue: Capture[] = [];

export async function drain(log: SyncListener): Promise<number> {
  let stored: Capture[] = [];
  try { stored = await idbAll(); } catch (e) { log(`queue unreadable (${describeErr(e)})`, "warn"); }
  const all = [...stored, ...memoryQueue];
  if (!all.length) return 0;
  let accepted = 0;
  for (const cap of all) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
    try {
      const res = await fetch("/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cap), signal: controller.signal,
      });
      const ack = await res.json() as Partial<ImportJob> & { accepted?: boolean };
      if (res.status !== 202 || ack.accepted !== true || !validImportJob(ack, cap)) {
        throw new Error(`invalid queue acknowledgement (HTTP ${res.status})`);
      }
      rememberImportJob(ack as ImportJob);
      try { await idbDel(cap.id); } catch { /* never stored; nothing to delete */ }
      const m = memoryQueue.indexOf(cap);
      if (m >= 0) memoryQueue.splice(m, 1);
      accepted++;
      log(`queued for import ${cap.id}`, "ok");
    } catch (e) {
      log(`upload failed (${describeErr(e)}) — kept in queue`, "warn");
      break;
    } finally {
      clearTimeout(timeout);
    }
  }
  return accepted;
}

/* --------------------------------------------------------------------- sync */
let running = false;
let aborted = false;
let activeDevice: BluetoothDevice | null = null;

function releaseRing(log: SyncListener, why: string): boolean {
  const d = activeDevice;
  if (!d?.gatt) return true;
  if (!d.gatt.connected) { activeDevice = null; return true; }
  try {
    d.gatt.disconnect();
  } catch (e) {
    log(`release failed: ${describeErr(e)}`, "err");
    return false;
  }
  const free = !d.gatt.connected;
  log(free ? `ring released (${why})` : `release requested but still connected (${why})`,
      free ? "ok" : "warn");
  if (free) activeDevice = null;
  return free;
}

/* Backgrounding is the LAST moment code can run before a force-quit -- so it
   is the one chance to hand the ring back, even mid-sync (iOS suspends a
   hidden page regardless, so the sync cannot proceed either way). Registered
   once at module load: this must survive regardless of which component using
   this module is mounted. */
if (typeof document !== "undefined") {
  addEventListener("pagehide", () => { aborted = true; releaseRing(() => {}, "page hidden"); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") return;
    if (running) aborted = true;
    releaseRing(() => {}, "backgrounded");
  });
}

export function releaseRingNow(log: SyncListener): boolean {
  return releaseRing(log, "manual");
}

function sinceLastSync(): number {
  try {
    const t = parseInt(localStorage.getItem(LAST_KEY) || "0", 10);
    return t ? Date.now() - t : Infinity;
  } catch { return Infinity; }
}
function markSynced() {
  try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch { /* private mode */ }
}
export function lastSyncAgo(): number { return sinceLastSync(); }

export type SyncProgress = { step: string; index: number; total: number };

export async function runSync(opts: {
  auto?: boolean;
  onLog: SyncListener;
  onState: (state: string, detail?: string) => void;
  onProgress: (p: SyncProgress) => void;
}): Promise<{ capture: Capture | null; queued: number }> {
  const { onLog: log, onState, onProgress } = opts;
  if (running) return { capture: null, queued: 0 };
  running = true;
  aborted = false;

  /* A real fix, not decoration: "backgrounded mid-sync" is the single most
     common cause of a stranded ring in the bug catalogue (2026-08-25's
     31-minute-late connect, 2026-08-27's mid-sync abort). The screen dimming
     and locking IS what triggers the visibilitychange handler above that aborts
     the sync. Fixed for real PWA use in iOS 18.4 -- feature-detected, and a
     rejected request (denied, or fired from a background tab) just means the
     sync proceeds without it, same as today. */
  let wakeLock: WakeLockSentinel | null = null;
  try { wakeLock = await navigator.wakeLock?.request("screen") ?? null; }
  catch (e) { log(`wake lock unavailable: ${describeErr(e)}`, "dim"); }

  let device: BluetoothDevice | null = null;
  try {
    const plan = await getPlan(log);
    onState("Connecting…", "the ring can take 30s");
    device = await getRing(log);
    activeDevice = device;
    log(`device: ${device.name}`);

    const t0 = Date.now();
    let server: BluetoothRemoteGATTServer;
    try {
      server = await connectWithRetry(device, log, () => aborted);
    } catch (e1) {
      log(`connect via remembered device failed: ${describeErr(e1)}`, "warn");
      log("retrying through the picker — choose COLMI R02_C302", "warn");
      device = await askForRing();
      activeDevice = device;
      server = await device.gatt!.connect();
    }
    log(`connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`, "ok");

    const cache: Record<string, unknown> = {};
    const steps: Capture["steps"] = [];
    for (let i = 0; i < plan.steps.length; i++) {
      if (aborted) { log("aborted — keeping what was collected", "warn"); break; }
      const step = plan.steps[i];
      onState("Syncing…", `${step.id} (${i + 1}/${plan.steps.length})`);
      onProgress({ step: step.id, index: i + 1, total: plan.steps.length });
      let chunks: string[] = [];
      try {
        chunks = await runStep(server, step, cache);
        /* A short step with NO reply is retried once -- the ring occasionally
           misses a command while the link is still settling, and there is no
           error for this: the reply just never arrives. Only cheap steps
           qualify; retrying the 12s HR collection would double the sync. */
        if (!chunks.length && step.collect_ms <= 2500) {
          log(`${step.id}: no reply — retrying once`, "warn");
          await sleep(300);
          chunks = await runStep(server, step, cache);
        }
      } catch (e) {
        log(`${step.id}: ${describeErr(e)}`, "err");
      }
      log(`${step.id}: ${chunks.length} chunk(s)`);
      steps.push({ id: step.id, kind: step.kind, day: step.day,
                   day_offset: step.day_offset, chunks });
    }

    const capturedAt = Date.now();
    let capturedTimezone: string | undefined;
    try { capturedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
    catch { /* fixed offset below is sufficient */ }
    const captureDraft: Omit<Capture, "id"> = {
      captured_at: capturedAt,
      captured_timezone: capturedTimezone,
      captured_utc_offset_min: -new Date(capturedAt).getTimezoneOffset(),
      source: opts.auto ? "auto" : "manual", plan_version: plan.version, steps,
    };
    const capture: Capture = { id: await stableCaptureId(captureDraft), ...captureDraft };
    let persisted = false;
    try {
      await idbPut(capture);
      persisted = true;
      log("capture saved locally", "ok");
    } catch (e) {
      log(`local store failed (${describeErr(e)}) — keeping it in memory`, "warn");
    }
    if (!persisted) memoryQueue.push(capture);

    releaseRing(log, "sync complete");

    const got = steps.filter((s) => s.chunks.length).length;
    if (got) markSynced();
    const queued = await drain(log);

    onState(queued ? "Captured" : "Saved locally",
            `${got}/${steps.length} replies · ${queued ? "queued for import" : "waiting for the Mac"}`);
    return { capture, queued };
  } catch (e) {
    log(`sync failed: ${describeErr(e)}`, "err");
    onState("Failed", describeErr(e));
    return { capture: null, queued: 0 };
  } finally {
    releaseRing(log, "sync ended");
    try { await wakeLock?.release(); } catch { /* already released by the OS */ }
    running = false;
  }
}
