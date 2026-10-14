/**
 * A39 §12 (D144), the model rung's READ half: the candidates a model may choose among, the state it is
 * shown, and the proposal a recorded decision becomes on an open line.
 *
 * CODE CHOOSES THE CANDIDATES, THE MODEL ONLY CHOOSES AMONG THEM. At most `MODEL_SUGGEST_TOP_K`
 * accounts: the ones this book booked lines of the same direction to (most used first), then the
 * chart's active accounts of the direction's kind, ranked by the words they share with the line. Bank
 * ledgers, the 1100/2000 control accounts and the VAT accounts are never candidates. Open models
 * collapse when asked to choose among many labels, and a candidate a person would never book to is a
 * candidate a model must never be offered.
 *
 * THE RUNG ONLY READS. It shows the newest `model_decision` recorded for the line by the model that is
 * registered NOW (same ref, same pinned sha256), and only while its chosen account is still a
 * candidate kind. The model itself runs in `suggest_bank_lines` (`bankModelSuggest.ts`), a write, so
 * every suggestion a person sees was recorded before they saw it (A35 §11). With no fit model
 * registered the context is `null` and the ladder is exactly what it was.
 *
 * NEVER `sure`. A probability is not a reference (owner answer 2 of A39 and D144): the rung is capped
 * at `check`, so no bulk path books it. §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { resolveRole, isRejection } from '../payments/accounts.js';
import { decideModel, latestModelDecisions } from '../voice/index.js';
import type { DecideQuestion, ModelDecisionRow } from '../voice/index.js';
import { lineBookingDate } from './bankLines.js';
import type { BankTxnDetailRow, BankTxnRow, BookBankLineTarget } from './bankLines.js';

/** The consumer name the bank inbox records its decisions under (E05 §10.2). */
export const BANK_INBOX_MODEL_CONSUMER = 'bank_inbox';
/** The subject kind of a bank-inbox decision. */
export const BANK_INBOX_MODEL_SUBJECT = 'bank_txn';
/** D144 item 2: a model reaches the bank inbox only if it reads German AND French. */
export const BANK_INBOX_MODEL_LANGUAGES: readonly string[] = ['de', 'fr'];
/** The most candidates one question carries (never above the model row's `maxChoices`). */
export const MODEL_SUGGEST_TOP_K = 8;
/** A choice below this probability is recorded but shows nothing: a guess is not a proposal. */
export const MODEL_SUGGEST_MIN_PROBABILITY = 0.5;
/** The one question the bank inbox asks. */
export const MODEL_SUGGEST_QUESTION_TEXT = 'Auf welches Konto gehört diese Bankzeile?';
/** The id of that question inside a decision. */
export const MODEL_SUGGEST_QUESTION_ID = 'account';
/** The newest `accounts` bookings the candidate history reads: history is a hint, not an audit. */
const HISTORY_BOUND = 2000;
/** The longest text field handed to a model. */
const STATE_TEXT_MAX = 500;

/** What the bank inbox requires of a model before it may speak (E05 §10.1, D144). */
export function bankInboxDecideModel() {
  return decideModel({
    questionTypes: ['choice'],
    requireLanguages: BANK_INBOX_MODEL_LANGUAGES,
    requireMeasuredCalibration: true,
  });
}

interface AccountFacts {
  id: string;
  number: string;
  name: string;
  type: string;
  archived: boolean;
  vatCodeDefault: string | null;
}

/** Everything the candidates and the rung need, read once per inbox page or per suggest call. */
export interface ModelCandidateBase {
  accounts: Map<string, AccountFacts>;
  /** Accounts that are never a candidate: bank ledgers, 1100/2000, the VAT accounts. */
  excluded: Set<string>;
  /** Per direction, how many live `accounts` bookings touched each account. */
  history: { DBIT: Map<string, number>; CRDT: Map<string, number> };
}

