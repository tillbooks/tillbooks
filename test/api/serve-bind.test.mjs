// The `till serve` bind policy, both halves of it: WHICH ADDRESS and WHICH PORT. One policy, so it
// lives in one file. Every refusal arrives before the store is opened and before anything listens,
// and the announced URL always names the address actually bound.
//
// The address half: loopback is the only address that binds silently, and everything else is refused
// unless TILL_EXPOSE_LEDGER_UNAUTHENTICATED=1 is set, in which case a warning naming the loss goes
// out BEFORE the socket opens. `/mcp` is protected by the Host/Origin guard in `local-guard.ts`,
// which is a DNS-rebinding defence and, by construction, not authentication: a non-browser peer
// writes its own Host header. So a bind to 0.0.0.0 hands the whole action registry, `post_entry` and
// `send_invoice` included, to anything that can route to the port.
//
// The port half: TILL_PORT used to be `Number(raw)`, which reinterprets instead of refusing.
// MEASURED on that code, not assumed: `TILL_PORT='   '` and `TILL_PORT=0` bound a RANDOM ephemeral
// port (64385 and 64386 in the run that produced this file), and `TILL_PORT=0x1f` bound port 31, a
// port nobody typed. The rest (`abc`, `-1`, `70000`, `8788.5`) did fail, but inside Node's own
// `listen`, with `ERR_SOCKET_BAD_PORT: options.port should be >= 0 and < 65536`, which names an
// `options.port` the operator never wrote and never mentions TILL_PORT.
//
// Everything is offline: loopback binds only, plus one deliberate wildcard bind on an ephemeral port
// against an empty `:memory:` ledger to prove the opt-in actually opts in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  startHttpServer,
  isLoopbackBindHost,
  nonLoopbackRefusal,
  nonLoopbackWarning,
  resolvePortEnv,
  isBindablePort,
  invalidPortRefusal,
  DEFAULT_PORT,
  MAX_PORT,
  EXPOSE_ENV,
} from '../../dist/api/serve.js';

const CLI = fileURLToPath(new URL('../../bin/till.mjs', import.meta.url));

/** Collects the lines `startHttpServer` would have put on stderr. */
function recorder() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

/** True when nothing is listening on 127.0.0.1:port. Used to prove a refusal bound nothing. */
function isPortClosed(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

test('isLoopbackBindHost: the loopback spellings, and only those', () => {
  // RFC 1122 3.2.1.3 (all of 127.0.0.0/8), RFC 4291 2.5.3 (::1) and 2.5.5.2 (IPv4-mapped),
  // RFC 6761 6.3 (localhost and *.localhost, which a hostile resolver cannot rebind).
  for (const host of [
    '127.0.0.1',
    '127.0.0.53',
    '127.1.2.3',
    'localhost',
    'LOCALHOST',
    'studio.localhost',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::1%lo0',
    '  127.0.0.1  ',
  ]) {
    assert.equal(isLoopbackBindHost(host), true, `${host} is loopback`);
  }

  // The wildcards, a concrete LAN address, the empty string (Node reads it as every interface),
  // and names that only look local.
  for (const host of [
    '0.0.0.0',
    '::',
    '[::]',
    '0:0:0:0:0:0:0:0',
    '192.168.178.36',
    '10.0.0.5',
    '169.254.1.1',
    '',
    '   ',
    undefined,
    'example.com',
    'localhost.evil.com',
    'evil-localhost.com',
    'notlocalhost',
    '::ffff:192.168.178.36',
  ]) {
    assert.equal(isLoopbackBindHost(host), false, `${String(host)} is NOT loopback`);
  }
});

test('a loopback bind binds, serves, and says nothing extra', async () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const rec = recorder();
    const handle = await startHttpServer({ dbPath: ':memory:', port: 0, host, log: rec.log });
    try {
      assert.deepEqual(rec.lines, [], `${host} bound silently`);
      const client = new Client({ name: 'bind-policy', version: '0.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`)));
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'post_entry'), `${host} serves the registry`);
      await client.close();
    } finally {
      await handle.close();
    }
  }
});

