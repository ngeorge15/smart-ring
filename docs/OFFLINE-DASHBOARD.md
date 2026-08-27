# Offline dashboard — design, and where it stands

Goal: the phone dashboard shows LAST NIGHT in the morning, with the Mac shut.

## The constraint that shapes everything

`sync.html` runs in **Bluefy** (only iOS browser with Web Bluetooth).
The dashboard runs in **Safari**. Two iOS apps = two storage jars, so Safari
cannot read the IndexedDB queue Bluefy writes.

  => `drainQueue()` in `app/src/App.tsx` has never found anything. Silent no-op,
     invisible because captures normally upload the moment the Mac is up.

The obvious fix (dashboard in Bluefy) fails differently: **no service worker in
Bluefy** (`sw:NO` in the user's logs), so with the Mac down it would not LOAD.

  Safari : loads offline YES, data frozen at last Mac build
  Bluefy : fresh data YES, cannot load offline

So a **handoff** is required: Bluefy decodes + hands a small payload to Safari
via URL fragment; Safari's cached app merges it into its cached snapshot.

## Accuracy: the cached snapshot IS the history

Offline, only the NEWEST DAY is missing. Everything expensive (90d Watch
baselines reduced to ~50 numbers in params.json, 8 weekly trend buckets, 14
nights of debt) is cached and slow-moving. The phone EXTENDS THE TAIL; it does
not recompute from scratch.

Divergences and their fixes:
  phone sees 1 capture, Mac sees the DB -> cached history + min(cached day-so-far,
      phone capture) for resting HR. Biggest one; closes outright.
  only newest capture decoded          -> accumulate decoded days in IndexedDB
  phone does not clean                 -> DONE: clipImpossible + hampel ported
  params age                           -> recompute ring-only baselines
      (hrv/stress/spo2 = mean/sd/percentiles) from cached series + new day.
      Watch baselines are 90d windows; one day is noise.

Out of reach: step calibration (blocked on the Mac anyway); slow drift if many
days pass without opening the Mac — surface the age, don't hide it.

## DONE (all additive, verified, shipping)

* `energy.resting_reference()` extracted — the 5th percentile of EVERY reading.
  Phone must use the identical anchor; one capture would give it a different and
  always higher resting value. Behaviour-preserving (193.7 kcal before & after).
* `params.json` gains an `energy` block (weight, age, RMR, hr_max, floor,
  met_max, blend). Without it the phone shows fresh STEPS beside stale calories,
  which is worse than showing neither.
* `trends.daily_inputs()` + `snapshot["daily"]` — the per-day terms
  `_weekly_agg` consumes. Lets the phone APPEND a day and re-run the same
  aggregation, instead of patching a rounded weekly mean. Trimmed to the trend
  window (was shipping 2,500 rows of Watch archive).
* `ring-engine.js`: `decodeSpo2`, `decodeTemperature`, `clipImpossible`,
  `hampel`, `cleanSeries`.
  hampel MATTERS most for resting HR — it is a MINIMUM, so one impossible low
  sample moves it directly where a mean would not notice.
  Its MAD is a ROLLING MEDIAN OF THE DEVIATION SERIES (each point vs its OWN
  local median, then smoothed) — NOT the median of |x - med[i]| in the window.
  The obvious reading gives different numbers. Fuzzed 300 random series against
  pandas: 300/300 exact.

verify.sh: ALL MATCH (39 assertions). Dashboard builds, serves 200.

## NOT STARTED

1. `web/handoff.js`  — codec: JSON -> gzip (CompressionStream) -> base64url.
   Payload is the DECODED summary (~5-8KB), never raw hex. Fits a fragment.
2. `sync.html`       — accumulate decoded days in IndexedDB (survive capture
   deletion); build payload; "Update dashboard" button + auto-attempt
   `x-safari-https://<host>/index.html#h=...`. BUILD BOTH PATHS — unknown
   whether Bluefy honours the scheme; user reports which fires.
3. `app/src/lib/overlay.ts` — read `#h=`, persist, strip hash, merge over the
   cached snapshot; `await initOverlay()` in main.tsx BEFORE render so every
   page sees merged DATA with no refactor (`Object.assign(DATA, merged)`).
4. Recompute on the dashboard side (it holds the history; Bluefy only decodes):
   sleep-debt tail, current partial week bucket, ring baselines, energy.
   Port targets: `trends.sleep_debt`, `trends._weekly_agg`, `baseline._stats`.
5. Provenance chips — overlay numbers must never masquerade as the Mac's.
   Keep snapshot `caveats` (do NOT port caveat logic).
6. Extend verify.sh to cover the new ports.

Rule throughout: Mac stays source of truth. Raw bytes upload regardless; overlay
is discarded once `meta.generated_at` passes the overlay timestamp.

---

# 2026-08-25 — auto-update + persistence fixes (all shipped & verified)

## Dashboard <-> Mac auto-update (was: only on manual reload)

`/ping` now also returns `built` (the snapshot's generated_at). The dashboard was
already polling that endpoint for reachability, so noticing a newer build is free.
App.tsx: reloads automatically ON FOREGROUND; while you are actively using the
page it offers a tap-to-load pill instead — yanking the view mid-tap is worse than
being one sync behind. Verified in Chrome: offers while visible = true,
auto-reloads on foreground = true, no errors.

NOTE serve.py `ROOT` is `web/dist`, so the snapshot source is `ROOT.parent /
"snapshot.json"`. A bare `except: pass` hid that wrong path once — it now logs.

## Mac sync agent was DEAD

`com.nikhi.smartring.sync` existed but was never loaded (`launchctl print` = 502).
Only sleepwatcher's on-wake hook was firing. Last Mac BLE sync: 2026-08-24 20:06.
Now bootstrapped. Plist comment said "30 min" while the value was 3600 — comment
corrected, value kept.

`autosync.sh` now SKIPS the radio when the phone synced in the last 45 min. The
ring takes one connection; a Mac attempt during a phone sync is a doomed 60s
timeout and one of the ways the ring gets stranded.

## Three bugs found in the phone's own log (data/probe-log.txt, 2026-08-25)

1. `params:none` FOREVER. Two causes: `selfCheck` queried the service-worker
   Cache (never populated in Bluefy, sw:NO) instead of localStorage, which hid
   the real bug — `getParams()` sat BELOW renderLocal's early return, so it only
   ran while a capture existed, and captures are deleted on upload. After a clean
   sync the phone had no scoring params at all. Params are now fetched on load,
   unconditionally; self-check reports localStorage.
2. IndexedDB took a completed sync down with it — `UnknownError: An internal
   error was encountered in the Indexed Database server` at the idbPut AFTER 33s
   of successful capture. Now non-fatal: capture stays in `memoryQueue` and still
   uploads; the local card is passed the capture via event detail rather than
   read back out of the store that just failed.
3. `connected in 1862.3s` — a connect resolved 31 MINUTES after the page was
   backgrounded and the sync aborted, handing back an untracked GATT link on a
   one-connection ring. THAT is what strands the ring and forces the iOS
   forget/Bluetooth-toggle. connectWithRetry now checks `aborted` and disconnects
   immediately; retries no longer continue into an abandoned sync.

Also: the local view survives its capture being uploaded (last summary mirrored
to localStorage under `ring-local-v1`). Verified: card still shown after
upload + reload; self-check reads `params:cached  local:cached`.

## Trends accuracy bug (fixed)

`_weekly_agg` dropped empty weeks, then computed delta against the previous ROW —
so a five-week gap rendered as a week-over-week change (Resting HR "+5.5",
Sleep "-375"). Delta is now null unless the previous bucket is the immediately
preceding week. Metrics also carry `latest_week` + `stale`, because Steps stop at
the Watch's last day and were reporting a week-old figure beside a current Sleep
one. (TrendsPage already labelled the week client-side, so no UI change needed.)

`hampel` fuzzed against pandas: 300/300 exact. verify.sh: ALL MATCH.

---

# 2026-08-25 (later) — the midnight-crossing sleep bug

## Root cause of "sleep debt didn't update"

The ring's sleep record stores start_min and end_min as minutes-from-midnight,
and BOTH WRAP. `end < start` therefore means the night crossed midnight.
Neither engine handled it:

    days_ago=0   start 1407 (23:27)   end 667 (11:07)
    naive:  667 - 1407 = -740     -> checksum FAIL, in_bed negative
    truth:  (667+1440) - 1407 = 700   -> 11h40m

Two consequences, both silent:
  * onset was dated a day late -> _night_of pushed it to 2026-08-26, OUTSIDE the
    14-night debt window, so the best night on record was invisible.
  * checksum_ok=False -> the phone's local view FILTERS on that, so it discarded
    the night outright.

Invisible until now because every earlier night began AFTER midnight (02:39,
02:54), where the naive and correct readings agree.

Fixed in `colmi_bigdata.parse_sleep` AND `ring-engine.decodeSleep` (which grew a
`wrapped` flag). Capture re-ingested; debt went 446m -> 226m.

Regression cover: `tools/fixtures/sleep_wrapped.hex` is now repo-tracked (was
/tmp/sleep_hex_clean.txt, which does not survive) and contains that night.
verify.sh asserts in_bed / asleep / segments / checksum / wrapped on all three.

NOTE sleep debt FLOORS AT ZERO by design -- surplus pays debt down but never
banks credit. It cannot show a positive balance. Nikhil expected one; if that
should change it is a model decision, not a bug.

## Trends: every chart had its own x-axis

`_weekly_agg` dropped empty weeks, so Sleep spanned 4 bars, Steps 7, HRV 2 --
and a five-week gap rendered the same width as one week. Empty weeks are now
EMITTED with `value: null`, so all metrics share identical slots. `latest` /
`latest_week` / `stale` / `delta` / `comparable` all key off the newest week
that HAS data, since rows[-1] is now usually empty.

## Trends bar selection

Brand meant two things -- "latest" (faint tint) and "selected" (solid) -- which
is exactly the ambiguity reported. Now BRAND MEANS SELECTED, nothing else;
recency is carried by the subtitle ("this week" / "week of 8/17").

Bars used `--raise`, a SURFACE token a hair off the card colour, so they were
barely visible. New `--bar` token: #5b6472 dark, #847d6e light (3.39:1 on the
card). The thin-week opacity fade was also removed to 0.72 -- with this much
missing history nearly every week is thin, so the fade dimmed the whole chart
to signal something the subtitle already said.

---

# 2026-08-25 (later still) — focus ring, debt selection, and a reload loop

## The blue box round the chart

Recharts moves focus to an internal `<g tabindex="-1">` wrapping the whole plot
on tap; the UA then paints its default `5px auto` focus ring around it. Those
nodes are tabindex="-1" so they are NOT keyboard-reachable and the ring carries
no information. Suppressed in index.css, scoped to `.recharts-wrapper`
internals only -- buttons, nav and links keep their real focus rings.

## Sleep debt now selects like Trends

Was a floating hover Tooltip; Trends is tap-to-select-and-stay. Now identical:
tap a bar -> headline swaps to that night, tap again to clear, brand underline
marks the slot.

Selection is signalled by OPACITY + the marker, never by hue: the debt chart is
a DIVERGING encoding where blue already means "surplus", so painting a selection
brand-blue would collide with the data. Trends can use brand because its bars
are a single neutral.

## Markers were rendering at zero width

`px-[11%]` on a `flex-1` item: percentage padding resolves against the ROW
width, so with flex-basis 0 the padding exceeded the slot and collapsed the
content box. Present in the DOM, measurable, invisible. Now `px-[3px]` +
`w-full`. Verified marker centre aligns with the selected bar centre.

## INFINITE RELOAD LOOP (introduced earlier today, caught in test)

build_web writes snapshot.json BEFORE running vite. A failed vite build (a TSX
syntax error, in this case) therefore leaves snapshot.json NEWER than
dist/index.html -- so /ping advertised a build the served page could not
possibly carry, the dashboard reloaded, landed on the same old page, saw the
same newer stamp, and reloaded again. Forever, on the phone.

Fixed at BOTH ends, deliberately:
  * serve.py compares mtimes and reports `built: null` when dist/index.html is
    older than snapshot.json -- never advertise a build the page cannot have.
  * App.tsx records the build stamp it reloaded for in sessionStorage and will
    reload AT MOST ONCE per stamp; a reload that changed nothing is thereafter
    only ever OFFERED, never repeated.

Verified: navigations after load = 1; with snapshot.json touched newer,
ping.built = null.

---

# 2026-08-25 — sleep UI from the Apple Health references, + readiness headroom

## Hypnogram (Charts.tsx)

* TIME AXIS on even wall-clock hours with gridlines. There was none before, so
  you could see THAT deep sleep happened but never WHEN -- most of the point of
  a hypnogram. Interval = smallest of [1,2,3,4,6]h keeping <=5 labels.
* TRANSITION CONNECTORS: one thin line per stage change, lane-to-lane, coloured
  by destination. Turns a field of disconnected blocks into one path; this is
  what makes cycling legible.
* Night labelled "Aug 24-25", not "2026-08-25". A night crossing midnight
  belongs to two dates -- the same ambiguity that let a 23:27 onset be filed a
  day forward in the decoder.
* OVERNIGHT HR + SpO2 on the SAME x-scale (NightSeries). HR is stored as
  absolute timestamps, SpO2 as (day, minute-of-day); both normalise to instants
  so the drawing code never knows the difference.

  Marks sit AT the value -- NOT bars from a baseline. Bottom-anchored bars
  assert a meaningful zero and neither series has one: overnight SpO2 spans
  96-99%, so a 96 drawn at a quarter the height of a 99 claims a fourfold
  difference that does not exist. First version had that bug.
  Range label lives with the row LABEL; drawn inside the plot it sat on top of
  the data it described.

  Both use --brand: the app's convention is one series, one brand hue (every
  SeriesChart does this). Inventing hues here would collide with the stage
  colours directly above.

