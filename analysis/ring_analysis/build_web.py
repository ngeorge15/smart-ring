"""
Regenerate the snapshot and rebuild the React dashboard.

The app is a Vite + React + Tailwind + shadcn/ui build; vite-plugin-singlefile
inlines every asset so the output stays ONE .html that opens from file://,
AirDrops, and works with no network.
"""
from __future__ import annotations

import json
import os
import shutil
from urllib.parse import quote
import subprocess
from pathlib import Path

from ring_analysis import snapshot

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "app"
OUT = ROOT / "web" / "dist" / "index.html"


def main() -> None:
    snap = snapshot.build()
    payload = json.dumps(snap, indent=1, default=str)
    (ROOT / "web" / "snapshot.json").write_text(payload)
    (APP / "src" / "snapshot.json").write_text(payload)   # bundled at build time

    # A LaunchAgent does not inherit a login shell's PATH, so shutil.which("npm")
    # returned None when the server triggered a rebuild even though npm is
    # installed. Check the usual locations before giving up.
    npm = shutil.which("npm")
    if npm is None:
        for cand in ("/usr/local/bin/npm", "/opt/homebrew/bin/npm",
                     "/usr/bin/npm"):
            if Path(cand).exists():
                npm = cand
                break
    if npm is None:
        raise RuntimeError("npm not found on PATH or in the usual locations")
    # npm shells out to node, so node must be on the PATH of the CHILD process --
    # finding npm itself is not enough. Under a LaunchAgent the inherited PATH is
    # minimal, which surfaced as "env: node: No such file or directory".
    env = {**os.environ, "PATH": ":".join([
        str(Path(npm).parent), "/usr/local/bin", "/opt/homebrew/bin",
        os.environ.get("PATH", "/usr/bin:/bin"),
    ])}
    r = subprocess.run([npm, "run", "build"], cwd=APP, capture_output=True,
                       text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"vite build failed:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")

    _emit_params()
    _emit_pwa_files()

    kb = OUT.stat().st_size / 1024
    print(f"built {OUT}  ({kb:.0f} KB, self-contained)")
    print(f"  readiness {snap['readiness']['score']} @ {snap['readiness']['confidence']:.0%} conf")


MANIFEST = """{
  "name": "Ring", "short_name": "Ring", "start_url": ".", "display": "standalone",
  "background_color": "#08090b", "theme_color": "#08090b", "orientation": "portrait",
  "icons": [
    {"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
    {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"}
  ]
}"""

# The page is fully self-contained, so the worker only has to cache one URL.
# Network-first keeps a stale dashboard from outliving the next sync.
SW = """
// ring-v2, NOT v1. The bump matters: a v1 cache on a phone may already hold a
// POISONED entry (see below) and activate() deletes every cache that is not the
// current one, which is the only way to clear it remotely.
const CACHE = 'ring-v2';
// PRECACHED on install so the phone works with the Mac asleep. Runtime caching
// alone was not enough: it only holds what has already been fetched, so a first
// visit while the Mac is down would fail with nothing to fall back to.
// './' is listed as well as 'index.html' because the manifest start_url is '.',
// and the Cache API is keyed by URL -- a launch requesting '/' does not match an
// entry stored under '/index.html'.
const PRECACHE = ['./', 'index.html', 'sync.html', 'ring-engine.js', 'handoff.js', 'params.json'];
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// Only a genuinely good response may REPLACE a working cached copy.
//
// This is the white-screen bug. The old worker did:
//     fetch(req).then(r => { cache.put(req, r.clone()); return r; })
// which stores WHATEVER came back -- and fetch only rejects on a transport
// failure. When the Mac is asleep, Tailscale Serve answers 502; that 502 is a
// perfectly valid Response, so it was cached ON TOP of the real index.html and
// then served forever after. The app opened blank and stayed blank, and the only
// cure was deleting and re-adding the PWA, because that is what clears storage.
const good = r => r && r.status === 200 && r.type !== 'opaque';

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // The Web Bluetooth probe is a debugging tool that changes constantly; a
  // cached copy makes it impossible to tell which build is running.
  if (e.request.url.includes('bluefy-probe')) return;
  // /ping answers "is the Mac reachable right now". A cached response makes it
  // answer "yes" while offline, which is worse than not asking at all.
  if (e.request.url.includes('/ping')) return;

  e.respondWith((async () => {
    // A navigation must never end at a browser error page: falling back to the
    // app shell is always better than a white screen.
    const shell = async () => (await caches.match('index.html'))
                           || (await caches.match('./'));
    try {
      const r = await fetch(e.request);
      if (good(r)) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      }
      // Bad status (502 with the Mac asleep, a captive-portal redirect, a
      // truncated range): keep what we have rather than overwriting it.
      return (await caches.match(e.request))
          || (e.request.mode === 'navigate' ? await shell() : null)
          || r;
    } catch {
      return (await caches.match(e.request))
          || (e.request.mode === 'navigate' ? await shell() : null)
          || Response.error();
    }
  })());
});
"""

REGISTER = ("<script>if('serviceWorker' in navigator){addEventListener('load',()=>"
            "navigator.serviceWorker.register('sw.js').catch(()=>{}))}</script>")

