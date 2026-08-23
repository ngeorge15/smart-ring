"""Empirically test which real-time readings actually return data."""
import asyncio
from colmi_r02_client.real_time import RealTimeReading
from ring_connect import connected_client

TESTS = [("HEART_RATE", RealTimeReading.HEART_RATE),
         ("SPO2",       RealTimeReading.SPO2),
         ("HRV",        RealTimeReading.HRV),
         ("PRESSURE",   RealTimeReading.PRESSURE)]

async def main():
    async with connected_client() as client:
        for name, rt in TESTS:
            try:
                res = await asyncio.wait_for(client.get_realtime_reading(rt), timeout=45)
                print(f"{name:12} -> {res}")
            except asyncio.TimeoutError:
                print(f"{name:12} -> TIMEOUT (no data)")
            except Exception as e:
                print(f"{name:12} -> ERROR {type(e).__name__}: {e}")
            await asyncio.sleep(1)

asyncio.run(main())
