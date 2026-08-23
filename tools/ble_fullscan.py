import asyncio
from bleak import BleakScanner

async def main():
    print("Scanning 15s for ALL BLE devices...\n")
    devs = await BleakScanner.discover(timeout=15.0, return_adv=True)
    rows = []
    for addr, (d, adv) in devs.items():
        rows.append((adv.rssi, d.name or "(no name)", addr, list(adv.service_uuids)))
    rows.sort(reverse=True)
    print(f"{'RSSI':>5}  {'NAME':<28} ADDRESS")
    print("-"*90)
    for rssi, name, addr, uuids in rows:
        print(f"{rssi:>5}  {name:<28} {addr}")
        if uuids:
            print(f"{'':>5}  svc: {', '.join(uuids)}")
    print(f"\nTotal: {len(rows)} devices")

asyncio.run(main())
