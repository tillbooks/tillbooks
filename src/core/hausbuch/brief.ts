/**
 * N00, THE WORKSPACE BRIEF: how this workspace books, in ONE read an agent makes first.
 *
 * A READ COMPOSITION OF EXISTING READS, storing nothing: who the caller is (`whoami`), the workspace's
 * name and VAT method, the chart, the VAT codes, the Bankkonten, the live Buchungsregeln and Vorlagen
 * (`listBankStandards`), the active house notes, and what waits for a decision (`attention_summary`). It
 * recomputes nothing those reads already answer: the identity is whoami's, the open counts are Pendenzen's.
 *
 * COMPACT BY CONSTRUCTION. An agent pays for every token of it on every session, so a list of records is
 * a header row and value rows (`columns` + `rows`), never an object per account, and a rule's recipe is
 * one line of text. A Nomadik-sized book stays well under 15'000 tokens (`test/hausbuch/`).
 *
 * PER-SECTION RBAC (the F00 `dashboard_overview` shape). Each section asserts its source verb's own read
 * gate and a refused section is not answered: it is named in `omitted` with `permission_denied`. The open
 * counts carry `attention_summary`'s own per-queue filter. So the brief discloses nothing the caller's own
 * source verbs would not answer, and no single boundary capability has to state a six-domain rule.
 *
 * WHICH SECTIONS. `sections` narrows the answer for one call; without it, the setting
 * `hausbuch.brief_sections` (all six by default) decides. The identity and the workspace header always
 * come along: they are what every other section is read against.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { Capability } from '../access/capabilities.js';
import { whoami } from '../access/members.js';
import { attentionSummary } from '../attention/compose.js';
import { listBankStandards, type BankStandard, type BankStandardLeg } from '../banking/bankStandards.js';
import { getSetting } from '../settings/settings.js';
import { activeNotes, type HausbuchNote } from './notes.js';
import { BRIEF_SECTIONS, isBriefSection, parseBriefSections, type BriefSection } from './sections.js';

/** The read gate each section asserts: its source verb's own (A24 `CAPABILITY_FOR_ACTION`). */
export const SECTION_CAPABILITY: Readonly<Record<Exclude<BriefSection, 'counts'>, Capability>> = {
  accounts: 'read_books', // list_accounts
  vatCodes: 'read_vat', // vat_codes
  bankAccounts: 'read_master_data', // list_bank_accounts
  rules: 'read_sales', // list_bank_standards
  notes: 'read_master_data', // hausbuch_notes
};

/** A table in rows: what a list of records costs in the brief. */
export type BriefTable = { columns: readonly string[]; rows: (string | number | null)[][] };

/** One rule or Vorlage in one line. */
export type BriefRule = {
  id: string;
  /** `bank`: proposed on a matching bank line; `manual`: a Vorlage picked in the composer. */
  scope: string;
  name: string;
  /** The counterparty as the bank names it, and the direction (`in` / `out`); null on a Vorlage. */
  counterparty: string | null;
  direction: string | null;
  /** The remittance text the rule requires, or null for every line of the counterparty. */
  match: string | null;
  /** The recipe in one line: `6500 VSt81 rest; 1170 ?MWST`, or `ignore: <reason>`. */
  legs: string;
  /** Why the rule went quiet, or absent while it is valid. */
  invalid?: string;
};

export type WorkspaceBriefOk = {
  /** The sections this answer carries, in order. */
  sections: BriefSection[];
  /** The caller, as `whoami` answers it (the agent seat also reads its dial levels here). */
  identity: { actor: string; role: string | null; provisioned: boolean; agentDial?: Record<string, string> };
  /** The workspace header, or absent when the caller may not read master data. */
  workspace?: { id: string; name: string; baseCurrency: string; fiscalYearStart: string; vatMethod: string | null; vatRegistered: boolean };
  accounts?: BriefTable;
  vatCodes?: BriefTable;
  bankAccounts?: BriefTable;
  rules?: BriefRule[];
  /** `withheld`: counterparty notes a caller without the bank's read right (`read_sales`) does not see. */
  notes?: { items: { id: string; scope: HausbuchNote['scope']; text: string }[]; withheld?: number; hint?: string };
  counts?: { total: number | null; incomplete: boolean; queues: Record<string, number> };
  /** The sections refused by their read gate, never answered. */
  omitted: { section: BriefSection; error: 'permission_denied'; capability: Capability }[];
};

