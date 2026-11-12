// E07's one allow-listed local subprocess (critic R1-L2): E04's `lsof` busy check is RECORDED by the
// hard probe (so egress_self_test reports that it ran) and delegated, while any other spawn on the
// subprocess door, an `lsof` of another shape included, stays a refused violation.

import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';

import { installEgressProbe, isAllowedLocalSubprocess, ALLOWED_LOCAL_SUBPROCESSES } from '../../dist/core/egress/probe.js';

test('the allow-list is lsof by name and system path only, and only in the busy-check shape', () => {
  assert.deepEqual([...ALLOWED_LOCAL_SUBPROCESSES].sort(), ['/usr/bin/lsof', '/usr/sbin/lsof', 'lsof']);
  assert.equal(isAllowedLocalSubprocess('spawnSync', ['/usr/sbin/lsof', ['-t', '-w', '--', '/a/Drafts'], { encoding: 'utf8' }]), true);
  assert.equal(isAllowedLocalSubprocess('spawnSync', ['lsof', ['-t', '-w', '--', '/a/Drafts', '/a/.parentlock']]), true);
  assert.equal(isAllowedLocalSubprocess('spawnSync', ['/tmp/x/lsof', ['-t', '-w', '--', '/a/Drafts']]), false, 'another path is not the system binary');
  assert.equal(isAllowedLocalSubprocess('spawnSync', ['lsof', ['-i', '-n']]), false, 'lsof -i lists sockets: not the busy check');
  assert.equal(isAllowedLocalSubprocess('spawnSync', ['lsof', ['-t', '-w', '--', 'relative']]), false);
  assert.equal(isAllowedLocalSubprocess('spawnSync', ['lsof', ['-t', '-w', '--', '/a/Drafts'], { shell: true }]), false, 'no shell');
  assert.equal(isAllowedLocalSubprocess('spawn', ['lsof', ['-t', '-w', '--', '/a/Drafts']]), false, 'the sync call only');
  assert.equal(isAllowedLocalSubprocess('spawnSync', ['curl', ['-t', '-w', '--', '/a']]), false);
});

test('the hard probe records the allowed lsof with allowed:true and lets it run; another spawn is still refused', () => {
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  let lsofResult;
  let refused;
  try {
    lsofResult = childProcess.spawnSync('lsof', ['-t', '-w', '--', '/nonexistent-till-probe'], { encoding: 'utf8' });
    try {
      childProcess.spawnSync('lsof', ['-i'], { encoding: 'utf8' });
    } catch (e) {
      refused = e;
    }
  } finally {
    probe.uninstall();
  }
  assert.equal(probe.violations[0].kind, 'subprocess');
  assert.equal(probe.violations[0].allowed, true);
  assert.notEqual(lsofResult, undefined, 'the allowed spawn was delegated, not thrown');
  assert.equal(refused?.name, 'EgressViolation', 'a different lsof shape is refused');
  assert.equal(probe.violations[1].allowed, undefined, 'and recorded as a real violation');
});
