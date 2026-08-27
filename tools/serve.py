"""
Serve the dashboard over the tailnet.

Tailscale gives the Mac a stable hostname reachable from your phone anywhere,
without exposing anything to the public internet. `tailscale serve` fronts this
with HTTPS, which is what lets the service worker register -- and that is what
makes the phone work offline when the Mac is asleep.

    python3 tools/serve.py           # port 8765
"""
from __future__ import annotations

import gzip
import http.server
import json
import shutil
import mimetypes
import socketserver
import subprocess
import sys
from datetime import datetime
from functools import partial
from pathlib import Path

def _python_with_pandas() -> str:
    """Find an interpreter that can actually run the analysis stack.

    shutil.which("python3") resolves against the caller's PATH, and a LaunchAgent
    does not inherit a login shell's -- so the server picked a python without
    pandas and every rebuild failed with ModuleNotFoundError. Candidates are
    TESTED rather than assumed.
    """
    seen = []
    for cand in (shutil.which("python3"),
                 "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
                 "/opt/homebrew/bin/python3", "/usr/local/bin/python3",
                 "/usr/bin/python3"):
        if not cand or cand in seen:
            continue
        seen.append(cand)
        try:
            r = subprocess.run([cand, "-c", "import pandas"],
                               capture_output=True, timeout=30)
            if r.returncode == 0:
                return cand
        except Exception:
            continue
    return seen[0] if seen else "/usr/bin/python3"


PORT = 8765
ROOT = Path(__file__).resolve().parents[1] / "web" / "dist"

# The phone cannot hand a log back by any other route -- reading it off a screen
# by hand loses lines, which is how the first Web Bluetooth session got lost.
PROBE_LOG = Path(__file__).resolve().parents[1] / "data" / "probe-log.txt"
MAX_UPLOAD = 512 * 1024

TOOLS = Path(__file__).resolve().parent
SPOOL = TOOLS.parent / "data" / "ingest"
VENV_PY = Path.home() / ("Library/Application Support/pipx/venvs/"
                         "colmi-r02-client/bin/python")
# The analysis stack needs pandas, which lives on the system interpreter.
PYTHON3 = None  # resolved lazily by _python_with_pandas()
sys.path.insert(0, str(TOOLS))


