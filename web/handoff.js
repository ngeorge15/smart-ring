/* =============================================================================
   Carrying one decoded capture from Bluefy to the dashboard.

   WHY THIS EXISTS AT ALL
   ----------------------
   sync.html runs in Bluefy (the only iOS browser with Web Bluetooth); the
   dashboard runs in Safari. They are separate iOS apps, so they have separate
   storage jars -- Safari cannot read Bluefy's IndexedDB. And the dashboard
   cannot simply move to Bluefy, because service workers do not register there,
   so with the Mac asleep it would not even load.

       Safari : loads offline YES, data frozen at the last Mac build
       Bluefy : fresh data YES, cannot load offline

   The only channel between two iOS apps that needs no server is a URL. So the
   payload travels in the FRAGMENT (#h=...), which is never sent to any server
   and never lands in a log.

   WHAT TRAVELS
   ------------
   DECODED SUMMARIES, never the raw hex. The raw capture is tens of KB of
   notification bytes; the decoded night, HR curve and daily series are a few KB
   and are what the dashboard actually renders. The raw bytes still go to the
   Mac by the normal upload path -- this is a display shortcut, not a second
   source of truth.
   ========================================================================== */

export const HANDOFF_VERSION = 2;

const b64urlEncode = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlDecode = (str) => {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

async function gzip(bytes) {
  // CompressionStream is Safari 16.4+. Absent, the payload simply travels
  // uncompressed -- a few KB more in a fragment nobody reads.
  if (typeof CompressionStream === "undefined") return null;
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  // The WRITER's promises reject independently of the read side. Left
  // unhandled they surface as an unhandled rejection -- not at the await
  // below -- so a corrupt payload took the whole page down instead of
  // returning null. Swallow them here; the read side reports the failure.
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzip(bytes) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/** Object -> fragment-safe string. Prefixed so the reader never has to guess. */
export async function encodeHandoff(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  const z = await gzip(raw).catch(() => null);
  return z ? "z" + b64urlEncode(z) : "r" + b64urlEncode(raw);
}

/** Fragment string -> object, or null if it is not ours / not intact. */
export async function decodeHandoff(str) {
  if (!str || str.length < 2) return null;
  try {
    const body = b64urlDecode(str.slice(1));
    const raw = str[0] === "z" ? await gunzip(body) : body;
    const obj = JSON.parse(new TextDecoder().decode(raw));
    // A payload from a future build could merge fields this dashboard does not
    // understand. Refuse rather than half-apply it.
    if (!obj || obj.v !== HANDOFF_VERSION) return null;
    return obj;
  } catch {
    return null;
  }
}
