/**
 * N00, THE HAUSBUCH: the workspace's house notes ("Hausregeln"), the conventions agents follow.
 *
 * A note is short free text with a SCOPE: the whole workspace, one account, one bank counterparty or a
 * topic. It is GUIDANCE ONLY: nothing in the engine reads a note to post, book or file (D139 stays whole),
 * so a wrong note costs a wrong hint, never a wrong figure. The brief (`./brief.ts`) carries every active
 * note to the agent, and the Studio shows a counterparty's note beside its bank lines.
 *
 * WHO WRITES. `hausbuch_note_set` and `hausbuch_note_archive` need A24 `manage_settings` and are governed
 * by the agent dial under `customize`, the family the settings writes use (`src/core/agent/dialMap.ts`):
 * an agent's write drafts a Vorschlag at the default level, the owner approves it in Pendenzen, and the
 * approval replays the verb as the person who approved it. One knob, the dial; no second setting.
 *
 * THE COUNTERPARTY SCOPE IS THE BANK'S OWN KEY. A counterparty note is keyed exactly as a Buchungsregel is
 * (`bank_standard.counterparty_key`, `counterpartyKeyOf` in `banking/bankProposals.ts`): `iban:<IBAN>` or
 * `name:<normalised name>`. So a note meets the bank lines of that payer in the Details panel without a
 * contact in between. A caller may give the key itself, or a raw IBAN or name that is folded into it.
 *
 * A COUNTERPARTY IS BANK DATA (security review, 02.11.2026). Its key carries an IBAN or a payer's name and
 * its label is read from the Buchungsregeln and the bank lines, which A24 puts behind `read_sales` (the
 * gate of `list_bank_inbox` and `list_bank_standards`). So a caller without `read_sales` never sees a
 * counterparty note in a list or the brief (they are `withheld`, counted, never shown), never gets a label
 * resolved from bank data when it writes one, and reads any counterparty scope a write answers with its
 * reference and label blanked.
 *
 * EVERY CHANGE IS RECORDED AND IDEMPOTENT ON ROWS. A create, an update, an archive and a restore each write
 * the note, one `hausbuch_note_change` row (old and new text and scope, the actor) and one A03 audit-chain
 * row, in ONE transaction under the call's idempotency key: a replay answers the stored result and writes
 * nothing. A set that changes nothing, or an archive of an archived note, records nothing (`changed: false`).
 *
 * §H-TENANT: every statement is scoped by `ctx.workspaceId`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { lineCounterpartyOf, normalisedName } from '../banking/bankProposals.js';
import { readBankTxn, readBankTxnDetail } from '../banking/bankLines.js';
import { cardKeyOf } from '../banking/derivedCounterparty.js';
import { isValidIban, normalizeIban } from '../setup/iban.js';

/** The longest note: a sentence or two the next session reads, never a document. */
export const NOTE_TEXT_MAX = 500;
/** The longest topic label (`MWST`, `Spesen`, `Lohn`). */
export const NOTE_TOPIC_MAX = 40;
/** The longest counterparty a caller may name (a bank's name field is 140 characters, ISO 20022). */
export const NOTE_COUNTERPARTY_MAX = 140;

/** What a note is about (§H-ENUM, single point; the Studio mirrors it). */
export const NOTE_SCOPE_KINDS = ['workspace', 'account', 'counterparty', 'topic'] as const;
export type NoteScopeKind = (typeof NOTE_SCOPE_KINDS)[number];

