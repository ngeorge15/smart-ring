# Running checks

Run `bash tools/verify.sh` from a checkout. It selects installed Python interpreters
by checking imports, creates synthetic scoring data and protocol packets in a
fresh temporary directory, compares the Python and JavaScript engines, and removes
the temporary directory when done. It also runs the isolated ingestion transaction,
capture acknowledgement, static containment, durable queue, atomic publication,
and rebuild response regressions. It does not read your biometric database or
require a generated dashboard, Bluetooth hardware, or a running server.

Requirements:

- Node.js 22.18+ (native TypeScript stripping for the small HTTP helper test).
- Python 3.12+ with NumPy and pandas for analysis.
- Python with `colmi-r02-client` for the independent protocol parser comparison.
  This can be the same interpreter as the analysis interpreter.

To use a dedicated environment, install `requirements-test.txt` into a virtual
environment and point both `RING_ANALYSIS_PYTHON` and `RING_PROTOCOL_PYTHON` at its
Python executable. The runner does not install anything itself. Existing macOS
system, Homebrew, and pipx interpreter locations are checked when overrides are
not set. An explicit override is honored or fails with an explanation.

For the frontend, run `npm ci` in `app` to restore the lockfile dependencies, then
`npm run build` and `npm run lint`. Preview and Bluetooth checks are separate:
desktop browser tests do not establish iOS Bluetooth or background/offline support.

Regression fixtures under `tools/fixtures` are repository fixtures. No generated
fixture or output from a personal database should be added to version control.
