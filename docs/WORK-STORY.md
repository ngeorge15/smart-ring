# Smart Ring — Engineering Work Story

A working document for resume bullets and interview prep. Every number and file
reference here is real and checkable in the repo. Re-upload this to Claude when
you need to tailor answers to a specific question or company.

---

## 1. What it is, in one breath

A local-first health tracker built on a ~$20 Colmi R02 smart ring whose vendor
app I didn't want to trust with my data. I reverse-engineered its BLE protocol,
built a Python analysis pipeline (sleep staging, readiness scoring, energy
expenditure, weekly trends, sleep debt), a React dashboard, and — because iOS
gives a laptop no way to reach a ring overnight — a phone-side capture path
using Web Bluetooth, with everything served privately over Tailscale.

**Scale of the thing:** ~4,000 lines across Python/TypeScript/JS, 3 runtimes
(Python analysis, browser dashboard, phone capture page), 2 independent decoder
implementations held to 101 cross-checked assertions, ~500K Apple Health records
reduced to ~50 baseline numbers so a phone can score offline.

**The constraint that shaped everything:** the ring accepts exactly one BLE
connection, only advertises when nothing is connected, and requires bonding.
Every architectural decision downstream traces back to that.

---

## 2. Architecture decisions (and the reasoning, not just the choice)

### Python is the source of truth; JavaScript is a display engine
The phone must show a readiness score with the laptop asleep, so scoring has to
exist in JS. But duplicating a *model* across two languages is how they drift.

Resolution: **duplicate only the evaluator, never the parameters.** Weights,
percentile anchors, baselines and thresholds are emitted once by Python into
`params.json` and consumed as data by both engines. Changing a rule changes both
at once. `tools/verify.sh` then holds the two implementations to the same
assertions on real captured bytes.

*Why it matters in interview terms:* it's a deliberate, testable answer to "how
do you keep two implementations honest" that isn't "we'll be careful."

### The phone is a dumb pipe
`tools/sync_plan.py` serves the BLE command sequence as **data** over
`/sync-plan`. The phone writes bytes, collects notification bytes, and posts
them back. It holds no protocol knowledge at all.

Payoff: a decode fix is a Python edit on the laptop with **no phone-side
deploy** — which matters enormously when the client is a page loaded in a
third-party browser you can't debug properly.

### Queue before upload
A capture is written to IndexedDB *before* any upload is attempted, so a sync
with the laptop asleep is still a successful sync. This is what actually closes
the overnight gap: the phone is the always-on device, not the laptop.

### Cached snapshot as the history; the phone only extends the tail
When asked to make the dashboard accurate offline, the naive read is "port the
analysis to JS." The right read was that the *expensive* parts — 90 days of
baselines, 8 weekly trend buckets, 14 nights of debt — are slow-moving and
already cached. Only the newest day is missing. So the phone appends one day and
the derived numbers re-run over cached history.

That reframing turned a large port into a small merge.

---

## 3. Where I deliberately went simple

Good engineering judgment shows up more in what you *didn't* build.

**Rejected a fancier sleep-debt baseline.** The tempting target was the person's
own 75th-percentile night (9h12m). I rejected it: for a high-variance sleeper,
long nights are mostly *recovery from prior debt* — the effect being measured,
fed back in as the baseline. Shipped the flat 8h standard with the reasoning
written into the code (`trends.py`, `DEFAULT_TARGET_MIN`).

**Refused to merge step counts across devices.** The ring read 0.51× the Watch
one day and 2.23× the next. Merging would put a step change into a trend line
that looks exactly like a change in behaviour — the one thing a trend exists to
detect. Shipped `steps_calibrated: false` in the payload and used the Watch
alone until a calibration factor exists. **Chose to show less rather than show
something wrong.**

**Gave up on background sync after proving it impossible.** Researched
exhaustively: no Background Sync API in any WebKit, JS suspended when the app
backgrounds, `UIBackgroundModes` is app-level only. Rather than keep pushing,
shipped **sync-on-foreground** — which also removed the force-quit habit that
was itself stranding the ring. The constraint became the feature.

