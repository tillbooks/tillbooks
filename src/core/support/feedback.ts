/**
 * G08 §4, the six verbs.
 *
 * Two design facts carry most of the weight here, and both are why this spec owns no SQLite table:
 *
 * - **The feedback log IS the directory.** `listFeedback` reads `~/.till/feedback/`. There is no
 *   second record to drift out of sync with the files it describes, so a user deleting a file
 *   deletes the row, and no reconciliation can ever be needed.
 * - **Idempotency without a key store.** The filename is DERIVED from the idempotency key
 *   (`fb_<base32(sha256(key))>`) and written with `O_EXCL`, so the file is its own key record. That
 *   is what lets §H-IDEMPOTENT hold for a capability that owns no table: a repeat call finds the
 *   file, reads it, and returns it unchanged.
 */

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { readConfig, writeCapture } from './config.js';
import type { SupportPaths } from './config.js';
import { appendEntry, clearJournal, readJournal, JOURNAL_CAP } from './diagnostics.js';
import { redactEntry } from './redact.js';
import type { DiagnosticEntry, RawDiagnostic } from './redact.js';
import {
  buildMailto,
  kindFromTitle,
  renderReport,
  FEEDBACK_KINDS,
  MESSAGE_MAX,
  SUBJECT_MAX,
} from './report.js';
import type { FeedbackKind, ReportEnvironment } from './report.js';

export interface SupportDeps {
  readonly paths: SupportPaths;
  readonly now: () => string;
  readonly env: ReportEnvironment;
  readonly installRoot: string;
}

export interface FeedbackInput {
  readonly kind?: unknown;
  readonly subject?: unknown;
  readonly message?: unknown;
  readonly includeDiagnostics?: unknown;
  readonly clientError?: unknown;
  readonly idempotencyKey?: unknown;
}

function validate(input: FeedbackInput): Result {
  const kind = input.kind ?? 'bug';
  if (typeof kind !== 'string' || !(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    return err('invalid_input', { field: 'kind', allowed: [...FEEDBACK_KINDS] });
  }
  const subject = input.subject;
  if (typeof subject !== 'string' || subject.trim() === '') {
    return err('invalid_input', { field: 'subject' });
  }
  if (subject.length > SUBJECT_MAX) return err('invalid_input', { field: 'subject', max: SUBJECT_MAX });
  const message = input.message;
  if (typeof message !== 'string' || message.trim() === '') {
    return err('invalid_input', { field: 'message' });
  }
  if (message.length > MESSAGE_MAX) return err('invalid_input', { field: 'message', max: MESSAGE_MAX });
  return ok({ kind, subject, message });
}

/**
 * Resolve what may travel, honouring BOTH gates (§4).
 *
 * `capture` governs RECORDING to disk; `includeDiagnostics` governs what TRAVELS. They are different
 * questions and collapsing them breaks a promise in one direction or the other: one way transmits
 * without consent, the other silences the crash report, which is the one report we most need.
 *
 * `clientError` is therefore not a second door: it is refused on exactly the same condition as the
 * journal, so an agent gets `diagnostics_not_enabled` whichever route it tries.
 */
function resolveDiagnostics(
  deps: SupportDeps,
  include: boolean,
  clientError: RawDiagnostic | undefined,
): Result {
  if (!include) return ok({ entries: undefined });
  const config = readConfig(deps.paths);
  if (!config.capture) {
    // No parameter can turn capture on. Consent is read from the user's stored choice, mirroring
    // E04's per-contact grounding consent, so an agent can never override it.
    return err('diagnostics_not_enabled');
  }
  const journal = readJournal(deps.paths);
  if (journal.ok === false) return journal;
  const entries = [...(journal.entries as readonly DiagnosticEntry[])];
  if (clientError !== undefined) {
    entries.push(redactEntry(clientError, { installRoot: deps.installRoot }));
  }
  return ok({ entries });
}

function parseClientError(raw: unknown, now: string): RawDiagnostic | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    kind: record.kind === 'transport_error' ? 'transport_error' : 'unhandled_exception',
    at: typeof record.at === 'string' ? record.at : now,
    code: typeof record.code === 'string' ? record.code : undefined,
    action: typeof record.action === 'string' ? record.action : undefined,
    surface: typeof record.surface === 'string' ? record.surface : undefined,
    error: record.error,
  };
}

interface Rendered {
  readonly report: string;
  readonly mailto: string;
  readonly mailtoBody: string;
  readonly truncated: boolean;
  readonly diagnosticsIncluded: boolean;
}

function render(deps: SupportDeps, input: FeedbackInput): Result {
  const valid = validate(input);
  if (valid.ok === false) return valid;
  const at = deps.now();
  const clientError = parseClientError(input.clientError, at);
  const resolved = resolveDiagnostics(deps, input.includeDiagnostics === true, clientError);
  if (resolved.ok === false) return resolved;
  const entries = resolved.entries as readonly DiagnosticEntry[] | undefined;
  const kind = valid.kind as FeedbackKind;
  const subject = valid.subject as string;
  const message = valid.message as string;
  const report = renderReport({ kind, subject, message, at, env: deps.env, diagnostics: entries });
  const mail = buildMailto(`[${kind}] ${subject}`, message);
  const out: Rendered = {
    report,
    mailto: mail.mailto,
    mailtoBody: mail.mailtoBody,
    truncated: mail.truncated,
    diagnosticsIncluded: entries !== undefined,
  };
  return ok({ ...out, at });
}