test('a loopback bind on ::1 works and reports a dialable bracketed URL', async (t) => {
  let handle;
  try {
    handle = await startHttpServer({ dbPath: ':memory:', port: 0, host: '::1' });
  } catch (e) {
    // A machine or container with IPv6 loopback switched off is not a policy failure.
    if (/EADDRNOTAVAIL|EAFNOSUPPORT|ENOTSUP/.test(String(e))) return t.skip('no IPv6 loopback here');
    throw e;
  }
  try {
    assert.match(handle.url, /^http:\/\/\[::1\]:\d+$/);
    assert.equal(new URL(handle.url).hostname, '[::1]'); // parses at all, which `http://::1:p` does not
  } finally {
    await handle.close();
  }
});

test('a non-loopback bind is refused, and nothing is listening afterwards', async () => {
  // Hermetic against the parallel gate: hold a PRIVATE ephemeral port (OS-assigned, ours for the
  // whole test) instead of scanning a fixed shared port for "nothing listening". A fixed port could
  // be occupied by a concurrent suite, which read as "0.0.0.0 bound nothing" and false-red the gate.
  //
  // Passing this already-occupied port to the refused call also makes the assertion STRONGER than the
  // old scan: the refusal must be the host-based one, which proves the loopback guard fires BEFORE
  // `listen` is ever attempted. A guard that refused too late would surface EADDRINUSE on this port
  // instead, and the message equality below would fail.
  const guard = createServer();
  await new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.listen(0, '127.0.0.1', resolve);
  });
  const port = guard.address().port;
  try {
    for (const host of ['0.0.0.0', '::', '[::]', '']) {
      await assert.rejects(
        () => startHttpServer({ dbPath: ':memory:', port, host }),
        (e) => {
          assert.equal(e.message, nonLoopbackRefusal(host, port));
          assert.doesNotMatch(e.message, /EADDRINUSE/, `${host || '(empty)'} never reached listen`);
          return true;
        },
        `${host || '(empty)'} refused`,
      );
    }
  } finally {
    guard.close();
    await once(guard, 'close');
  }
});

test('a concrete LAN address is refused BEFORE listen, not by the OS', async () => {
  // 192.168.178.36 is the peer address from the reproduction. On a machine that does not own it,
  // `listen` would fail with EADDRNOTAVAIL; the point is that TILL never gets that far, so the same
  // refusal appears on the machine that DOES own the address.
  await assert.rejects(
    () => startHttpServer({ dbPath: ':memory:', port: 0, host: '192.168.178.36' }),
    (e) => {
      assert.equal(e.message, nonLoopbackRefusal('192.168.178.36', 0));
      assert.doesNotMatch(e.message, /EADDRNOTAVAIL/);
      return true;
    },
  );
});

test('the refusal names the opt-in, the accepted spellings, and what the guard is not', () => {
  const text = nonLoopbackRefusal('0.0.0.0', 8788);
  assert.match(text, /refusing to bind 0\.0\.0\.0:8788/);
  assert.match(text, /not authentication/i);
  assert.match(text, /DNS-rebinding/);
  assert.match(text, /post_entry/);
  assert.match(text, /send_invoice/);
  assert.match(text, /127\.0\.0\.1.*127\.0\.0\.0\/8/s);
  assert.match(text, /::1/);
  assert.match(text, /\*\.localhost/);
  assert.match(text, new RegExp(`${EXPOSE_ENV}=1`));
  assert.equal(EXPOSE_ENV, 'TILL_EXPOSE_LEDGER_UNAUTHENTICATED');
});

test('the opt-in binds, and the warning goes out before the socket does', async () => {
  const rec = recorder();
  // A real wildcard bind on an ephemeral port over an empty in-memory ledger: the only way to prove
  // the opt-in opts in rather than merely printing. Closed in the same test.
  const handle = await startHttpServer({
    dbPath: ':memory:',
    port: 0,
    host: '0.0.0.0',
    allowNonLoopback: true,
    log: rec.log,
  });
  try {
    const boundPort = handle.server.address().port;
    assert.deepEqual(rec.lines, nonLoopbackWarning('0.0.0.0', 0));
    const banner = rec.lines.join('\n');
    assert.match(banner, /EXPOSING THE LEDGER/);
    assert.match(banner, /not a loopback address/i);
    assert.match(banner, /DNS-rebinding defence.*NOT authentication/s);
    assert.match(banner, /post_entry/);
    assert.match(banner, /send_invoice/);
    assert.match(banner, /no password and no token/);
    assert.match(banner, new RegExp(`${EXPOSE_ENV}=1`));
    for (const line of rec.lines) assert.match(line, /^!! /);
    // And it really is bound wide, which is exactly what the warning claims.
    assert.equal(await isPortClosed(boundPort), false);
  } finally {
    await handle.close();
  }
});

