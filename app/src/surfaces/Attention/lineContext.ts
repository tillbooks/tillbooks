/**
 * D208 (owner, 18.11.2026): what a bank Vorschlag row needs beyond the drafted read, read ONCE for the list
 * (Pendenzen, the Übersicht card), never per row:
 *
 *  - the open bank lines (`list_bank_inbox`, open): the rule the line's proposal used (`standardId`, its
 *    `reasonCode` and target) and how many receipts the line already holds (`receiptCount`);
 *  - the live Buchungsregeln (`list_bank_standards`): a rule's name and since when, for the source glyph's
 *    tooltip, and the comment to the agent the star's speech bubble edits;
 *  - the chart (`list_accounts`) and the MWST codes (`vat_codes`), for the open line's two `Select`s.
 *
 * Each read degrades on its own: a refused read is "none", and a row then shows less, never a guess. Pure
 * helpers below turn one Vorschlag and this context into the row's source, its hint and its open line.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { parseChart, parseTaxCodes, type ChartAccount, type TaxCode } from '../Bank/model';
import type { DraftedAction } from '../Agent/model';
import type { VorschlagItem } from '../Agent/vorschlagView';

/** What one open bank line says for its Vorschlag row. */
export interface LineInfo {
  standardId: string | null;
  /** Every live rule of the line's counterparty and direction (the slot's rule is the one without a text). */
  ruleIds: string[];
  reasonCode: string | null;
  receiptCount: number;
}

/** One live Buchungsregel, as the row names it. */
export interface RuleInfo {
  id: string;
  name: string;
  setAt: string;
  note: string | null;
  legs: { accountId: string; taxCode: string | null }[];
  /** `legs` or `ignore` ("Nicht buchen"). */
  outcome: string;
  /** What an edit must carry over unchanged (the edit replaces the whole rule). */
  label: string | null;
  matchText: string | null;
  viaAccountId: string | null;
  followUpStandardId: string | null;
  /**
   * The rule's own recipe as `set_bank_standard` takes it back (every leg's account, code, amount, `against`
   * and description): a save that changes nothing else sends exactly this, so the engine answers
   * `unchanged` and writes no new version (critic D208: no lost autopilot grant, no lost leg).
   */
  recipe: RuleLeg[];
}

/** One leg of a rule's recipe, in the shape `set_bank_standard { legs }` takes. */
export interface RuleLeg {
  accountId: string;
  taxCode: string | null;
  amount: Record<string, unknown>;
  against?: true;
  description?: string;
}

export interface LineContext {
  lines: ReadonlyMap<string, LineInfo>;
  rules: ReadonlyMap<string, RuleInfo>;
  chart: readonly ChartAccount[];
  taxCodes: readonly TaxCode[];
  /** D210: the workspace has a turnover template (Bank's "Vorlage für Umsatz" presets); null while unknown. */
  turnoverTemplates: boolean | null;
  reload: () => void;
}

const EMPTY: Omit<LineContext, 'reload'> = { lines: new Map(), rules: new Map(), chart: [], taxCodes: [], turnoverTemplates: null };