# Assets that MUST survive the Mac being unreachable.
#
# sync.html runs in Bluefy, where service workers do not register (sw:NO in the
# phone's own logs), so the HTTP cache is the ONLY offline mechanism it has.
# Served `no-cache` -- as everything was -- Bluefy revalidates against the Mac on
# every load, and off the tailnet that revalidation fails and the page will not
# open at all. A ring sync then becomes impossible precisely when the laptop is
# shut, which is the case the whole phone-first design exists for.
#
# Staleness is cheap here BY DESIGN: sync.html is a dumb pipe that fetches the
# command plan from /sync-plan at runtime (falling back to its localStorage
# copy), so protocol changes are Python edits that a cached page still picks up.
# The page itself changes rarely.
#
# index.html is deliberately NOT in this list: the dashboard has a real service
# worker doing network-first, and HTTP-caching it too would fight the
# newer-build detection in App.tsx.
OFFLINE_ASSETS = {
    "/sync.html", "/ring-engine.js", "/handoff.js", "/params.json",
    "/manifest.json", "/icon-180.png", "/icon-192.png", "/icon-512.png",
    "/favicon.svg", "/icons.svg",
}
# 24h is served straight from cache with no network at all -- that is the
# guarantee, and max-age is universally supported. The stale-* extensions add a
# best-effort week on top where the browser implements them.
OFFLINE_CACHE = "public, max-age=86400, stale-while-revalidate=604800, stale-if-error=604800"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        route = self.path.split("?")[0]
        if route in OFFLINE_ASSETS:
            self.send_header("Cache-Control", OFFLINE_CACHE)
        else:
            # The dashboard is rebuilt every sync; never let a stale copy stick.
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_GET(self):  # noqa: N802
        """Dynamic routes first; everything else is a static file."""
        route = self.path.split("?")[0].rstrip("/")
        if route == "/ping":
            # Deliberately tiny and uncached: the dashboard calls this to answer
            # "can I reach the Mac RIGHT NOW", which a value baked into the
            # snapshot can never do -- that only records what was true when the
            # snapshot was built.
            # `built` rides along so the dashboard can notice the Mac has a
            # NEWER snapshot than the one it is running and reload itself. The
            # page bakes its snapshot in at build time, so an app left open --
            # or reopened from the home screen -- otherwise shows yesterday's
            # numbers indefinitely with no hint that better ones exist. Free:
            # this endpoint was already being polled for reachability.
            built = None
            try:
                # ROOT is web/dist (the served directory), so the snapshot
                # source sits one level UP, not under it.
                snap = ROOT.parent / "snapshot.json"
                page = ROOT / "index.html"
                built = json.loads(snap.read_text())["meta"]["generated_at"]
                # Report the build the PAGE actually carries, not the one on
                # disk. build_web writes snapshot.json before running vite, so a
                # failed vite build leaves the snapshot NEWER than the page that
                # bakes it in -- and the dashboard, told a newer build exists,
                # reloads into the same old page and does it again, forever.
                # Seen for real on 2026-08-25 after a TSX syntax error.
                if page.stat().st_mtime < snap.stat().st_mtime:
                    print("/ping: dist/index.html is older than snapshot.json -- "
                          "the last build did not finish; reporting no build",
                          file=sys.stderr)
                    built = None
            except Exception as e:
                # Never let this break reachability -- but do not swallow it
                # silently either; a bare `pass` here already hid one wrong path.
                print(f"/ping: build time unavailable: {e!r}", file=sys.stderr)
            self._json({"now": datetime.now().isoformat(timespec="seconds"),
                        "built": built})
            return
        if route == "/sync-plan":
            import sync_plan
            self._json(sync_plan.build(full="full=1" in self.path))
            return
        if self._maybe_gzip(route):
            return
        super().do_GET()

    def _maybe_gzip(self, route: str) -> bool:
        """Serve text assets gzipped.

        The dashboard is a single self-contained file -- every asset is inlined,
        so it is ~816KB and compresses to ~275KB. SimpleHTTPRequestHandler does
        no compression, and combined with the no-cache header that meant the
        phone re-downloaded the full 816KB on every open, over a VPN. Returns
        True when it has handled the response.
        """
        if "gzip" not in self.headers.get("Accept-Encoding", ""):
            return False
        rel = route.lstrip("/") or "index.html"
        if not rel.endswith((".html", ".js", ".json", ".css", ".svg")):
            return False
        path = ROOT / rel
        if not path.is_file():
            return False
        try:
            raw = path.read_bytes()
        except OSError:
            return False

        body = gzip.compress(raw, 6)
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return True

    def _json(self, obj) -> None:
        body = json.dumps(obj, default=str).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802  (base class naming)
        route = self.path.rstrip("/")
        if route == "/ingest":
            self._ingest()
            return
        if route == "/rebuild":
            # Regenerate the dashboard from whatever is already in the database.
            # Lets the app pull in data that arrived after it was last built,
            # without waiting for the next sync to trigger a rebuild.
            r = subprocess.run([_python_with_pandas(), "-m", "ring_analysis.build_web"],
                               cwd=str(TOOLS.parent / "analysis"),
                               capture_output=True, text=True, timeout=300)
            self._json({"ok": r.returncode == 0,
                        "detail": (r.stderr or r.stdout)[-300:] if r.returncode else ""})
            return
        """Accept a probe log from the phone. Tailnet-only; nothing is executed."""
        if route != "/probe-log":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.send_error(400, "bad length")
            return
        if n <= 0 or n > MAX_UPLOAD:
            self.send_error(413, "empty or too large")
            return

        body = self.rfile.read(n).decode("utf-8", "replace")
        PROBE_LOG.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().isoformat(timespec="seconds")
        with PROBE_LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"\n===== {stamp} =====\n{body}\n")

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _ingest(self) -> None:
        """Spool a phone capture and decode it out-of-process.

        Decoding needs the pipx venv (colmi_r02_client, pandas), which this
        server does not run under -- and a slow decode must not hold the phone's
        request open, because the ring link is still up while it waits. So the
        bytes are written to disk and handed to a detached worker.
        """
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.send_error(400, "bad length")
            return
        if n <= 0 or n > MAX_UPLOAD:
            self.send_error(413, "empty or too large")
            return

        raw = self.rfile.read(n)
        try:
            capture = json.loads(raw)
        except ValueError:
            self.send_error(400, "not json")
            return

        SPOOL.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S_%f")
        path = SPOOL / f"{stamp}.json"
        path.write_text(json.dumps(capture))

        started = False
        if VENV_PY.exists():
            subprocess.Popen(
                ["/usr/bin/arch", "-arm64", str(VENV_PY), str(TOOLS / "ingest.py"), str(path)],
                stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                start_new_session=True)
            started = True

        self._json({"spooled": path.name, "steps": len(capture.get("steps", [])),
                    "decoding": started})

    def log_message(self, *_args):
        pass  # quiet


def main() -> None:
    if not ROOT.exists():
        raise SystemExit(f"No build at {ROOT}. Run build_web.py first.")
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), partial(Handler, directory=str(ROOT))) as httpd:
        print(f"serving {ROOT} on http://0.0.0.0:{PORT}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