NOT taken from Apple: stage pills (ours is a table WITH share %), D/W/M/6M
(three days of history would be four empty tabs).

## readiness.headroom (score.py)

"77" invites the wrong question. The gap to 100 splits into two things that look
identical on the dial and have OPPOSITE remedies:

    MEASUREMENT  how last night scored against your own range
    CONFIDENCE   the shrink applied to short/borrowed baselines -- not you

Inverting the shrink recovers the raw score: raw = 50 + (shown - 50) / conf.
Today: gap 23.1 = 10.0 measurement + 13.1 confidence. Sleep scored raw 90 and
was held to 70 purely because the baseline is Watch-derived and capped at 0.5.

Locked components are listed separately with what unlocks them, because a
dropped component costs CONFIDENCE, not points -- telling someone to "improve
your HRV" when the truth is "the baseline needs three more nights" is advice
they cannot act on. sleep_quality is reported "not measurable" rather than
given a fake action.

## Trap worth remembering

`\uXXXX` inside a JSX TEXT NODE is literal text, not an escape -- it rendered as
"score’s" on the page. Same class as the °F bug. Inside a JS template
literal (nightLabel) it IS an escape and works. Real characters in JSX text.

---

# 2026-08-26 — the Mac pairing prompt, and a battery that stopped updating

