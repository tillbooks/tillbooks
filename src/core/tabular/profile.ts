/**
 * A20 §13.4 (D205): the IMPORT PROFILE as a file format, `till-import-profile/v1`. A profile names one
 * export layout (the headers a file must carry, `match.headers`) and the mapping that reads it, for one kind
 * of table: a bank statement (A20) or a settlement table (A43). TILL ships a typed built-in catalogue per kind
 * (the bank one in `banking/csvMapping.ts`); a community profile is a pull request with one entry and a
 * synthetic fixture. There is no workspace profile table: a mapping lives where it is used, and a profile is
 * how it travels as a file. This module checks the ENVELOPE only; each kind checks its own mapping.
 */

export const IMPORT_PROFILE_FORMAT = 'till-import-profile/v1';

/** The kinds of table a profile reads (§H-ENUM, single point). */
export const IMPORT_PROFILE_KINDS = ['bank_statement', 'settlement_table'] as const;
export type ImportProfileKind = (typeof IMPORT_PROFILE_KINDS)[number];

export interface ImportProfile<M = unknown> {
  format: typeof IMPORT_PROFILE_FORMAT;
  kind: ImportProfileKind;
  /** Lower case letters, digits, `_`, `.` and `-`, at most 64 characters (`zkb_account_statement`). */
  id: string;
  /** What a person reads (`ZKB eBanking, Account statement (CSV)`). */
  label: string;
  /** A file carrying EVERY one of these headers is this layout. */
  match: { headers: string[] };
  mapping: M;
}

export type ProfileRefusal = { field: string; reason: string };

const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** A profile read from input: the envelope checked, the mapping handed on unread (the kind checks it). */
export function readImportProfileEnvelope(raw: unknown): { profile: ImportProfile<unknown> } | ProfileRefusal {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { field: 'profile', reason: `an object { format: '${IMPORT_PROFILE_FORMAT}', kind, id, label, match: { headers }, mapping }` };
  const p = raw as Record<string, unknown>;
  if (p['format'] !== IMPORT_PROFILE_FORMAT) return { field: 'profile.format', reason: `'${IMPORT_PROFILE_FORMAT}'` };
  const kind = p['kind'];
  if (typeof kind !== 'string' || !(IMPORT_PROFILE_KINDS as readonly string[]).includes(kind)) return { field: 'profile.kind', reason: IMPORT_PROFILE_KINDS.join(' | ') };
  const id = p['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) return { field: 'profile.id', reason: 'lower case letters, digits, _ . - (at most 64)' };
  const label = p['label'];
  if (typeof label !== 'string' || label.trim() === '' || label.length > 120) return { field: 'profile.label', reason: 'a name of at most 120 characters' };
  const match = p['match'];
  const headers = match !== null && typeof match === 'object' && !Array.isArray(match) ? (match as Record<string, unknown>)['headers'] : undefined;
  if (!Array.isArray(headers) || headers.length === 0 || headers.length > 64 || headers.some((h) => typeof h !== 'string' || h.trim() === '' || h.length > 200)) {
    return { field: 'profile.match.headers', reason: 'from 1 to 64 header texts' };
  }
  if (p['mapping'] === undefined) return { field: 'profile.mapping', reason: 'the mapping the profile reads its table with' };
  return { profile: { format: IMPORT_PROFILE_FORMAT, kind: kind as ImportProfileKind, id, label: label.trim(), match: { headers: (headers as string[]).map((h) => h.trim()) }, mapping: p['mapping'] } };
}

/** Does a file with these headers carry every header the profile names? */
export function profileMatches(profile: Pick<ImportProfile, 'match'>, headers: readonly string[]): boolean {
  const have = new Set(headers.map((h) => h.trim()));
  return profile.match.headers.every((h) => have.has(h));
}
