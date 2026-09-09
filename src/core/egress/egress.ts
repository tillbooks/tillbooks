/**
 * E07, the offline proof: the two engine verbs behind the product's central OP6 claim, "nothing
 * leaves the device". `egressSelfTest` is the user's on-demand ritual (US-E07.1), `egressStatus` is
 * the standing indicator's read model (US-E07.2). Neither owns a table: state is OBSERVED at read
 * time and DELIBERATELY never stored, because a trust indicator that reports stored state can report
 * STALE state, and a stale trust indicator is worse than none (spec §4).
 *
 * WHAT MAKES THE SELF-TEST EVIDENCE AND NOT DECORATION. It runs the REAL E04 -> E05 -> E06 loop
 * (`generateDraft`), never a simulation, with the hard egress probe installed over every vector: a
 * self-test that does not exercise the real path tests nothing (spec §4). If any socket is opened it
 * FAILS LOUDLY with the offender named (`egress_violated`), because we report our own violation
 * rather than degrade the claim quietly (US-E07.1 Error). The probe counts sockets, so it works with
 * the wifi ON as well as off: the wifi-off ritual is for the human, the probe is the machine's
 * version of the same fact, and the identical mechanism runs in CI on every build (US-E07.3).
 *
 * NO MONEY PATH, ASSERTED BY ABSENCE (spec §4): this module imports no `postEntry`, no
 * `recordPayment`, nothing from `ledger/` or `payments/`. It produces a draft through E06's
 * already-idempotent path and touches the ledger not at all.
 *
 * TENANCY (§H-TENANT): both verbs take `workspaceId`. `egressStatus` reads NO rows (it reports the
 * PROCESS's observed socket count, which is workspace-independent by construction). `egressSelfTest`
 * reads only the workspace-scoped E04/E05 registers and runs the workspace-scoped `generateDraft`, so
 * a foreign workspace's mail can never be drawn into another tenant's proof.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { listMailAccounts, listMailThreads } from '../mail/index.js';
import { listVoiceProfiles, registeredRuntime } from '../voice/index.js';
import { generateDraft } from '../drafting/index.js';
import { installEgressProbe } from './probe.js';
import { observedEgress, observedOffenders } from './monitor.js';

/** The stages of the local-correspondence loop the self-test exercises, in order (US-E07.1). */
const SELF_TEST_STEPS = ['mail_read', 'voice_retrieve', 'draft_compose', 'draft_write'] as const;

/**
 * US-E07.2: the standing trust indicator's read model (Pattern P5). Returns the PROCESS's observed
 * egress state: `local` when the monitor is installed and has seen zero sockets, `violated` when it
 * has seen one or more (with the offenders), `unknown` when the monitor could not install (an
 * unverified claim renders as unverified, never as optimism). Observed, never persisted.
 */
export function egressStatus(_ctx: WorkspaceContext): Result {
  const observed = observedEgress();
  return ok({
    state: observed.state,
    socketsOpened: observed.socketsOpened,
    since: observed.since,
    // The offenders ride along ONLY when there is something to report, so the happy read is small
    // and a `violated` panel has the host and stack it needs to name the bug (US-E07.2 Error).
    ...(observed.state === 'violated' ? { offenders: observedOffenders() } : {}),
  });
}

/**
 * US-E07.1: run the offline proof. Verifies setup is complete, then runs a REAL generation through
 * the whole E04/E05/E06 loop with the hard egress probe installed, and reports honestly:
 *
 *   - setup incomplete            -> `needs_setup` naming exactly what is missing (US-E07.1 Empty)
 *   - a socket was opened         -> `egress_violated` with sockets_opened + the offenders (Error)
 *   - the loop could not complete
 *     for a NON-egress reason      -> `self_test_incomplete` with the reason (honest, not vacuous)
 *   - clean                       -> `ok({ passed:true, socketsOpened:0, steps, draftId })`
 *
 * THE PAYLOAD VERDICT IS NAMED `passed`, NOT `ok`, on purpose: the spec's `{ ok, ... }` shape would
 * collide with the Result envelope's own `ok` (did the verb run) and let a naive caller read a
 * violation as success. `passed` is the test verdict; a violation additionally fails the ENVELOPE
 * (`err`), so a caller that checks only `result.ok` still cannot miss it.
 */