## Why a pairing prompt appeared to come FROM the ring

I bootstrapped com.nikhi.smartring.sync on 2026-08-25 (it had been dead since
08-24). Hourly + on-wake. It reached the ring, called discoverCharacteristics,
and the RING replied Insufficient Authentication -- it requires an encrypted
link. CoreBluetooth then started SMP pairing and macOS raised its system dialog,
which names the PERIPHERAL and never the app that triggered it. Pairing was not
completed, so the ring dropped the link -> BleakError: disconnected.

Bonding is per-central and NOT exclusive: the iPhone's bond does not lock the
Mac out. Only the CONNECTION is exclusive, and the ring advertises whenever the
phone has released it. Consistent with the iOS A/B test (declining gave
`number: 2` on every characteristic).

Guard rewritten: autosync.sh now gates on DATA FRESHNESS (newest heart_rates row
older than 6h), not on when the phone last synced. The phone syncs on
foreground, so >45min gaps are normal while everything works, and the old guard
let the Mac grab a healthy ring -- causing exactly the pairing prompt and
stranded link that make you forget the ring in iOS. Verified: with a 1h-old
reading the script logs "phone is keeping up, skipping BLE and rebuilding only".

## Battery froze at 31% straight through a charge

The dashboard rebuilt correctly (14:04:43, right after the 14:03 sync) and every
other series was current. But battery_log had no row after 2026-08-25T15:33.

