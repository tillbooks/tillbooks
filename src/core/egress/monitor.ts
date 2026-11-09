/**
 * E07, the standing egress monitor: the observed-socket count behind the shell-rail trust indicator
 * (US-E07.2). Where `egress.selfTest` is a scoped, blocking ritual the user runs on demand, THIS is
 * the passive, process-lifetime observer that lets `egress.status` answer "has this session dialled
 * out at all" on an ordinary Tuesday.
 *
 * RECORD MODE, LEAF LAYER, AND BOTH CHOICES ARE THE HONEST ONES. It installs the probe with
 * `hard:false` so it never throws: a monitor that turned a dependency's stray connect into a crash
 * would be enforcement, not observation, and enforcement belongs to the self-test and the CI gate.
 * It uses the `leaf` layer (TCP/UDP/DNS only) so the count is EXACT: a single real connection reaches
 * `net.Socket.prototype.connect` exactly once, and wrapping the high-layer doors here would count the
 * same connection twice. The consequence, stated so the panel can state it: the standing indicator
 * observes NETWORK SOCKETS, which is the spec's central claim ("zero sockets for the drafting loop");
 * the subprocess vector is proven by the self-test's hard probe, not by this counter.
 *
 * INSTALLED ONCE, AS EARLY AS THE ENGINE LOADS. The module self-installs on import (guarded so a
 * second import is a no-op), and the engine barrel is imported by the action registry that every
 * face of the product loads, so the observer is running from process start rather than from the
 * first time someone opens the panel. That matters for honesty: a socket opened before anyone
 * looked must still be seen. If the install ever fails, `status` reports `unknown`, never `local`
 * (spec US-E07.2 Error: an unverified claim renders as unverified).
 */

import { installEgressProbe } from './probe.js';
import type { EgressViolation } from './probe.js';
import type { EgressState } from './enums.js';

interface MonitorState {
  installed: boolean;
  since: string | null;
  violations: EgressViolation[];
}

const monitor: MonitorState = { installed: false, since: null, violations: [] };

/**
 * Install the standing observer once. Idempotent: a second call is a no-op, so importing the engine
 * from many entry points cannot stack observers or reset the count. Never throws: a failure to
 * install leaves `installed:false`, which `status` reports as `unknown`.
 */
export function ensureEgressMonitor(): void {
  if (monitor.installed) return;
  try {
    const probe = installEgressProbe({ hard: false, layers: 'leaf' });
    monitor.violations = probe.violations;
    monitor.since = new Date().toISOString();
    monitor.installed = true;
  } catch {
    monitor.installed = false;
    monitor.since = null;
  }
}

/** Read the observed state without recomputing anything: pure P5 (status is observed, never stored). */
export function observedEgress(): { state: EgressState; socketsOpened: number; since: string | null } {
  if (!monitor.installed) return { state: 'unknown', socketsOpened: 0, since: null };
  const socketsOpened = monitor.violations.length;
  return {
    state: socketsOpened === 0 ? 'local' : 'violated',
    socketsOpened,
    since: monitor.since,
  };
}

/**
 * The observed offenders, for the `violated` panel (host + door + stack). A copy, so a caller can
 * never mutate the record the monitor is keeping.
 */
export function observedOffenders(): EgressViolation[] {
  return monitor.violations.map((v) => ({ ...v }));
}

/**
 * Test seam ONLY: tear the observer down and forget the count, so a suite can assert the three
 * states deterministically. Never called by any shipped verb; the standing monitor is install-once
 * and forget in production.
 */
export function resetEgressMonitorForTests(): void {
  monitor.installed = false;
  monitor.since = null;
  monitor.violations = [];
}

/**
 * Test seam ONLY: force the monitor into a chosen state (used to prove `status` reports `unknown`
 * when the probe could not install, and `violated` when a socket was seen). Never shipped-code.
 */
export function forceEgressMonitorForTests(state: { installed: boolean; violations?: EgressViolation[] }): void {
  monitor.installed = state.installed;
  monitor.since = state.installed ? new Date().toISOString() : null;
  monitor.violations = state.violations ?? [];
}

// Self-install on import: the engine barrel is imported by the registry every face loads, so the
// observer is running from process start. Guarded and non-throwing, so this side effect is safe in
// every test that merely imports the engine.
ensureEgressMonitor();