export const NOTE_STATUSES = ['active', 'archived'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** A stored scope: the kind, the stored reference, and the label a person reads. */
export interface NoteScope {
  kind: NoteScopeKind;
  /** An account id, a counterparty key (`iban:` / `name:`), a topic; null for the workspace. */
  ref: string | null;
  /** The account as `number name`, the counterparty as the bank names it, the topic; null for the workspace. */
  label: string | null;
}

/** A note as every face answers it. */
export type HausbuchNote = {
  id: string;
  scope: NoteScope;
  text: string;
  status: NoteStatus;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

interface NoteRow {
  id: string;
  workspace_id: string;
  scope_kind: NoteScopeKind;
  scope_ref: string | null;
  scope_label: string | null;
  text: string;
  status: NoteStatus;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

// --- input checks ------------------------------------------------------------------------------------

/** The trimmed note text, or the refusal naming the field and the bound. */
function checkText(value: unknown): { text: string } | { refusal: Err } {
  if (typeof value !== 'string') return { refusal: err('invalid_input', { field: 'text', maxLength: NOTE_TEXT_MAX }) };
  const text = value.trim();
  if (text.length === 0 || text.length > NOTE_TEXT_MAX) {
    return { refusal: err('invalid_input', { field: 'text', maxLength: NOTE_TEXT_MAX, length: text.length }) };
  }
  return { text };
}

function checkKey(value: unknown): { key: string } | { refusal: Err } {
  return typeof value === 'string' && value.length > 0 ? { key: value } : { refusal: err('invalid_input', { field: 'idempotencyKey' }) };
}

/** The bank's read gate (`list_bank_inbox`, `list_bank_standards`): who may see a counterparty. */
export const BANK_READ_CAPABILITY = 'read_sales';

function canReadBank(ctx: WorkspaceContext): boolean {
  return ctx.capabilities.assert(BANK_READ_CAPABILITY).ok;
}

/** The bank's counterparty keys for a name and an IBAN, IBAN first: what a bank line is grouped by. */
export function counterpartyKeysOf(counterparty: { name?: string | null; iban?: string | null }): string[] {
  const keys: string[] = [];
  const iban = typeof counterparty.iban === 'string' && counterparty.iban.trim().length > 0 ? normalizeIban(counterparty.iban) : null;
  if (iban !== null) keys.push(`iban:${iban}`);
  const name = normalisedName(typeof counterparty.name === 'string' ? counterparty.name : null);
  if (name !== null) keys.push(`name:${name}`);
  return keys;
}

/** The name a bank gave a counterparty key: a Buchungsregel's label first, else a line's, else null. */
function counterpartyLabelOf(ctx: WorkspaceContext, key: string): string | null {
  const rule = ctx.store.db
    .prepare('SELECT counterparty_label FROM bank_standard WHERE workspace_id = ? AND counterparty_key = ? ORDER BY set_at DESC, rowid DESC LIMIT 1')
    .get(ctx.workspaceId, key) as { counterparty_label: string } | undefined;
  if (rule !== undefined && rule.counterparty_label.trim().length > 0) return rule.counterparty_label;
  if (key.startsWith('iban:')) {
    const iban = key.slice('iban:'.length);
    const lines = ctx.store.db
      .prepare(
        `SELECT counterparty_name, counterparty_iban FROM bank_txn_detail
          WHERE workspace_id = ? AND counterparty_iban IS NOT NULL AND counterparty_name IS NOT NULL ORDER BY rowid DESC`,
      )
      .all(ctx.workspaceId) as { counterparty_name: string; counterparty_iban: string }[];
    const named = lines.find((l) => normalizeIban(l.counterparty_iban) === iban);
    if (named !== undefined) return named.counterparty_name;
  }
  return null;
}

/**
 * Resolve a scope as a caller states it (`{kind, ref?}`) to what is stored. An account is named by its
 * number or its id (stored as the id, so a renumbered account keeps its notes; unknown is
 * `scope_not_found`); a counterparty by its bank key (`iban:` / `name:`) or a raw IBAN or name, folded into
 * the key; a topic by a label of 1 to 40 characters; the workspace takes no reference.
 */
export function resolveScope(ctx: WorkspaceContext, raw: unknown): { scope: NoteScope } | { refusal: Err } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { refusal: err('invalid_input', { field: 'scope', allowed: [...NOTE_SCOPE_KINDS] }) };
  }
  const { kind, ref } = raw as { kind?: unknown; ref?: unknown };
  if (typeof kind !== 'string' || !(NOTE_SCOPE_KINDS as readonly string[]).includes(kind)) {
    return { refusal: err('invalid_input', { field: 'scope.kind', allowed: [...NOTE_SCOPE_KINDS] }) };
  }
  if (kind === 'workspace') return { scope: { kind: 'workspace', ref: null, label: null } };
  if (typeof ref !== 'string' || ref.trim().length === 0) return { refusal: err('invalid_input', { field: 'scope.ref' }) };
  const wanted = ref.trim();
  if (kind === 'topic') {
    if (wanted.length > NOTE_TOPIC_MAX) return { refusal: err('invalid_input', { field: 'scope.ref', maxLength: NOTE_TOPIC_MAX }) };
    return { scope: { kind: 'topic', ref: wanted, label: wanted } };
  }
  if (kind === 'account') {
    const account = ctx.store.db
      .prepare('SELECT id, number, name FROM account WHERE workspace_id = ? AND (id = ? OR number = ?) ORDER BY (id = ?) DESC LIMIT 1')
      .get(ctx.workspaceId, wanted, wanted, wanted) as { id: string; number: string; name: string } | undefined;
    if (account === undefined) return { refusal: err('scope_not_found', { scope: { kind, ref: wanted } }) };
    return { scope: { kind: 'account', ref: account.id, label: `${account.number} ${account.name}` } };
  }
  // counterparty
  if (wanted.length > NOTE_COUNTERPARTY_MAX) return { refusal: err('invalid_input', { field: 'scope.ref', maxLength: NOTE_COUNTERPARTY_MAX }) };
  let key: string | null;
  let given: string | null = null;
  if (wanted.startsWith('iban:')) {
    const iban = normalizeIban(wanted.slice('iban:'.length));
    key = iban.length > 0 ? `iban:${iban}` : null;
  } else if (wanted.startsWith('card:')) {
    // D188 (critic r1 L-c): a counterparty TILL read from a card text, keyed exactly as `lineCounterpartyOf`.
    const body = cardKeyOf(wanted.slice('card:'.length));
    key = body === null ? null : `card:${body}`;
  } else if (wanted.startsWith('bank:')) {
    // D188: the account's own bank of a fee line, by its institution id (or the own IBAN).
    const body = wanted.slice('bank:'.length).replace(/\s+/g, '').toUpperCase();
    key = /^[A-Z0-9]{1,34}$/.test(body) ? `bank:${body}` : null;
  } else if (wanted.startsWith('name:')) {
    const name = normalisedName(wanted.slice('name:'.length));
    key = name === null ? null : `name:${name}`;
  } else if (isValidIban(wanted)) {
    key = `iban:${normalizeIban(wanted)}`;
  } else {
    const name = normalisedName(wanted);
    key = name === null ? null : `name:${name}`;
    given = wanted;
  }
  if (key === null) return { refusal: err('invalid_input', { field: 'scope.ref' }) };
  // The bank's own name for the key only for a caller who may read the bank; anyone else keeps what they typed.
  const label = given ?? (canReadBank(ctx) ? counterpartyLabelOf(ctx, key) : null) ?? key.slice(key.indexOf(':') + 1);
  return { scope: { kind: 'counterparty', ref: key, label } };
}

// --- reading -----------------------------------------------------------------------------------------

function loadNote(ctx: WorkspaceContext, id: string): NoteRow | undefined {
  return ctx.store.db.prepare('SELECT * FROM hausbuch_note WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) as NoteRow | undefined;
}

/** The label of an account note as the chart reads NOW (a renamed account reads its new name). */
function accountLabels(ctx: WorkspaceContext, rows: readonly NoteRow[]): Map<string, string> {
  const ids = [...new Set(rows.filter((r) => r.scope_kind === 'account' && r.scope_ref !== null).map((r) => r.scope_ref as string))];
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;
  const found = ctx.store.db
    .prepare(`SELECT id, number, name FROM account WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(', ')})`)
    .all(ctx.workspaceId, ...ids) as { id: string; number: string; name: string }[];
  for (const a of found) labels.set(a.id, `${a.number} ${a.name}`);
  return labels;
}

function viewsOf(ctx: WorkspaceContext, rows: readonly NoteRow[]): HausbuchNote[] {
  const accounts = accountLabels(ctx, rows);
  const bank = rows.some((r) => r.scope_kind === 'counterparty') ? canReadBank(ctx) : true;
  return rows.map((r) => ({
    id: r.id,
    scope:
      r.scope_kind === 'counterparty' && !bank
        ? { kind: r.scope_kind, ref: null, label: null }
        : {
            kind: r.scope_kind,
            ref: r.scope_ref,
            label: r.scope_kind === 'account' && r.scope_ref !== null ? (accounts.get(r.scope_ref) ?? r.scope_label) : r.scope_label,
          },
    text: r.text,
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

function viewOf(ctx: WorkspaceContext, row: NoteRow): HausbuchNote {
  return viewsOf(ctx, [row])[0] as HausbuchNote;
}

/** The rows a caller may see: counterparty notes only with the bank's read right; the rest counted. */
function visible(ctx: WorkspaceContext, rows: readonly NoteRow[]): { rows: NoteRow[]; withheld: number } {
  if (!rows.some((r) => r.scope_kind === 'counterparty') || canReadBank(ctx)) return { rows: [...rows], withheld: 0 };
  const shown = rows.filter((r) => r.scope_kind !== 'counterparty');
  return { rows: shown, withheld: rows.length - shown.length };
}

/**
 * Every active note the caller may see, scope kind in `NOTE_SCOPE_KINDS` order, newest first inside a kind
 * (the brief's order), and how many counterparty notes were withheld from a caller without `read_sales`.
 */
export function activeNotes(ctx: WorkspaceContext): { notes: HausbuchNote[]; withheld: number } {
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM hausbuch_note WHERE workspace_id = ? AND status = 'active'
        ORDER BY CASE scope_kind WHEN 'workspace' THEN 0 WHEN 'account' THEN 1 WHEN 'counterparty' THEN 2 ELSE 3 END,
                 updated_at DESC, id DESC`,
    )
    .all(ctx.workspaceId) as NoteRow[];
  const seen = visible(ctx, rows);
  return { notes: viewsOf(ctx, seen.rows), withheld: seen.withheld };
}

export interface ListNotesInput {
  scope?: unknown;
  status?: unknown;
  counterparty?: unknown;
}

export type ListNotesOk = {
  notes: HausbuchNote[];
  /** Counterparty notes withheld from a caller without `read_sales` (counted, never shown). */
  withheld: number;
};

const LIST_STATUSES = ['active', 'archived', 'all'] as const;

/**
 * The notes, newest change first. `status` is `active` (default), `archived` or `all`; `scope` narrows to a
 * kind (`{kind}`) or one scope (`{kind, ref}`); `counterparty` (`{name?, iban?, bankTxnId?}`, a bank line's
 * counterparty, or the line itself: its key through `lineCounterpartyOf`, D188) answers the ACTIVE
 * counterparty notes keyed by its IBAN, its normalised name or the counterparty its text names, and needs the
 * bank's read right too (`read_sales`, `permission_denied` otherwise), as does a `scope` filter of kind
 * `counterparty`, refused before the key is resolved. Read right: `read_master_data` (house
 * notes are workspace configuration); counterparty notes only beside `read_sales` (see the module note).
 */
export function listNotes(ctx: WorkspaceContext, input: ListNotesInput = {}): Result<ListNotesOk> {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const status = input.status ?? 'active';
  if (typeof status !== 'string' || !(LIST_STATUSES as readonly string[]).includes(status)) {
    return err('invalid_input', { field: 'status', allowed: [...LIST_STATUSES] });
  }
  if (input.counterparty !== undefined && input.counterparty !== null) {
    const cp = input.counterparty;
    if (typeof cp !== 'object' || Array.isArray(cp)) return err('invalid_input', { field: 'counterparty' });
    const { name, iban, bankTxnId } = cp as { name?: unknown; iban?: unknown; bankTxnId?: unknown };
    if (
      (name !== undefined && name !== null && typeof name !== 'string') ||
      (iban !== undefined && iban !== null && typeof iban !== 'string') ||
      (bankTxnId !== undefined && bankTxnId !== null && typeof bankTxnId !== 'string')
    ) {
      return err('invalid_input', { field: 'counterparty' });
    }
    const bank = ctx.capabilities.assert(BANK_READ_CAPABILITY);
    if (!bank.ok) return bank;
    const keys = counterpartyKeysOf({ name: name ?? null, iban: iban ?? null });
    // D188 (critic r1 L-c): a bank line names its counterparty through the ONE reader, `lineCounterpartyOf`,
    // so a card or fee line finds the notes of the counterparty its text names. §H-TENANT: `readBankTxn` reads
    // this workspace's line only; another workspace's id finds nothing.
    if (typeof bankTxnId === 'string' && bankTxnId !== '') {
      const row = readBankTxn(ctx, bankTxnId);
      const key = row === undefined ? null : (lineCounterpartyOf(ctx, row, readBankTxnDetail(ctx, row.id))?.key ?? null);
      if (key !== null && !keys.includes(key)) keys.push(key);
    }
    if (keys.length === 0) return ok<ListNotesOk>({ notes: [], withheld: 0 });
    const rows = ctx.store.db
      .prepare(
        `SELECT * FROM hausbuch_note WHERE workspace_id = ? AND status = 'active' AND scope_kind = 'counterparty'
           AND scope_ref IN (${keys.map(() => '?').join(', ')}) ORDER BY updated_at DESC, id DESC`,
      )
      .all(ctx.workspaceId, ...keys) as NoteRow[];
    return ok<ListNotesOk>({ notes: viewsOf(ctx, rows), withheld: 0 });
  }
  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (input.scope !== undefined && input.scope !== null) {
    const raw = input.scope;
    if (typeof raw !== 'object' || Array.isArray(raw)) return err('invalid_input', { field: 'scope', allowed: [...NOTE_SCOPE_KINDS] });
    const { kind, ref } = raw as { kind?: unknown; ref?: unknown };
    // Security review r2 (existence oracle): a counterparty filter is a bank read. Refused BEFORE the key
    // is resolved or matched, the same refusal the `counterparty` lookup gives, so a caller without the
    // bank's read right learns nothing about whether a key exists.
    if (kind === 'counterparty') {
      const bank = ctx.capabilities.assert(BANK_READ_CAPABILITY);
      if (!bank.ok) return bank;
    }
    if (ref === undefined || ref === null || ref === '' || kind === 'workspace') {
      if (typeof kind !== 'string' || !(NOTE_SCOPE_KINDS as readonly string[]).includes(kind)) {
        return err('invalid_input', { field: 'scope.kind', allowed: [...NOTE_SCOPE_KINDS] });
      }
      where.push('scope_kind = ?');
      params.push(kind);
    } else {
      const resolved = resolveScope(ctx, raw);
      if ('refusal' in resolved) return resolved.refusal;
      where.push('scope_kind = ? AND scope_ref = ?');
      params.push(resolved.scope.kind, resolved.scope.ref);
    }
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM hausbuch_note WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC`)
    .all(...params) as NoteRow[];
  const seen = visible(ctx, rows);
  return ok<ListNotesOk>({ notes: viewsOf(ctx, seen.rows), withheld: seen.withheld });
}

// --- writing -----------------------------------------------------------------------------------------

/** What a set or an archive answers. */
export type NoteWriteOk = {
  note: HausbuchNote;
  /** False when the call changed nothing (the same text and scope, or an archive of an archived note). */
  changed: boolean;
  /** The history row the change wrote, or null when nothing changed. */
  changeId: string | null;
};

type ChangeKind = 'create' | 'update' | 'archive' | 'restore';

/** The A03 action each change stamps: the audit vocabulary's existing words. */
const AUDIT_ACTION_FOR: Readonly<Record<ChangeKind, string>> = {
  create: 'create',
  update: 'update',
  archive: 'archive',
  restore: 'unarchive',
};

function scopeJson(kind: NoteScopeKind, ref: string | null): string {
  return JSON.stringify({ kind, ref });
}

/** The history row and the audit-chain row of one accepted change; runs inside the caller's transaction. */
function recordChange(
  ctx: WorkspaceContext,
  noteId: string,
  kind: ChangeKind,
  before: NoteRow | undefined,
  after: { text: string; scope: NoteScope } | null,
  at: string,
): string {
  const changeId = ctx.ids.next('hbc');
  ctx.store.db
    .prepare(
      `INSERT INTO hausbuch_note_change (id, workspace_id, note_id, kind, old_text, new_text, old_scope_json, new_scope_json, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      changeId,
      ctx.workspaceId,
      noteId,
      kind,
      before?.text ?? null,
      after?.text ?? null,
      before === undefined ? null : scopeJson(before.scope_kind, before.scope_ref),
      after === null ? null : scopeJson(after.scope.kind, after.scope.ref),
      ctx.actor,
      at,
    );
  ctx.audit.record({ entityKind: 'hausbuch_note', entityId: noteId, action: AUDIT_ACTION_FOR[kind], actor: ctx.actor, at });
  return changeId;
}

export interface SetNoteInput {
  id?: unknown;
  text?: unknown;
  scope?: unknown;
  idempotencyKey?: unknown;
}

/**
 * Write a note: a new one without `id`, a change to one with `id` (an archived note comes back active,
 * which is the way back of an archive). Needs `manage_settings`; an agent seat's call drafts under the dial.
 */
export function setNote(ctx: WorkspaceContext, input: SetNoteInput): Result<NoteWriteOk> {
  const capable = ctx.capabilities.assert('manage_settings');
  if (!capable.ok) return capable;
  const k = checkKey(input.idempotencyKey);
  if ('refusal' in k) return k.refusal;
  const replayed = ctx.store.recallIdempotent<Result<NoteWriteOk>>(ctx.workspaceId, k.key, 'hausbuch_note_set');
  if (replayed !== undefined) return replayed;
  if (input.id !== undefined && input.id !== null && (typeof input.id !== 'string' || input.id.length === 0)) {
    return err('invalid_input', { field: 'id' });
  }
  const t = checkText(input.text);
  if ('refusal' in t) return t.refusal;
  const s = resolveScope(ctx, input.scope);
  if ('refusal' in s) return s.refusal;
  let existing: NoteRow | undefined;
  if (typeof input.id === 'string') {
    existing = loadNote(ctx, input.id);
    if (existing === undefined) return err('not_found', { noteId: input.id });
  }
  const next = { text: t.text, scope: s.scope };
  return ctx.store.rememberIdempotent(ctx.workspaceId, k.key, 'hausbuch_note_set', (): Result<NoteWriteOk> => {
    const now = ctx.clock.now();
    if (existing === undefined) {
      const id = ctx.ids.next('hbn');
      ctx.store.db
        .prepare(
          `INSERT INTO hausbuch_note (id, workspace_id, scope_kind, scope_ref, scope_label, text, status, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, next.scope.kind, next.scope.ref, next.scope.label, next.text, now, ctx.actor, now, ctx.actor);
      const changeId = recordChange(ctx, id, 'create', undefined, next, now);
      return ok<NoteWriteOk>({ note: viewOf(ctx, loadNote(ctx, id) as NoteRow), changed: true, changeId });
    }
    const restoring = existing.status === 'archived';
    const same = existing.text === next.text && existing.scope_kind === next.scope.kind && existing.scope_ref === next.scope.ref;
    if (same && !restoring) return ok<NoteWriteOk>({ note: viewOf(ctx, existing), changed: false, changeId: null });
    ctx.store.db
      .prepare(
        `UPDATE hausbuch_note SET scope_kind = ?, scope_ref = ?, scope_label = ?, text = ?, status = 'active', updated_at = ?, updated_by = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(next.scope.kind, next.scope.ref, next.scope.label, next.text, now, ctx.actor, ctx.workspaceId, existing.id);
    const changeId = recordChange(ctx, existing.id, restoring ? 'restore' : 'update', existing, next, now);
    return ok<NoteWriteOk>({ note: viewOf(ctx, loadNote(ctx, existing.id) as NoteRow), changed: true, changeId });
  });
}

export interface ArchiveNoteInput {
  id?: unknown;
  idempotencyKey?: unknown;
}

/** Archive a note: it leaves the brief and the bank Details; `hausbuch_note_set` on its id brings it back. */
export function archiveNote(ctx: WorkspaceContext, input: ArchiveNoteInput): Result<NoteWriteOk> {
  const capable = ctx.capabilities.assert('manage_settings');
  if (!capable.ok) return capable;
  const k = checkKey(input.idempotencyKey);
  if ('refusal' in k) return k.refusal;
  const replayed = ctx.store.recallIdempotent<Result<NoteWriteOk>>(ctx.workspaceId, k.key, 'hausbuch_note_archive');
  if (replayed !== undefined) return replayed;
  if (typeof input.id !== 'string' || input.id.length === 0) return err('invalid_input', { field: 'id' });
  const existing = loadNote(ctx, input.id);
  if (existing === undefined) return err('not_found', { noteId: input.id });
  return ctx.store.rememberIdempotent(ctx.workspaceId, k.key, 'hausbuch_note_archive', (): Result<NoteWriteOk> => {
    if (existing.status === 'archived') return ok<NoteWriteOk>({ note: viewOf(ctx, existing), changed: false, changeId: null });
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(`UPDATE hausbuch_note SET status = 'archived', updated_at = ?, updated_by = ? WHERE workspace_id = ? AND id = ?`)
      .run(now, ctx.actor, ctx.workspaceId, existing.id);
    const changeId = recordChange(ctx, existing.id, 'archive', existing, null, now);
    return ok<NoteWriteOk>({ note: viewOf(ctx, loadNote(ctx, existing.id) as NoteRow), changed: true, changeId });
  });
}