export function modelCandidateBase(ctx: WorkspaceContext): ModelCandidateBase {
  const rows = ctx.store.db
    .prepare('SELECT id, number, name, type, archived, vat_code_default FROM account WHERE workspace_id = ?')
    .all(ctx.workspaceId) as { id: string; number: string; name: string; type: string; archived: number; vat_code_default: string | null }[];
  const accounts = new Map<string, AccountFacts>();
  for (const r of rows) {
    accounts.set(r.id, { id: r.id, number: r.number, name: r.name, type: r.type, archived: r.archived === 1, vatCodeDefault: r.vat_code_default });
  }
  const excluded = new Set<string>();
  for (const r of rows) if (['1170', '1171', '2200'].includes(r.number)) excluded.add(r.id);
  for (const b of ctx.store.db.prepare('SELECT ledger_account_id AS id FROM bank_account WHERE workspace_id = ?').all(ctx.workspaceId) as { id: string }[]) {
    excluded.add(b.id);
  }
  for (const role of ['receivable', 'payable'] as const) {
    const resolved = resolveRole(ctx, role);
    if (!isRejection(resolved)) excluded.add(resolved.id);
  }
  const counts = ctx.store.db
    .prepare(
      `SELECT t.credit_debit AS cd, jl.account_id AS accountId, COUNT(DISTINCT d.entry_id) AS n
         FROM bank_line_decision d
         JOIN bank_txn t ON t.workspace_id = d.workspace_id AND t.id = d.bank_txn_id
         JOIN journal_entry e ON e.workspace_id = d.workspace_id AND e.id = d.entry_id
         JOIN journal_line jl ON jl.entry_id = e.id
        WHERE d.workspace_id = ? AND d.rowid IN (
                SELECT rowid FROM bank_line_decision
                 WHERE workspace_id = ? AND superseded_at IS NULL AND target_kind = 'accounts'
                 ORDER BY rowid DESC LIMIT ${HISTORY_BOUND})
        GROUP BY t.credit_debit, jl.account_id`,
    )
    .all(ctx.workspaceId, ctx.workspaceId) as { cd: string; accountId: string; n: number }[];
  const history = { DBIT: new Map<string, number>(), CRDT: new Map<string, number>() };
  for (const c of counts) {
    if (c.cd === 'DBIT' || c.cd === 'CRDT') history[c.cd].set(c.accountId, c.n);
  }
  return { accounts, excluded, history };
}

