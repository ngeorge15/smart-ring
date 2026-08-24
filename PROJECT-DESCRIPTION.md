# Local-First Biometric Platform for a Reverse-Engineered BLE Smart Ring

## One-line summary

Reverse-engineered the undocumented Bluetooth protocol of a $20 consumer smart
ring, then built a full local-first health platform on top of it — data
pipeline, analysis engine, and an offline-capable mobile dashboard — with no
cloud service, no subscription, and no vendor app in the loop.

## Context

Commercial smart rings (Oura, Ultrahuman) pair capable hardware with locked
ecosystems: data lives on the vendor's servers, insights arrive as opaque
scores, and meaningful access costs a recurring subscription. The Colmi R02 uses
comparable sensors — a VCare VC30F PPG and an STK8321 accelerometer on a BlueX
RF03 (ARM Cortex-M0) — for roughly a fiftieth of the price, but ships with only
a minimal Chinese-market companion app and no documented API.

The goal was to own the entire stack: extract every signal the hardware
produces, compute the derived metrics locally, and present them without a server
or a subscription.

## Protocol reverse engineering

The one existing open-source client (`tahnok/colmi_r02_client`) covered only
heart rate and step counts. Everything else was undocumented, and several
published assumptions turned out to be wrong.

**Discovered a second, unused BLE service.** The community client speaks only
the Nordic-UART-style service. A second GATT service (`de5bf728-…`) carries a
"big data" protocol where sleep staging and SpO2 actually live — which is why
those metrics were widely assumed unavailable on this hardware.

**Decoded five undocumented data streams** by capturing raw notification bytes
and validating candidate layouts against physiological plausibility and
cross-referenced measurements:

| Stream | How it was found |
|---|---|
| HRV history (cmd `0x39`) | Byte-level decode; constants later matched Gadgetbridge exactly |
| Stress history (cmd `0x37`) | Same; validated against a real-time read of the same metric |
| 4-stage sleep (big-data `0x27`) | Stage constants cross-referenced from Gadgetbridge source |
| SpO2 history (big-data `0x2a`) | Per-day record framing decoded from raw bytes |
| **Body temperature (big-data `0x25`)** | **Previously undocumented anywhere** — found by scanning the big-data type space; scale confirmed against the vendor app |

The temperature channel appears in no public protocol documentation and is not
implemented in Gadgetbridge, the most complete open-source client for this
device family.

**Validation methodology.** Every decode was verified before being trusted:
cross-checking a history stream's maximum against a real-time read of the same
metric; confirming a decoded sleep window against an independent signal (mean
heart rate 8 bpm lower inside the window, with the night's minimum falling
inside it); and adding structural checksums — a sleep record's declared
start/end must equal the sum of its segment durations, or the record is flagged
rather than trusted.

That checksum caught a real bug: a record header was 4 bytes, not 2, and the
mis-read bytes had decoded as a *plausible* 2-minute sleep segment on the first
night sampled. The error was invisible until a second night's data made it
produce an impossible stage value.

## Platform engineering

**Data pipeline.** Python/asyncio BLE client with a Hampel (median-absolute-
deviation) filter for PPG motion artifacts, gap-aware resampling that refuses to
interpolate across real gaps, and SQLite persistence with idempotent writes.
Outliers are *flagged*, never overwritten — raw readings are preserved.

**Analysis engine.** Personal-baseline modeling (z-scores and percentiles
against the user's own distribution, not population norms), transparent weighted
scoring where every component exposes its weight, confidence, and contribution,
and a confidence model that degrades explicitly when baselines are thin rather
than presenting a thinly-supported number as certain.

**Cross-device calibration.** Imports ~500K Apple Health records as a reference
track. Compares *matched hours* rather than daily totals — partial-wear days are
the norm, and comparing 6 hours of ring data against 24 hours of watch data
reads as a large fake undercount. Includes an explicit rule preventing
cross-device baseline seeding for non-equivalent metrics (Apple records HRV as
SDNN, the ring reports RMSSD — a ~1.7× magnitude difference that would have
produced systematically wrong readings every day).

**Frontend.** React 19, TypeScript, Tailwind v4, shadcn/ui, Recharts — compiled
to a single self-contained HTML file that works entirely offline. Four-tab
mobile interface with WCAG-validated color palettes (programmatically verified
for colorblind separation and contrast in both light and dark themes).

**Infrastructure.** Fully automated collection: launchd agents for scheduled and
wake-triggered sync, plus private-network delivery via Tailscale so the phone
reaches the host from anywhere without exposing anything publicly.

## Platform-level problems solved

- **macOS CoreBluetooth**: the BLE library could not reconnect once the OS held
  a link — the device stops advertising, and the library resolves addresses only
  by scanning. Solved by retrieving the peripheral handle directly from
  CoreBluetooth and bypassing discovery.
- **TCC permissions**: background agents cannot access protected directories or
  Bluetooth. Solved by relocating the runtime and packaging the sync as a signed
  `.app` bundle launched through LaunchServices, giving macOS an identity to
  attach the Bluetooth grant to.
- **Architecture mismatch**: universal-binary Python launched by LaunchServices
  could select the x86_64 slice, breaking arm64-only NumPy wheels; pinned the
  correct slice.
- **Diagnosed a macOS power-state constraint** (CoreBluetooth is unavailable
  during DarkWake) using `pmset` logs, correcting an earlier incorrect diagnosis
  and reshaping the sync strategy around it.

## Design principle

The interface states its own limits. Interpolated points are visually distinct
from measurements, every score carries a confidence value, metrics computed by
inspectable firmware are labeled as such, and a "Known Limits" panel lists what
the system cannot do. Where a value could not be verified, it is stored raw and
left unconverted rather than displayed as a confident number.

## Stack

Python · asyncio · SQLite · pandas/NumPy · Bleak/CoreBluetooth · React 19 ·
TypeScript · Tailwind CSS v4 · shadcn/ui · Recharts · Vite · launchd · Tailscale

## Résumé bullets

- Reverse-engineered an undocumented BLE protocol for a consumer smart ring,
  decoding five data streams unavailable in existing open-source clients —
  including a body-temperature channel not documented in any public source.
- Built an end-to-end local-first health platform: async BLE pipeline, SQLite
  store, statistical analysis engine, and an offline React dashboard, with zero
  cloud dependencies.
- Designed a validation methodology (cross-metric verification, structural
  checksums, physiological plausibility bounds) that caught multiple silent
  decoding errors producing plausible-but-incorrect values.
- Implemented cross-device calibration against ~500K Apple Health records using
  coverage-matched comparison, with explicit guards against combining
  non-equivalent metrics.
- Solved platform-level constraints across macOS TCC permissions, CoreBluetooth
  connection lifecycle, binary-architecture mismatches, and power-state
  restrictions on background Bluetooth.