**Didn't move the dashboard into the Bluetooth browser.** It would have solved
data sharing in one line — and broken offline loading entirely, because service
workers don't register there. Verified the blocker before building on it.

**Deleted my own dead code.** `drainQueue()` in the dashboard read an IndexedDB
store that only exists in another iOS app's storage jar. It looked correct in a
desktop browser, where both pages share one origin. Removed rather than left to
mislead.

---

## 4. Where I spent the time to get it exactly right

**Fitted a physiological constant instead of picking one.** Energy expenditure
needed an intensity floor below which heart rate reflects posture and caffeine
rather than work. Rather than guessing, I fitted it against 868 days where the
Watch recorded *both* HR and its own active energy:

```
floor 20% HRR -> median ratio 2.38   (over by 138%)
floor 25% HRR -> 1.65
floor 30% HRR -> 1.08   <- adopted, essentially unbiased
floor 40% HRR -> 0.51   (under by half)
```

**Then admitted my own model was the weaker one.** Measured on the same 868
days: HR alone 49.9% median error, **steps alone 26.0%**, blended 14.7% — 14.6%
out-of-sample when fit on half and tested on the rest. The heart-rate model I'd
built was worse than the simple thing. Shipped the blend.

**Fuzz-tested a port against its reference.** Porting pandas' Hampel filter, I
found the MAD is a *rolling median of the deviation series* (each point against
its own local median, then smoothed) — not the obvious "median of |x − med| in
the window." Those give different numbers. Verified with 300 randomly generated
series: 300/300 exact match.

**Chased a 0.23-point divergence to its root.** `params.json` was rounding
percentile anchors to 2dp, which put a value that sat exactly on p50 in Python
just below it in JS. Emitted at 6dp; the anchors are compared against raw
measurements, so they must carry the precision of those measurements.

---

## 5. Risk management

- **Tailscale Serve, never Funnel.** Funnel publishes to the public internet,
  and Certificate Transparency logs make the hostname discoverable. This is
  health data; tailnet-only, always.
- **Handoff payload rides in the URL *fragment*.** Fragments are never sent to a
  server and never land in an access log.
- **Return-URL validation.** The sync page accepts a `return` parameter; it's
  regex-validated to relative paths so an attacker-supplied URL can't redirect
  off-site.
- **The service worker only caches HTTP 200.** See §6.
- **Reload-once guard.** The auto-update path records the build stamp it
  reloaded for in `sessionStorage`, so a reload that changes nothing is
  thereafter only *offered*, never repeated — belt-and-braces against an
  infinite reload loop on a phone.
- **Cache version bump as a remote kill switch.** Bumping `ring-v1` → `ring-v2`
  with `activate()` deleting all other caches was the only way to purge a
  poisoned entry from a device I couldn't reach.
- **Honest confidence, everywhere.** Cross-device baselines are capped at 0.5
  confidence; unscoreable components are dropped and the *available weight* is
  reported rather than silently renormalised.

---

## 6. Bug catalogue — each with its lesson

These are the strongest interview material because each has a concrete
detection story, a root cause, and a generalisable lesson.

### Silent data loss (the worst one)
Two timestamp formats in one column — the library wrote microseconds, my ingest
path didn't. pandas' date inference produced `NaT` for whichever it didn't
guess, and `dropna()` then deleted them: **243 of 489 heart-rate rows gone.**
Separately, a `UNIQUE` constraint that didn't actually dedupe let steps
double-count: **6,687 vs a true 3,458.**

*Fix:* `format="mixed"`, matching write format, a `normalise_timestamps()` pass,
DB backup, then dedupe. *Lesson:* the dangerous bug isn't the crash — it's the
one that silently deletes and still renders a plausible chart.

