"""
Sync the Colmi ring WITHOUT scanning.

bleak's macOS backend always resolves an address via BleakScanner, so if macOS
already holds the GATT link the ring stops advertising and bleak can never find
it. We retrieve the CBPeripheral straight from CoreBluetooth and hand bleak a
prebuilt BLEDevice, bypassing discovery entirely.
"""
import asyncio, objc, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from CoreBluetooth import CBUUID
from bleak import BleakClient
from bleak.backends.device import BLEDevice
from bleak.backends.corebluetooth.CentralManagerDelegate import CentralManagerDelegate

from colmi_r02_client import db, date_utils
from colmi_r02_client.client import Client, UART_SERVICE_UUID
from ring_connect import set_time_local

RING_UUID = "B9606358-9C44-11D9-8CF4-7B42D630E23A"
DB_DIR = Path("/Users/nikhi/smart-ring/data")


async def retrieve_device() -> BLEDevice:
    delegate = CentralManagerDelegate.alloc().init()
    for _ in range(20):                      # wait for poweredOn (state 5)
        if delegate.central_manager.state() == 5:
            break
        await asyncio.sleep(0.25)
    cm = delegate.central_manager

    NSUUID = objc.lookUpClass("NSUUID")
    ident = NSUUID.alloc().initWithUUIDString_(RING_UUID)
    found = list(cm.retrievePeripheralsWithIdentifiers_([ident]) or [])
    if not found:
        found = list(cm.retrieveConnectedPeripheralsWithServices_(
            [CBUUID.UUIDWithString_(UART_SERVICE_UUID)]) or [])
    if not found:
        sys.exit("Could not retrieve the peripheral from CoreBluetooth.")

    p = found[0]
    print(f"retrieved peripheral: {p.name()!r} state={p.state()}")
    return BLEDevice(RING_UUID, p.name(), (p, delegate), -60)


async def main():
    device = await retrieve_device()

    client = Client(RING_UUID)
    client.bleak_client = BleakClient(device)     # <-- the bypass

    db_path = DB_DIR / "ring_data.sqlite"
    DB_DIR.mkdir(parents=True, exist_ok=True)

    with db.get_db_session(db_path) as session:
        start = db.get_last_sync(session, client.address) or (
            date_utils.now() - timedelta(days=7))
        end = date_utils.now()
        print(f"syncing {start} -> {end}\nwriting to {db_path}")

        async with client:
            print("connected.")
            fd = await client.get_full_data(start, end)
            db.full_sync(session, fd)
            await set_time_local(client)
            print("clock set.")
    print("DONE")

asyncio.run(main())