Cause: the battery step returned ZERO CHUNKS on two consecutive syncs.

    20260826T140330  battery chunks = 0
    20260825T190841  battery chunks = 0
    20260825T153347  battery chunks = 1  ('031f...' -> 0x1f = 31%)

Battery is the FIRST command after connect -- fired while service discovery and
the notification subscription are still settling -- and carried the TIGHTEST
window in the plan at 900ms. There is no error when this happens: the reply
never arrives and the step returns []. That is indistinguishable from "no data
for this day", which is why it went unnoticed for two syncs.

Three fixes:
  1. sync_plan: battery collect_ms 900 -> 2500. Costs 1.6s once per sync.
  2. sync.html: a step returning NOTHING is retried once, but only when
     collect_ms <= 2500 -- retrying the 12s HR collection would double the sync.
  3. snapshot device.battery_at + RingPage shows the level's OWN age, amber past
     6h. Everything else can be current while this one is a day old, so a
     battery percentage without its age cannot be judged. This is the part that
     would have made the original symptom self-evident.

NOTE serve.py does `import sync_plan` INSIDE the handler; Python caches the
module, so a plan change needs the server restarted (launchctl kickstart -k)
or /sync-plan keeps serving the old windows. Caught by checking the SERVED plan
rather than the source.

## Battery expectancy (2026-08-26)

