"""
Full sync: everything the ring exposes, in one connection.

  HR + steps      via colmi_r02_client (UART service)
  sleep + SpO2    via big-data V2 service
  HRV + stress    via the undocumented history commands
"""
import asyncio
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from bleak import BleakClient
from colmi_r02_client import db as colmi_db, date_utils
from colmi_r02_client.client import Client

from colmi_r02_client import hr as colmi_hr

import colmi_bigdata as bd
import colmi_extra as ce
import store
from ring_connect import RING_UUID, retrieve_device, set_time_local

DB_PATH = Path(__file__).resolve().parents[1] / "data" / "ring_data.sqlite"

# The library hardcodes a 2s wait for the HR log. At a 5-minute logging interval
# the reply is ~6x larger and routinely needs longer, so widen it.
HR_LOG_TIMEOUT = 20.0


async def _patient_hr_log(self, target=None):
    if target is None:
        target = date_utils.start_of_day(date_utils.now())
    await self.send_packet(colmi_hr.read_heart_rate_packet(target))
    return await asyncio.wait_for(
        self.queues[colmi_hr.CMD_READ_HEART_RATE].get(), timeout=HR_LOG_TIMEOUT)


Client.get_heart_rate_log = _patient_hr_log


async def main():
    device = await retrieve_device()
    client = Client(RING_UUID)
    client.bleak_client = BleakClient(device)

    summary = {}
    conn = store.connect(DB_PATH)

    async with client:
        # --- HR + steps into the colmi schema
        with colmi_db.get_db_session(DB_PATH) as session:
            start = colmi_db.get_last_sync(session, client.address) or (
                date_utils.now() - timedelta(days=7))
            fd = await client.get_full_data(start, date_utils.now())
            colmi_db.full_sync(session, fd)
            summary["hr_logs"] = len(fd.heart_rates)
            summary["step_logs"] = len(fd.sport_details)
            await set_time_local(client)

        # --- HRV + stress history
        # day_offset 0 = today, 1 = yesterday; the ring echoes it back so the
        # series can be dated instead of assumed.
        for cmd, kind in [(ce.CMD_HRV_LOG, "hrv"), (ce.CMD_PRESSURE_LOG, "stress")]:
            total = 0
            for off in (0, 1, 2, 3, 4, 5, 6):
                s = await ce.fetch_log(client, cmd, day_offset=off)
                if not any(v for v in s.values):
                    break
                day = (date.today() - timedelta(days=s.day_offset)).isoformat()
                total += store.save_series(
                    conn, kind, day, s.interval_minutes or 30, s.values)
            summary[kind] = total

        # --- sleep + SpO2 over the big-data service
        raw_sleep = await bd.fetch_bigdata(client.bleak_client, bd.TYPE_SLEEP)
        nights = bd.parse_sleep(raw_sleep)
        summary["sleep_nights"] = store.save_sleep(conn, nights)

        raw_spo2 = await bd.fetch_bigdata(client.bleak_client, bd.TYPE_SPO2)
        interval = 1440 // bd.SPO2_SAMPLES_PER_DAY          # 30 minutes
        total = 0
        for days_ago, vals in bd.parse_spo2(raw_spo2):
            day = (date.today() - timedelta(days=days_ago)).isoformat()
            total += store.save_series(conn, "spo2", day, interval, vals)
        summary["spo2"] = total

        # Temperature: big-data type 0x25, undocumented and absent from
        # Gadgetbridge. Stored RAW -- the scale is unconfirmed (raw/5 gives a
        # plausible skin temp, raw/10+20 a plausible body temp), so nothing is
        # converted until one reading is checked against the QRing app.
        raw_temp = await bd.fetch_bigdata(client.bleak_client, bd.TYPE_TEMP)
        t_total = 0
        for days_ago, interval, vals in bd.parse_temperature(raw_temp):
            day = (date.today() - timedelta(days=days_ago)).isoformat()
            t_total += store.save_series(conn, "temp_raw", day, interval or 30, vals)
        summary["temp_raw"] = t_total

        batt = await client.get_battery()
        store.save_battery(conn, batt.battery_level, batt.charging)

    summary["dropped_future_rows"] = store.drop_future_rows(conn)

    conn.close()
    print("\n=== sync complete ===")
    for k, v in summary.items():
        print(f"  {k:14} {v}")
    print(f"  {'battery':14} {batt.battery_level}%  charging={batt.charging}")
    for n in nights:
        print(f"\n  sleep {n.night_of}: {n.asleep}min asleep / {n.time_in_bed} in bed "
              f"({n.efficiency:.0f}%)  {n.totals}")

asyncio.run(main())
