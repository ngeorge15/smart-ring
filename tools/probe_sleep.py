"""
Fetch sleep history over the Colmi 'big data V2' service, which lives on a
SEPARATE GATT service that colmi_r02_client never touches.

  service  de5bf728-d711-4e47-af26-65e3012a5dc7
  command  de5bf72a-...  (write)
  notify   de5bf729-...  (notify)

Request (raw, NOT the 16-byte checksummed framing):
  bc 27 01 00 ff 00 ff
Response header is 6 bytes: bc, type, len_lo, len_hi, crc_lo, crc_hi
"""
import asyncio
from bleak import BleakClient
from ring_connect import retrieve_device

SVC_V2  = "de5bf728-d711-4e47-af26-65e3012a5dc7"
CMD_CH  = "de5bf72a-d711-4e47-af26-65e3012a5dc7"
NOTIF   = "de5bf729-d711-4e47-af26-65e3012a5dc7"

SLEEP_REQ = bytes([0xbc, 0x27, 0x01, 0x00, 0xff, 0x00, 0xff])
SPO2_REQ  = bytes([0xbc, 0x2a, 0x01, 0x00, 0xff, 0x00, 0xff])

async def main():
    dev = await retrieve_device()
    async with BleakClient(dev) as c:
        svcs = [s.uuid.lower() for s in c.services]
        print("V2 service present:", SVC_V2 in svcs)
        if SVC_V2 not in svcs:
            print("services found:", svcs); return

        for label, req in [("SLEEP", SLEEP_REQ), ("SPO2", SPO2_REQ)]:
            chunks = []
            def cb(_h, data: bytearray, _c=chunks):
                _c.append(bytes(data))
            await c.start_notify(NOTIF, cb)
            await c.write_gatt_char(CMD_CH, req, response=False)
            await asyncio.sleep(6.0)
            await c.stop_notify(NOTIF)

            blob = b"".join(chunks)
            print(f"\n=== {label}: {len(chunks)} notification(s), {len(blob)} bytes")
            if blob:
                print("  header:", blob[:6].hex(" "))
                declared = int.from_bytes(blob[2:4], "little")
                print(f"  declared payload len = {declared}, actual = {len(blob)-6}")
                print("  payload:", blob[6:].hex(" ")[:400])

asyncio.run(main())
