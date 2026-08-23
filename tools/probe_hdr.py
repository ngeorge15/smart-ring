"""Dump raw 55/57 packets at two day offsets to pin down the header bytes."""
import asyncio
from colmi_r02_client import client as ccl
import colmi_extra as ce
from ring_connect import connected_client

raw = {}
def mk(cmd):
    def cap(p):
        raw.setdefault(cmd, []).append(bytes(p)); return None
    return cap

async def main():
    async with connected_client() as client:
        for cmd, name in [(ce.CMD_HRV_LOG,"hrv"), (ce.CMD_PRESSURE_LOG,"stress")]:
            for off in (0,1):
                raw[cmd] = []
                ccl.COMMAND_HANDLERS[cmd] = mk(cmd)
                await client.send_packet(ce.request_packet(cmd, off))
                await asyncio.sleep(3)
                print(f"\n--- {name} offset={off}")
                for p in raw[cmd][:4]:
                    print("   ", p.hex(" "))
                stream = b"".join(p[2:15] for p in sorted(raw[cmd], key=lambda x:x[1])[1:])
                print("    stream[:14]:", stream[:14].hex(" "))

asyncio.run(main())