/** Render exactly what would be sent, and write nothing (P5). */
export function previewFeedback(deps: SupportDeps, input: FeedbackInput): Result {
  return render(deps, input);
}

/** `fb_` plus a base32 digest of the idempotency key. The file is its own key record. */
export function feedbackIdFor(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest();
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (let i = 0; i < 16; i += 1) out += alphabet[digest[i]! % 32];
  return `fb_${out}`;
}

export function prepareFeedback(deps: SupportDeps, input: FeedbackInput): Result {
  const idempotencyKey = input.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const rendered = render(deps, input);
  if (rendered.ok === false) return rendered;
  const feedbackId = feedbackIdFor(idempotencyKey);
  const path = join(deps.paths.feedbackDir, `${feedbackId}.md`);
  const body = rendered.report as string;
  try {
    mkdirSync(deps.paths.feedbackDir, { recursive: true });
    // O_EXCL is the idempotency check. A repeat call loses the race with itself and reads instead.
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Same key, same report: return the original rather than writing a second file (§H-IDEMPOTENT).
      const existing = readFileSync(path, 'utf8');
      return ok({
        feedbackId,
        path,
        report: existing,
        mailto: rendered.mailto,
        mailtoBody: rendered.mailtoBody,
        truncated: rendered.truncated,
        diagnosticsIncluded: rendered.diagnosticsIncluded,
        state: 'prepared',
      });
    }
    return err('feedback_not_writable', { path, reason: e instanceof Error ? e.name : 'unknown' });
  }
  return ok({
    feedbackId,
    path,
    report: body,
    mailto: rendered.mailto,
    mailtoBody: rendered.mailtoBody,
    truncated: rendered.truncated,
    diagnosticsIncluded: rendered.diagnosticsIncluded,
    state: 'prepared',
  });
}

export interface FeedbackRow {
  readonly feedbackId: string;
  readonly subject: string;
  readonly kind: string;
  readonly at: string;
  readonly path: string;
  readonly state: 'prepared';
}

const TITLE_RE = /^# TILL feedback: (.*)$/m;
const KIND_RE = /^- Kind: (.*)$/m;
const AT_RE = /^- Written: (.*)$/m;

/**
 * The directory IS the log. Nothing is indexed, so nothing can be stale, and a user who deletes a
 * file has deleted the row. Rows carry `prepared` and never `sent`: TILL hands a report to the mail
 * client and cannot observe what happens next.
 */
export function listFeedback(deps: SupportDeps): Result {
  let names: string[];
  try {
    names = readdirSync(deps.paths.feedbackDir).filter((n) => n.endsWith('.md'));
  } catch {
    return ok({ reports: [] });
  }
  const reports: FeedbackRow[] = [];
  for (const name of names) {
    const path = join(deps.paths.feedbackDir, name);
    try {
      const body = readFileSync(path, 'utf8');
      reports.push({
        feedbackId: name.replace(/\.md$/, ''),
        subject: TITLE_RE.exec(body)?.[1] ?? name,
        kind: kindFromTitle(KIND_RE.exec(body)?.[1] ?? '') ?? '',
        at: AT_RE.exec(body)?.[1] ?? statSync(path).mtime.toISOString(),
        path,
        state: 'prepared',
      });
    } catch {
      continue;
    }
  }
  reports.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return ok({ reports, folder: deps.paths.feedbackDir });
}

export function getDiagnostics(deps: SupportDeps): Result {
  const config = readConfig(deps.paths);
  if (!config.capture) {
    return ok({
      capture: false,
      configReadable: config.configReadable,
      entries: [],
      cap: JOURNAL_CAP,
      journalPath: deps.paths.journalPath,
    });
  }
  const journal = readJournal(deps.paths);
  if (journal.ok === false) return journal;
  return ok({
    capture: true,
    configReadable: config.configReadable,
    entries: journal.entries,
    cap: JOURNAL_CAP,
    journalPath: deps.paths.journalPath,
  });
}

/**
 * Set the opt-in. Absolute state, so no idempotency key (§H-IDEMPOTENT's own exemption, with the
 * written reason in G08 §5).
 *
 * Turning capture OFF deletes the journal. Off means gone, not dormant, and the hint beside the
 * switch states that consequence BEFORE the click so the destruction is disclosed, not discovered.
 */
export function setDiagnostics(deps: SupportDeps, input: { readonly capture?: unknown }): Result {
  if (typeof input.capture !== 'boolean') return err('invalid_input', { field: 'capture' });
  const written = writeCapture(deps.paths, input.capture);
  if (written.ok === false) return written; // capture stays off: the private failure mode
  if (!input.capture) {
    const cleared = clearJournal(deps.paths);
    if (cleared.ok === false) return cleared;
  }
  return ok({ capture: input.capture });
}

/** Erase the journal, leaving written reports alone. Absolute state, so no idempotency key. */
export function clearDiagnostics(deps: SupportDeps): Result {
  return clearJournal(deps.paths);
}

/**
 * The `DiagnosticsPort` implementation a host wires. Reads the preference on every call, so a user
 * switching capture off stops recording immediately rather than at the next restart.
 */
export function recordDiagnostic(deps: SupportDeps, raw: RawDiagnostic): void {
  if (!readConfig(deps.paths).capture) return;
  appendEntry(deps.paths, redactEntry(raw, { installRoot: deps.installRoot }));
}
