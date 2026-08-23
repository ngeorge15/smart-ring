"""
Protocol support for Colmi history commands that tahnok/colmi_r02_client does
NOT implement: HRV (57) and stress/pressure (55).

Wire format (both share it):
    packet[0]  command id
    packet[1]  packet index; index 0 is a header
    header:    packet[2] = number of packets, packet[3] = interval in minutes
    data:      bytes 2..14 of packets 1..n, concatenated into one stream

    stream[0] = the day_offset echoed back; samples start at stream[1].
    HRV      -> little-endian uint16 per sample (milliseconds, RMSSD-like)
    PRESSURE -> one uint8 per sample (0-100 stress scale)

    The day echo is why the series can be dated rather than assumed to be today.
    NOTE: reading HRV big-endian from stream[0] gives identical numbers while
    values stay under 256 (00 1e BE == 1e 00 LE), so that error is invisible
    until an HRV reading exceeds 255 ms. It is not equivalent.

Validated 2026-08-23: pressure log max (61) matched a real-time PRESSURE read
of 61 taken minutes earlier; HRV decoded to 30-47 ms, a plausible RMSSD range.
Zero samples mean "no measurement", not a real zero.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from colmi_r02_client.packet import make_packet

CMD_HRV_LOG = 57       # 0x39
CMD_PRESSURE_LOG = 55  # 0x37


@dataclass
class LogSeries:
    kind: str
    interval_minutes: int
    values: list[int | None] = field(default_factory=list)
    day_offset: int = 0
    """Days before today, read from the payload echo -- not assumed."""

    def __repr__(self) -> str:
        got = [v for v in self.values if v]
        rng = f"{min(got)}-{max(got)}" if got else "empty"
        return (f"<LogSeries {self.kind} n={len(self.values)} "
                f"valid={len(got)} range={rng} every={self.interval_minutes}min>")


def request_packet(cmd: int, day_offset: int = 0) -> bytearray:
    # Mirrors the steps.py request shape; the ring ignores the trailing constants
    # for these two commands (bare offset returned identical bytes).
    sub = bytearray(b"\x00\x0f\x00\x5f\x01")
    sub[0] = day_offset
    return make_packet(cmd, sub)


def parse_log(cmd: int, packets: list[bytes]) -> LogSeries:
    kind = {CMD_HRV_LOG: "hrv", CMD_PRESSURE_LOG: "stress"}[cmd]
    by_index = {p[1]: p for p in packets if p and p[0] == cmd}
    if 0 not in by_index:
        return LogSeries(kind, 0, [])

    header = by_index[0]
    n_packets, interval = header[2], header[3]

    stream = bytearray()
    for i in range(1, n_packets):
        if i in by_index:
            stream += by_index[i][2:15]

    if not stream:
        return LogSeries(kind, interval, [])

    day_offset = stream[0]          # echoed request offset, not a sample
    body = stream[1:]

    if cmd == CMD_HRV_LOG:
        vals = [int.from_bytes(body[i:i + 2], "little") for i in range(0, len(body) - 1, 2)]
    else:
        vals = list(body)

    return LogSeries(kind, interval, [v if v else None for v in vals], day_offset)


# --- capture hook -------------------------------------------------------------
# Client registers self._handle_tx as the notify callback at connect time, so
# patching the class later has no effect on an open connection. _handle_tx does
# look up COMMAND_HANDLERS dynamically though, so we hook there instead.
# Returning None keeps the result out of the queues (nothing else consumes it).

_captured: dict[int, list[bytes]] = {CMD_HRV_LOG: [], CMD_PRESSURE_LOG: []}


def _make_capture(cmd: int):
    def capture(packet: bytearray):
        _captured[cmd].append(bytes(packet))
        return None
    return capture


def install() -> None:
    """Register capture handlers. Safe to call repeatedly."""
    from colmi_r02_client import client as _ccl
    for cmd in (CMD_HRV_LOG, CMD_PRESSURE_LOG):
        _ccl.COMMAND_HANDLERS[cmd] = _make_capture(cmd)


install()


async def fetch_log(client, cmd: int, day_offset: int = 0, wait: float = 3.0) -> LogSeries:
    """Send a history request and collect the multi-packet reply."""
    _captured[cmd].clear()
    await client.send_packet(request_packet(cmd, day_offset))
    await asyncio.sleep(wait)
    return parse_log(cmd, list(_captured[cmd]))
