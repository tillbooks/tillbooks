/**
 * THE SETTLEMENT BOOKING TEMPLATE (D185): how the owner books one settlement source, kept in TILL and
 * never read from the file.
 *
 * One template per (workspace, `source.system`, `source.processor`), both names trimmed and lower case.
 * It holds the CLEARING ACCOUNT (the Durchlaufkonto the processor balance is booked on, a balance account:
 * an asset or a liability) and, per event kind, what an import does with an event of that kind:
 *
 *   - `{ action: 'book', accountId, taxCode | null }`: one entry, the clearing account against the contra
 *     account, the VAT (when the event carries any) under the tax code;
 *   - `{ action: 'skip' }`: nothing is booked (the money is booked elsewhere, or stays where it is);
 *   - `{ action: 'attention' }`: nothing is booked and the answer names the event as needing a person.
 *
 * DEFAULTS, filled in for a kind the save does not name (D172: every behaviour choice is a setting with a
 * sensible default, and this template is that setting): `bank_payout` and `bank_payout_summary` skip (the
 * bank import books the payout, bank account against the clearing account), `reserve` skips (a reserve
 * moves money inside the processor balance, which stays on the clearing account), `other` is `attention`.
 * Every other kind has no default: until the owner maps it, an import of a file that carries it refuses
 * `settlement_template_incomplete` naming it, before anything is written.
 *
 * Saving replaces the template (every change kept in `settlement_template_change`, old and new, and in
 * the audit chain). It books nothing. Needs `post`: what it decides is where every later settlement entry
 * goes, the right a Buchungsregel needs (`set_bank_standard`).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { SETTLEMENT_KINDS, normalizeSourceName } from './format.js';
import type { SettlementKind } from './format.js';

export const TEMPLATE_ACTIONS = ['book', 'skip', 'attention'] as const;
export type TemplateAction = (typeof TEMPLATE_ACTIONS)[number];

export type KindRule = { action: 'book'; accountId: string; taxCode: string | null } | { action: 'skip' } | { action: 'attention' };

export interface SettlementTemplate {
  clearingAccountId: string;
  kinds: Partial<Record<SettlementKind, KindRule>>;
}

/** The kinds a template defaults, and to what, when the save does not name them. */
export const TEMPLATE_KIND_DEFAULTS: Readonly<Partial<Record<SettlementKind, KindRule>>> = {
  bank_payout: { action: 'skip' },
  bank_payout_summary: { action: 'skip' },
  reserve: { action: 'skip' },
  other: { action: 'attention' },
};

/** The account types a clearing account may have: it holds a balance, so it is a balance account. */
const BALANCE_TYPES = new Set(['asset', 'liability']);

/** The tax-code kinds a settlement event can be booked under with an exact, externally stated VAT. */
export const BOOKABLE_TAX_KINDS: ReadonlySet<string> = new Set(['output', 'input', 'zero', 'exempt']);

