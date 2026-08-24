#!/bin/zsh
# Fired by sleepwatcher when the Mac wakes (including clamshell/DarkWake -> use).
# Bluetooth is not immediately usable at wake, so give the radio a moment before
# asking for a connection; without this the first attempt reliably times out.
sleep 20
exec /usr/bin/open -a /Users/nikhi/smart-ring/SmartRingSync.app
