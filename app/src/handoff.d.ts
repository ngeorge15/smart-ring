/* Type surface for the shared codec at ../web/handoff.js.

   The implementation lives OUTSIDE the app on purpose: sync.html loads the very
   same file as a plain ES module in Bluefy, so there is one wire format with one
   definition. Vite resolves the "@handoff" alias; tsc needs telling separately. */
declare module "@handoff" {
  export const HANDOFF_VERSION: number;
  export function encodeHandoff(obj: unknown): Promise<string>;
  export function decodeHandoff(str: string): Promise<unknown>;
}
