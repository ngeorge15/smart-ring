#!/bin/zsh
# Periodic ring sync. Exits quietly when the ring is out of range -- that is the
# normal case, not an error, so it must never spam or block.
#
# macOS has no coreutils `timeout`, so the watchdog is a backgrounded sleep+kill.
ROOT="/Users/nikhi/smart-ring"
LOG="$ROOT/data/autosync.log"
OUT="$ROOT/data/.autosync.$$.out"
PY="$HOME/Library/Application Support/pipx/venvs/colmi-r02-client/bin/python"
# The python.org interpreters are UNIVERSAL (x86_64 + arm64) but the installed
# numpy/pandas wheels are arm64-only. Launched from Terminal the process runs
# arm64 and all is well; launched via LaunchServices macOS may pick the x86_64
# slice, and an arm64 .so cannot load into a Rosetta process -- surfacing as
# "ImportError: Unable to import required dependency numpy". Pin the slice.
ARCH="/usr/bin/arch -arm64"

# launchd runs with a minimal PATH; the vite build needs node/npm.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

exec >> "$LOG" 2>&1

# Single-instance lock. `open -a` can re-trigger while a run is still going, and
# two runs racing on the same temp file was corrupting output.
LOCK="$ROOT/data/.autosync.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
    echo "--- $(date '+%Y-%m-%d %H:%M:%S') --- skipped, run already in progress"
    exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

echo "--- $(date '+%Y-%m-%d %H:%M:%S') ---"
cd "$ROOT/tools" || exit 1

# Do not fight the phone for the ring.
#
# The ring accepts ONE connection. When the phone is holding it, every Mac
# attempt is a doomed 60s CoreBluetooth timeout -- and a connect request that
# lands mid-phone-sync is one of the ways the ring ends up stranded, which costs
# a Bluetooth toggle to clear. The phone is now the primary capture path (37
# phone syncs against 25 from the Mac), so the Mac defers to it and simply
# rebuilds from what the phone already uploaded.
# Gate on DATA FRESHNESS, not on when the phone last synced.
#
# The first version skipped only if a phone sync had happened in the last 45
# minutes. But the phone syncs on foreground, so gaps longer than that are
# completely normal while everything is working -- and the Mac would then grab
# a ring that needed no help. Because macOS has no bond with the ring, that
# raises a PAIRING PROMPT and ends in a dropped link, which is one of the ways
# the ring gets stranded and has to be forgotten in iOS.
#
# The only reason for the Mac to touch the radio is that nothing else has kept
# the data current. So: measure the data.
STALE_H=6
NEWEST=$(/usr/bin/sqlite3 "$ROOT/data/ring_data.sqlite" \
    "SELECT CAST((julianday('now','localtime') - julianday(MAX(timestamp))) * 24 \
     AS INT) FROM heart_rates;" 2>/dev/null || echo 999)
if [ -n "$NEWEST" ] && [ "$NEWEST" -lt "$STALE_H" ] 2>/dev/null; then
    echo "newest reading is ${NEWEST}h old (< ${STALE_H}h) -- phone is keeping up, "\
         "skipping BLE and rebuilding only"
    SKIP_BLE=1
fi

if [ -z "$SKIP_BLE" ]; then
    ${=ARCH} "$PY" sync_all.py > "$OUT" 2>&1 &
    PID=$!
    ( sleep 180; kill -9 $PID 2>/dev/null ) &
    WATCHDOG=$!

    wait $PID
    STATUS=$?
    kill $WATCHDOG 2>/dev/null

    grep -vE "^Did not expect|^received" "$OUT" | tail -12
    rm -f "$OUT"

    if [ $STATUS -ne 0 ]; then
        echo "sync failed (status=$STATUS) -- ring out of range, or held by the phone"
    fi
fi

# Rebuild the dashboard from whatever is now in the database. Runs even when the
# sync failed, so the page still reflects the latest stored data.
${=ARCH} "$ROOT/.venv/bin/python" -c "
import sys; sys.path.insert(0, '$ROOT/analysis')
from ring_analysis import build_web; build_web.main()
" 2>&1 | tail -3

tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
