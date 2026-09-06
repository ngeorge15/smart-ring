from __future__ import annotations

import io
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from types import ModuleType
from unittest import mock


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(REPO / "analysis"))

import serve

# Publication helpers have no pandas dependency. Stub the snapshot module so
# this focused reliability suite also runs under the lightweight server Python.
snapshot_stub = ModuleType("ring_analysis.snapshot")
snapshot_stub.OUT = REPO / "web" / "snapshot.json"
sys.modules.setdefault("ring_analysis.snapshot", snapshot_stub)
build_web = importlib.import_module("ring_analysis.build_web")


class GzipContainmentTests(unittest.TestCase):
    def _handler(self):
        handler = object.__new__(serve.Handler)
        handler.headers = {"Accept-Encoding": "gzip"}
        handler.command = "GET"
        handler.wfile = io.BytesIO()
        return handler

    def test_gzip_rejects_parent_traversal_and_outside_symlink(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "dist"
            root.mkdir()
            secret = base / "secret.json"
            secret.write_text('{"secret":true}')
            (root / "escape.json").symlink_to(secret)
            handler = self._handler()

            with mock.patch.object(serve, "ROOT", root):
                self.assertFalse(handler._maybe_gzip("/../secret.json"))
                self.assertFalse(handler._maybe_gzip("/escape.json"))

    def test_static_translate_path_contains_symlink_escape(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "dist"
            root.mkdir()
            secret = base / "secret.html"
            secret.write_text("secret")
            (root / "escape.html").symlink_to(secret)

            handler = object.__new__(serve.Handler)
            handler.directory = str(root)

            translated = Path(handler.translate_path("/escape.html"))
            self.assertEqual(translated, (root / ".outside-root").resolve())


class DurableQueueTests(unittest.TestCase):
    def test_spool_is_durable_idempotent_and_detects_id_reuse(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(
                serve, "SPOOL", Path(td)):
            capture = {"id": "capture-17", "steps": [{"kind": "hr"}]}
            raw = json.dumps(capture).encode()

            status, created = serve._spool_capture(capture, raw)
            again, created_again = serve._spool_capture(capture, raw)

            self.assertTrue(created)
            self.assertFalse(created_again)
            self.assertEqual(status["state"], "queued")
            self.assertEqual(again["job_id"], status["job_id"])
            self.assertEqual(
                json.loads(serve._capture_path(status["job_id"]).read_text()), capture)
            self.assertTrue(serve._status_path(status["job_id"]).is_file())

            changed = {**capture, "steps": []}
            with self.assertRaises(FileExistsError):
                serve._spool_capture(changed, json.dumps(changed).encode())

    def test_worker_claims_queue_before_process_is_spawned(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(
                serve, "SPOOL", Path(td)), mock.patch.object(
                serve, "VENV_PY", Path(sys.executable)):
            capture = {"id": "capture-18", "steps": []}
            status, _ = serve._spool_capture(capture, json.dumps(capture).encode())

            with mock.patch.object(serve.subprocess, "Popen",
                                   return_value=SimpleNamespace(pid=1234)):
                self.assertTrue(serve._start_worker(status["job_id"]))

            claimed = serve._read_status(status["job_id"])
            self.assertEqual(claimed["state"], "running")
            self.assertEqual(claimed["worker"]["state"], "launching")


class RebuildResponseTests(unittest.TestCase):
    def _call_rebuild(self, side_effect=None, returncode=0):
        handler = object.__new__(serve.Handler)
        handler.path = "/rebuild"
        handler._json = mock.Mock()
        completed = subprocess.CompletedProcess([], returncode, "output", "failure")
        with mock.patch.object(serve, "_python_with_pandas", return_value=sys.executable), \
             mock.patch.object(serve.subprocess, "run", return_value=completed,
                               side_effect=side_effect):
            serve.Handler.do_POST(handler)
        return handler._json

    def test_failed_build_is_http_500(self):
        response = self._call_rebuild(returncode=2)
        self.assertEqual(response.call_args.kwargs["status"], 500)
        self.assertFalse(response.call_args.args[0]["ok"])

    def test_timed_out_build_is_http_504(self):
        response = self._call_rebuild(
            side_effect=subprocess.TimeoutExpired(["python"], 300))
        self.assertEqual(response.call_args.kwargs["status"], 504)


class IngestApiContractTests(unittest.TestCase):
    def _ingest(self, body: bytes, spool: Path):
        handler = object.__new__(serve.Handler)
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler._json = mock.Mock()
        with mock.patch.object(serve, "SPOOL", spool), \
             mock.patch.object(serve, "_start_worker", return_value=False):
            serve.Handler._ingest(handler)
        return handler._json

    def _retry(self, job_id: str, spool: Path, *, venv: Path = Path(sys.executable),
               popen_side_effect=None):
        handler = object.__new__(serve.Handler)
        handler.path = f"/ingest-retry?id={job_id}"
        handler._json = mock.Mock()
        patches = [
            mock.patch.object(serve, "SPOOL", spool),
            mock.patch.object(serve, "VENV_PY", venv),
            mock.patch.object(serve.subprocess, "Popen",
                              return_value=SimpleNamespace(pid=1234),
                              side_effect=popen_side_effect),
        ]
        with patches[0], patches[1], patches[2]:
            serve.Handler.do_POST(handler)
        return handler._json

    def test_ingest_accepts_only_after_durable_queue_record(self):
        with tempfile.TemporaryDirectory() as td:
            capture = {"id": "capture-19", "steps": []}
            response = self._ingest(json.dumps(capture).encode(), Path(td))
            payload = response.call_args.args[0]

            self.assertEqual(response.call_args.kwargs["status"], 202)
            self.assertTrue(payload["accepted"])
            self.assertEqual(payload["capture_id"], capture["id"])
            self.assertEqual(payload["state"], "queued")
            self.assertRegex(payload["job_id"], r"^[0-9a-f]{24}$")
            self.assertEqual(payload["status_url"], f"/ingest-status?id={payload['job_id']}")
            self.assertEqual(payload["retry_url"], f"/ingest-retry?id={payload['job_id']}")
            self.assertTrue((Path(td) / f"{payload['job_id']}.status.json").is_file())
            self.assertTrue((Path(td) / f"{payload['job_id']}.capture.json").is_file())

    def test_bad_ingest_body_is_json_400(self):
        with tempfile.TemporaryDirectory() as td:
            response = self._ingest(b"not json", Path(td))
            self.assertEqual(response.call_args.kwargs["status"], 400)
            self.assertFalse(response.call_args.args[0]["ok"])

    def test_retry_launch_blocked_queue_returns_accepted_contract(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(serve, "SPOOL", Path(td)):
            capture = {"id": "capture-20", "steps": []}
            status, _ = serve._spool_capture(capture, json.dumps(capture).encode())

            response = self._retry(
                status["job_id"], Path(td), venv=Path(td) / "missing-python")
            payload = response.call_args.args[0]

            self.assertEqual(response.call_args.kwargs["status"], 202)
            self.assertTrue(payload["accepted"])
            self.assertEqual(payload["state"], "queued")
            self.assertEqual(payload["capture_id"], capture["id"])
            self.assertEqual(payload["retry_url"], f"/ingest-retry?id={payload['job_id']}")
            self.assertEqual(payload["worker"]["state"], "unavailable")

    def test_retry_launch_failed_queue_returns_accepted_contract(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(serve, "SPOOL", Path(td)):
            capture = {"id": "capture-21", "steps": []}
            status, _ = serve._spool_capture(capture, json.dumps(capture).encode())

            response = self._retry(
                status["job_id"], Path(td), popen_side_effect=OSError("boom"))
            payload = response.call_args.args[0]

            self.assertEqual(response.call_args.kwargs["status"], 202)
            self.assertTrue(payload["accepted"])
            self.assertEqual(payload["state"], "queued")
            self.assertEqual(payload["worker"]["state"], "launch_failed")

    def test_retry_completed_job_remains_conflict(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(serve, "SPOOL", Path(td)):
            capture = {"id": "capture-22", "steps": []}
            status, _ = serve._spool_capture(capture, json.dumps(capture).encode())
            status.update(state="completed", updated_at=serve._now())
            serve._atomic_json(serve._status_path(status["job_id"]), status)

            response = self._retry(status["job_id"], Path(td))

            self.assertEqual(response.call_args.kwargs["status"], 409)
            self.assertFalse(response.call_args.args[0]["ok"])
            self.assertEqual(response.call_args.args[0]["state"], "completed")


class AtomicBuildPublicationTests(unittest.TestCase):
    def test_complete_staged_tree_replaces_live_tree(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            live, staged = base / "dist", base / "stage"
            live.mkdir()
            staged.mkdir()
            (live / "index.html").write_text("old")
            (staged / "index.html").write_text("new")
            (staged / "snapshot.json").write_text("new-snapshot")

            build_web._publish_build(staged, live)

            self.assertEqual((live / "index.html").read_text(), "new")
            self.assertEqual((live / "snapshot.json").read_text(), "new-snapshot")
            self.assertFalse(staged.exists())

    def test_failed_stage_swap_restores_live_tree(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            live, staged = base / "dist", base / "stage"
            live.mkdir()
            staged.mkdir()
            (live / "index.html").write_text("old")
            (staged / "index.html").write_text("new")
            real_replace = os.replace

            def fail_stage(source, destination):
                if Path(source) == staged:
                    raise OSError("simulated publication failure")
                return real_replace(source, destination)

            with mock.patch.object(build_web.os, "replace", side_effect=fail_stage):
                with self.assertRaises(OSError):
                    build_web._publish_build(staged, live)

            self.assertEqual((live / "index.html").read_text(), "old")


class ServiceWorkerContractTests(unittest.TestCase):
    def test_status_endpoints_are_never_cached(self):
        self.assertIn("path === '/ingest-status'", build_web.SW)
        self.assertIn("path === '/sync-plan'", build_web.SW)


if __name__ == "__main__":
    unittest.main()
