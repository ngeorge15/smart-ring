import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, rebuildDashboard } from '../app/src/lib/http.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('refresh rejects an unsuccessful rebuild even when HTTP is 200', async () => {
  globalThis.fetch = async () => Response.json({ ok: false });
  await assert.rejects(rebuildDashboard(), /rebuild failed/);
});

test('refresh requires explicit success and rejects HTTP failures', async () => {
  for (const response of [Response.json({}), Response.json({ ok: true }, { status: 503 })]) {
    globalThis.fetch = async () => response;
    await assert.rejects(rebuildDashboard());
  }
  globalThis.fetch = async () => Response.json({ ok: true });
  await rebuildDashboard();
});

test('HTML fallback is not mistaken for a successful API response', async () => {
  globalThis.fetch = async () => new Response('<html>cached dashboard</html>');
  await assert.rejects(fetchJson('ping'));
});

test('a stalled body is aborted, not just a stalled connection', async () => {
  let aborted = false;
  globalThis.fetch = async (_url, { signal }) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  await assert.rejects(fetchJson('ping', {}, 10), { name: 'AbortError' });
  assert.equal(aborted, true);
});