/** D210: whether `get_settlement_template` answered a template with a clearing account; null when it did not answer. */
export function hasTurnoverTemplate(body: unknown): boolean | null {
  if (body === null || body === undefined) return null;
  const list = rec(body).templates;
  return Array.isArray(list) && list.some((raw) => typeof rec(rec(raw).template).clearingAccountId === 'string');
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function parseLines(body: unknown): Map<string, LineInfo> {
  const out = new Map<string, LineInfo>();
  const lines = rec(body).lines;
  if (!Array.isArray(lines)) return out;
  for (const raw of lines) {
    const l = rec(raw);
    const id = str(l.bankTxnId);
    if (id === null) continue;
    out.set(id, {
      standardId: str(l.standardId),
      ruleIds: Array.isArray(l.ruleIds) ? l.ruleIds.filter((x): x is string => typeof x === 'string') : [],
      reasonCode: str(rec(l.proposal).reasonCode),
      receiptCount: typeof l.receiptCount === 'number' ? l.receiptCount : 0,
    });
  }
  return out;
}

export function parseRules(body: unknown): Map<string, RuleInfo> {
  const out = new Map<string, RuleInfo>();
  const list = rec(body).standards;
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const s = rec(raw);
    const id = str(s.id);
    if (id === null) continue;
    const legs = Array.isArray(s.legs)
      ? s.legs.flatMap((l) => {
          const x = rec(l);
          const accountId = str(x.accountId);
          return accountId === null ? [] : [{ accountId, taxCode: str(x.taxCode) }];
        })
      : [];
    const recipe: RuleLeg[] = Array.isArray(s.legs)
      ? s.legs.flatMap((l) => {
          const x = rec(l);
          const accountId = str(x.accountId);
          const amount = rec(x.amount);
          if (accountId === null || typeof amount.kind !== 'string') return [];
          const description = str(x.description);
          return [{ accountId, taxCode: str(x.taxCode), amount, ...(x.against === true ? { against: true as const } : {}), ...(description !== null ? { description } : {}) }];
        })
      : [];
    out.set(id, {
      id,
      name: str(s.label) ?? str(s.counterpartyLabel) ?? [str(s.accountNumber), str(s.accountName), str(s.taxCode)].filter((x): x is string => x !== null).join(' '),
      outcome: str(s.outcome) ?? 'legs',
      setAt: str(s.setAt) ?? '',
      note: str(s.note),
      legs,
      label: str(s.label),
      matchText: str(s.matchText),
      viaAccountId: str(s.viaAccountId),
      followUpStandardId: str(s.followUpStandardId),
      recipe: recipe.length === legs.length ? recipe : [],
    });
  }
  return out;
}

/** The rule in words: its name, else "Nicht buchen", else "Regel ohne Namen". */
export function ruleWords(t: (key: string) => string, rule: RuleInfo): string {
  if (rule.name !== '') return rule.name;
  return rule.outcome === 'ignore' ? t('attention.autoRule.ignoreRule') : t('attention.line.unnamedRule');
}

/**
 * The list's context, read while `enabled`, and again whenever `refreshKey` changes (the list re-read after a
 * decision) or `reload` is called (after an attach).
 */
export function useLineContext(enabled: boolean, workspaceId: string | null, refreshKey = ''): LineContext {
  const client = useClient();
  const [ctx, setCtx] = useState<Omit<LineContext, 'reload'>>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const active = useRef(workspaceId);
  active.current = workspaceId;

  useEffect(() => {
    setCtx(EMPTY);
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled || workspaceId === null) return undefined;
    const ws = workspaceId;
    let live = true;
    const read = async (action: string, input: Record<string, unknown> = {}): Promise<unknown> => {
      try {
        const r = await client.call(action, { workspaceId: ws, ...input });
        return isErr(r.body) ? null : r.body;
      } catch {
        return null;
      }
    };
    void Promise.all([
      read('list_bank_inbox', { status: 'open', limit: 200 }),
      read('list_bank_standards', { scope: 'bank' }),
      read('list_accounts'),
      read('vat_codes'),
      // D210: the turnover templates decide where "Als Umsatz buchen" leads (Bank's presets, or Umsatz Regeln).
      read('get_settlement_template'),
    ]).then(([inbox, standards, chart, tax, templates]) => {
      if (!live || active.current !== ws) return;
      setCtx({
        lines: parseLines(inbox),
        rules: parseRules(standards),
        chart: parseChart(chart),
        taxCodes: parseTaxCodes(tax),
        turnoverTemplates: hasTurnoverTemplate(templates),
      });
    });
    return () => {
      live = false;
    };
  }, [client, enabled, workspaceId, nonce, refreshKey]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...ctx, reload };
}

// --- Pure: one Vorschlag in this context -------------------------------------------------------------

/** One booking leg of a bank Vorschlag's target, as the open line edits it. */
export interface DraftLeg {
  accountId: string;
  taxCode: string | null;
  amountMinor: number | null;
}