test(`${EXPOSE_ENV} is read from the environment, and only the exact value 1 counts`, async (t) => {
  const original = process.env[EXPOSE_ENV];
  t.after(() => {
    if (original === undefined) delete process.env[EXPOSE_ENV];
    else process.env[EXPOSE_ENV] = original;
  });

  for (const value of ['0', 'false', 'yes', 'true', '']) {
    process.env[EXPOSE_ENV] = value;
    await assert.rejects(
      () => startHttpServer({ dbPath: ':memory:', port: 0, host: '0.0.0.0' }),
      /refusing to bind/,
      `${EXPOSE_ENV}=${value} does not open the door`,
    );
  }

  process.env[EXPOSE_ENV] = '1';
  const rec = recorder();
  const handle = await startHttpServer({ dbPath: ':memory:', port: 0, host: '0.0.0.0', log: rec.log });
  try {
    assert.ok(rec.lines.length > 0, 'the env opt-in still warns');
  } finally {
    await handle.close();
  }
});

test('an explicit allowNonLoopback: false beats the environment', async (t) => {
  const original = process.env[EXPOSE_ENV];
  process.env[EXPOSE_ENV] = '1';
  t.after(() => {
    if (original === undefined) delete process.env[EXPOSE_ENV];
    else process.env[EXPOSE_ENV] = original;
  });
  await assert.rejects(
    () => startHttpServer({ dbPath: ':memory:', port: 0, host: '0.0.0.0', allowNonLoopback: false }),
    /refusing to bind/,
  );
});

// ---------------------------------------------------------------------------------------------
// The port half of the same policy.
// ---------------------------------------------------------------------------------------------

test('resolvePortEnv: the whole decision table for TILL_PORT', () => {
  // Accepted, with the resolved port. Blank is UNSET, not an error, matching resolveDbPath's ruling
  // that a blank environment variable is a misconfiguration and not a request: `docker run -e
  // TILL_PORT` hands over an empty string for a variable nobody set.
  const accepted = [
    [undefined, DEFAULT_PORT],
    ['', DEFAULT_PORT],
    ['   ', DEFAULT_PORT], // used to reach Number('   ') === 0 and bind a RANDOM port
    ['\n\t ', DEFAULT_PORT],
    ['8788', 8788],
    [' 8788 ', 8788], // a value read out of a file keeps its newline
    ['8788\n', 8788],
    ['1', 1], // the privileged range is the operating system's call, not TILL's
    ['1023', 1023],
    ['08788', 8788],
    [String(MAX_PORT), MAX_PORT],
  ];
  for (const [raw, expected] of accepted) {
    assert.equal(resolvePortEnv(raw), expected, `TILL_PORT=${JSON.stringify(raw)}`);
  }

  // Refused, with the part of the message that has to be there. Decimal digits only, so every
  // spelling Number() would silently reinterpret is refused instead.
  const refused = [
    ['abc', /not a port number: "abc"/],
    ['8788abc', /not a port number: "8788abc"/],
    ['0x1f', /not a port number: "0x1f"/], // used to bind port 31
    ['8.788e3', /not a port number/],
    ['8788.5', /not a port number/],
    ['8788.0', /not a port number/],
    ['+8788', /not a port number/],
    ['-1', /not a port number: "-1"/],
    ['Infinity', /not a port number/],
    ['NaN', /not a port number/],
    ['１２３', /not a port number/], // full-width digits are not decimal digits
    ['87 88', /not a port number/],
    ['0', /TILL_PORT is 0/],
    ['00', /TILL_PORT is 0/],
    [' 0 ', /TILL_PORT is 0/],
    ['65536', /out of range: 65536/],
    ['70000', /out of range: 70000/],
    ['99999999999999999999', /out of range/],
  ];
  for (const [raw, expected] of refused) {
    assert.throws(() => resolvePortEnv(raw), expected, `TILL_PORT=${JSON.stringify(raw)}`);
  }
});