/** What an empty notes section says to the agent. */
export const NO_NOTES_HINT = 'No house notes yet: when you learn a convention, write it with hausbuch_note_set (it waits for the owner as a Vorschlag).';

function amountWord(leg: BankStandardLeg): string {
  const a = leg.amount;
  switch (a.kind) {
    case 'rest':
      return 'rest';
    case 'ask':
      return `?${a.label}`;
    case 'same':
      return `=leg${a.legIndex + 1}`;
    case 'factor':
      return `${a.num}/${a.den} ${a.label}`;
  }
}

/** A recipe in one line: account number, code, side or against, and the amount rule, legs joined by `; `. */
export function legsLine(rule: Pick<BankStandard, 'outcome' | 'legs' | 'ignoreReason' | 'viaAccountNumber'>): string {
  if (rule.outcome === 'ignore') return `ignore: ${rule.ignoreReason ?? ''}`.trim();
  const legs = rule.legs.map((leg) => {
    const parts = [leg.side ?? (leg.against === true ? 'against' : null), leg.accountNumber, leg.taxCode, amountWord(leg)];
    return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
  });
  const via = rule.viaAccountNumber !== null ? ` via ${rule.viaAccountNumber}` : '';
  return `${legs.join('; ')}${via}`;
}

export interface WorkspaceBriefInput {
  sections?: unknown;
}

/** The sections asked for: the input's, else the setting's. */
function sectionsOf(ctx: WorkspaceContext, input: WorkspaceBriefInput): BriefSection[] | { refusal: Result<never> } {
  if (input.sections === undefined || input.sections === null) {
    return parseBriefSections(getSetting<string>(ctx, 'hausbuch.brief_sections'));
  }
  if (!Array.isArray(input.sections) || input.sections.length === 0 || !input.sections.every(isBriefSection)) {
    return { refusal: err('invalid_input', { field: 'sections', allowed: [...BRIEF_SECTIONS] }) };
  }
  const named = new Set<string>(input.sections);
  return BRIEF_SECTIONS.filter((s) => named.has(s));
}

