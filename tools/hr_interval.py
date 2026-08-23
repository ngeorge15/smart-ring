"""Read (and optionally set) the ring's periodic HR logging interval."""
import asyncio, sys
from ring_connect import connected_client

async def main():
    new = int(sys.argv[1]) if len(sys.argv) > 1 else None
    async with connected_client() as client:
        cur = await client.get_heart_rate_log_settings()
        print(f"current: enabled={cur.enabled} interval={cur.interval} min")
        if new is not None:
            print(f"setting -> enabled=True interval={new} min")
            await client.set_heart_rate_log_settings(True, new)
            await asyncio.sleep(1)
            print("now:", await client.get_heart_rate_log_settings())

asyncio.run(main())