export function egressSelfTest(ctx: WorkspaceContext): Result {
  // 1. Setup completeness (US-E07.1 Empty): a real run needs a connected store, a learned voice, a
  // registered local runtime, and an inbound thread to reply to. Name what is missing rather than
  // failing vaguely.
  const missing: string[] = [];

  const accounts = listMailAccounts(ctx) as { ok: boolean; accounts?: unknown[] };
  const hasStore = accounts.ok === true && (accounts.accounts?.length ?? 0) > 0;
  if (!hasStore) missing.push('mail_store');

  const profiles = listVoiceProfiles(ctx) as { ok: boolean; profiles?: unknown[] };
  const hasProfile = profiles.ok === true && (profiles.profiles?.length ?? 0) > 0;
  if (!hasProfile) missing.push('voice_profile');

  if (registeredRuntime() === undefined) missing.push('local_runtime');

  // A draftable thread: the newest message is inbound and unanswered (the `needs_reply` bucket).
  // Only checked once the prerequisites exist, so an empty workspace names the store/profile/runtime
  // it lacks rather than a thread it could never have.
  let threadId: string | undefined;
  if (hasStore) {
    const threads = listMailThreads(ctx, { bucket: 'needs_reply' }) as {
      ok: boolean;
      items?: { id: string }[];
    };
    threadId = threads.ok === true ? threads.items?.[0]?.id : undefined;
    if (threadId === undefined) missing.push('draftable_thread');
  }

  if (missing.length > 0) return err('needs_setup', { missing });

  // 2. The REAL run under the hard probe over EVERY vector. Synchronous end to end (the adapter's
  // `complete` and better-sqlite3 are synchronous), so install -> run -> uninstall cannot interleave
  // with anything, and the probe is always torn down.
  const probe = installEgressProbe({ hard: true, layers: 'all' });
  let draftResult: Result;
  try {
    // No idempotencyKey: the self-test is not a keyed business write, it produces a fresh draft each
    // time it is pressed (spec §5: egress_self_test takes no idempotency_key). The draft lands in the
    // practitioner's OWN local Drafts folder, disclosed to no one.
    draftResult = generateDraft(ctx, { threadId: threadId as string });
  } finally {
    probe.uninstall();
  }

  const socketsOpened = probe.violations.length;
  const offenders = probe.violations.map((v) => {
    const [host, port] = v.target.split(':');
    return { kind: v.kind, host, port: port ?? '', target: v.target, stack: v.stack };
  });

  // 3a. A socket was opened: FAIL LOUDLY, offender named, envelope err. Takes precedence over every
  // other outcome, because the record survives even a generation that swallowed the throw into a
  // structured `generation_failed` (probe.mjs header: assert the record, not only the throw).
  if (socketsOpened > 0) {
    return err('egress_violated', {
      state: 'violated',
      passed: false,
      socketsOpened,
      offenders,
      steps: SELF_TEST_STEPS.map((name) => ({ name, completed: false })),
    });
  }

  // 3b. No socket, but the loop could not finish for a NON-egress reason (the thread went stale, no
  // voice profile matched, the adapter refused): report it honestly rather than claim a clean pass
  // over a run that did not happen.
  if (!draftResult.ok) {
    return err('self_test_incomplete', {
      reason: draftResult.error,
      socketsOpened: 0,
      steps: SELF_TEST_STEPS.map((name) => ({ name, completed: false })),
    });
  }

  // 3c. Clean: the loop completed and opened zero sockets. The claim, measured.
  const draftId = (draftResult as { draftId?: string | null }).draftId ?? null;
  return ok({
    passed: true,
    state: 'local',
    socketsOpened: 0,
    offenders: [],
    steps: SELF_TEST_STEPS.map((name) => ({ name, completed: true })),
    draftId,
  });
}