### The white screen that required deleting the app
```js
fetch(req).then(r => { cache.put(req, r.clone()); return r; })
```
`fetch` only *rejects* on transport failure. With the laptop asleep, Tailscale
Serve answers **502** — a perfectly valid Response — so the worker cached that
502 on top of the real `index.html` and served it forever. The only cure was
deleting the PWA, because that's what clears storage.

*Fix:* only `status === 200` may replace a cached copy; navigation falls back to
the app shell; cache name bumped to purge poisoned entries. *Lesson:* "the
request succeeded" and "the response is good" are different questions.

### A night filed into the future
The ring stores sleep as minutes-from-midnight and **both endpoints wrap**.
`end < start` means the night crossed midnight. Neither engine handled it:
```
start 1407 (23:27)   end 667 (11:07)
naive:  667 - 1407      = -740   -> checksum FAIL, negative duration
truth:  (667+1440)-1407 =  700   -> 11h40m
```
The onset was dated a day late, pushing the night *outside* the 14-night debt
window, and the failed checksum made the phone discard it. My best recorded
night was invisible in both places.

Invisible for weeks because every earlier night began *after* midnight, where
the naive and correct readings agree. *Lesson:* a validity check that fails on
correct data is worse than no check — it silently discards truth.

### Battery frozen through a charge
Battery is the first command after connect and carried the tightest window in
the plan (900 ms), fired while service discovery was still settling. It returned
zero chunks on two consecutive syncs. There's no error for this — the reply
never arrives and the step returns `[]`, indistinguishable from "no data."

*Fix:* wider window, retry for cheap steps, and — most importantly — the reading
now carries **its own age** in the UI, amber past 6h. *Lesson:* when one signal
can fail independently of the others, it has to display its own freshness; the
UI change is what would have made the bug self-evident.

### A five-week gap rendered as a week-over-week change
Weekly trends dropped empty weeks, then computed deltas against the previous
*row*. A five-week silence was reported as "+5.5 slipping."

*Fix:* empty weeks are emitted with `value: null`, so every metric shares one
x-axis, and a delta is `null` unless the previous bucket is the immediately
preceding week. *Lesson:* absent data must occupy space, or the axis lies.

### Three LaunchAgent PATH bugs in a row
launchd does not inherit a login shell's PATH. First a python without pandas,
then npm not found, then npm unable to find node. *Fix:* the interpreter is
chosen by **testing for pandas**, not by assuming a path.

### A GATT timeout I invented
I set a 15-second connection timeout with no evidence. Real connects take 14–26
seconds. The user caught it: *"it connected but you assumed it failed."*
*Lesson:* don't invent a threshold you haven't measured — I removed the race
entirely rather than picking a new guess.

### A connect that resolved 31 minutes after we gave up
```
11:13:27  backgrounded mid-sync — aborting
11:43:23  connected in 1862.3s
```
It handed back a live GATT link nothing was tracking, on a ring that accepts one
connection. That's the state that strands the ring and forces a Bluetooth
toggle. *Fix:* check the abort flag on resolve and disconnect immediately.

### Others worth a sentence
- **IndexedDB destroyed a completed sync** — a store failure after 33s of
  successful capture. Now non-fatal: the capture stays in memory and uploads.
- **`params:none` forever** — `getParams()` sat below an early return, so it only
  ran while a capture existed, and captures are deleted on upload. The
  self-check compounded it by querying the wrong store.
- **Fragment-only navigation doesn't reload** — so a payload arriving at an
  already-open tab was never seen.
- **Stream writer rejections escaped `try/catch`** — a corrupt payload crashed
  the page instead of returning null.
- **`\uXXXX` in a JSX text node is literal text**, not an escape. Hit twice
  (`°F`, then `’`).

---

## 7. Testing strategy

**The suite grew 39 → 101 assertions**, and its design point is unusual and
worth explaining in an interview:

- **Cross-engine assertions** on *real captured bytes*, not synthetic fixtures —
  the two decoder implementations must agree on the same input.
