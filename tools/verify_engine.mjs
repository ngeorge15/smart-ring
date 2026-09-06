/* Prove the JS engine matches Python on real data. Run: node tools/verify_engine.mjs */
import { readFileSync } from "fs";
import { join } from "node:path";

const fixtureDir = process.env.RING_VERIFY_DIR;
if (!fixtureDir) throw new Error("Run tools/verify.sh to generate isolated fixtures first");
const fixture = (name) => JSON.parse(readFileSync(join(fixtureDir, name)));
import { readiness, decodeSleep, splitMessages, decodeBattery, hexToBytes,
         decodeHeartRateLog, decodeSportDetail, decodeSpo2, decodeTemperature,
         clipImpossible, hampel } from "../web/ring-engine.js";
import { encodeHandoff, decodeHandoff, HANDOFF_VERSION } from "../web/handoff.js";

let fail = 0;
const check = (label, got, want, tol = 0.05) => {
  const ok = want == null ? got == null : Math.abs(got - want) <= tol;
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(26)} js=${got} py=${want}`);
};

console.log("SCORING (JS vs Python, deterministic inputs)");
for (const { name, inputs, params, expected } of fixture("scoring_cases.json")) {
  console.log(`  ${name}`);
  const r = readiness(inputs, params);
  check("readiness score", r.score, expected.score);
  check("confidence", r.confidence, expected.confidence);
  for (const c of r.components) {
    const py = expected.components.find((x) => x.name === c.name);
    check(`  ${c.name}`, c.score, py.score);
    check(`  ${c.name} available`, Number(c.available), Number(py.available), 0);
  }
}

console.log("\nDECODING (phone's real captured bytes)");
const sleepHex = readFileSync(
  new URL("./fixtures/sleep_wrapped.hex", import.meta.url), "utf8").trim();
const msgs = splitMessages(hexToBytes(sleepHex));
const nights = msgs.flatMap(decodeSleep);
const py = fixture("python_sleep.json");
check("nights decoded", nights.length, py.length, 0);
nights.forEach((n, i) => {
  check(`  night ${i} in_bed`, n.in_bed_min, py[i].in_bed_min, 0);
  check(`  night ${i} asleep`, n.asleep_min, py[i].asleep_min, 0);
  check(`  night ${i} segments`, n.segments.length, py[i].n_segs, 0);
  check(`  night ${i} checksum`, n.checksum_ok ? 1 : 0, py[i].checksum_ok ? 1 : 0, 0);
  // The midnight-crossing case, asserted explicitly: a night beginning before
  // midnight must be flagged wrapped in BOTH engines, or the phone drops it.
  check(`  night ${i} wrapped`, n.wrapped ? 1 : 0, py[i].wrapped ? 1 : 0, 0);
});
const bat = decodeBattery(["0347000000000000000000000000004a"]);
check("battery level", bat.level, 71, 0);

console.log("\nHR + STEPS (synthetic packets, both parsers)");
const synth = fixture("synth_packets.json");
const pyHS = fixture("python_hr_steps.json");

const hrLog = decodeHeartRateLog(synth.hr);
check("hr samples", hrLog ? hrLog.samples.length : null, pyHS.hr_count, 0);
if (hrLog) {
  const jsVals = hrLog.samples.map((s) => s.bpm).join(",");
  check("hr values identical", jsVals === pyHS.hr_values.join(",") ? 1 : 0, 1, 0);
}

const sd = decodeSportDetail(synth.steps);
check("step rows", sd.length, pyHS.steps.length, 0);
check("step terminator seen", sd.complete ? 1 : 0, 1, 0);
sd.forEach((r, i) => {
  const py = pyHS.steps[i];
  if (!py) return;
  check(`  row ${i} steps`, r.steps, py.steps, 0);
  check(`  row ${i} calories`, r.calories, py.calories, 0);
  check(`  row ${i} distance`, r.distance, py.distance, 0);
});


/* --------------------------------------------------------------------------
   SpO2 + temperature. Same big-data channel as sleep, same real capture, and
   until now decoded by only one of the two engines with nothing checking that
   the other agreed.
   -------------------------------------------------------------------------- */
console.log("\nSpO2 / TEMPERATURE (phone's real captured bytes)");
const eqList = (label, got, want) => {
  check(label, got.length, want.length, 0);
  for (let i = 0; i < Math.min(got.length, want.length); i++) {
    check(`  ${label} ${i} days_ago`, got[i].days_ago, want[i].days_ago, 0);
    check(`  ${label} ${i} interval`, got[i].interval, want[i].interval, 0);
    const a = got[i].values, b = want[i].values;
    check(`  ${label} ${i} n values`, a.length, b.length, 0);
    // One mismatched sample is a decode bug; count them rather than printing 48
    // lines per day.
    let bad = 0;
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      const x = a[k] == null ? null : a[k], y = b[k] == null ? null : b[k];
      if (x !== y) bad++;
    }
    check(`  ${label} ${i} mismatched`, bad, 0, 0);
  }
};
eqList("spo2",
  decodeSpo2([readFileSync(new URL("./fixtures/spo2.hex", import.meta.url), "utf8").trim()]),
  fixture("python_spo2.json"));
eqList("temp",
  decodeTemperature([readFileSync(new URL("./fixtures/temp.hex", import.meta.url), "utf8").trim()]),
  fixture("python_temp.json"));

/* --------------------------------------------------------------------------
   CLEANING. The filter resting HR is most exposed to: it is a MINIMUM, so one
   impossible low sample moves it directly where a mean would not notice. The
   MAD is a rolling median OF THE DEVIATION SERIES, which is not the obvious
   reading -- exactly the kind of detail that drifts silently between two
   implementations.
   -------------------------------------------------------------------------- */
console.log("\nCLEANING (clip + hampel vs pandas)");
const noisy = JSON.parse(readFileSync(new URL("./fixtures/hr_noisy.json", import.meta.url)));
const pyClean = fixture("python_clean.json");
const jsClipped = clipImpossible(noisy, "bpm");
const jsCleaned = hampel(jsClipped);
const countDiff = (a, b) => a.reduce((n, v, i) => n + ((v ?? null) === (b[i] ?? null) ? 0 : 1), 0);
check("clip mismatched", countDiff(jsClipped, pyClean.clipped), 0, 0);
check("hampel mismatched", countDiff(jsCleaned, pyClean.cleaned), 0, 0);
check("outliers removed", jsCleaned.filter((v) => v == null).length,
      pyClean.cleaned.filter((v) => v == null).length, 0);

/* --------------------------------------------------------------------------
   HANDOFF CODEC. JS-only -- there is no Python twin -- so this checks the
   properties that matter instead: an exact round-trip, and that every way a
   fragment can arrive mangled yields null rather than a throw. A corrupt
   payload used to take the page down through an unhandled stream rejection.
   -------------------------------------------------------------------------- */
console.log("\nHANDOFF CODEC");
let rejected = 0;
process.on("unhandledRejection", () => { rejected++; });
const sample = { v: HANDOFF_VERSION, at: 1787000000000,
  nights: [{ night_of: "2026-08-25", asleep_min: 700, efficiency: 100 }],
  hr: Array.from({ length: 288 }, (_, i) => ({ t: i, v: 55 + (i % 20) })) };
const enc = await encodeHandoff(sample);
check("round-trip identical",
      JSON.stringify(await decodeHandoff(enc)) === JSON.stringify(sample) ? 1 : 0, 1, 0);
check("payload under 8KB", enc.length < 8192 ? 1 : 0, 1, 0);
for (const [label, bad] of [["corrupt", "zGARBAGE"], ["truncated", enc.slice(0, enc.length >> 1)],
                            ["foreign", "hello"], ["empty", ""]]) {
  check(`  ${label} -> null`, (await decodeHandoff(bad)) === null ? 1 : 0, 1, 0);
}
check("wrong version -> null",
      (await decodeHandoff(await encodeHandoff({ ...sample, v: 999 }))) === null ? 1 : 0, 1, 0);
await new Promise((r) => setTimeout(r, 200));
check("no unhandled rejections", rejected, 0, 0);

console.log(fail ? `\n${fail} MISMATCH(ES)` : "\nALL MATCH — engines agree");
process.exit(fail ? 1 : 0);