test('every TILL_PORT refusal names the variable and the way out', () => {
  for (const raw of ['abc', '0', '70000']) {
    let message = '';
    try {
      resolvePortEnv(raw);
      assert.fail(`${raw} should have been refused`);
    } catch (e) {
      message = e.message;
    }
    assert.match(message, /^till serve: refusing to start/, `${raw} refuses in the house voice`);
    assert.match(message, /TILL_PORT/, `${raw} names the variable that is wrong`);
    assert.match(message, new RegExp(String(DEFAULT_PORT)), `${raw} names the default`);
    assert.doesNotMatch(message, /options\.port/, `${raw} does not leak Node internals`);
  }
});

test('TILL_PORT=0 is refused, but startHttpServer({ port: 0 }) is not', async () => {
  // Deliberately asymmetric. In code, 0 is an explicit request for an ephemeral port and the caller
  // reads the answer back off `handle.url`. In an environment variable it is a typo or an unfilled
  // template, and honouring it moves the server on every restart.
  assert.throws(() => resolvePortEnv('0'), /ask for it in\s+code: startHttpServer\({ port: 0 }\)/);

  const handle = await startHttpServer({ dbPath: ':memory:', port: 0 });
  try {
    const bound = handle.server.address().port;
    assert.ok(bound > 0, 'the OS picked a port');
    assert.equal(new URL(handle.url).port, String(bound), 'and the URL names the port really bound');
  } finally {
    await handle.close();
  }
});

test('isBindablePort: the bind-time rule, which includes 0', () => {
  for (const port of [0, 1, 80, 8788, MAX_PORT]) assert.equal(isBindablePort(port), true, `${port}`);
  for (const port of [NaN, Infinity, -Infinity, -1, 65536, 70000, 8788.5, 0.5]) {
    assert.equal(isBindablePort(port), false, `${port}`);
  }
});

test('an embedder passing an unusable port is refused before the store is opened', async () => {
  for (const port of [NaN, -1, 70000, 8788.5]) {
    await assert.rejects(
      () => startHttpServer({ dbPath: ':memory:', port }),
      (e) => {
        assert.equal(e.message, invalidPortRefusal(port));
        // Node's own ERR_SOCKET_BAD_PORT is what used to surface here, naming a key nobody wrote.
        assert.doesNotMatch(e.message, /ERR_SOCKET_BAD_PORT/);
        assert.match(e.message, /not a usable TCP port/);
        return true;
      },
      `port ${port} refused`,
    );
  }
});

test('a bad port is refused before the ledger directory is even created', async (t) => {
  // The strongest available statement of "before the store is touched": point TILL_DB_PATH at a file
  // in a directory that does not exist, and prove the refused run did not create it.
  const scratch = mkdtempSync(join(tmpdir(), 'till-port-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const dbDir = join(scratch, 'ledger');
  const dbPath = join(dbDir, 'till.db');

  const { code, stderr } = await runCli(['serve'], { TILL_DB_PATH: dbPath, TILL_PORT: 'abc' });
  assert.equal(code, 1);
  assert.match(stderr, /TILL_PORT is not a port number/);
  assert.equal(existsSync(dbDir), false, 'ensureDbPath never ran');
  assert.equal(existsSync(dbPath), false, 'and no ledger was created');
});

// ---------------------------------------------------------------------------------------------
// The CLI, end to end. This is the surface the user actually meets.
// ---------------------------------------------------------------------------------------------

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, TILL_DB_PATH: ':memory:', [EXPOSE_ENV]: '', ...env } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test('till help stops selling TILL_HOST as a convenience knob', async () => {
  const { code, stdout } = await runCli(['help']);
  assert.equal(code, 0);
  assert.match(stdout, /loopback\s+only/i);
  assert.match(stdout, /REFUSED/);
  assert.match(stdout, /not\s+authentication/i);
  assert.match(stdout, /DNS-rebinding/);
  assert.match(stdout, /post_entry and send_invoice/);
  assert.match(stdout, new RegExp(`${EXPOSE_ENV}=1`));
});

test('TILL_HOST=0.0.0.0 till serve refuses, exits 1, and serves nothing', async () => {
  const { code, stderr } = await runCli(['serve'], { TILL_HOST: '0.0.0.0', TILL_PORT: '8792' });
  assert.equal(code, 1);
  assert.match(stderr, /refusing to bind 0\.0\.0\.0:8792/);
  assert.match(stderr, /DNS-rebinding/);
  assert.match(stderr, new RegExp(`${EXPOSE_ENV}=1`));
  assert.doesNotMatch(stderr, /MCP over HTTP/, 'nothing was served');
  assert.doesNotMatch(stderr, /at Object|node:internal/, 'a message, not a stack trace');
  assert.equal(await isPortClosed(8792), true);
});

/**
 * Spawn `till serve`, wait until it has either announced or given up, hand the stderr to `check`,
 * and always reap the child. Waiting on the announcement rather than on a timer is what makes these
 * assertions about the real listener and not about a race.
 */
async function withServe(env, check) {
  const child = spawn(process.execPath, [CLI, 'serve'], {
    env: { ...process.env, TILL_DB_PATH: ':memory:', [EXPOSE_ENV]: '', ...env },
  });
  let stderr = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`till serve went quiet: ${stderr}`)), 20_000);
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.includes('MCP over HTTP')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', reject);
    });
    await check(stderr);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