- **Property tests** for the Python-only pieces that have no twin: battery
  expectancy invariants (noise doesn't split a discharge cycle; a real recharge
  does; sub-2h segments are ignored), and readiness-headroom invariants (the gap
  equals shrink + measurement; inverting the shrink never invents a score above
  the raw one).
- **Fuzzing** where a port had to match a reference implementation exactly.
- **Repo-tracked fixtures.** The sleep fixture originally read from `/tmp` — one
  reboot from silently not running. Moved into the repo, and deliberately chose
  the capture containing the midnight-crossing night so that regression is
  permanently covered.

**End-to-end browser testing** with headless Chrome driving the actually-served
app. It caught: an infinite reload loop, the fragment-navigation bug,
zero-width selection markers (percentage padding on a `flex-basis: 0` item
collapses the content box), a literal-escape rendering bug, and cache poisoning.

**A failing test is a hypothesis about the test, too.** Two of my own tests were
wrong in instructive ways: `reload()` sends a revalidation that bypasses a fresh
HTTP cache (so it wrongly "proved" offline loading was broken), and opening the
dashboard before applying a handoff caused it to upload the capture, rebuild,
and correctly discard the overlay as redundant — the system working, the test
misleading.

---

## 8. Things I reworked entirely

- **Calorie model, twice.** Keytel et al. (2005) → gave 3,733 kcal for an
  ordinary day against a measured ~110–280, because it's fitted on *exercising*
  subjects and reads a seated HR of 80 as exertion. → %HRR with a fitted floor →
  HR + steps blend once measurement showed HR alone was the weaker predictor.
- **Sync architecture, laptop-primary → phone-primary.** The laptop can't reach
  the ring overnight; the phone is the always-on device.
- **The offline story, three times.** "Service worker everywhere" → discovered
  SWs don't register in the Bluetooth browser → "SW in Safari, HTTP cache in
  Bluefy, plus a fragment handoff to bridge two apps that cannot share storage."
- **Trend bar selection, twice.** Brand colour was doing two jobs (latest *and*
  selected) — the exact ambiguity reported. Now brand means selected, full stop;
  recency is carried by text.
- **Light mode, three times**, on direct feedback that it was too bright.

---

## 9. Metrics worth quoting

| Metric | Value |
|---|---|
| Calorie model error (median, out-of-sample) | 49.9% → 26.0% → **14.6%** |
| Model fitting set | 868 paired Watch days |
| Hampel port verification | **300/300** random series exact vs pandas |
| Test suite | 39 → **101** assertions |
| Dashboard payload | 834 KB → **282 KB** gzipped |
| Baseline compression | ~500K Apple Health records → ~50 numbers |
| Handoff payload | **3.6 KB** gzipped (full night + 288-point HR curve) |
| Battery expectancy | 29.3%/day → **3.4 days**, from 45.1h observed |
| Sleep-debt correction | invisible night recovered; debt 446m → **226m** |

---

## 10. Mapping to common interview questions

- **"Tell me about a hard bug."** → the silent data loss (§6), or the white
  screen (§6). Both have clean detection → root cause → fix → lesson arcs.
- **"A time you shipped something imperfect."** → `steps_calibrated: false`,
  confidence caps, publishing a 46% error bar rather than hiding it.
- **"A time you went back and did it properly."** → the fitted HRR floor, the
  Hampel fuzz, the 6dp params fix.
- **"Disagreed with your own earlier decision."** → replacing my heart-rate
  calorie model after measuring that steps alone beat it.
- **"How do you manage risk?"** → §5, especially Serve-not-Funnel and the cache
  version bump as a remote kill switch.
- **"How do you test something you can't easily test?"** → §7: cross-engine
  assertions on real bytes, property tests where no twin exists, headless E2E,
  and treating a failing test as a hypothesis about the test.
- **"A time you simplified."** → §3, especially refusing to merge step counts
  and killing background sync after proving it impossible.
