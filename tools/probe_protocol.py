"""
Capture raw responses for the undocumented-in-client commands:
  68 = Sleep, 57 = HRV log, 55 = Pressure log

We do NOT guess a parser here -- we dump bytes so the structure can be decoded
from real data.
"""
import asyncio
from colmi_r02_client import client as ccl
from colmi_r02_client.packet import make_packet
from ring_connect import connected_client

CMDS = {68: "SLEEP", 57: "HRV_LOG", 55: "PRESSURE_LOG"}
captured: dict[int, list[bytes]] = {c: [] for c in CMDS}

# Patch the raw notification handler so nothing is dropped as "unexpected".
_orig = ccl.Client._handle_tx
def handle_tx(self, _sender, packet: bytearray):
    if packet and packet[0] in captured:
        captured[packet[0]].append(bytes(packet))
    try:
        _orig(self, _sender, packet)
    except Exception:
        pass
ccl.Client._handle_tx = handle_tx

async def main():
    async with connected_client() as client:
        for cmd, name in CMDS.items():
            # mirror the steps.py request shape: day_offset + constants
            for label, sub in [("steps-style", bytearray(b"\x00\x0f\x00\x5f\x01")),
                               ("bare-offset", bytearray(b"\x00"))]:
                before = len(captured[cmd])
                await client.send_packet(make_packet(cmd, sub))
                await asyncio.sleep(3.0)
                got = captured[cmd][before:]
                print(f"\n--- {name} (cmd {cmd}) [{label}] -> {len(got)} packet(s)")
                for p in got[:12]:
                    print("   ", p.hex(" "))

asyncio.run(main())