interface AccountRow {
  id: string;
  number: string;
  name: string;
  type: string;
  archived: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function readAccountRow(ctx: WorkspaceContext, id: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AccountRow | undefined;
}

/** The source pair, normalised, or the refusal naming the field. */
export function readSource(input: { system?: unknown; processor?: unknown }): { system: string; processor: string } | Err {
  const system = normalizeSourceName(input.system);
  if (system === null) return err('invalid_input', { field: 'system', reason: 'the settlement source system, as the file names it in source.system' });
  const processor = normalizeSourceName(input.processor);
  if (processor === null) return err('invalid_input', { field: 'processor', reason: 'the settlement processor, as the file names it in source.processor' });
  return { system, processor };
}

/**
 * Check a template's accounts and tax codes against the workspace as it is NOW: every account exists, is
 * not archived, the clearing account is a balance account and no contra account is the clearing account;
 * every tax code exists, is active and is of a kind a stated VAT can be booked under. Read at save AND at
 * every import (an account archived since the save refuses the import, never a half-booked file).
 */
export function checkTemplate(ctx: WorkspaceContext, template: SettlementTemplate): Err | null {
  const clearing = readAccountRow(ctx, template.clearingAccountId);
  if (clearing === undefined) return err('invalid_account', { field: 'clearingAccountId', account: template.clearingAccountId, reason: 'no_such_account' });
  if (clearing.archived === 1) return err('account_archived', { field: 'clearingAccountId', account: clearing.number });
  if (!BALANCE_TYPES.has(clearing.type)) {
    return err('invalid_account', {
      field: 'clearingAccountId',
      account: clearing.number,
      reason: 'the clearing account holds the processor balance, so it must be a balance account (asset or liability)',
    });
  }
  for (const [kind, rule] of Object.entries(template.kinds) as [SettlementKind, KindRule][]) {
    if (rule.action !== 'book') continue;
    const field = `kinds.${kind}.accountId`;
    const account = readAccountRow(ctx, rule.accountId);
    if (account === undefined) return err('invalid_account', { field, account: rule.accountId, reason: 'no_such_account' });
    if (account.archived === 1) return err('account_archived', { field, account: account.number });
    if (account.id === clearing.id) return err('invalid_account', { field, account: account.number, reason: 'the contra account cannot be the clearing account' });
    if (rule.taxCode !== null) {
      const code = ctx.store.db
        .prepare('SELECT kind, active FROM tax_code WHERE workspace_id = ? AND code = ? ORDER BY valid_from DESC LIMIT 1')
        .get(ctx.workspaceId, rule.taxCode) as { kind: string; active: number } | undefined;
      if (code === undefined) return err('unknown_tax_code', { field: `kinds.${kind}.taxCode`, taxCode: rule.taxCode });
      if (code.active !== 1) return err('archived_tax_code', { field: `kinds.${kind}.taxCode`, taxCode: rule.taxCode });
      if (!BOOKABLE_TAX_KINDS.has(code.kind)) {
        return err('tax_code_unsupported', {
          field: `kinds.${kind}.taxCode`,
          taxCode: rule.taxCode,
          kind: code.kind,
          reason: 'a settlement books the VAT the file states, on the sale or purchase it describes: an output, input, zero-rated or exempt code',
        });
      }
    }
  }
  return null;
}

/** Read a template from a caller's input: the shape only (the workspace is checked by `checkTemplate`). */
export function readTemplateInput(input: { clearingAccountId?: unknown; kinds?: unknown }): SettlementTemplate | Err {
  if (typeof input.clearingAccountId !== 'string' || input.clearingAccountId.length === 0) return err('invalid_input', { field: 'clearingAccountId' });
  const raw = input.kinds ?? {};
  if (!isPlainObject(raw)) return err('invalid_input', { field: 'kinds', reason: 'an object keyed by event kind' });
  const kinds: Partial<Record<SettlementKind, KindRule>> = {};
  for (const [kind, value] of Object.entries(raw)) {
    if (!(SETTLEMENT_KINDS as readonly string[]).includes(kind)) {
      return err('invalid_input', { field: `kinds.${kind}`, reason: 'not a settlement event kind', allowed: [...SETTLEMENT_KINDS] });
    }
    if (value === null || value === undefined) continue;
    if (!isPlainObject(value)) return err('invalid_input', { field: `kinds.${kind}`, reason: 'an object { action, accountId?, taxCode? }' });
    const action = value['action'];
    if (action === 'skip' || action === 'attention') {
      kinds[kind as SettlementKind] = { action };
      continue;
    }
    if (action !== 'book') return err('invalid_input', { field: `kinds.${kind}.action`, allowed: [...TEMPLATE_ACTIONS] });
    if (typeof value['accountId'] !== 'string' || value['accountId'].length === 0) return err('invalid_input', { field: `kinds.${kind}.accountId` });
    const taxCode = value['taxCode'];
    if (taxCode !== undefined && taxCode !== null && (typeof taxCode !== 'string' || taxCode.length === 0 || taxCode === 'none')) {
      return err('invalid_input', { field: `kinds.${kind}.taxCode`, reason: 'a tax code, or null for no VAT' });
    }
    kinds[kind as SettlementKind] = { action: 'book', accountId: value['accountId'], taxCode: typeof taxCode === 'string' ? taxCode : null };
  }
  for (const [kind, rule] of Object.entries(TEMPLATE_KIND_DEFAULTS) as [SettlementKind, KindRule][]) {
    if (kinds[kind] === undefined) kinds[kind] = rule;
  }
  return { clearingAccountId: input.clearingAccountId, kinds };
}

/** The template as stored: kinds in the format's own order, so two saves of one template compare equal. */
function canonical(template: SettlementTemplate): string {
  const kinds: Record<string, KindRule> = {};
  for (const kind of SETTLEMENT_KINDS) {
    const rule = template.kinds[kind];
    if (rule === undefined) continue;
    kinds[kind] = rule.action === 'book' ? { action: 'book', accountId: rule.accountId, taxCode: rule.taxCode } : { action: rule.action };
  }
  return JSON.stringify({ clearingAccountId: template.clearingAccountId, kinds });
}

interface TemplateRow {
  id: string;
  template_json: string;
  updated_by: string;
  updated_at: string;
}

export interface StoredTemplate {
  templateId: string;
  system: string;
  processor: string;
  template: SettlementTemplate;
  updatedBy: string;
  updatedAt: string;
}

/** The stored template of one source, or null when the owner has not set one. */
export function readStoredTemplate(ctx: WorkspaceContext, system: string, processor: string): StoredTemplate | null {
  const row = ctx.store.db
    .prepare('SELECT id, template_json, updated_by, updated_at FROM settlement_template WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
    .get(ctx.workspaceId, system, processor) as TemplateRow | undefined;
  if (row === undefined) return null;
  const parsed = JSON.parse(row.template_json) as SettlementTemplate;
  return { templateId: row.id, system, processor, template: parsed, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

/** A template as an answer reads it: every kind with its rule, `unmapped` for a kind with none. */
export function describeTemplate(ctx: WorkspaceContext, template: SettlementTemplate): Record<string, unknown> {
  const number = (id: string): string | null => readAccountRow(ctx, id)?.number ?? null;
  const kinds: Record<string, unknown> = {};
  for (const kind of SETTLEMENT_KINDS) {
    const rule = template.kinds[kind];
    if (rule === undefined) kinds[kind] = { action: 'unmapped' };
    else if (rule.action === 'book') kinds[kind] = { action: 'book', accountId: rule.accountId, accountNumber: number(rule.accountId), taxCode: rule.taxCode };
    else kinds[kind] = { action: rule.action };
  }
  return { clearingAccountId: template.clearingAccountId, clearingAccountNumber: number(template.clearingAccountId), kinds };
}

export type SetSettlementTemplateOk = {
  templateId: string;
  system: string;
  processor: string;
  changed: boolean;
  template: Record<string, unknown>;
};

export interface SetSettlementTemplateInput {
  system?: unknown;
  processor?: unknown;
  clearingAccountId?: unknown;
  kinds?: unknown;
  idempotencyKey?: unknown;
}

/** The checks `set_settlement_template` runs before it writes, shared with the pre-draft validation. */
function prepareSet(ctx: WorkspaceContext, input: SetSettlementTemplateInput): { system: string; processor: string; template: SettlementTemplate } | Err {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  const source = readSource(input);
  if ((source as { ok?: unknown }).ok === false) return source as Err;
  const template = readTemplateInput(input);
  if ((template as { ok?: unknown }).ok === false) return template as Err;
  const checked = checkTemplate(ctx, template as SettlementTemplate);
  if (checked !== null) return checked;
  const s = source as { system: string; processor: string };
  return { system: s.system, processor: s.processor, template: template as SettlementTemplate };
}

/** `set_settlement_template`: save (replace) the booking template of one settlement source. */
export function setSettlementTemplate(ctx: WorkspaceContext, input: SetSettlementTemplateInput): Result<SetSettlementTemplateOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const prepared = prepareSet(ctx, input);
  if ((prepared as { ok?: unknown }).ok === false) return prepared as Err;
  const { system, processor, template } = prepared as { system: string; processor: string; template: SettlementTemplate };
  const json = canonical(template);
  const scopedKey = JSON.stringify(['set_settlement_template', system, processor, input.idempotencyKey]);
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_settlement_template', () => {
    const now = ctx.clock.now();
    const existing = ctx.store.db
      .prepare('SELECT id, template_json FROM settlement_template WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
      .get(ctx.workspaceId, system, processor) as { id: string; template_json: string } | undefined;
    let templateId: string;
    let changed = true;
    if (existing === undefined) {
      templateId = ctx.ids.next('stltpl');
      ctx.store.db
        .prepare('INSERT INTO settlement_template (id, workspace_id, source_system, source_processor, template_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(templateId, ctx.workspaceId, system, processor, json, ctx.actor, now);
    } else {
      templateId = existing.id;
      changed = existing.template_json !== json;
      if (changed) {
        ctx.store.db
          .prepare('UPDATE settlement_template SET template_json = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
          .run(json, ctx.actor, now, ctx.workspaceId, templateId);
      }
    }
    if (changed) {
      ctx.store.db
        .prepare('INSERT INTO settlement_template_change (id, workspace_id, template_id, old_json, new_json, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.ids.next('stltchg'), ctx.workspaceId, templateId, existing?.template_json ?? null, json, ctx.actor, now);
      ctx.audit.record({ entityKind: 'settlement_template', entityId: templateId, action: existing === undefined ? 'create' : 'update', actor: ctx.actor, at: now });
    }
    return ok<SetSettlementTemplateOk>({ templateId, system, processor, changed, template: describeTemplate(ctx, template) });
  });
}

/** D158: the save's own validation with nothing written, run before a governed seat's call is drafted. */
export function prevalidateSetSettlementTemplate(ctx: WorkspaceContext, input: SetSettlementTemplateInput): Result | undefined {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const prepared = prepareSet(ctx, input);
  return (prepared as { ok?: unknown }).ok === false ? (prepared as Err) : undefined;
}

export type GetSettlementTemplateOk = {
  templates: Array<{ templateId: string; system: string; processor: string; template: Record<string, unknown>; updatedBy: string; updatedAt: string }>;
};

/**
 * `get_settlement_template`: the template of one source (`system` + `processor`), or every template of the
 * workspace when neither is given. An unknown source answers an empty list. A pure read.
 */
export function getSettlementTemplate(ctx: WorkspaceContext, input: { system?: unknown; processor?: unknown }): Result<GetSettlementTemplateOk> {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  let rows: { source_system: string; source_processor: string }[];
  if (input.system === undefined && input.processor === undefined) {
    rows = ctx.store.db
      .prepare('SELECT source_system, source_processor FROM settlement_template WHERE workspace_id = ? ORDER BY source_system, source_processor')
      .all(ctx.workspaceId) as { source_system: string; source_processor: string }[];
  } else {
    const source = readSource(input);
    if ((source as { ok?: unknown }).ok === false) return source as Err;
    const s = source as { system: string; processor: string };
    rows = [{ source_system: s.system, source_processor: s.processor }];
  }
  const templates: GetSettlementTemplateOk['templates'] = [];
  for (const r of rows) {
    const stored = readStoredTemplate(ctx, r.source_system, r.source_processor);
    if (stored === null) continue;
    templates.push({
      templateId: stored.templateId,
      system: stored.system,
      processor: stored.processor,
      template: describeTemplate(ctx, stored.template),
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt,
    });
  }
  return ok<GetSettlementTemplateOk>({ templates });
}