/** The legs of an `accounts` booking (`book_bank_line` target), else null. */
export function draftLegs(action: Pick<DraftedAction, 'actionTool' | 'payload'>): DraftLeg[] | null {
  if (action.actionTool !== 'book_bank_line') return null;
  const target = rec(action.payload.target);
  if (target.kind !== 'accounts' || !Array.isArray(target.legs)) return null;
  const legs = target.legs.flatMap((l) => {
    const x = rec(l);
    const accountId = str(x.accountId) ?? str(x.account);
    return accountId === null ? [] : [{ accountId, taxCode: str(x.taxCode), amountMinor: typeof x.amountMinor === 'number' ? x.amountMinor : null }];
  });
  return legs.length === target.legs.length ? legs : null;
}

/**
 * Can the open line change this Vorschlag's account and MWST code? Only a booking of the WHOLE line to ONE
 * account, without a Durchlaufkonto (what the line's two `Select`s can say); the booking text changes on any
 * `book_bank_line`.
 */
export function editableLeg(action: Pick<DraftedAction, 'actionTool' | 'payload'>): DraftLeg | null {
  const legs = draftLegs(action);
  if (legs === null || legs.length !== 1) return null;
  if (str(rec(action.payload.target).viaAccountId) !== null) return null;
  return legs[0] ?? null;
}

/** Where the booking comes from: a Buchungsregel, the agent, or TILL's own default (no glyph). */
export type Source = { kind: 'rule'; rule: RuleInfo } | { kind: 'agent' } | null;

/** A leg's booking signature: its account and MWST code. */
const sig = (l: { accountId: string; taxCode: string | null }) => `${l.accountId}|${l.taxCode ?? ''}`;

const RULE_REASONS: ReadonlySet<string> = new Set(['standard', 'rule_computed', 'rule_needs_amount']);

/**
 * The source of a bank Vorschlag: the rule its target names (`kind: rule`), or the rule the line's proposal
 * used when the Vorschlag books exactly that rule's accounts and codes; else the agent's when an agent drafted
 * it; else nothing (TILL's default).
 */
export function sourceOf(action: Pick<DraftedAction, 'actionTool' | 'payload' | 'actor'>, ctx: Pick<LineContext, 'lines' | 'rules'>): Source {
  const bankTxnId = str(action.payload.bankTxnId);
  const target = rec(action.payload.target);
  if (action.actionTool === 'book_bank_line') {
    const named = target.kind === 'rule' ? str(target.standardId) : null;
    if (named !== null) {
      const rule = ctx.rules.get(named);
      if (rule !== undefined) return { kind: 'rule', rule };
    }
    const line = bankTxnId === null ? undefined : ctx.lines.get(bankTxnId);
    const legs = draftLegs(action);
    if (line !== undefined && line.standardId !== null && line.reasonCode !== null && RULE_REASONS.has(line.reasonCode) && legs !== null) {
      const rule = ctx.rules.get(line.standardId);
      if (rule !== undefined && rule.legs.length > 0 && [...new Set(legs.map(sig))].sort().join(',') === [...new Set(rule.legs.map(sig))].sort().join(',')) {
        return { kind: 'rule', rule };
      }
    }
  }
  return action.actor !== 'system' && action.actor !== '' ? { kind: 'agent' } : null;
}

/** Does the rule book exactly these accounts and codes (a "legs" rule, the same set)? */
export function booksLike(rule: RuleInfo, legs: readonly { accountId: string; taxCode: string | null }[]): boolean {
  return rule.outcome === 'legs' && rule.legs.length > 0 && legs.length > 0 && [...new Set(legs.map(sig))].sort().join(',') === [...new Set(rule.legs.map(sig))].sort().join(',');
}

/**
 * The slot a star would fill (the line's counterparty and direction, no text) as the list read it: `known`
 * false when the list holds no entry for the line (it read the newest 200 open lines), else the rule standing
 * there, or null for an empty slot. What the person was SHOWN: the commit pins exactly this (critic D208).
 */
export type ShownSlot = { known: false } | { known: true; rule: RuleInfo | null };