# The dashboard drains the queue too. Captures are written to IndexedDB by
# sync.html whenever the Mac is unreachable, and opening the dashboard is the
# most common moment the Mac IS reachable -- leaving the backlog to sit until
# someone remembers to open a second page would strand it. Plain JS rather than
# React so it runs before/independently of the bundle, and it never throws.
# The dashboard used to inline a queue-drain script here. Removed: the queue is
# in Bluefy's IndexedDB and the dashboard runs in Safari, so it read an
# always-empty store on every load. It looked correct in a desktop browser --
# where both pages share one storage jar -- and was dead on the actual phone.
# Captures reach the Mac from sync.html, which owns the queue.


ICON_DIR = ROOT / "web" / "icon"


def _emit_params() -> None:
    """The small blob the phone needs to score WITHOUT the Mac.

    Baselines reduce ~500K Apple Health records to about fifty numbers, so a
    phone can compute readiness with elementary arithmetic -- no pandas, no
    reference archive, no Mac awake. Weights ship as data as well, so the
    scoring PARAMETERS have exactly one definition and only the evaluator is
    duplicated across languages.

    Emitted at build time rather than served dynamically: it is then a static
    file the service worker can cache, which is the whole point.
    """
    from ring_analysis.baseline import MIN_N_SCORABLE, all_baselines
    from ring_analysis.energy import (BLEND, HRR_FLOOR, MET_MAX, SAMPLE_MINUTES,
                                      load_profile)
    from ring_analysis.score import RULES, WEIGHTS

    def num(x):
        # 6dp, not 2. Rounding the percentile anchors to 2dp made a value that
        # sits EXACTLY on p50 in Python land just below it in JS, so the two
        # scorers disagreed by 0.23 on HRV. The anchors are compared against raw
        # measurements, so they must keep the precision of those measurements.
        return None if x is None or x != x else round(float(x), 6)

    payload = {
        "generated_at": snapshot.datetime.now().isoformat(timespec="seconds"),
        "weights": WEIGHTS,
        # Thresholds travel as DATA so the phone's evaluator cannot drift from
        # Python's. Changing a rule here changes both engines at once.
        "rules": {**RULES, "min_baseline_n": MIN_N_SCORABLE},
        "baselines": {
            k: {"mean": num(b.mean), "sd": num(b.sd), "p10": num(b.p10),
                "p50": num(b.p50), "p90": num(b.p90), "n": b.n,
                "source": b.source, "confidence": round(b.confidence, 3),
                "note": b.note}
            for k, b in all_baselines().items()
        },
    }

    # Calorie estimation needs body mass and age, which live in config.json and
    # never reach the phone otherwise. Without this the phone can show fresh
    # STEPS beside a stale calorie figure, which is worse than showing neither:
    # the two would visibly disagree with no way to tell which is current.
    prof = load_profile()
    if prof is not None:
        payload["energy"] = {
            "weight_kg": num(prof.weight_kg), "age": prof.age,
            "rmr_kcal_day": num(prof.rmr_kcal_day), "hr_max": num(prof.hr_max),
            "hrr_floor": HRR_FLOOR, "met_max": MET_MAX,
            "sample_minutes": SAMPLE_MINUTES, "blend": BLEND,
        }
    (OUT.parent / "params.json").write_text(json.dumps(payload, indent=1))


def _emit_pwa_files() -> None:
    """Manifest + service worker, so the served copy installs and works offline.

    These only take effect over HTTPS (Tailscale serve). Opened from file:// the
    page is already fully local, so nothing is lost when they are inert.
    """
    d = OUT.parent
    (d / "manifest.json").write_text(MANIFEST)
    (d / "sw.js").write_text(SW)

    # Web Bluetooth probe. Lives in web/ and is copied in because vite empties
    # dist on every build. Served over the tailnet's HTTPS, which is what makes
    # it a secure context -- Web Bluetooth refuses to run without one.
    # handoff.js is loaded at RUNTIME by sync.html in Bluefy and is also
    # bundled into the dashboard through the @handoff alias -- one file, two
    # consumers, so the wire format cannot drift between the two apps.
    for extra in ("bluefy-probe.html", "sync.html", "ring-engine.js", "handoff.js"):
        src = ROOT / "web" / extra
        if src.exists():
            shutil.copyfile(src, d / extra)

    for name in ("icon-180.png", "icon-192.png", "icon-512.png"):
        src = ICON_DIR / name
        if src.exists():
            shutil.copyfile(src, d / name)

    # The favicon is inlined as a data URI so it survives an AirDropped single
    # file; the apple-touch-icon must be a real file, which the served copy has.
    svg = (ICON_DIR / "ring.svg").read_text()
    favicon = "data:image/svg+xml;utf8," + quote(svg, safe="")

    html = OUT.read_text()
    if "apple-touch-icon" not in html:
        head = (f'<link rel="icon" href="{favicon}">'
                '<link rel="apple-touch-icon" href="icon-180.png">'
                '<link rel="manifest" href="manifest.json">')
        html = html.replace("</head>", head + "</head>")
        html = html.replace("</body>", REGISTER + "</body>")
        OUT.write_text(html)


if __name__ == "__main__":
    main()
