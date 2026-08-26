"""
The command plan the phone executes.

WHY THIS EXISTS AS DATA RATHER THAN CODE
----------------------------------------
The phone page is a dumb pipe: it fetches this plan, writes each `hex` to the
named characteristic, collects whatever comes back, and posts the bytes here.
It knows nothing about the protocol.

That means adding a command, changing a day range, or fixing a decode is a Python
edit on the Mac -- no page rebuild, no Bluefy cache to fight, no second copy of
the protocol to drift out of sync. The one thing that would force a phone-side
change is a new *transport* (a third GATT service), which has not happened since
the big-data service was found.

TIMING
------
The ring drops IDLE links after roughly 30s, but stays up while commands are
flowing. `collect_ms` is how long to listen after each write. The heart-rate log
is by far the largest reply (288 five-minute samples, sent as many packets) and
needs a much longer window than everything else -- the Python client hit a
2s-timeout bug here for exactly this reason.
"""
from __future__ import annotations

import json
import struct
import sys
from datetime import datetime, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import colmi_bigdata as bd

# Deliberately NOT imported from colmi_extra: that module pulls in
# colmi_r02_client, which lives only in the pipx venv, and serve.py runs on the
# system interpreter. These three lines are the whole request shape; colmi_extra
# remains the source of truth for PARSING, which is where the complexity is.
CMD_HRV_LOG = 57       # 0x39
CMD_PRESSURE_LOG = 55  # 0x37


def request_packet(cmd: int, day_offset: int = 0) -> bytearray:
    sub = bytearray(b"\x00\x0f\x00\x5f\x01")
    sub[0] = day_offset
    return _packet(cmd, bytes(sub))

# Characteristic addresses, lowercased for Web Bluetooth (it rejects uppercase).
UART = {
    "service": "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e",
    "write":   "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
    "notify":  "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
}
V2 = {
    "service": bd.SVC_V2.lower(),
    "write":   bd.CMD_CHAR.lower(),
    "notify":  bd.NOTIFY.lower(),
}

CMD_BATTERY = 3
CMD_READ_HEART_RATE = 21
CMD_GET_STEP_SOMEDAY = 67


def _packet(command: int, sub: bytes = b"") -> bytearray:
    p = bytearray(16)
    p[0] = command
    p[1:1 + len(sub)] = sub
    p[15] = sum(p) & 0xFF
    return p


def _hr_packet(day: datetime) -> bytearray:
    """CMD 21 + little-endian unix timestamp of that day's midnight."""
    midnight = datetime.combine(day.date(), time.min)
    return _packet(CMD_READ_HEART_RATE, struct.pack("<L", int(midnight.timestamp())))


def _steps_packet(day_offset: int) -> bytearray:
    sub = bytearray(b"\x00\x0f\x00\x5f\x01")
    sub[0] = day_offset
    return _packet(CMD_GET_STEP_SOMEDAY, bytes(sub))


def _step(sid: str, kind: str, chan: dict, payload: bytes, collect_ms: int,
          **meta) -> dict:
    return {"id": sid, "kind": kind, "hex": bytes(payload).hex(),
            "collect_ms": collect_ms, **chan, **meta}


def build(full: bool = False) -> dict:
    """`full` backfills a week of HRV/stress; the default is a fast today-only pull."""
    now = datetime.now()
    days = range(7) if full else range(1)
    steps_days = range(3) if full else range(2)

    plan: list[dict] = [
        # 2500ms, not 900. Battery is the FIRST command after connect, so it
        # fires while service discovery and the notification subscription are
        # still settling -- the least settled moment of the whole session, given
        # the tightest window in the plan. It silently returned 0 chunks on
        # 2026-08-25 19:08 and 2026-08-26 14:03, so the dashboard kept showing a
        # 23-hour-old level right through a charge, with nothing to say it was
        # stale. Costs 1.6s once per sync.
        _step("battery", "battery", UART, _packet(CMD_BATTERY), 2500),
        # The big reply. 12s is generous on purpose -- an undersized window here
        # silently truncates the day's heart rate rather than failing loudly.
        _step("hr_today", "hr", UART, _hr_packet(now), 12000,
              day=now.date().isoformat()),
    ]
    for off in steps_days:
        plan.append(_step(f"steps_{off}", "steps", UART, _steps_packet(off), 1800,
                          day_offset=off))
    for off in days:
        plan.append(_step(f"hrv_{off}", "hrv", UART,
                          request_packet(CMD_HRV_LOG, off), 1800, day_offset=off))
    for off in days:
        plan.append(_step(f"stress_{off}", "stress", UART,
                          request_packet(CMD_PRESSURE_LOG, off), 1800, day_offset=off))
    for sid, kind in (("sleep", bd.TYPE_SLEEP), ("spo2", bd.TYPE_SPO2),
                      ("temp", bd.TYPE_TEMP)):
        plan.append(_step(sid, sid, V2, bd.request(kind), 3000))

    return {
        "version": 1,
        "generated_at": now.isoformat(timespec="seconds"),
        "full": full,
        "estimated_ms": sum(s["collect_ms"] for s in plan) + 400 * len(plan),
        "steps": plan,
    }


if __name__ == "__main__":
    p = build(full="--full" in sys.argv)
    print(json.dumps(p, indent=1))
    print(f"\n{len(p['steps'])} steps, ~{p['estimated_ms'] / 1000:.0f}s", file=sys.stderr)
