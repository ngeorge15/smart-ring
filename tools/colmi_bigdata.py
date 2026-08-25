"""
Colmi "Big Data V2" protocol -- sleep stages and SpO2 history.

This lives on a SECOND GATT service that tahnok/colmi_r02_client never touches,
which is why sleep appears unavailable through that library. Constants cross-
checked against Gadgetbridge's ColmiR0xConstants.java.

  service  de5bf728-d711-4e47-af26-65e3012a5dc7
  command  de5bf72a-...  (write, raw bytes -- NOT the 16-byte checksummed framing)
  notify   de5bf729-...  (notify, may arrive in several chunks)

Request:  bc <type> 01 00 ff 00 ff
Response: bc <type> <len_lo> <len_hi> <crc_lo> <crc_hi> <payload...>

Sleep payload:  [n_days][ per day: days_ago, len, body[len] ]
                body = [start_lo, start_hi][end_lo, end_hi] then (stage, minutes) pairs
                start/end are minutes-from-midnight, little-endian.

WARNING: the header is FOUR bytes. Reading only two and starting the pairs at
byte 2 yields a phantom first segment. On 2026-08-23 those bytes were 02 02,
which decodes as a plausible "light, 2 min" and hid the bug completely; the next
night they were 9a 01 -> "stage 154", which exposed it. end - start MUST equal
the sum of segment minutes, and parse_sleep asserts exactly that.
Validated 2026-08-23: declared length matched actual exactly; decoded window
02:39-08:36 held mean HR 75.3 vs 83.2 outside it, with the night's minimum inside.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

SVC_V2   = "de5bf728-d711-4e47-af26-65e3012a5dc7"
CMD_CHAR = "de5bf72a-d711-4e47-af26-65e3012a5dc7"
NOTIFY   = "de5bf729-d711-4e47-af26-65e3012a5dc7"

BIG_DATA_CMD    = 0xBC
TYPE_SLEEP      = 0x27
TYPE_SPO2       = 0x2A
TYPE_TEMP       = 0x25          # undocumented; not in Gadgetbridge

STAGE = {2: "light", 3: "deep", 4: "REM", 5: "awake"}

logger = logging.getLogger(__name__)


def request(kind: int) -> bytes:
    return bytes([BIG_DATA_CMD, kind, 0x01, 0x00, 0xFF, 0x00, 0xFF])


@dataclass
class SleepSegment:
    stage: str
    minutes: int
    start: datetime


@dataclass
class SleepNight:
    night_of: date
    onset: datetime
    segments: list[SleepSegment] = field(default_factory=list)
    checksum_ok: bool = True
    """False when end - start disagrees with the summed segments, i.e. the
    record did not decode the way we think it does. Never silently trusted."""

    @property
    def totals(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for s in self.segments:
            out[s.stage] = out.get(s.stage, 0) + s.minutes
        return out

    @property
    def time_in_bed(self) -> int:
        return sum(s.minutes for s in self.segments)

    @property
    def asleep(self) -> int:
        return self.time_in_bed - self.totals.get("awake", 0)

    @property
    def efficiency(self) -> float:
        return (self.asleep / self.time_in_bed * 100) if self.time_in_bed else 0.0


def parse_sleep(payload: bytes, today: date | None = None) -> list[SleepNight]:
    if not payload:
        return []
    today = today or date.today()
    nights: list[SleepNight] = []

    n_days, i = payload[0], 1
    for _ in range(n_days):
        if i + 2 > len(payload):
            break
        days_ago, ln = payload[i], payload[i + 1]
        body = payload[i + 2: i + 2 + ln]
        i += 2 + ln
        if len(body) < 2:
            continue

        if len(body) < 4:
            continue
        night_of = today - timedelta(days=days_ago)
        start_min = int.from_bytes(body[0:2], "little")
        end_min = int.from_bytes(body[2:4], "little")

        # Both are minutes-from-midnight and BOTH WRAP at midnight; the ring does
        # not use a continuous axis. end < start therefore means the night
        # crossed midnight, which has two consequences:
        #
        #   * the checksum must compare against end + 1440, not end. Otherwise
        #     every night that begins before midnight fails its own integrity
        #     check -- and the phone's local view drops records that fail it.
        #   * the onset belongs to the PREVIOUS day. night_of is the morning you
        #     woke (days_ago counts back from the wake day), so a 23:27 start
        #     happened the evening before it.
        #
        # Nothing caught this until 2026-08-25 because every earlier night in the
        # data began after midnight (02:39, 02:54), where both readings agree.
        # That night -- 23:27 to 11:07, the longest recorded -- was filed a day
        # into the future, landing outside the sleep-debt window entirely.
        wrapped = end_min < start_min
        end_abs = end_min + 1440 if wrapped else end_min
        start_day = night_of - timedelta(days=1) if wrapped else night_of
        cursor = datetime.combine(start_day, datetime.min.time()) + timedelta(minutes=start_min)
        onset = cursor

        segs: list[SleepSegment] = []
        for j in range(4, len(body) - 1, 2):          # pairs start AFTER the 4-byte header
            stage, mins = body[j], body[j + 1]
            if mins == 0:
                continue
            segs.append(SleepSegment(STAGE.get(stage, f"unknown({stage})"), mins, cursor))
            cursor += timedelta(minutes=mins)

        if segs:
            total = sum(sg.minutes for sg in segs)
            ok = (end_abs - start_min) == total
            if not ok:
                logger.warning(
                    "sleep record for %s failed its checksum: end-start=%d but "
                    "segments sum to %d -- the layout may have changed",
                    night_of, end_abs - start_min, total)
            nights.append(SleepNight(night_of, onset, segs, checksum_ok=ok))
    return nights


SPO2_SAMPLES_PER_DAY = 48          # one every 30 minutes
SPO2_RECORD = 1 + SPO2_SAMPLES_PER_DAY


def parse_spo2(payload: bytes) -> list[tuple[int, list[int | None]]]:
    """Per-day SpO2 records -> [(days_ago, [48 samples]), ...].

    Layout mirrors sleep: fixed 49-byte records, each [days_ago][48 uint8].
    A 147-byte payload is exactly 3 records. 0 means "no measurement".

    An earlier version read this as one flat array after skipping 2 bytes, which
    swallowed the day markers as readings -- producing an impossible SpO2 of 1%
    -- and merged every day together. It also implied a 15-minute interval, when
    48 samples across 24h is 30.
    """
    if len(payload) < SPO2_RECORD:
        return []
    if len(payload) % SPO2_RECORD:
        logger.warning("SpO2 payload %d bytes is not a multiple of %d -- layout may "
                       "have changed; parsing what fits", len(payload), SPO2_RECORD)

    out: list[tuple[int, list[int | None]]] = []
    for off in range(0, len(payload) - SPO2_RECORD + 1, SPO2_RECORD):
        rec = payload[off:off + SPO2_RECORD]
        days_ago = rec[0]
        vals = [v if v else None for v in rec[1:]]
        if any(v is not None for v in vals):
            out.append((days_ago, vals))
    return out


def split_messages(blob: bytes) -> list[bytes]:
    """Split a reply into payloads, one per big-data message.

    A reply is not always a single message. Type 0x25 answers with one message
    PER DAY, each carrying its own 6-byte header, so the naive
    "payload = blob[6:], truncate to declared length" reading returned only the
    first day and treated the following headers as data. Walk the framing.
    """
    out: list[bytes] = []
    off = 0
    while off + 6 <= len(blob):
        if blob[off] != BIG_DATA_CMD:
            break
        declared = int.from_bytes(blob[off + 2:off + 4], "little")
        start, end = off + 6, off + 6 + declared
        if end > len(blob):
            logger.warning("truncated big-data message: want %d bytes, have %d",
                           declared, len(blob) - start)
            out.append(blob[start:])
            break
        out.append(blob[start:end])
        off = end
    return out


async def fetch_bigdata(bleak_client, kind: int, wait: float = 6.0) -> bytes:
    """Write a big-data request and return every message payload, concatenated."""
    chunks: list[bytes] = []

    def cb(_h, data: bytearray):
        chunks.append(bytes(data))

    await bleak_client.start_notify(NOTIFY, cb)
    try:
        await bleak_client.write_gatt_char(CMD_CHAR, request(kind), response=False)
        await asyncio.sleep(wait)
    finally:
        await bleak_client.stop_notify(NOTIFY)

    blob = b"".join(chunks)
    if len(blob) < 6 or blob[0] != BIG_DATA_CMD:
        return b""
    return b"".join(split_messages(blob))


TEMP_SAMPLES_PER_DAY = 48       # one every 30 minutes
TEMP_RECORD = 2 + TEMP_SAMPLES_PER_DAY


def parse_temperature(payload: bytes) -> list[tuple[int, int, list[int | None]]]:
    """Per-day records -> [(days_ago, interval_min, [48 raw samples]), ...].

    Record layout: [days_ago][interval_minutes][48 uint8].
    SCALE CONFIRMED 2026-08-24:  celsius = raw / 10 + 20
    Checked against the QRing app, which showed 97-98 F. raw 158-169 maps to
    96.4-98.4 F under this formula; the competing hypothesis (raw / 5, skin
    temperature) would have given 89-93 F and is ruled out.
    Values are still STORED raw so the conversion stays in one place.
    """
    out: list[tuple[int, int, list[int | None]]] = []
    for off in range(0, len(payload) - TEMP_RECORD + 1, TEMP_RECORD):
        rec = payload[off:off + TEMP_RECORD]
        days_ago, interval = rec[0], rec[1]
        vals = [v if v else None for v in rec[2:]]
        if any(v is not None for v in vals):
            out.append((days_ago, interval, vals))
    return out
