"""Ask the ring what it claims to support (set-time response is a capability bitfield)."""
import asyncio
from datetime import datetime, timezone

from colmi_r02_client import client as ccl
from colmi_r02_client import set_time
from ring_connect import connected_client

raw_packets = []
_orig = set_time.parse_set_time_packet

def capture(packet: bytearray):
    raw_packets.append(bytes(packet))
    return _orig(packet)

# CMD_SET_TIME normally maps to empty_parse, which throws the response away.
ccl.COMMAND_HANDLERS[set_time.CMD_SET_TIME] = capture

async def main():
    async with connected_client() as client:
        await client.set_time(datetime.now(tz=timezone.utc))
        caps = await asyncio.wait_for(client.queues[set_time.CMD_SET_TIME].get(), timeout=5)

    print("raw capability packet:", raw_packets[0].hex(" ") if raw_packets else "(none)")
    print()
    for k, v in caps.items():
        mark = "  <<<" if "Temperature" in k or "Oxygen" in k or "Sleep" in k else ""
        print(f"  {k:28} {v}{mark}")

asyncio.run(main())
