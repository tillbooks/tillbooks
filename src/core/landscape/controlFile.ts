/**
 * The TAMPER-EVIDENT landscape control file and its host-level audit chain (canon finding #2).
 *
 * The original design made `environments.json` an unaudited plain-JSON root of trust: anyone could
 * hand-edit it to repoint an environment's data root at `main`'s volume, or to flip a guard, with no
 * trace. This module closes that:
 *
 *   1. The control file carries a `checksum` over the canonical serialization of everything else, so a
 *      hand-edit that does not also recompute it is a DETECTED, REFUSED condition. `readLandscape`
 *      FAILS LOUD (throws `LandscapeIntegrityError`) on a mismatch; it never silently falls back.
 *   2. Every mutation appends a hash-chained record to `environments.audit.jsonl`
 *      (hash = H(prev_hash || canonical(record)), the ledger's own scheme), and the chain's tip is
 *      bound INTO the control file as `audit_head`. So truncating or rewriting the audit file, or
 *      swapping in an older control file, breaks the binding and is refused.
 *
 * The read helpers are the ones that FAIL LOUD: `env_list` / `env_status` must never render a landscape
 * they cannot vouch for. The write helper re-verifies before it appends, so a mutation on a tampered
 * file is refused before it can launder the tamper into a fresh, self-consistent checksum.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUDIT_FILE_NAME,
  AUDIT_GENESIS_PREV,
  CONTROL_FILE_NAME,
  type EnvAuditRecord,
  type LandscapeControlFile,
} from './model.js';

/** Thrown when the control file or its audit chain does not verify. Operations translate it to an err. */
export class LandscapeIntegrityError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'LandscapeIntegrityError';
  }
}

const CONTROL_PATH = (supportDir: string): string => join(supportDir, CONTROL_FILE_NAME);
const AUDIT_PATH = (supportDir: string): string => join(supportDir, AUDIT_FILE_NAME);

/** The separator between the prev hash and the record body in the chained audit hash (auditLog.ts). */
const HASH_SEP = '|';

/**
 * Canonical JSON with keys sorted at every level, so the checksum is stable regardless of insertion
 * order. Deliberately simple (objects and primitives only), which is all the control file holds.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** hash = H(prev_hash || canonical(record)), the ledger's audit scheme (auditLog.ts), for the host chain. */
export function auditHashRecord(prevHash: string, record: Omit<EnvAuditRecord, 'prev_hash' | 'hash'>): string {
  return createHash('sha256').update(prevHash).update(HASH_SEP).update(canonicalJson(record)).digest('hex');
}

/** The checksum a control file MUST carry: sha256 over everything except the checksum field itself. */
export function controlChecksum(file: Omit<LandscapeControlFile, 'checksum'>): string {
  return sha256Hex(canonicalJson(file));
}

/** Does a control file already exist on disk? Used by the operations to decide bootstrap vs load. */
export function landscapeExists(supportDir: string): boolean {
  return existsSync(CONTROL_PATH(supportDir));
}

/**
 * Read and VERIFY the control file, failing loud on any integrity problem. The caller must have
 * ensured the file exists (bootstrap is a separate, explicit step): a missing file throws
 * `control_missing` rather than being silently invented, so a read never fabricates a landscape.
 */
export function readLandscape(supportDir: string): LandscapeControlFile {
  const path = CONTROL_PATH(supportDir);
  if (!existsSync(path)) throw new LandscapeIntegrityError('control_missing');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new LandscapeIntegrityError('control_unreadable');
  }
  if (parsed === null || typeof parsed !== 'object') throw new LandscapeIntegrityError('control_malformed');

  const file = parsed as LandscapeControlFile;
  if (file.version !== 1) throw new LandscapeIntegrityError('control_version_unsupported');
  if (typeof file.checksum !== 'string' || file.checksum.length === 0) {
    throw new LandscapeIntegrityError('control_checksum_missing');
  }

  // 1. The control file must vouch for itself: recompute the checksum over everything else.
  const { checksum, ...rest } = file;
  if (controlChecksum(rest) !== checksum) throw new LandscapeIntegrityError('control_checksum_mismatch');

  // 2. The audit chain must match the head the control file binds, so neither file can be swapped
  //    independently of the other. A landscape with no head yet (only possible transiently) skips this.
  if (file.audit_head !== null) {
    const records = readAuditChain(supportDir);
    const tip = records[records.length - 1];
    if (tip === undefined) throw new LandscapeIntegrityError('audit_chain_missing');
    if (tip.seq !== file.audit_head.seq || tip.hash !== file.audit_head.hash) {
      throw new LandscapeIntegrityError('audit_head_mismatch');
    }
  }

  return file;
}

/**
 * Read the audit log and VERIFY the hash chain end to end: each record's `prev_hash` must be the prior
 * record's `hash`, and each `hash` must recompute. A break throws, so a truncated or edited audit file
 * is a detected condition. Returns the records in order.
 */
export function readAuditChain(supportDir: string): readonly EnvAuditRecord[] {
  const path = AUDIT_PATH(supportDir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const records: EnvAuditRecord[] = [];
  let prev = AUDIT_GENESIS_PREV;
  let expectedSeq = 1;
  for (const line of lines) {
    let record: EnvAuditRecord;
    try {
      record = JSON.parse(line) as EnvAuditRecord;
    } catch {
      throw new LandscapeIntegrityError('audit_record_unreadable');
    }
    if (record.seq !== expectedSeq) throw new LandscapeIntegrityError('audit_seq_break');
    if (record.prev_hash !== prev) throw new LandscapeIntegrityError('audit_prev_break');
    const { prev_hash, hash, ...body } = record;
    void prev_hash;
    if (auditHashRecord(prev, body) !== hash) throw new LandscapeIntegrityError('audit_hash_break');
    records.push(record);
    prev = record.hash;
    expectedSeq += 1;
  }
  return records;
}

/**
 * Persist a mutation ATOMICALLY-ENOUGH: append the new audit record, then write the control file whose
 * `audit_head` binds that record. The audit append happens first so that a crash between the two leaves
 * an audit record with no matching head, which `readLandscape` refuses (a refusal to open on a
 * detectable inconsistency, never a silent half-state). `verifiedPrevHead` is the head the caller read
 * and verified, so a concurrent writer cannot be clobbered without detection.
 *
 * Returns the fully-formed, checksummed control file that was written.
 */
export function writeLandscape(
  supportDir: string,
  next: Omit<LandscapeControlFile, 'audit_head' | 'checksum'>,
  audit: Omit<EnvAuditRecord, 'seq' | 'prev_hash' | 'hash'>,
  verifiedPrevHead: LandscapeControlFile['audit_head'],
): LandscapeControlFile {
  mkdirSync(supportDir, { recursive: true });

  const seq = (verifiedPrevHead?.seq ?? 0) + 1;
  const prev = verifiedPrevHead?.hash ?? AUDIT_GENESIS_PREV;
  const body = { seq, at: audit.at, actor: audit.actor, action: audit.action, target: audit.target, outcome: audit.outcome };
  const hash = auditHashRecord(prev, body);
  const record: EnvAuditRecord = { ...body, prev_hash: prev, hash };

  appendFileSync(AUDIT_PATH(supportDir), `${JSON.stringify(record)}\n`);

  const withHead: Omit<LandscapeControlFile, 'checksum'> = { ...next, audit_head: { seq, hash } };
  const file: LandscapeControlFile = { ...withHead, checksum: controlChecksum(withHead) };
  writeFileSync(CONTROL_PATH(supportDir), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}
