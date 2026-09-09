// m-4: the localhost guard's accepted cases, stated as intent instead of left implicit.
//
// The guard has two deliberately wide doors: it accepts a request with NO Origin header, and it
// accepts any `*.localhost` origin. Both are defensible, and both were undocumented, which meant a
// later reader could not tell a decision from an oversight and could "tighten" or "loosen" either
// one without knowing what it was for. `src/api/local-guard.ts` now carries the reasoning; these
// tests pin it, together with the boundary each door stops at.
//
// Everything here goes through the REAL router over real HTTP, at a registry-reaching face, because
// what matters is what the mounted endpoint does, not what the predicate returns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';

import { createLocalHttpRouter } from '../../dist/api/local-http.js';
import { makeApiDeps } from '../../dist/api/mcp.js';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } },
});

async function withRouter(body) {
  const { deps, store } = makeApiDeps();
  const router = createLocalHttpRouter(deps, { rest: true });
  const http = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();

  /** Status for a request carrying `headers`. Host is whatever fetch sets: 127.0.0.1. */
  const withOrigin = async (origin) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(origin === undefined ? {} : { origin }),
      },
      body: INITIALIZE,
    });
    return res.status;
  };

  /** Status for a raw request with a forged Host, the way a rebound name arrives. */
  const withHost = (host) =>
    new Promise((resolve, reject) => {
      const socket = createConnection(port, '127.0.0.1', () => {
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
            `Accept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(INITIALIZE)}\r\n` +
            `Connection: close\r\n\r\n${INITIALIZE}`,
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
      socket.on('error', reject);
    });

  try {
    await body({ port, withOrigin, withHost });
  } finally {
    await router.closeAll();
    await new Promise((resolve) => http.close(resolve));
    store.close();
  }
}

test('m-4 ACCEPTED (1/2): a missing Origin passes, because the browser is the threat and it always sends one', async () => {
  await withRouter(async ({ withOrigin }) => {
    // The `till` CLI, an agent subprocess, curl and the MCP SDK's HTTP client all send no Origin.
    // A rebound page cannot suppress it on a cross-origin fetch, so requiring the header would lock
    // out every real local client while stopping no browser attack. Host is checked regardless.
    assert.equal(await withOrigin(undefined), 200, 'a non-browser local client sends no Origin and must pass');
  });
});

test('m-4 BOUNDARY: "no Origin" does NOT mean "any Origin"', async () => {
  await withRouter(async ({ withOrigin }) => {
    assert.equal(await withOrigin('null'), 403, 'a sandboxed page sends the literal "null" and is not local');
    assert.equal(await withOrigin('https://evil.example'), 403);
    // Userinfo is not the host: a URL that merely mentions localhost before an @ is a foreign origin.
    assert.equal(await withOrigin('http://localhost@evil.example'), 403);
  });
});

test('m-4 ACCEPTED (2/2): any *.localhost name passes, per RFC 6761 section 6.3', async () => {
  await withRouter(async ({ withOrigin, withHost }) => {
    // RFC 6761 section 6.3 makes localhost names special: users "may presume that IPv4 and IPv6
    // address queries for localhost names will always resolve to the respective IP loopback
    // address", and resolvers SHOULD always answer them with loopback. Such a name therefore cannot
    // be rebound to an attacker's address by a hostile DNS server, which is the attack being
    // defended against, and a developer may address the bridge by a readable name.
    assert.equal(await withHost('studio.localhost:1234'), 200);
    assert.equal(await withOrigin('http://studio.localhost:5173'), 200);
    assert.equal(await withOrigin('https://deep.sub.localhost'), 200);
  });
});

test('m-4 BOUNDARY: the *.localhost door is anchored on the DOT, never on the substring', async () => {
  await withRouter(async ({ withOrigin, withHost }) => {
    // These are the names an attacker actually registers. Every one is a domain they control.
    assert.equal(await withHost('evil-localhost.com'), 403);
    assert.equal(await withHost('localhost.evil.com'), 403);
    assert.equal(await withHost('xn--localhost-.com'), 403);
    assert.equal(await withOrigin('http://127.0.0.1.evil.com'), 403);
    assert.equal(await withOrigin('http://localhost.evil.com'), 403);
  });
});

test('m-4: a Host header is mandatory, and hostname matching is case-insensitive', async () => {
  await withRouter(async ({ port, withOrigin, withHost }) => {
    // HTTP/1.0 may omit Host. Absent is refused, not defaulted: the guard has nothing to check.
    const hostless = await new Promise((resolve, reject) => {
      const socket = createConnection(port, '127.0.0.1', () => {
        socket.write(`POST /mcp HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(hostless, /^HTTP\/1\.1 403/, 'a request with no Host must be refused');
    assert.match(hostless, /forbidden_host/);

    // Scheme and host are case-insensitive per RFC 3986, so the guard lowercases before matching.
    // (No port on this one: Node's own HTTP parser rejects an uppercase host WITH a port at 400,
    // before any of this runs, which is a parser quirk and not a statement about the guard.)
    assert.equal(await withHost('LOCALHOST'), 200);
    assert.equal(await withOrigin('HTTP://LOCALHOST:5173'), 200);
  });
});

test('m-4 DELIBERATELY STRICT: the trailing-dot FQDN form is refused', async () => {
  await withRouter(async ({ withHost }) => {
    // `localhost.` is the root-anchored spelling of the same name, so refusing it is stricter than
    // RFC 6761 requires. It stays refused on purpose: no real client sends it, hostname matching
    // that normalises before comparing is one more thing that can be got wrong, and the conservative
    // side of an unclear case is the right side for a guard standing in front of the ledger. This
    // test exists so the 403 reads as a decision rather than as an oversight in the suffix test.
    assert.equal(await withHost('localhost.'), 403);
    assert.equal(await withHost('evil.com.'), 403);
  });
});