export function shownSlotOf(action: Pick<DraftedAction, 'payload'>, ctx: Pick<LineContext, 'lines' | 'rules'>): ShownSlot {
  const bankTxnId = str(action.payload.bankTxnId);
  const line = bankTxnId === null ? undefined : ctx.lines.get(bankTxnId);
  if (line === undefined) return { known: false };
  const ids = line.ruleIds;
  // A slot id the rules read does not hold is not known either: the name could not be shown.
  const found = ids.map((id) => ctx.rules.get(id));
  if (found.some((r) => r === undefined)) return { known: false };
  return { known: true, rule: found.find((r): r is RuleInfo => r !== undefined && r.matchText === null) ?? null };
}

/**
 * D208 (critic D207 F3, said before the click): the rule standing in the slot a star would fill when it books
 * otherwise than this Vorschlag, so the star's name can say it replaces it. Null when the slot is empty,
 * holds the same booking, or is unknown (the commit then asks by name before it replaces anything).
 */
export function slotRuleOf(action: Pick<DraftedAction, 'actionTool' | 'payload'>, ctx: Pick<LineContext, 'lines' | 'rules'>): RuleInfo | null {
  const shown = shownSlotOf(action, ctx);
  if (!shown.known || shown.rule === null) return null;
  const legs = draftLegs(action);
  return legs !== null && booksLike(shown.rule, legs) ? null : shown.rule;
}

/**
 * Critic D208 (6): the TEXT rule that proposed this line's booking (a rule with a match text beats the rule
 * without one), or null. A star on such a line adapts that rule: a rule saved into the slot without text
 * would stay shadowed by it.
 */
export function textRuleOf(action: Pick<DraftedAction, 'actionTool' | 'payload'>, ctx: Pick<LineContext, 'lines' | 'rules'>): RuleInfo | null {
  if (action.actionTool !== 'book_bank_line') return null;
  const bankTxnId = str(action.payload.bankTxnId);
  const line = bankTxnId === null ? undefined : ctx.lines.get(bankTxnId);
  if (line === undefined || line.standardId === null) return null;
  const rule = ctx.rules.get(line.standardId);
  return rule !== undefined && rule.matchText !== null ? rule : null;
}

/** The MWST kinds that claim Vorsteuer. */
const VORSTEUER_KINDS: ReadonlySet<string> = new Set(['input', 'import']);

/**
 * D208 point 9: the one row hint today. A bank booking that claims Vorsteuer (a leg with an input-tax code)
 * while neither the line holds a receipt nor the Vorschlag brings one.
 */
export function missingBeleg(action: Pick<VorschlagItem, 'actionTool' | 'payload' | 'belege'>, ctx: Pick<LineContext, 'lines' | 'taxCodes'>): boolean {
  const legs = draftLegs(action);
  const bankTxnId = str(action.payload.bankTxnId);
  if (legs === null || bankTxnId === null) return false;
  const line = ctx.lines.get(bankTxnId);
  if (line === undefined || line.receiptCount > 0 || (action.belege?.length ?? 0) > 0) return false;
  const kinds = new Map(ctx.taxCodes.map((c) => [c.code, c.kind]));
  return legs.some((l) => l.taxCode !== null && VORSTEUER_KINDS.has(kinds.get(l.taxCode) ?? ''));
}

/** The booking text as the booking would carry it today: the Vorschlag's own, else the engine's default. */
export function prefillText(action: Pick<VorschlagItem, 'payload' | 'lineFacts'>): string {
  const own = str(action.payload.text);
  if (own !== null) return own;
  const f = action.lineFacts ?? null;
  const parts = [f?.counterparty ?? null, f?.text ?? null].filter((s): s is string => s !== null && s !== '');
  return parts.length > 0 ? `Bank: ${parts.join(', ')}` : '';
}

/** A revenue account (Nettoerlöse, 30xx to 38xx): where a payout never goes (D203). */
export function isRevenueNumber(number: string | undefined): boolean {
  if (number === undefined || !/^\d{4}$/.test(number)) return false;
  const n = Number(number);
  return n >= 3000 && n <= 3899;
}