Symptom: "not enough data" for drain/life, right after a charge, while sitting
on 45 hours of good discharge history.

Cause: the rate was computed from the VISIBLE CURVE, and the curve deliberately
starts at the last charge (so a recharge does not draw a vertical cliff). Five
minutes after unplugging there is one point, nothing to divide, "drain unknown".

Fix: `snapshot.battery_life` splits the log into DISCHARGE SEGMENTS and measures
each one. Expectancy does not need the current cycle, it needs any cycle.
  * split where level jumps up by MORE THAN 2 -- a +1/+2 wobble is sensor noise,
    not a charge (the ring logged 61,62,62,60 inside one continuous discharge)
  * a segment under 2h is discarded: quantised 1% steps dominate, and one tick
    across 40 minutes extrapolates to 36%/day
  * prefer the current segment when it qualifies, else the MEDIAN of completed
    ones, so a single heavy day does not set the expectation forever
  * report `basis` and `observed_hours` -- "3.4 days" with no provenance is
    indistinguishable from a guess

Now reads: 29.3%/day - 3.4d on a full charge - measured over 45.1h of the
previous charge. The curve's own "no readings yet" message was reworded so it
no longer implies the ESTIMATE is missing too; only the curve is.

---

# 2026-08-27 — white screen, and Bluefy off-tailnet

## PWA white-screened until deleted and re-added  (THE service worker bug)

    fetch(req).then(r => { cache.put(req, r.clone()); return r; })

`fetch` only REJECTS on transport failure. When the Mac is asleep, Tailscale
Serve answers **502** -- a perfectly valid Response -- so the worker cached that
502 ON TOP of the real index.html and served it forever after. Blank app, and
the only cure was deleting the PWA, because that is what clears storage.

Fixed: only `status === 200 && type !== 'opaque'` may replace a cached copy. On
a bad status the worker keeps what it has; a navigation with nothing usable
falls back to the app shell rather than a browser error page. Cache name bumped
to **ring-v2** and activate() deletes every other cache -- the only way to purge
an already-poisoned v1 entry from the phone.

Also precache './' as well as 'index.html': manifest start_url is '.', and the
Cache API is URL-keyed, so a launch requesting '/' never matched '/index.html'.

Verified: a non-200 leaves the cached copy intact and is not served; offline
reload still renders the app.

## Bluefy could not open off the tailnet

serve.py sent `Cache-Control: no-cache, must-revalidate` for EVERYTHING from a
blanket end_headers(). Bluefy has no service worker, so the HTTP cache is its
only offline mechanism -- and `no-cache` forces a revalidation against the Mac
on every load. Off the tailnet that fails and the page will not open at all,
which is exactly when a sync matters most.

Now `OFFLINE_ASSETS` (sync.html, ring-engine.js, params.json, icons, manifest)
get `max-age=86400, stale-while-revalidate=604800, stale-if-error=604800`.
24h from cache with NO network is the guarantee (max-age is universal); the
stale-* extensions add a best-effort week.