test('till serve on the default loopback bind starts clean and warns about nothing', async () => {
  await withServe({ TILL_PORT: '8793' }, async (stderr) => {
    assert.match(stderr, /till serve: MCP over HTTP at http:\/\/127\.0\.0\.1:8793\/mcp/);
    assert.doesNotMatch(stderr, /!!/, 'a loopback bind is silent');
    assert.doesNotMatch(stderr, /EXPOSING/);
    assert.equal(await isPortClosed(8793), false, 'and it really is listening');
  });
});

test('every refused TILL_PORT spelling exits 1, says which knob is wrong, and serves nothing', async () => {
  // Blank and whitespace-only are NOT here: they mean unset, they start, and they have their own
  // test below. Everything else is a spelling the old `Number(raw)` either reinterpreted or handed
  // to Node to reject on TILL's behalf.
  for (const raw of ['abc', '0', '-1', '70000', '65536', '8788.5', '0x1f', '8.788e3', '8788abc']) {
    const { code, stderr } = await runCli(['serve'], { TILL_PORT: raw });
    assert.equal(code, 1, `TILL_PORT=${JSON.stringify(raw)} exits 1`);
    assert.match(stderr, /^till serve: refusing to start/, JSON.stringify(raw));
    assert.match(stderr, /TILL_PORT/, `${JSON.stringify(raw)} names TILL_PORT`);
    assert.doesNotMatch(stderr, /MCP over HTTP/, `${JSON.stringify(raw)} served nothing`);
    assert.doesNotMatch(stderr, /node:internal|ERR_SOCKET_BAD_PORT/, `${JSON.stringify(raw)} printed no stack`);
  }
});

test('a whitespace-only TILL_PORT lands on the default, never on a random port', async () => {
  // The measured old behaviour: Number('   ') === 0, so the OS handed out 64385. The bug is not that
  // it failed, it is that it succeeded at the wrong address. 8788 may legitimately be taken on the
  // machine running the suite, and EADDRINUSE naming 8788 proves the same point: 8788 was the
  // target. What must never appear is a different, arbitrary port.
  await withServe({ TILL_PORT: '   ' }, (stderr) => {
    const announced = /MCP over HTTP at http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(stderr);
    if (announced) {
      assert.equal(announced[1], String(DEFAULT_PORT), 'the default port, not an arbitrary one');
    } else {
      assert.match(stderr, new RegExp(`EADDRINUSE[^\\n]*${DEFAULT_PORT}`), `unexpected output: ${stderr}`);
      assert.match(stderr, /Pick a different one with TILL_PORT/);
    }
  });
});

test('a port already in use fails as a sentence, not as a stack trace', async () => {
  const squatter = await startHttpServer({ dbPath: ':memory:', port: 0 });
  const taken = squatter.server.address().port;
  try {
    const { code, stderr } = await runCli(['serve'], { TILL_PORT: String(taken) });
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`till serve: cannot bind 127\\.0\\.0\\.1:${taken}`));
    assert.match(stderr, /EADDRINUSE/);
    assert.match(stderr, /Pick a different one with TILL_PORT/);
    assert.doesNotMatch(stderr, /node:internal|throw er;/, 'no uncaught-exception dump');
  } finally {
    await squatter.close();
  }
});

test('till help states the port rule as a rule', async () => {
  const { code, stdout } = await runCli(['help']);
  assert.equal(code, 0);
  assert.match(stdout, /TILL_PORT takes decimal digits, 1 to 65535/);
  assert.match(stdout, /refuses anything else instead of reinterpreting it/);
});
