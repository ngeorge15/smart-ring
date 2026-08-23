"""
Reusable scan-free connector for the Colmi ring on macOS.

bleak's CoreBluetooth backend always resolves an address via BleakScanner. Once
macOS holds the GATT link the ring stops advertising, so bleak can never find it
again. We pull the CBPeripheral straight from CoreBluetooth and hand bleak a
prebuilt BLEDevice, skipping discovery entirely.

    from ring_connect import connected_client
    async with connected_client() as client:
        ...
"""
import asyncio
import objc
from contextlib import asynccontextmanager

from CoreBluetooth import CBUUID
from bleak import BleakClient
from bleak.backends.device import BLEDevice
from bleak.backends.corebluetooth.CentralManagerDelegate import CentralManagerDelegate

from colmi_r02_client.client import Client, UART_SERVICE_UUID

RING_UUID = "B9606358-9C44-11D9-8CF4-7B42D630E23A"


async def retrieve_device(ring_uuid: str = RING_UUID) -> BLEDevice:
    delegate = CentralManagerDelegate.alloc().init()
    for _ in range(20):                       # wait for poweredOn (state 5)
        if delegate.central_manager.state() == 5:
            break
        await asyncio.sleep(0.25)
    cm = delegate.central_manager

    NSUUID = objc.lookUpClass("NSUUID")
    ident = NSUUID.alloc().initWithUUIDString_(ring_uuid)
    found = list(cm.retrievePeripheralsWithIdentifiers_([ident]) or [])
    if not found:
        found = list(cm.retrieveConnectedPeripheralsWithServices_(
            [CBUUID.UUIDWithString_(UART_SERVICE_UUID)]) or [])
    if not found:
        raise RuntimeError(
            "Could not retrieve the peripheral from CoreBluetooth. "
            "If the ring has never been seen by this Mac, run tools/find-ring.sh first."
        )
    p = found[0]
    return BLEDevice(ring_uuid, p.name(), (p, delegate), -60)


@asynccontextmanager
async def connected_client(ring_uuid: str = RING_UUID):
    device = await retrieve_device(ring_uuid)
    client = Client(ring_uuid)
    client.bleak_client = BleakClient(device)   # the bypass
    async with client:
        yield client


async def set_time_local(client) -> None:
    """
    Set the ring clock to LOCAL wall-clock time.

    colmi_r02_client.set_time_packet() converts anything that isn't already
    tzinfo=utc into UTC, which puts the ring 7h ahead here and silently splits
    the database across two timezones. QRing sets the ring to local time, and
    sleep analysis is circadian, so local is the correct frame.

    We hand it local wall-clock digits already LABELLED utc, so the library's
    conversion is a no-op and the digits reach the ring unchanged.
    """
    from datetime import datetime, timezone
    from colmi_r02_client import set_time as _st
    wall = datetime.now().replace(tzinfo=timezone.utc)
    await client.send_packet(_st.set_time_packet(wall))
