/**
 * Security review F6 (Low): `computeRuntimeRoots` takes node's grandparent as a read-allowed runtime
 * root. That is a runtime prefix for a system / Homebrew / nvm node, but for a node at `$HOME/bin/node`
 * the computed root is `$HOME`, so the kernel jail would `(allow file-read* (subpath "$HOME"))` (the
 * ledger lives under `$HOME`) while `sandboxStatus()` still reports `active:true`. The fix fails CLOSED:
 * host construction THROWS when a derived root contains `$HOME` / the ledger / the support dir / cwd, so
 * the platform reports no usable mechanism rather than a jail that leaks the ledger.
 *
 * BITE: remove the `assertRuntimeRootsAreConfined(runtimeRoots)` call from
 * `dist/api/plugin-sandbox-host.js` and the first test stops throwing (a $HOME-rooted jail builds).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProcessSandboxHost } from '../../dist/api/plugin-sandbox-host.js';

const NODE = process.execPath;
const HOST_CONFIG = { pluginRoot: tmpdir(), invoke: () => ({ ok: true }), resolveActor: () => 'x' };

test('F6: a node whose grandparent is $HOME makes host construction FAIL CLOSED (throws)', () => {
  const priorHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'till-f6-home-'));
  mkdirSync(join(fakeHome, 'bin'), { recursive: true });
  const fakeNode = join(fakeHome, 'bin', 'node');
  symlinkSync(NODE, fakeNode); // grandparent of $HOME/bin/node is $HOME
  process.env.HOME = fakeHome;
  try {
    assert.throws(
      () => createProcessSandboxHost({ ...HOST_CONFIG, nodePath: fakeNode }),
      /runtime read root .* contains a sensitive path/,
      'a $HOME-rooted runtime must be refused at construction, not silently widen the allowlist',
    );
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('F6 non-vacuity: a normal runtime (this box`s node) still constructs a host', () => {
  // The default nodePath (a system/Homebrew/nvm prefix) is NOT an ancestor of $HOME/the ledger, so
  // construction succeeds. Proves the guard is not vacuously throwing on every input.
  assert.doesNotThrow(() => createProcessSandboxHost(HOST_CONFIG), 'a normally-located node must still build a host');
});