/** The brief. Reads only; see the module note for what each section is and which gate it asserts. */
export function workspaceBrief(ctx: WorkspaceContext, input: WorkspaceBriefInput = {}): Result<WorkspaceBriefOk> {
  const picked = sectionsOf(ctx, input);
  if (!Array.isArray(picked)) return picked.refusal;
  const db = ctx.store.db;
  const can = (capability: Capability): boolean => ctx.capabilities.assert(capability).ok;

  const who = whoami(ctx) as { ok: boolean; actor?: string; role?: string | null; provisioned?: boolean; agentDial?: Record<string, string> };
  const out: WorkspaceBriefOk = {
    sections: [],
    identity: {
      actor: who.actor ?? ctx.actor,
      role: who.role ?? null,
      provisioned: who.provisioned ?? false,
      ...(who.agentDial !== undefined ? { agentDial: who.agentDial } : {}),
    },
    omitted: [],
  };

  if (can('read_master_data')) {
    const w = db
      .prepare('SELECT id, name, base_currency, fiscal_year_start, vat_method, vat_registered FROM workspace WHERE id = ?')
      .get(ctx.workspaceId) as
      | { id: string; name: string; base_currency: string; fiscal_year_start: string; vat_method: string | null; vat_registered: number }
      | undefined;
    if (w !== undefined) {
      out.workspace = {
        id: w.id,
        name: w.name,
        baseCurrency: w.base_currency,
        fiscalYearStart: w.fiscal_year_start,
        vatMethod: w.vat_method,
        vatRegistered: w.vat_registered === 1,
      };
    }
  }

  for (const section of picked) {
    if (section !== 'counts') {
      const capability = SECTION_CAPABILITY[section];
      if (!can(capability)) {
        out.omitted.push({ section, error: 'permission_denied', capability });
        continue;
      }
    }
    out.sections.push(section);
    switch (section) {
      case 'accounts': {
        const rows = db
          .prepare('SELECT number, name, type, vat_code_default FROM account WHERE workspace_id = ? AND archived = 0 ORDER BY number')
          .all(ctx.workspaceId) as { number: string; name: string; type: string; vat_code_default: string | null }[];
        out.accounts = { columns: ['number', 'name', 'type', 'vat'], rows: rows.map((r) => [r.number, r.name, r.type, r.vat_code_default]) };
        break;
      }
      case 'vatCodes': {
        const rows = db
          .prepare('SELECT code, kind, rate_bp, label FROM tax_code WHERE workspace_id = ? AND active = 1 ORDER BY code')
          .all(ctx.workspaceId) as { code: string; kind: string; rate_bp: number; label: string | null }[];
        out.vatCodes = { columns: ['code', 'kind', 'rateBp', 'label'], rows: rows.map((r) => [r.code, r.kind, r.rate_bp, r.label]) };
        break;
      }
      case 'bankAccounts': {
        const rows = db
          .prepare(
            `SELECT b.id, b.name, b.iban, b.currency, a.number AS ledger FROM bank_account b
               LEFT JOIN account a ON a.workspace_id = b.workspace_id AND a.id = b.ledger_account_id
              WHERE b.workspace_id = ? AND b.archived = 0 ORDER BY b.name, b.id`,
          )
          .all(ctx.workspaceId) as { id: string; name: string; iban: string; currency: string; ledger: string | null }[];
        out.bankAccounts = {
          columns: ['id', 'name', 'iban', 'currency', 'ledger'],
          rows: rows.map((r) => [r.id, r.name, r.iban, r.currency, r.ledger]),
        };
        break;
      }
      case 'rules': {
        const listed = listBankStandards(ctx);
        const standards = listed.ok ? listed.standards : [];
        out.rules = standards.map((s) => ({
          id: s.id,
          scope: s.scope,
          name: s.label ?? s.counterpartyLabel ?? s.id,
          counterparty: s.counterpartyLabel,
          direction: s.direction,
          match: s.matchText,
          legs: legsLine(s),
          ...(s.invalidReason !== null ? { invalid: s.invalidReason } : {}),
        }));
        break;
      }
      case 'notes': {
        const active = activeNotes(ctx);
        const items = active.notes.map((n) => ({ id: n.id, scope: n.scope, text: n.text }));
        out.notes = {
          items,
          ...(active.withheld > 0 ? { withheld: active.withheld } : {}),
          ...(items.length === 0 && active.withheld === 0 ? { hint: NO_NOTES_HINT } : {}),
        };
        break;
      }
      case 'counts': {
        // Pendenzen's own answer, its per-queue read filter included: a queue the caller may not read is
        // absent here as it is there. `topLimit: 1` keeps the ranked rows it computes to one, then drops it.
        const summary = attentionSummary(ctx, { topLimit: 1 }) as {
          ok: boolean;
          total?: number | null;
          incomplete?: boolean;
          queues?: { queueId: string; count: number }[];
        };
        out.counts = {
          total: summary.total ?? null,
          incomplete: summary.incomplete === true,
          queues: Object.fromEntries((summary.queues ?? []).map((q) => [q.queueId, q.count])),
        };
        break;
      }
    }
  }
  return ok<WorkspaceBriefOk>(out);
}
