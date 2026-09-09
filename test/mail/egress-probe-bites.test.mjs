/**
 * The probe proves ITSELF, every run: a trust test that has never been seen to fail is not
 * evidence, it is decoration (E07 spec §7). Each case here is a DELIBERATE OFFENDER: it attempts
 * real egress under the probe and the suite passes only because the probe refuses and records it.
 * If a refactor ever quietens the probe, this file goes red before any mail suite silently loses
 * its guarantee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dns from 'node:dns';

import { installEgressProbe } from './egress-probe.mjs';

test('OP6 probe: a TCP connect is refused, recorded, and names its target', () => {
  const probe = installEgressProbe();
  try {
    assert.throws(
      () => net.connect({ host: '127.0.0.1', port: 9 }),
      (error) => error.name === 'EgressViolation' && /127\.0\.0\.1:9/.test(error.message),
      'the deliberate offender was NOT caught: the probe is decoration',
    );
    assert.equal(probe.violations.length, 1);
    assert.equal(probe.violations[0].kind, 'tcp_connect');
    assert.match(probe.violations[0].stack, /egress-probe-bites/, 'the violation does not name its caller');
  } finally {
    probe.uninstall();
  }
});

test('OP6 probe: a DNS lookup is refused too (egress does not need a socket to leak a hostname)', () => {
  const probe = installEgressProbe();
  try {
    assert.throws(() => dns.lookup('till-op6-offender.example', () => {}), /EgressViolation|egress refused/);
    assert.equal(probe.violations.length, 1);
    assert.equal(probe.violations[0].kind, 'dns');
    assert.equal(probe.violations[0].target, 'till-op6-offender.example');
  } finally {
    probe.uninstall();
  }
});

test('OP6 probe: soft mode records without throwing, so a swallowed catch still leaves evidence', () => {
  const probe = installEgressProbe({ hard: false });
  try {
    // The engine idiom under test: a try/catch that would swallow a hard throw. The RECORD is the
    // part no catch can erase, which is why suites assert `violations`, not only the throw.
    try {
      const socket = net.connect({ host: '127.0.0.1', port: 9 });
      socket.destroy();
    } catch {
      assert.fail('soft mode must not throw');
    }
    assert.equal(probe.violations.length, 1);
  } finally {
    probe.uninstall();
  }
});

test('OP6 probe: uninstall restores the exact originals', () => {
  const originalConnect = net.Socket.prototype.connect;
  const originalLookup = dns.lookup;
  const probe = installEgressProbe();
  assert.notEqual(net.Socket.prototype.connect, originalConnect, 'install changed nothing: the probe is not wired');
  probe.uninstall();
  assert.equal(net.Socket.prototype.connect, originalConnect);
  assert.equal(dns.lookup, originalLookup);
});
