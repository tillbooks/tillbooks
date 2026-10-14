/**
 * Test helpers for the Studio key (critic probe P6, `src/api/session.ts`).
 *
 * The local HTTP faces hand the human `studio` seat ONLY to a request carrying the host's per-launch
 * Studio key. A suite that acts as the Studio over HTTP gets the key HERE, out of the printed link the
 * way the real Studio does, or from the host that minted it, and never by weakening the check: there is no flag
 * that turns the check off, in tests or anywhere else.
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { createLocalHttpRouter } from '../../dist/api/local-http.js';

/** The header the Studio key travels in (`STUDIO_KEY_HEADER` in `src/api/session.ts`). */
export const STUDIO_KEY_HEADER = 'x-till-studio-key';

/**
 * Mint a key for a router a suite builds itself: the same 32 CSPRNG bytes as base64url a host mints
 * (`session.mintStudioKey`, whose shape `studio-key-seat.test.mjs` pins). Minted here rather than
 * through the engine so a suite run against an engine without the key still reaches its assertions.
 */
export function mintStudioKey() {
  return randomBytes(32).toString('base64url');
}

/** The header that makes a request the Studio's. */
export function studioHeaders(studioKey) {
  return { [STUDIO_KEY_HEADER]: studioKey };
}

/** POST one REST twin as the Studio. Returns the parsed body; `{ status, body }` with `withStatus`. */
export async function postAsStudio(baseUrl, action, input, studioKey, extraHeaders = {}) {
  const resp = await fetch(`${baseUrl}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...studioHeaders(studioKey), ...extraHeaders },
    body: JSON.stringify(input ?? {}),
  });
  return { status: resp.status, body: await resp.json() };
}

/**
 * Read the key out of the Studio LINK a host prints (`till up`'s `studioUrl`), exactly as the browser
 * does: from the `#k=` fragment. The served page carries no key (critic R3-B2). Throws when the link
 * has none, so a host that stopped handing it out fails loudly.
 */
export function studioKeyFromLink(link) {
  const hash = typeof link === 'string' ? new URL(link).hash.replace(/^#/, '') : '';
  const key = new URLSearchParams(hash).get('k');
  if (key === null || key === '') throw new Error(`the Studio link ${String(link)} carries no Studio key`);
  return key;
}

/** Every 43-character base64url run in a text: what a scraper would try as a key. */
export function keyShapedRuns(text) {
  return text.match(/[A-Za-z0-9_-]{43,}/g) ?? [];
}

/**
 * A router the way the hosts that serve the Studio build it (`rest: true` plus a freshly minted key),
 * mounted on a loopback listener. Returns `{ url, port, studioKey, router, server, close }`.
 */
export async function listenStudioRouter(deps, opts = {}) {
  const studioKey = opts.studioKey ?? mintStudioKey();
  const router = createLocalHttpRouter(deps, { rest: true, ...opts, studioKey });
  const server = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    studioKey,
    router,
    server,
    async close() {
      await router.closeAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
