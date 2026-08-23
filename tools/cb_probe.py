"""Ask CoreBluetooth directly whether macOS currently holds a live GATT link."""
import asyncio, objc
from CoreBluetooth import CBUUID, CBCentralManager
from bleak.backends.corebluetooth.CentralManagerDelegate import CentralManagerDelegate

UART = "6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E"
RING_UUID = "B9606358-9C44-11D9-8CF4-7B42D630E23A"

async def main():
    d = CentralManagerDelegate.alloc().init()
    await asyncio.sleep(2)          # let it reach poweredOn
    cm = d.central_manager
    print("central state:", cm.state())

    # 1. Peripherals macOS considers CONNECTED right now
    conn = cm.retrieveConnectedPeripheralsWithServices_([CBUUID.UUIDWithString_(UART)])
    print(f"\nretrieveConnectedPeripherals(UART) -> {len(conn)} device(s)")
    for p in conn:
        print(f"   name={p.name()!r} id={p.identifier().UUIDString()} state={p.state()}")

    # 2. Look the ring up by identifier regardless of connection state
    import uuid as _u
    ns = objc.lookUpClass("NSUUID").alloc().initWithUUIDString_(RING_UUID)
    known = cm.retrievePeripheralsWithIdentifiers_([ns])
    print(f"\nretrievePeripheralsWithIdentifiers(ring) -> {len(known)} device(s)")
    for p in known:
        # CBPeripheralState: 0=disconnected 1=connecting 2=connected 3=disconnecting
        print(f"   name={p.name()!r} state={p.state()}  (0=disconnected, 2=connected)")

asyncio.run(main())
