"""
Serve the dashboard over the tailnet.

Tailscale gives the Mac a stable hostname reachable from your phone anywhere,
without exposing anything to the public internet. `tailscale serve` fronts this
with HTTPS, which is what lets the service worker register -- and that is what
makes the phone work offline when the Mac is asleep.

    python3 tools/serve.py           # port 8765
"""
from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import http.server
import json
import mimetypes
import os
import shutil
import socketserver
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta
from functools import partial
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

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


ROOT = Path(__file__).resolve().parents[1] / "web" / "dist"
BUILD_LOCK = ROOT.parent / ".build.lock"

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

STATUS_VERSION = 1
STALE_WORKER_AFTER = timedelta(minutes=15)
MAX_WORKER_ATTEMPTS = 3


class DecodeRejected(RuntimeError):
    """A complete decoder run rejected the capture; retry only on request."""


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _atomic_json(path: Path, obj: object) -> None:
    """Durably replace a small JSON file, including its directory entry."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = json.dumps(obj, separators=(",", ":"), default=str).encode()
    try:
        with tmp.open("wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _status_path(job_id: str) -> Path:
    return SPOOL / f"{job_id}.status.json"


def _capture_path(job_id: str) -> Path:
    return SPOOL / f"{job_id}.capture.json"


@contextmanager
def _job_lock(job_id: str):
    SPOOL.mkdir(parents=True, exist_ok=True)
    with (SPOOL / f"{job_id}.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _valid_job_id(job_id: str) -> bool:
    return len(job_id) == 24 and all(c in "0123456789abcdef" for c in job_id)


def _read_status(job_id: str) -> dict:
    if not _valid_job_id(job_id):
        raise ValueError("invalid job id")
    return json.loads(_status_path(job_id).read_text())


def _job_id(capture: dict, raw: bytes) -> str:
    capture_id = capture.get("id")
    key = f"capture:{capture_id}".encode() if isinstance(capture_id, str) and capture_id else raw
    return hashlib.sha256(key).hexdigest()[:24]


def _spool_capture(capture: dict, raw: bytes) -> tuple[dict, bool]:
    """Persist a capture before acknowledging it; return status and whether new."""
    job_id = _job_id(capture, raw)
    capture_path = _capture_path(job_id)
    status_path = _status_path(job_id)
    digest = hashlib.sha256(raw).hexdigest()
    with _job_lock(job_id):
        if status_path.exists():
            status = _read_status(job_id)
            if status.get("payload_sha256") != digest:
                raise FileExistsError("capture id was already used for different content")
            return status, False

        # Publish the payload before the queue record. A visible queue record
        # must never point at bytes that were not made durable first.
        _atomic_json(capture_path, capture)
        status = {
            "schema_version": STATUS_VERSION,
            "job_id": job_id,
            "capture_id": capture.get("id") if isinstance(capture.get("id"), str) else None,
            "state": "queued",
            "steps": len(capture.get("steps", [])) if isinstance(capture.get("steps"), list) else 0,
            "status_url": f"/ingest-status?id={job_id}",
            "retry_url": f"/ingest-retry?id={job_id}",
            "payload_sha256": digest,
            "accepted_at": _now(),
            "updated_at": _now(),
            "attempts": 0,
            "worker": {"state": "pending"},
        }
        _atomic_json(status_path, status)
        return status, True


def _worker_command(job_id: str) -> list[str]:
    base = [str(VENV_PY), str(Path(__file__).resolve()), "--ingest-worker", job_id]
    if Path("/usr/bin/arch").exists():
        return ["/usr/bin/arch", "-arm64", *base]
    return base


def _start_worker(job_id: str) -> bool:
    """Start one queued job. Its durable state explains every launch failure."""
    with _job_lock(job_id):
        status = _read_status(job_id)
        if status.get("state") != "queued":
            return False
        if not VENV_PY.exists():
            status.update(updated_at=_now(), worker={
                "state": "unavailable", "detail": f"interpreter not found: {VENV_PY}"})
            _atomic_json(_status_path(job_id), status)
            return False
        # Claim the job before spawning so a duplicate POST or retry scan cannot
        # launch a second decoder in the parent/child scheduling gap.
        status.update(state="running", updated_at=_now(),
                      worker={"state": "launching"})
        _atomic_json(_status_path(job_id), status)
        try:
            subprocess.Popen(
                _worker_command(job_id), stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True)
        except Exception as exc:
            status.update(state="queued", updated_at=_now(), worker={
                "state": "launch_failed", "detail": f"{type(exc).__name__}: {exc}"})
            _atomic_json(_status_path(job_id), status)
            return False
        return True


def _retry_job(job_id: str, *, explicit: bool = False) -> bool:
    """Recover an abandoned/transient job, or explicitly retry a rejected one."""
    cutoff = datetime.now().astimezone() - STALE_WORKER_AFTER
    with _job_lock(job_id):
        status = _read_status(job_id)
        state = status.get("state")
        attempts = int(status.get("attempts", 0))
        retry = state == "queued"
        if state == "running":
            updated = datetime.fromisoformat(status["updated_at"])
            retry = updated < cutoff
        elif state == "failed":
            retry = explicit or bool(status.get("retryable"))
        if not retry or attempts >= MAX_WORKER_ATTEMPTS:
            return False
        if state != "queued":
            status.update(state="queued", updated_at=_now(), worker={
                "state": "retry_queued", "previous_state": state})
            _atomic_json(_status_path(job_id), status)
    return _start_worker(job_id)


def _retry_pending() -> int:
    """Restart durable queued and safely retryable jobs after a server restart."""
    if not SPOOL.exists():
        return 0
    started = 0
    for path in sorted(SPOOL.glob("*.status.json")):
        try:
            status = json.loads(path.read_text())
            if _retry_job(status["job_id"]):
                started += 1
        except Exception as exc:
            print(f"ingest retry skipped {path.name}: {exc!r}", file=sys.stderr)
    return started


def _run_ingest_worker(job_id: str) -> int:
    """Decode one queued job and record committed ingest/rebuild outcomes."""
    status = _read_status(job_id)
    status.update(state="running", updated_at=_now(),
                  attempts=int(status.get("attempts", 0)) + 1,
                  worker={"state": "running", "pid": os.getpid()})
    _atomic_json(_status_path(job_id), status)
    try:
        import ingest

        capture = json.loads(_capture_path(job_id).read_text())
        result = ingest.ingest(capture)
        acknowledged = bool(result.get("acknowledged", not result.get("errors")))
        if not acknowledged:
            status["result"] = result
            raise DecodeRejected(
                "capture decoded with errors: " + "; ".join(result.get("errors", [])))
        status.update(state="completed", completed_at=_now(), updated_at=_now(),
                      result=result, worker={"state": "completed", "pid": os.getpid()})
        _atomic_json(_status_path(job_id), status)
        try:
            rebuilt = ingest.rebuild()
            status["rebuild"] = ({"state": "completed"} if rebuilt.returncode == 0 else {
                "state": "failed", "exit_code": rebuilt.returncode,
                "detail": (rebuilt.stderr or rebuilt.stdout)[-500:]})
        except Exception as exc:
            status["rebuild"] = {
                "state": "failed", "detail": f"{type(exc).__name__}: {exc}"}
        _atomic_json(_status_path(job_id), status)
        return 0
    except Exception as exc:
        status.update(state="failed", failed_at=_now(), updated_at=_now(),
                      worker={"state": "failed", "pid": os.getpid()},
                      retryable=not isinstance(exc, DecodeRejected),
                      error=f"{type(exc).__name__}: {exc}")
        _atomic_json(_status_path(job_id), status)
        return 1


@contextmanager
def _published_build():
    """Prevent a filesystem build swap while a response opens static files."""
    BUILD_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with BUILD_LOCK.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        """Apply SimpleHTTPRequestHandler mapping, then contain symlinks too."""
        translated = Path(super().translate_path(path)).resolve()
        root = Path(self.directory or os.getcwd()).resolve()
        if not translated.is_relative_to(root):
            return str(root / ".outside-root")
        return str(translated)

    def end_headers(self):
        route = self.path.split("?")[0]
        if route in OFFLINE_ASSETS:
            self.send_header("Cache-Control", OFFLINE_CACHE)
        else:
            # The dashboard is rebuilt every sync; never let a stale copy stick.
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_HEAD(self):  # noqa: N802
        parsed = urlsplit(self.path)
        route = unquote(parsed.path).rstrip("/")
        with _published_build():
            if self._maybe_gzip(route):
                return
            super().do_HEAD()

    def do_GET(self):  # noqa: N802
        """Dynamic routes first; everything else is a static file."""
        parsed = urlsplit(self.path)
        route = unquote(parsed.path).rstrip("/")
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
                with _published_build():
                    # The published snapshot and page move together as one build.
                    snap = ROOT / "snapshot.json"
                    page = ROOT / "index.html"
                    built = json.loads(snap.read_text())["meta"]["generated_at"]
                    page.stat()
            except Exception as e:
                # Never let this break reachability -- but do not swallow it
                # silently either; a bare `pass` here already hid one wrong path.
                print(f"/ping: build time unavailable: {e!r}", file=sys.stderr)
            self._json({"now": datetime.now().isoformat(timespec="seconds"),
                        "built": built})
            return
        if route == "/sync-plan":
            try:
                import sync_plan
                full = parse_qs(parsed.query).get("full", []) == ["1"]
                self._json(sync_plan.build(full=full))
            except Exception as exc:
                self._json_error(500, f"{type(exc).__name__}: {exc}")
            return
        if route == "/ingest-status":
            values = parse_qs(parsed.query).get("id", [])
            if len(values) != 1 or not _valid_job_id(values[0]):
                self._json_error(400, "invalid job id")
                return
            try:
                _retry_job(values[0])
                status = _read_status(values[0])
            except FileNotFoundError:
                self._json_error(404, "job not found")
                return
            except Exception as exc:
                self._json_error(500, f"{type(exc).__name__}: {exc}")
                return
            self._json(status)
            return
        with _published_build():
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
        if "\\" in rel or "\x00" in rel:
            return False
        if not rel.endswith((".html", ".js", ".json", ".css", ".svg")):
            return False
        root = ROOT.resolve()
        path = (root / rel).resolve()
        if not path.is_relative_to(root):
            return False
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

    def _json(self, obj, *, status: int = 200) -> None:
        body = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, status: int, message: str, **extra) -> None:
        payload = {"ok": False, "error": message}
        payload.update(extra)
        self._json(payload, status=status)

    def _accepted_job(self, status: dict) -> dict:
        return {
            "schema_version": STATUS_VERSION,
            "accepted": True,
            "state": status["state"],
            "job_id": status["job_id"],
            "capture_id": status.get("capture_id"),
            "steps": status["steps"],
            "status_url": status["status_url"],
            "retry_url": status["retry_url"],
            "worker": status.get("worker"),
        }

    def do_POST(self):  # noqa: N802  (base class naming)
        parsed = urlsplit(self.path)
        route = parsed.path.rstrip("/")
        if route == "/ingest":
            self._ingest()
            return
        if route == "/ingest-retry":
            values = parse_qs(parsed.query).get("id", [])
            if len(values) != 1 or not _valid_job_id(values[0]):
                self._json_error(400, "invalid job id")
                return
            try:
                started = _retry_job(values[0], explicit=True)
                status = _read_status(values[0])
            except FileNotFoundError:
                self._json_error(404, "job not found")
                return
            except Exception as exc:
                self._json_error(500, f"{type(exc).__name__}: {exc}")
                return
            if not started:
                worker_state = (status.get("worker") or {}).get("state")
                attempts = int(status.get("attempts", 0))
                if (status.get("state") == "queued" and
                        worker_state in {"unavailable", "launch_failed"} and
                        attempts < MAX_WORKER_ATTEMPTS):
                    self._json(self._accepted_job(status), status=202)
                    return
                self._json_error(409, "job is not retryable", state=status.get("state"))
                return
            self._json(self._accepted_job(status), status=202)
            return
        if route == "/rebuild":
            # Regenerate the dashboard from whatever is already in the database.
            # Lets the app pull in data that arrived after it was last built,
            # without waiting for the next sync to trigger a rebuild.
            try:
                r = subprocess.run([_python_with_pandas(), "-m", "ring_analysis.build_web"],
                                   cwd=str(TOOLS.parent / "analysis"),
                                   capture_output=True, text=True, timeout=300)
            except subprocess.TimeoutExpired:
                self._json({"ok": False, "detail": "build timed out"}, status=504)
                return
            except Exception as exc:
                self._json({"ok": False, "detail": f"{type(exc).__name__}: {exc}"}, status=500)
                return
            ok = r.returncode == 0
            self._json({"ok": ok,
                        "detail": (r.stderr or r.stdout)[-300:] if not ok else ""},
                       status=200 if ok else 500)
            return
        """Accept a probe log from the phone. Tailnet-only; nothing is executed."""
        if route != "/probe-log":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._json_error(400, "bad length")
            return
        if n <= 0 or n > MAX_UPLOAD:
            self._json_error(413, "empty or too large")
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
            self._json_error(400, "bad length")
            return
        if n <= 0 or n > MAX_UPLOAD:
            self._json_error(413, "empty or too large")
            return

        raw = self.rfile.read(n)
        try:
            capture = json.loads(raw)
        except ValueError:
            self._json_error(400, "not json")
            return

        if not isinstance(capture, dict):
            self._json_error(400, "capture must be an object")
            return
        try:
            status, created = _spool_capture(capture, raw)
        except FileExistsError as exc:
            self._json_error(409, str(exc))
            return
        except Exception as exc:
            self._json_error(500, f"{type(exc).__name__}: {exc}")
            return
        if created or status.get("state") == "queued":
            _start_worker(status["job_id"])
            status = _read_status(status["job_id"])
        self._json(self._accepted_job(status), status=202)

    def log_message(self, *_args):
        pass  # quiet


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Serve the ring dashboard")
    parser.add_argument("--bind", default=os.environ.get("RING_SERVER_BIND", "127.0.0.1"))
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("RING_SERVER_PORT", "8765")))
    parser.add_argument("--ingest-worker", metavar="JOB_ID", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.ingest_worker:
        raise SystemExit(_run_ingest_worker(args.ingest_worker))
    if not ROOT.exists():
        raise SystemExit(f"No build at {ROOT}. Run build_web.py first.")
    socketserver.TCPServer.allow_reuse_address = True
    retried = _retry_pending()
    if retried:
        print(f"restarted {retried} queued ingest worker(s)")
    socketserver.ThreadingTCPServer.daemon_threads = True
    with socketserver.ThreadingTCPServer((args.bind, args.port),
                                         partial(Handler, directory=str(ROOT))) as httpd:
        print(f"serving {ROOT} on http://{args.bind}:{args.port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