function fold(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function wordsOf(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/** The length of the prefix two words share. */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * How many words of an account name the line shares: a whole word, or a common stem of 4+ letters
 * ("Büromaterial" meets "Bürokosten" on "buro"). German compounds share stems, not whole words.
 */
function overlap(lineWords: readonly string[], accountName: string): number {
  let n = 0;
  for (const a of wordsOf(accountName)) {
    if (lineWords.some((w) => w === a || commonPrefix(w, a) >= 4)) n += 1;
  }
  return n;
}

export interface ModelCandidate {
  accountId: string;
  /** "6500 Büromaterial": what the model reads as the option. */
  label: string;
}

/** A usable candidate account: live, and not a kind a line is never booked to. */
function isCandidateAccount(base: ModelCandidateBase, id: string): boolean {
  const a = base.accounts.get(id);
  return a !== undefined && !a.archived && !base.excluded.has(id);
}

/** The line's candidates, best first, at most `k`. Pure over the base. */
export function bankLineCandidates(
  base: ModelCandidateBase,
  row: Pick<BankTxnRow, 'credit_debit' | 'payer_name'>,
  detail: Pick<BankTxnDetailRow, 'counterparty_name' | 'remittance_text'> | undefined,
  k: number,
): ModelCandidate[] {
  const direction = row.credit_debit === 'CRDT' ? 'CRDT' : 'DBIT';
  const kind = direction === 'CRDT' ? 'income' : 'expense';
  const counts = base.history[direction];
  const lineWords = wordsOf(`${detail?.counterparty_name ?? row.payer_name ?? ''} ${detail?.remittance_text ?? ''}`);
  const pool = new Set<string>();
  for (const id of counts.keys()) if (isCandidateAccount(base, id)) pool.add(id);
  for (const a of base.accounts.values()) if (a.type === kind && isCandidateAccount(base, a.id)) pool.add(a.id);
  const scored = [...pool].map((id) => {
    const a = base.accounts.get(id)!;
    return { a, used: counts.get(id) ?? 0, shared: overlap(lineWords, a.name) };
  });
  scored.sort((x, y) => y.used - x.used || y.shared - x.shared || x.a.number.localeCompare(y.a.number));
  return scored.slice(0, Math.max(0, k)).map(({ a }) => ({ accountId: a.id, label: `${a.number} ${a.name}` }));
}

/**
 * An IBAN-shaped token: a two-letter country code, two check digits, then groups of up to four letters or
 * digits, spaced or not ("CH44 3199 9123 0008 8901 2", "CH4431999123000889012"). RF is an ISO 11649
 * creditor reference, not an account, and is left alone.
 */
const IBAN_SHAPED = /\b(?!RF)[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi;

/**
 * Replace every IBAN quoted in free text with "[IBAN]" (critic C4): "the model never sees an IBAN" holds
 * for the counterparty field by construction, and for a remittance that quotes one only by this mask.
 * A match counts as an IBAN when its compact form is 15 to 34 characters and carries at least ten
 * digits, so ordinary words shaped like "ab12 test haus" are left alone.
 */
export function maskIbans(text: string): string {
  return text.replace(IBAN_SHAPED, (m) => {
    const compact = m.replace(/ /g, '');
    const digits = compact.replace(/\D/g, '').length;
    return compact.length >= 15 && compact.length <= 34 && digits >= 10 ? '[IBAN]' : m;
  });
}

function clip(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = maskIbans(s.replace(/\s+/g, ' ').trim());
  return t.length === 0 ? null : t.slice(0, STATE_TEXT_MAX);
}

/**
 * The state the model reads: the line's direction, amount, currency, booking date, counterparty name,
 * remittance text and reference kind. Never an IBAN, not even one quoted in the text (`maskIbans`,
 * critic C4), never a document (D144, E05 §10.3's minimal-state
 * rule applied locally too). Deterministic, so the same line and candidates hash the same.
 */
export function bankLineDecisionState(row: BankTxnRow, detail: BankTxnDetailRow | undefined): string {
  return JSON.stringify({
    direction: row.credit_debit === 'CRDT' ? 'in' : 'out',
    amount: (row.amount_minor / 100).toFixed(2),
    currency: row.currency,
    bookingDate: lineBookingDate(row),
    counterparty: clip(detail?.counterparty_name ?? row.payer_name),
    remittance: clip(detail?.remittance_text),
    referenceKind: row.reference_kind,
  });
}

/** The one question, over the candidates in order. */
export function bankLineQuestion(candidates: readonly ModelCandidate[]): DecideQuestion {
  return { id: MODEL_SUGGEST_QUESTION_ID, type: 'choice', text: MODEL_SUGGEST_QUESTION_TEXT, options: candidates.map((c) => c.label) };
}

/** The rung's per-page context: the registered model's recorded decisions, or null when none may speak. */
export interface ModelRungContext {
  modelRef: string;
  modelSha256: string;
  decisions: Map<string, ModelDecisionRow>;
  base: ModelCandidateBase;
}

export function modelRungContext(ctx: WorkspaceContext): ModelRungContext | null {
  const model = bankInboxDecideModel();
  if (!model.ok) return null;
  const decisions = latestModelDecisions(ctx, {
    consumer: BANK_INBOX_MODEL_CONSUMER,
    subjectKind: BANK_INBOX_MODEL_SUBJECT,
    modelRef: model.modelRef,
    modelSha256: model.modelSha256,
  });
  if (decisions.size === 0) return null;
  return { modelRef: model.modelRef, modelSha256: model.modelSha256, decisions, base: modelCandidateBase(ctx) };
}

/** What the rung proposes (the `BankLineProposal` shape, built by the caller's ladder). */
export interface ModelRungProposal {
  target: BookBankLineTarget;
  probability: number;
  decisionId: string;
  modelRef: string;
  candidates: number;
  accountId: string;
  vatCode: string | null;
  /** The model's measured expected calibration error when it answered, or null. */
  ece: number | null;
}

/**
 * The probability an agent reads on `list_bank_inbox`: floored to four decimals and capped at 0.9999,
 * the engine twin of the Studio's percent (floored, capped at 99). A model's number is never rounded
 * UP into a certainty it did not state (critic C5b).
 */
export function readableProbability(p: number): number {
  // The 1e-9 absorbs binary noise (0.82 * 10000 is 8199.999...), far below the fourth decimal.
  return Math.min(0.9999, Math.floor(p * 10_000 + 1e-9) / 10_000);
}

/** The recorded decision for this line as a proposal, or null when there is none to show. */
export function modelRungProposal(mc: ModelRungContext, row: BankTxnRow): ModelRungProposal | null {
  const d = mc.decisions.get(row.id);
  if (d === undefined || d.chosen_value === null || d.chosen_probability === null) return null;
  if (d.chosen_probability < MODEL_SUGGEST_MIN_PROBABILITY) return null;
  if (!isCandidateAccount(mc.base, d.chosen_value)) return null;
  const account = mc.base.accounts.get(d.chosen_value)!;
  // Critic C10: the probability belongs to the label the model scored. An account renumbered or
  // renamed since then means something else now, and its old number is not shown under the new name.
  if (d.chosen_label !== `${account.number} ${account.name}`) return null;
  let candidates = 0;
  try {
    const qs = JSON.parse(d.questions_json) as { options?: unknown[] }[];
    candidates = Array.isArray(qs[0]?.options) ? qs[0]!.options!.length : 0;
  } catch {
    candidates = 0;
  }
  const vat = account.vatCodeDefault !== null && account.vatCodeDefault.length > 0 ? account.vatCodeDefault : null;
  // Owner, 30.09.2026: the measured calibration error travels with the percent it qualifies.
  let ece: number | null = null;
  try {
    const cal = d.calibration_json === null ? null : (JSON.parse(d.calibration_json) as { measured?: unknown; ece?: unknown });
    if (cal !== null && cal.measured === true && typeof cal.ece === 'number' && Number.isFinite(cal.ece)) ece = cal.ece;
  } catch {
    ece = null;
  }
  return {
    target: {
      kind: 'accounts',
      legs: [{ accountId: account.id, amountMinor: row.amount_minor, ...(vat !== null ? { taxCode: vat } : {}) }],
    },
    probability: readableProbability(d.chosen_probability),
    decisionId: d.id,
    modelRef: d.model_ref,
    candidates,
    accountId: account.id,
    vatCode: vat,
    ece,
  };
}
