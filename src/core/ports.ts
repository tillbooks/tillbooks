/**
 * The seams A02 consumes but does not own.
 *
 * A02 must honour period locks (A03) and the `post` capability (A24) without owning either. It
 * reaches them through these ports, so it stays unit-testable in isolation: Phase 1 wires the
 * permissive defaults below; A03 replaces `PeriodPort` with the real lock check, A24 replaces
 * `CapabilityPort` with the real grant matrix, and the audit hook (A03) replaces `noAudit` with the
 * hash-chained append. The call sites exist from day one, so there is no bypass to retrofit.
 */

import { ok } from './result.js';
import type { Result } from './result.js';

export interface CapabilityPort {
  /** `ok()` if the actor holds `capability`, else `err('permission_denied', { capability, ... })`. */
  assert(capability: string): Result;
}

export interface PeriodPort {
  /** `ok()` if `date` falls in an open period, else `err('period_locked', { period, kind })`. */
  assertOpen(date: string): Result;
}

export interface AuditEvent {
  entityKind: string;
  entityId: string;
  action: string;
  actor: string;
  at: string;
}

export interface AuditPort {
  record(event: AuditEvent): void;
}

/**
 * G08's seam. The engine notices a defect; it does not decide whether to write one down.
 *
 * The core ships `noDiagnostics` and nothing else, so an embedder that wires no host records
 * nothing at all. The host's implementation is the only thing that reads the user's capture
 * preference, which keeps the consent check in exactly one place and keeps file I/O out of the
 * engine's pure path. `entry` is already redacted by the time it reaches an implementation.
 */
export interface DiagnosticsPort {
  record(entry: {
    kind: 'verb_error' | 'unhandled_exception' | 'transport_error';
    at: string;
    code?: string | undefined;
    action?: string | undefined;
    surface?: string | undefined;
    detail?: Record<string, unknown> | undefined;
    error?: unknown;
  }): void;
}

/** Wave-0 default: every capability is granted. A24 supersedes this with the real grant matrix. */
export const allowAllCapabilities: CapabilityPort = { assert: () => ok() };

/** Default: nothing is recorded. G08's host implementation supersedes this when the user opts in. */
export const noDiagnostics: DiagnosticsPort = { record: () => undefined };

/** Phase-1 default: every period is open. A03 supersedes this with the real lock check. */
export const allPeriodsOpen: PeriodPort = { assertOpen: () => ok() };

/** Phase-1 default: auditing is a no-op. A03 supersedes this with the hash-chained append. */
export const noAudit: AuditPort = { record: () => undefined };
