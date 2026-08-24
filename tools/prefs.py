"""Read (and optionally set) the ring's all-day monitoring switches.

These are ON/OFF only -- unlike heart rate, there is no interval parameter, so
sampling cadence is firmware's decision. Enabling them is the only lever.
"""
import asyncio, sys
from colmi_r02_client import client as ccl
from colmi_r02_client.packet import make_packet
from ring_connect import connected_client

PREFS = {0x2c: "spo2", 0x36: "stress", 0x38: "hrv", 0x16: "heart_rate"}
PREF_READ, PREF_WRITE = 0x01, 0x02
seen: dict[int, bytes] = {}

def cap(cmd):
    def h(p):
        seen[cmd] = bytes(p); return None
    return h

for c in PREFS:
    ccl.COMMAND_HANDLERS[c] = cap(c)

async def main():
    enable = "--enable" in sys.argv
    async with connected_client() as client:
        for cmd, name in PREFS.items():
            seen.pop(cmd, None)
            await client.send_packet(make_packet(cmd, bytearray([PREF_READ])))
            await asyncio.sleep(1.2)
            r = seen.get(cmd)
            print(f"  {name:11} {r.hex(' ') if r else '(no reply)'}")

        if enable:
            print("\n  enabling all-day monitoring...")
            for cmd, name in ((0x2c, "spo2"), (0x36, "stress"), (0x38, "hrv")):
                await client.send_packet(make_packet(cmd, bytearray([PREF_WRITE, 0x01])))
                await asyncio.sleep(1.0)
            print("  re-reading:")
            for cmd, name in PREFS.items():
                seen.pop(cmd, None)
                await client.send_packet(make_packet(cmd, bytearray([PREF_READ])))
                await asyncio.sleep(1.2)
                r = seen.get(cmd)
                print(f"  {name:11} {r.hex(' ') if r else '(no reply)'}")

asyncio.run(main())
