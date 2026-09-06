"""Run isolated regressions using installed interpreters; never install packages."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def interpreter(env_name: str, imports: str) -> str:
    explicit = os.environ.get(env_name)
    candidates = [explicit] if explicit else [
        str(ROOT / ".venv/bin/python"), sys.executable,
        "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
        "/opt/homebrew/bin/python3", "/usr/local/bin/python3",
        str(Path.home() / "Library/Application Support/pipx/venvs/colmi-r02-client/bin/python"),
    ]
    for candidate in dict.fromkeys(candidates):
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            result = subprocess.run([candidate, "-c", imports], capture_output=True, timeout=20)
            if result.returncode == 0:
                return candidate
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise SystemExit(f"No interpreter passed `{imports}`. Set {env_name} to an interpreter "
                     "with the dependencies documented in docs/TESTING.md.")


def main():
    analysis_py = interpreter("RING_ANALYSIS_PYTHON", "import numpy, pandas")
    protocol_py = interpreter("RING_PROTOCOL_PYTHON", "import colmi_r02_client.hr, colmi_r02_client.steps")
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required; see docs/TESTING.md")
    print(f"Analysis Python: {analysis_py}\nProtocol Python: {protocol_py}", flush=True)
    with tempfile.TemporaryDirectory(prefix="ring-verify-") as fixture_dir:
        env = {**os.environ, "RING_VERIFY_DIR": fixture_dir, "TZ": "UTC"}
        for executable, part in ((analysis_py, "analysis"), (protocol_py, "protocol")):
            subprocess.run([executable, "tools/prepare_verify.py", part, fixture_dir],
                           cwd=ROOT, env=env, check=True)
        subprocess.run([node, "tools/verify_engine.mjs"], cwd=ROOT, env=env, check=True)
        subprocess.run([node, "--test", "tools/test_http.mjs"], cwd=ROOT, env=env, check=True)
        # Keep these in separate processes: the lightweight server suite stubs
        # snapshot imports, while the data suite deliberately exercises the
        # real pandas-backed acknowledgement query.
        for pattern in ("test_data_integrity_audit.py",
                        "test_server_build_reliability_audit.py"):
            subprocess.run([analysis_py, "-m", "unittest", "discover",
                            "-v", "-s", "tests", "-p", pattern],
                           cwd=ROOT, env=env, check=True)


if __name__ == "__main__":
    main()