index.html is deliberately NOT in that set: it has a real service worker doing
network-first, and HTTP-caching it too would fight the newer-build detection.

Staleness is cheap by design -- sync.html is a dumb pipe that pulls the command
plan from /sync-plan at runtime -- but sync.html now also re-fetches itself and
ring-engine.js with `cache: 'reload'` on boot when online, so shipping a fix
leaves you at most ONE launch behind instead of 24 hours.

Verified with service workers disabled (Bluefy simulation): fresh navigation
while offline LOADS, sync button present, params in localStorage.
NOTE reload() sends a revalidation and bypasses a fresh cache -- test the
bookmark path with a normal navigation or you will wrongly conclude it failed.

## Tailscale CLI note

tailscaled runs with `--tun=userspace-networking --socket=~/.tailscale/tailscaled.sock`.
The default CLI socket path does NOT work; use
`tailscale --socket=/Users/nikhi/.tailscale/tailscaled.sock ...`.
The Mac also cannot resolve its own ts.net name in userspace mode -- curl from
the Mac fails while peers are served fine. Do not read that as "serve is down".

---

# 2026-08-27 — the Bluefy -> PWA handoff is BUILT (was "NOT STARTED")

Supersedes the NOT STARTED list at the top of this file.

## Shape

    Bluefy (sync.html)                    Safari (dashboard)
      decodes the capture                   holds the HISTORY (cached snapshot)
      builds a DECODED payload   --#h=-->   merges it on, keyed by day
      ~3.6 KB gzipped                       renders as if the Mac had built it

Payload travels in the FRAGMENT: never sent to a server, never in a log.
DECODED summaries, never raw hex -- the raw capture is tens of KB the dashboard
cannot read, while the decoded form is what it renders. Raw bytes still upload
to the Mac by the normal path, so this stays a display shortcut.

## Files

* `web/handoff.js`  -- codec. JSON -> gzip (CompressionStream) -> base64url,
  version-tagged. ONE copy: sync.html loads it as a module, the app reaches it
  through the vite `@handoff` alias, so the wire format cannot drift between two
  apps that cannot see each other's storage. `app/src/handoff.d.ts` types it.
* `web/sync.html`   -- buildHandoff() + "Update dashboard" button + auto-attempt
  at `x-safari-https:` with an in-place fallback 1.2s later (Bluefy may refuse
  the scheme; nothing happens at all if it does, no error to catch).
* `app/src/lib/overlay.ts` -- decode, persist, strip, merge. Runs in main.tsx
  BEFORE first render, so no page knows an overlay exists and nothing renders
  the Mac's older numbers and then visibly swaps them.

## Two bugs the tests caught

1. **Unhandled rejection on a corrupt payload.** A stream WRITER's promises
   reject independently of the read side; unhandled they surfaced as an
   unhandled rejection rather than at the await, so a mangled fragment took the
   page down instead of returning null. Both gzip and gunzip now swallow the
   writer promises; the read side reports failure. Verified: corrupt,
   truncated, foreign and wrong-version payloads all return null, no rejections.

2. **A fragment-only navigation does NOT reload the page.** If Safari already
   has the dashboard open, `.../index.html#h=...` changes the fragment in place:
   main.tsx never re-runs and the payload is never seen. Fixed with a
   `hashchange` listener that stores the payload, strips the fragment, and
   reloads -- the normal boot path then applies it exactly as on a cold open.
   Verified: cold open AND warm hashchange both apply it, hash stripped, and
   navigation count is stable afterwards (one reload, no loop).

## Deliberate limits

* Overlay is DROPPED the moment `meta.generated_at` passes its timestamp -- by
  then the Mac has re-decoded the same bytes with full history behind it.
  (This is why an e2e test that opens the dashboard first appears to "fail":
  the dashboard's drain uploads the capture, the Mac rebuilds, and the overlay
  is correctly redundant.)
* `readiness.headroom` is blanked under an overlay. It is a Python computation
  over full baselines; pairing the Mac's breakdown with the phone's score would
  describe a gap that does not match the number above it.
* Component display/delta strings come from score.py and are not reproduced;
  `explain` stands in rather than showing the Mac's sentence about another night.
* A provenance banner is always shown. These numbers were scored on the phone
  against cached baselines -- close, but not the same computation.
