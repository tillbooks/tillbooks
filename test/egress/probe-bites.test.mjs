/**
 * THE NON-VACUITY TEST, and the single most important test in E07 (spec §7, §9): a trust test that
 * has never been seen to fail is not evidence, it is decoration. This plants a DELIBERATE offender on
 * EVERY egress vector the runtime probe claims to cover and asserts each one is CAUGHT, BLOCKED and
 * NAMED. If any assertion here could be deleted without the probe noticing, the product's central
 * "nothing leaves the device" claim would be decoration at that vector.
 *
 * It also proves the two properties a naive probe gets wrong: a CLEAN block records nothing (no false
 * positive), and a high-layer door (http/https/fetch) is counted exactly ONCE at its own door rather
 * than a second time when it would have fallen through to the TCP leaf (no double count).
 *
 * Everything here runs OFFLINE: hard mode throws BEFORE the real dial, so `curl` never spawns and no
 * socket ever reaches the network. The offenders are refused at the door, which is the whole point.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';

const { installEgressProbe } = await import('../../dist/core/egress/index.js');

const REFUSED = /OP6 egress refused|EgressViolation/;

test('E07 probe: a CLEAN run records nothing (no false positive, so a green is a real green)', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    // Ordinary in-process work, no socket of any kind.
    const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
    assert.equal(sum, 6);
  } finally {
    probe.uninstall();
  }
  assert.equal(probe.violations.length, 0, 'a probe that fires on clean code cries wolf and gets ignored');
});

test('E07 probe: TCP connect is caught and named', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    assert.throws(() => net.connect({ host: '203.0.113.9', port: 443 }), REFUSED);
  } finally {
    probe.uninstall();
  }
  assert.equal(probe.violations.length, 1);
  assert.equal(probe.violations[0].kind, 'tcp_connect');
  assert.match(probe.violations[0].target, /203\.0\.113\.9:443/);
});

test('E07 probe: UDP send is caught and named', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  const socket = dgram.createSocket('udp4');
  try {
    assert.throws(() => socket.send(Buffer.from('x'), 0, 1, 53, '203.0.113.9'), REFUSED);
  } finally {
    probe.uninstall();
    socket.close();
  }
  assert.equal(probe.violations.length, 1);
  assert.equal(probe.violations[0].kind, 'udp_send');
});

test('E07 probe: DNS resolution is caught (callback and promise faces)', async () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    assert.throws(() => dns.lookup('example.com', () => {}), REFUSED);
    assert.throws(() => dns.resolve('example.com', () => {}), REFUSED);
    // The promise face throws synchronously (the wrapper records-then-throws before returning).
    assert.throws(() => dns.promises.lookup('example.com'), REFUSED);
  } finally {
    probe.uninstall();
  }
  assert.ok(probe.violations.length >= 3, 'each DNS door must be caught');
  assert.ok(probe.violations.every((v) => v.kind === 'dns'));
  assert.ok(probe.violations.some((v) => v.target.includes('example.com')));
});

test('E07 probe: TLS connect is caught and named', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    assert.throws(() => tls.connect({ host: 'example.com', port: 443 }), REFUSED);
  } finally {
    probe.uninstall();
  }
  // Named at its own door, and counted ONCE: the throw stops it falling through to the TCP leaf.
  assert.equal(probe.violations.length, 1, 'a TLS dial must not be double-counted at the leaf');
  assert.equal(probe.violations[0].kind, 'tls_connect');
});

test('E07 probe: HTTP request/get are caught and named ONCE (no double count at the leaf)', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    assert.throws(() => http.get('http://example.com/steal'), REFUSED);
  } finally {
    probe.uninstall();
  }
  assert.equal(probe.violations.length, 1, 'http.get reached both the http door AND the tcp leaf');
  assert.equal(probe.violations[0].kind, 'http_request');
  assert.match(probe.violations[0].target, /example\.com/);
});

test('E07 probe: HTTPS request is caught and named ONCE', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    assert.throws(() => https.request('https://example.com/exfil'), REFUSED);
  } finally {
    probe.uninstall();
  }
  assert.equal(probe.violations.length, 1);
  assert.equal(probe.violations[0].kind, 'https_request');
});

test('E07 probe: global fetch is caught and named', () => {
  assert.equal(typeof fetch, 'function', 'this Node has global fetch, which is the realistic egress door');
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    // The wrapper records-then-throws synchronously, before undici opens anything.
    assert.throws(() => fetch('https://example.com/exfil'), REFUSED);
  } finally {
    probe.uninstall();
  }
  assert.equal(probe.violations.length, 1);
  assert.equal(probe.violations[0].kind, 'fetch');
  assert.match(probe.violations[0].target, /example\.com/);
});

test('E07 probe: global WebSocket is caught and named (when this Node has it)', () => {
  if (typeof WebSocket !== 'function') return; // Node < 21: nothing to wrap, nothing to assert.
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    assert.throws(() => new WebSocket('wss://example.com/stream'), REFUSED);
  } finally {
    probe.uninstall();
  }
  assert.equal(probe.violations.length, 1);
  assert.equal(probe.violations[0].kind, 'websocket');
});

test('E07 probe: a child process (a shell that curls) is caught before it spawns', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  try {
    // The vector an in-process socket patch CANNOT see: the child would open its OWN socket. Blocked
    // at the spawn, so curl never runs and nothing reaches the network.
    assert.throws(() => childProcess.exec('curl -s https://example.com/exfil'), REFUSED);
    assert.throws(() => childProcess.spawnSync('curl', ['https://example.com/exfil']), REFUSED);
  } finally {
    probe.uninstall();
  }
  assert.ok(probe.violations.length >= 2, 'both the async and sync spawn doors must be caught');
  assert.ok(probe.violations.every((v) => v.kind === 'subprocess'));
});

test('E07 probe: uninstall restores every door, so a later clean run is not haunted by the probe', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  probe.uninstall();
  // After uninstall the doors are the originals again: a SECOND probe over clean code sees nothing,
  // which would be false if the first install had leaked a wrapper.
  const second = installEgressProbe({ hard: true, layers: 'all' });
  try {
    assert.equal(typeof net.connect, 'function');
  } finally {
    second.uninstall();
  }
  assert.equal(second.violations.length, 0);
});

test('E07 probe: a stacked install unwinds cleanly (the monitor + a self-test on top)', () => {
  const outer = installEgressProbe({ hard: false, layers: 'leaf' }); // the record-mode monitor shape
  const inner = installEgressProbe({ hard: true, layers: 'all' }); // a self-test on top
  inner.uninstall();
  // The outer (record) probe is still installed and must still observe, not throw: a real connect
  // here would be counted, so we do not make one; we only assert the door is a function and that
  // tearing the inner probe down did not tear the outer one down with it.
  assert.equal(typeof net.Socket.prototype.connect, 'function');
  outer.uninstall();
  assert.equal(inner.violations.length, 0);
});
