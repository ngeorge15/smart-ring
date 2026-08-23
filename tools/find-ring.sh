#!/bin/sh
# Scan for the Colmi ring. Ring must be awake and NOT connected to the QRing app.
export PATH="$HOME/.local/bin:$PATH"
echo "== filtered scan (known Colmi prefixes) =="
colmi_r02_util scan
echo
echo "== full scan (everything advertising) =="
"$HOME/Library/Application Support/pipx/venvs/colmi-r02-client/bin/python" \
  "$(dirname "$0")/ble_fullscan.py" | grep -iE "R0[0-9]|colmi|ring|RSSI|Total" 
