"""Does the day_offset byte actually select a different day for 55/57?

If it does, index-based series can be attributed to real dates and backfilled,
instead of being assumed to be 'today'.
"""
import asyncio
import colmi_extra as ce
from ring_connect import connected_client

async def main():
    async with connected_client() as client:
        for cmd, name in [(ce.CMD_HRV_LOG, "hrv"), (ce.CMD_PRESSURE_LOG, "stress")]:
            print(f"\n=== {name} ===")
            seen = {}
            for off in (0, 1, 2):
                s = await ce.fetch_log(client, cmd, day_offset=off)
                vals = [v for v in s.values if v]
                sig = tuple(vals)
                seen[off] = sig
                print(f"  offset={off}: n={len(s.values)} valid={len(vals)} "
                      f"interval={s.interval_minutes} first6={vals[:6]}")
            if seen[0] and seen[0] == seen.get(1):
                print("  -> offset IGNORED (0 and 1 identical): always 'today'")
            elif seen.get(1):
                print("  -> offset WORKS: distinct data per day, backfill possible")
            else:
                print("  -> offset=1 returned nothing (no older data, or unsupported)")

asyncio.run(main())
