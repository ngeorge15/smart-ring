# Colmi R02 — protocol notes

Device: `COLMI R02_C302` · HW `RT02CR_V3.1` · FW `RT02CR_3.12.01_260428`
CoreBluetooth UUID `B9606358-9C44-11D9-8CF4-7B42D630E23A` · MAC `30:37:45:37:C3:02`

## macOS: the ring "disappears"

bleak's CoreBluetooth backend **always** resolves an address via `BleakScanner`
(`backends/corebluetooth/client.py`). Once macOS holds the GATT link the ring stops
advertising, so bleak can never find it again — every connect fails with
`BleakDeviceNotFoundError` and no amount of scanning, `blueutil --disconnect/--unpair`,
or Bluetooth power-cycling helps (`blueutil` drives the *classic* BT API and no-ops on
BLE GATT links).

Fix: retrieve the `CBPeripheral` straight from CoreBluetooth and hand bleak a prebuilt
`BLEDevice`, skipping discovery. See `tools/ring_connect.py`.
Diagnose with `tools/cb_probe.py` — if `retrieveConnectedPeripherals` returns the ring
while `state=0`, the system holds the link and *we* are the reason it's invisible.

## Two BLE services

| | UUID |
|---|---|
| UART (v1) service | `6e40fff0-b5a3-f393-e0a9-e50e24dcca9e` |
| write / notify | `6e400002-…` / `6e400003-…` |
| **Big-data (v2) service** | `de5bf728-d711-4e47-af26-65e3012a5dc7` |
| command / notify | `de5bf72a-…` / `de5bf729-…` |

`colmi_r02_client` only knows the v1 service. **Sleep and SpO2 history live on v2**,
which is why they look unavailable through that library.

## Commands

UART framing: 16 bytes, `[0]` = command, `[15]` = `sum(bytes) & 0xFF`.

| ID | Command | In client? | Notes |
|---:|---|---|---|
| 1 | Set time | yes | response is a capability bitfield |
| 3 | Battery | yes | |
| 21 | HR log | yes | 2s timeout is too short at 5-min logging — widen it |
| 22 | HR log settings | yes | interval is **1 byte: 1–255 min** |
| 55 (`0x37`) | Stress history | **no** | `tools/colmi_extra.py`; day_offset works |
| 57 (`0x39`) | HRV history | **no** | `tools/colmi_extra.py`; day_offset works |
| 67 | Steps | yes | |
| 68 (`0x44`) | Sleep (old) | n/a | **returns nothing on this firmware** — use big-data |
| 105/106 | Real-time start/stop | yes | HR, SpO2, stress work; **HRV times out** |

### 55 / 57 history wire format
```
[0] cmd   [1] packet index (0 = header)
header:   [2] packet count   [3] interval minutes
data:     bytes 2..14 of packets 1..n, concatenated ->
          stream[0] = day_offset ECHOED BACK (not a sample)
          samples start at stream[1]:
            HRV     -> little-endian uint16 per sample (ms, RMSSD-like)
            stress  -> uint8 per sample (0-100)
```
Zero means "no measurement", not a real zero.

**The day echo is how these series get dated.** They carry no absolute clock, so
without it the only option is assuming "today". Request offsets 0..6 to backfill;
an all-zero reply means no data for that day (stop there).

**Endianness trap:** reading HRV big-endian from `stream[0]` produces *identical
numbers* while values stay under 256 (`00 1e` BE == `1e 00` LE) and additionally
swallows the day echo as a harmless zero at offset 0. It is still wrong, and
breaks silently the first time HRV exceeds 255 ms or a non-zero day offset is
requested (the echo then parses as a 256 ms reading). Verified 2026-08-23.

### Big-data V2 (sleep, SpO2, temperature)

**A reply may be SEVERAL messages**, each with its own 6-byte header. Type 0x25
sends one message PER DAY. Reading `blob[6:]` and truncating to the first
declared length returns only the first record and treats the following headers
as data. Walk the framing: `[bc][type][len_lo][len_hi][crc][crc]` + len bytes,
repeat.

| type | what | record layout |
|---|---|---|
| 0x27 | sleep | `[n_days]` then per day `[days_ago][len][body]` |
| 0x2a | SpO2 | fixed 49B: `[days_ago][48 x uint8]` |
| **0x25** | **temperature** | fixed 50B: `[days_ago][interval][48 x uint8]` |

**0x25 is undocumented** -- not on colmi.puxtril.com and not in Gadgetbridge.
Found by scanning big-data types 0x20-0x3f; every other type returns a 1-byte
status. Scale confirmed against the QRing app (97-98 F):

    celsius = raw / 10 + 20


Request is **raw, not the 16-byte framing**: `bc <type> 01 00 ff 00 ff`
(`type` 0x27 = sleep, 0x2a = SpO2). Reply may arrive in several notifications.
```
header (6 bytes):  bc <type> <len_lo> <len_hi> <crc_lo> <crc_hi>
sleep payload:     [n_days][ per day: days_ago, len, body[len] ]
                   body = [start_lo, start_hi] then (stage, minutes) pairs
                   start = minutes from midnight; stages 2=light 3=deep 4=REM 5=awake
spo2 payload:      2 header bytes then one uint8 per sample
```

## Capability bitfield is NOT trustworthy

The set-time response reports `mSupportHrv: True`, but real-time HRV times out. It also
claims `mSupportWeChat` and 20 contacts on a ring with no screen. Treat every bit as a
claim to verify empirically. `mSupportTemperature: True` **is** corroborated by QRing
showing temperature — but no temperature command is documented anywhere, and
Gadgetbridge doesn't implement one either. **Still unsolved.**

## Validation performed (2026-08-23)

- Stress history max = 61 exactly matched a real-time stress read of 61 minutes earlier.
- SpO2 history 96–99% matched a real-time SpO2 read of 96–98%.
- Sleep: declared payload length matched actual byte count exactly; decoded window
  02:39–08:36 held mean HR **75.3** vs **83.2** outside it, with the night's minimum inside.
- HRV decoded to 30–47 ms, a plausible RMSSD range.
- `CMD_SYNC_HRV = 0x39` / `CMD_SYNC_STRESS = 0x37` reverse-engineered from raw bytes
  before checking Gadgetbridge — the constants matched.

## The ring clock has no timezone

`CMD_SET_TIME` carries BCD year/month/day/hour/min/sec and **no offset field**.
The ring stores whatever wall-clock digits it is given. `colmi_r02_client`'s
`set_time_packet()` converts to UTC, which silently put this ring 7h ahead of
local and split the database across two timezones mid-day. QRing sets local, and
sleep is circadian, so local is correct: `tools/ring_connect.py:set_time_local()`
hands the library local wall-clock already labelled `utc` so its conversion is a
no-op.

Consequence: ring timestamps are **naive local**. DST shifts leave the clock an
hour off until the next sync re-sets it (auto-sync runs every 2h, so it
self-corrects). `store.drop_future_rows()` deletes impossible future-dated rows
as a standing guard against clock drift.

## Gotchas

- Real-time SpO2's first value is a **stale HR packet** bleeding through the queue. Drop it.
- `Client._handle_tx` is registered as a *bound* method at connect time; patching the class
  mid-connection does nothing. Hook `COMMAND_HANDLERS` instead (looked up dynamically).
- SpO2/HRV/stress arrive index-based with no absolute clock. Timestamps are **inferred**
  from the interval field and stored with `ts_inferred = 1`.
