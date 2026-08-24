"""
Scan big-data types for anything we don't already know about -- temperature
being the target.

Read-only by construction: every request mirrors the known read pattern
(bc <type> 01 00 ff 00 ff) used by sleep (0x27) and SpO2 (0x2a). We do NOT
brute-force raw command ids on the UART channel, where unknown opcodes could
hit reboot (0x08) or worse.
"""
import asyncio
from bleak import BleakClient
import colmi_bigdata as bd
from ring_connect import retrieve_device

KNOWN = {0x27: "sleep", 0x2a: "spo2"}

async def main():
    dev = await retrieve_device()
    hits = []
    async with BleakClient(dev) as c:
        for t in range(0x20, 0x40):
            chunks = []
            def cb(_h, data, _c=chunks): _c.append(bytes(data))
            await c.start_notify(bd.NOTIFY, cb)
            await c.write_gatt_char(bd.CMD_CHAR, bd.request(t), response=False)
            await asyncio.sleep(1.1)
            await c.stop_notify(bd.NOTIFY)
            blob = b"".join(chunks)
            if len(blob) > 6:
                payload = blob[6:]
                nonzero = sum(1 for b in payload if b)
                tag = KNOWN.get(t, "UNKNOWN")
                hits.append((t, len(payload), nonzero, tag, payload[:24].hex(" ")))
                print(f"  0x{t:02x} [{tag:8}] {len(payload):4}B  {nonzero:3} non-zero  {payload[:20].hex(' ')}")
    print(f"\n  {len(hits)} responding type(s); "
          f"{sum(1 for h in hits if h[3]=='UNKNOWN')} not previously known")

asyncio.run(main())
