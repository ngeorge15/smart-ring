/* Type surface for the shared decode engine at ../web/ring-engine.js.
   Lives outside the app for the same reason as @handoff — sync.html loads the
   very same file at runtime, so there is one decoder with one definition. */
declare module "@ring-engine" {
  export function hexToBytes(hex: string): Uint8Array;
  export function decodeBattery(chunks: string[]): { level: number; charging: boolean } | null;
  export function splitMessages(blob: Uint8Array): { type: number; body: Uint8Array }[];
  export function decodeSleep(msg: { type: number; body: Uint8Array }): {
    days_ago: number; start: number; end: number; wrapped: boolean;
    in_bed_min: number; asleep_min: number; efficiency: number | null;
    checksum_ok: boolean; stages: Record<string, number>;
    segments: { stage: string; minutes: number }[];
  }[];
  export function decodeLog(cmd: number, chunks: string[]):
    { day_offset: number; interval: number; values: (number | null)[] } | null;
  export function decodeHeartRateLog(chunks: string[]):
    { samples: { at: Date; bpm: number }[] } | null;
  export function decodeSportDetail(chunks: string[]): {
    year: number; month: number; day: number; steps: number;
    calories: number; distance: number;
  }[];
  export function decodeSpo2(chunks: string[]):
    { days_ago: number; interval: number; values: (number | null)[] }[];
  export function decodeTemperature(chunks: string[]):
    { days_ago: number; interval: number; values: (number | null)[] }[];
  export function clipImpossible(values: (number | null)[], kind: string): (number | null)[];
  export function hampel(values: (number | null)[], window?: number,
                          nSigmas?: number, minPeriods?: number): (number | null)[];
  export function cleanSeries(values: (number | null)[], kind: string): (number | null)[];
  export function mean(xs: (number | null)[]): number | null;
  export function readiness(inputs: {
    asleep_min: number | null; efficiency: number | null; resting_hr: number | null;
    hrv: number | null; stress: number | null;
  }, params: unknown): {
    score: number | null; confidence: number;
    components: { name: string; value: number | null; score: number | null;
                  weight: number; confidence: number; explain: string;
                  available: boolean }[];
  };
}
