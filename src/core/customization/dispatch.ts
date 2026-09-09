/**
 * G05 §10, dispatch texts ("Textbausteine") and the cross-document send log ("Protokoll").
 *
 * WHAT THIS MODULE IS, AND WHAT IT REFUSES TO BE. It owns the saved per-kind/per-locale outbound
 * message text, a pure preview that resolves one, and the append-only `dispatches` log the three
 * existing send verbs write through `recordDispatch`. It changes NO send semantics: `send_invoice`,
 * `send_dunning_run` and `quotes_send` keep their exact signatures, channels, P8 gates and P9
 * degradations, and in this pass they also keep their exact outbound bytes (spec §0 item 8a). The
 * log records what ACTUALLY left the workspace, never what a saved text would have said.
 *
 * MONEY: none computed. `amount_total` / `overdue_total` arrive as already-resolved integer-Rappen
 * read-model values and are formatted once here for the resolved locale (the §4 never-re-derive
 * rule applied to prose). There is no code path from this module to A02 or A14 (P3 by omission,
 * asserted structurally in `test/customization/dispatch.test.mjs`).
 *
 * THE VARIABLE REGISTRY IS §H-ENUM SINGLE-SOURCED. A template can never name a value outside its
 * kind's set: `dispatchTextUpsert` refuses `unknown_variable` at SAVE time, naming the valid set
 * (prevention at the control, never a broken mail at send time).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { getDocument } from '../sales/document.js';
import { applySavedView } from './views.js';
import { TEMPLATE_LOCALES } from './documentTemplates.js';

/** §H-ENUM: the three dispatchable kinds. `credit_note` is excluded by design (spec §10.3). */
export const DISPATCH_TEXT_KINDS: readonly string[] = ['invoice', 'quote', 'dunning_run'];

/** §H-ENUM: how a dispatch left (or did not leave) the workspace. */
export const DISPATCH_CHANNELS: readonly string[] = ['smtp', 'cloud_relay', 'artifact_only'];

/** §H-ENUM: the fixed outcome mapping (spec §10.4): artifact_created is a SUCCESS, never degraded. */
export const DISPATCH_OUTCOMES: readonly string[] = ['sent', 'degraded', 'failed', 'artifact_created'];

/**
 * §H-ENUM: the per-kind variable registry, values drawn from what the send verb already holds.
 * `run_date` (not a sketched `pay_by_date`): A15 ships no payment-window value (spec §0 item 8c).
 */
export const DISPATCH_VARIABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  invoice: Object.freeze(['contact_name', 'company_name', 'invoice_number', 'amount_total', 'currency', 'due_date']),
  quote: Object.freeze([
    'contact_name',
    'company_name',
    'quote_number',
    'amount_total',
    'currency',
    'valid_until',
    'accept_link',
  ]),
  dunning_run: Object.freeze([
    'contact_name',
    'company_name',
    'dunning_level',
    'overdue_total',
    'currency',
    'invoice_numbers',
    'run_date',
  ]),
});

export const MAX_DISPATCH_SUBJECT_LENGTH = 200;
export const MAX_DISPATCH_BODY_LENGTH = 4000;

const KIND_SET: ReadonlySet<string> = new Set(DISPATCH_TEXT_KINDS);
const LOCALE_SET: ReadonlySet<string> = new Set(TEMPLATE_LOCALES);

/**
 * The built-in default text per kind and locale (P9: a send never fails for lack of a saved text,
 * and the log then carries `dispatch_text_defaulted:true`). Plain business prose, real umlauts,
 * no sharp-s (de-CH has none). Every variable named here is in the kind's registry above.
 */
const DEFAULT_TEXTS: Readonly<Record<string, Readonly<Record<string, { subject: string; body: string }>>>> =
  Object.freeze({
    invoice: Object.freeze({
      'de-CH': {
        subject: 'Rechnung {{invoice_number}} von {{company_name}}',
        body: 'Guten Tag {{contact_name}}\n\nIm Anhang finden Sie die Rechnung {{invoice_number}} über {{amount_total}}, zahlbar bis {{due_date}}.\n\nFreundliche Grüsse\n{{company_name}}',
      },
      'fr-CH': {
        subject: 'Facture {{invoice_number}} de {{company_name}}',
        body: 'Bonjour {{contact_name}}\n\nVous trouverez en annexe la facture {{invoice_number}} de {{amount_total}}, payable au {{due_date}}.\n\nMeilleures salutations\n{{company_name}}',
      },
      'it-CH': {
        subject: 'Fattura {{invoice_number}} da {{company_name}}',
        body: 'Buongiorno {{contact_name}}\n\nIn allegato trova la fattura {{invoice_number}} di {{amount_total}}, pagabile entro il {{due_date}}.\n\nCordiali saluti\n{{company_name}}',
      },
      en: {
        subject: 'Invoice {{invoice_number}} from {{company_name}}',
        body: 'Dear {{contact_name}}\n\nPlease find attached invoice {{invoice_number}} for {{amount_total}}, due by {{due_date}}.\n\nKind regards\n{{company_name}}',
      },
    }),
    quote: Object.freeze({
      'de-CH': {
        subject: 'Offerte {{quote_number}} von {{company_name}}',
        body: 'Guten Tag {{contact_name}}\n\nIm Anhang finden Sie unsere Offerte {{quote_number}} über {{amount_total}}, gültig bis {{valid_until}}.\n\nFreundliche Grüsse\n{{company_name}}',
      },
      'fr-CH': {
        subject: 'Offre {{quote_number}} de {{company_name}}',
        body: 'Bonjour {{contact_name}}\n\nVous trouverez en annexe notre offre {{quote_number}} de {{amount_total}}, valable jusqu’au {{valid_until}}.\n\nMeilleures salutations\n{{company_name}}',
      },
      'it-CH': {
        subject: 'Offerta {{quote_number}} da {{company_name}}',
        body: 'Buongiorno {{contact_name}}\n\nIn allegato trova la nostra offerta {{quote_number}} di {{amount_total}}, valida fino al {{valid_until}}.\n\nCordiali saluti\n{{company_name}}',
      },
      en: {
        subject: 'Quote {{quote_number}} from {{company_name}}',
        body: 'Dear {{contact_name}}\n\nPlease find attached our quote {{quote_number}} for {{amount_total}}, valid until {{valid_until}}.\n\nKind regards\n{{company_name}}',
      },
    }),
    dunning_run: Object.freeze({
      'de-CH': {
        subject: 'Zahlungserinnerung von {{company_name}}',
        body: 'Guten Tag {{contact_name}}\n\nZu den Rechnungen {{invoice_numbers}} sind {{overdue_total}} offen (Mahnstufe {{dunning_level}}, Stand {{run_date}}). Details finden Sie im Anhang.\n\nFreundliche Grüsse\n{{company_name}}',
      },
      'fr-CH': {
        subject: 'Rappel de paiement de {{company_name}}',
        body: 'Bonjour {{contact_name}}\n\nPour les factures {{invoice_numbers}}, un montant de {{overdue_total}} reste ouvert (niveau de rappel {{dunning_level}}, au {{run_date}}). Vous trouverez les détails en annexe.\n\nMeilleures salutations\n{{company_name}}',
      },
      'it-CH': {
        subject: 'Sollecito di pagamento da {{company_name}}',
        body: 'Buongiorno {{contact_name}}\n\nPer le fatture {{invoice_numbers}} risulta aperto un importo di {{overdue_total}} (livello di sollecito {{dunning_level}}, al {{run_date}}). I dettagli sono in allegato.\n\nCordiali saluti\n{{company_name}}',
      },
      en: {
        subject: 'Payment reminder from {{company_name}}',
        body: 'Dear {{contact_name}}\n\n{{overdue_total}} is outstanding on invoices {{invoice_numbers}} (reminder level {{dunning_level}}, as of {{run_date}}). Details are attached.\n\nKind regards\n{{company_name}}',
      },
    }),
  });

interface DispatchTextRow {
  id: string;
  workspace_id: string;
  document_kind: string;
  locale: string;
  subject: string;
  body: string;
  updated_at: string;
  updated_by: string;
}

function mapText(row: DispatchTextRow): Record<string, unknown> {
  return {
    dispatchTextId: row.id,
    documentKind: row.document_kind,
    locale: row.locale,
    subject: row.subject,
    body: row.body,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function readText(ctx: WorkspaceContext, documentKind: string, locale: string): DispatchTextRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM dispatch_texts WHERE workspace_id = ? AND document_kind = ? AND locale = ?')
    .get(ctx.workspaceId, documentKind, locale) as DispatchTextRow | undefined;
}

/** Every `{{variable}}` token in a template, deduplicated, in first-appearance order. */
function variablesIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    seen.add(match[1] as string);
  }
  return [...seen];
}

export interface DispatchTextUpsertInput {
  documentKind: string;
  locale: string;
  subject: string;
  body: string;
}

/**
 * Save the one text slot for `(documentKind, locale)` (spec §10.4).
 *
 * NATURALLY IDEMPOTENT per §H-IDEMPOTENT's set-style rule: it asserts the absolute state of one
 * slot, a second delivery re-asserts the same state and cannot accumulate, so no `idempotencyKey`.
 * A VALUE-IDENTICAL upsert is a FULL no-op write: it does not touch `updated_at`/`updated_by`, so
 * the conformance gate's double-call sees byte-identical rows and the claim is tested, not asserted.
 *
 * Every `{{variable}}` is validated against the kind's registry AT SAVE TIME: an unknown one is
 * refused with `unknown_variable` naming the offender and the valid set (US-G05.6).
 */
export function dispatchTextUpsert(ctx: WorkspaceContext, input: DispatchTextUpsertInput): Result {
  return ctx.store.tx((): Result => {
    if (!KIND_SET.has(input.documentKind)) {
      return err('unknown_document_kind', { documentKind: input.documentKind, known: [...DISPATCH_TEXT_KINDS] });
    }
    if (!LOCALE_SET.has(input.locale)) {
      return err('invalid_locale', { locale: input.locale, allowed: [...TEMPLATE_LOCALES] });
    }
    if (typeof input.subject !== 'string' || input.subject.trim().length === 0) {
      return err('invalid_subject', {});
    }
    if (input.subject.length > MAX_DISPATCH_SUBJECT_LENGTH) {
      return err('invalid_subject', { max: MAX_DISPATCH_SUBJECT_LENGTH });
    }
    if (typeof input.body !== 'string' || input.body.trim().length === 0) {
      return err('invalid_body', {});
    }
    if (input.body.length > MAX_DISPATCH_BODY_LENGTH) {
      return err('invalid_body', { max: MAX_DISPATCH_BODY_LENGTH });
    }
    const valid = DISPATCH_VARIABLES[input.documentKind] as readonly string[];
    for (const variable of variablesIn(`${input.subject}\n${input.body}`)) {
      if (!valid.includes(variable)) {
        return err('unknown_variable', { variable, valid: [...valid] });
      }
    }

    const existing = readText(ctx, input.documentKind, input.locale);
    if (existing !== undefined && existing.subject === input.subject && existing.body === input.body) {
      // The full no-op: same slot, same value, nothing touched (not even updated_at).
      return ok({ dispatchText: mapText(existing), unchanged: true });
    }
    const now = ctx.clock.now();
    if (existing !== undefined) {
      ctx.store.db
        .prepare('UPDATE dispatch_texts SET subject = ?, body = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(input.subject, input.body, now, ctx.actor, existing.id);
      return ok({ dispatchText: mapText(readText(ctx, input.documentKind, input.locale) as DispatchTextRow) });
    }
    const id = ctx.ids.next('dsptxt');
    ctx.store.db
      .prepare(
        `INSERT INTO dispatch_texts (id, workspace_id, document_kind, locale, subject, body, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, input.documentKind, input.locale, input.subject, input.body, now, ctx.actor);
    return ok({ dispatchText: mapText(readText(ctx, input.documentKind, input.locale) as DispatchTextRow) });
  });
}

/** The resolved text for a slot: the saved row, else the built-in default (P9, never an error). */
export function resolveDispatchText(
  ctx: WorkspaceContext,
  documentKind: string,
  locale: string,
): { subject: string; body: string; defaulted: boolean; locale: string } {
  const effective = LOCALE_SET.has(locale) ? locale : 'de-CH';
  const saved = readText(ctx, documentKind, effective);
  if (saved !== undefined) {
    return { subject: saved.subject, body: saved.body, defaulted: false, locale: effective };
  }
  const defaults = DEFAULT_TEXTS[documentKind] ?? DEFAULT_TEXTS['invoice']!;
  const text = defaults[effective] ?? defaults['de-CH']!;
  return { subject: text.subject, body: text.body, defaulted: true, locale: effective };
}

/** Fill every registered `{{variable}}`. Save-time validation means no unknown token survives. */
export function renderDispatchTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** `1'234.55` with the currency in front: the P11 shape, formatted ONCE at resolve time. */
function formatMoneyMinor(minor: number, currency: string): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const francs = Math.trunc(absolute / 100);
  const rappen = absolute % 100;
  const grouped = String(francs).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${currency} ${negative ? '-' : ''}${grouped}.${String(rappen).padStart(2, '0')}`;
}

/** `dd.mm.yyyy`, the Swiss written-date convention across all four render locales. */
function formatDateCh(iso: string | null): string {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** The workspace's outbound sender name: the creditor profile's, else the workspace's own. */
function companyNameOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT name, creditor_name FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { name: string; creditor_name: string | null } | undefined;
  return row?.creditor_name ?? row?.name ?? '';
}

function contactOf(ctx: WorkspaceContext, contactId: string | null): { name: string; email: string | null; lang: string | null } {
  if (contactId === null) return { name: '', email: null, lang: null };
  const row = ctx.store.db
    .prepare('SELECT name, email, lang FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { name: string | null; email: string | null; lang: string | null } | undefined;
  return { name: row?.name ?? '', email: row?.email ?? null, lang: row?.lang ?? null };
}

/** The contact's language when it is a render locale, else de-CH (the P11 chain's tail). */
function localeForContact(lang: string | null): string {
  return lang !== null && LOCALE_SET.has(lang) ? lang : 'de-CH';
}

/** One resolved preview message (spec §10.2 US-G05.7). */
interface PreviewMessage {
  recipient: string | null;
  contactId: string | null;
  locale: string;
  subject: string;
  body: string;
  attachments: readonly string[];
  flags: readonly string[];
  defaulted: boolean;
}

function messageFor(
  ctx: WorkspaceContext,
  documentKind: string,
  locale: string,
  values: Readonly<Record<string, string>>,
  recipient: string | null,
  contactId: string | null,
  attachments: readonly string[],
  flags: readonly string[],
): PreviewMessage {
  const text = resolveDispatchText(ctx, documentKind, locale);
  return {
    recipient,
    contactId,
    locale: text.locale,
    subject: renderDispatchTemplate(text.subject, values),
    body: renderDispatchTemplate(text.body, values),
    attachments,
    flags,
    defaulted: text.defaulted,
  };
}

/** SAMPLE values for the editor's template preview (no document named): clearly marked MUSTER data. */
function sampleValues(documentKind: string, locale: string): Record<string, string> {
  const base: Record<string, string> = {
    contact_name: 'Muster AG',
    company_name: companyNamePlaceholder(),
    currency: 'CHF',
    amount_total: formatMoneyMinor(123450, 'CHF'),
    due_date: '30.09.2026',
    invoice_number: 'R-2026-0001',
    quote_number: 'O-2026-0001',
    valid_until: '30.09.2026',
    accept_link: '(Link folgt beim Versand)',
    dunning_level: '1',
    overdue_total: formatMoneyMinor(123450, 'CHF'),
    invoice_numbers: 'R-2026-0001',
    run_date: '01.09.2026',
  };
  void documentKind;
  void locale;
  return base;
}

function companyNamePlaceholder(): string {
  return 'Ihre Firma';
}

export interface DispatchPreviewInput {
  documentKind: string;
  documentId?: string;
  runId?: string;
  contactId?: string;
  locale?: string;
}

/**
 * Resolve the concrete message(s) a dispatch would carry, as a PURE READ (US-G05.7): nothing is
 * sent, nothing is written. A `documentId` yields exactly one message; a `runId` yields one per
 * debtor (the log side's one-row-per-recipient cardinality), narrowed by `contactId`. With neither,
 * the template resolves against MUSTER sample values (the editor's preview; `locale` picks the
 * slot, default de-CH). `flags` reuse the owning send verbs' OWN P9 names (`needs_customer_email`
 * per A11, `needs_email_transport` per A15), never a freshly minted synonym.
 */
export function dispatchPreview(ctx: WorkspaceContext, input: DispatchPreviewInput): Result {
  if (!KIND_SET.has(input.documentKind)) {
    return err('unknown_document_kind', { documentKind: input.documentKind, known: [...DISPATCH_TEXT_KINDS] });
  }
  if (input.locale !== undefined && !LOCALE_SET.has(input.locale)) {
    return err('invalid_locale', { locale: input.locale, allowed: [...TEMPLATE_LOCALES] });
  }

  // The editor's sample preview: no document named, the template alone.
  if (input.documentId === undefined && input.runId === undefined) {
    const locale = input.locale ?? 'de-CH';
    const values = sampleValues(input.documentKind, locale);
    const company = companyNameOf(ctx);
    if (company.length > 0) values['company_name'] = company;
    return ok({
      messages: [messageFor(ctx, input.documentKind, locale, values, null, null, [], [])],
      sample: true,
    });
  }

  if (input.documentKind === 'dunning_run') {
    if (input.runId === undefined) return err('invalid_input', { field: 'runId', reason: 'a dunning_run preview needs a runId' });
    return previewDunningRun(ctx, input.runId, input.contactId ?? null);
  }
  if (input.documentId === undefined) {
    return err('invalid_input', { field: 'documentId', reason: 'an invoice or quote preview needs a documentId' });
  }
  return previewDocument(ctx, input.documentKind, input.documentId);
}

function previewDocument(ctx: WorkspaceContext, documentKind: string, documentId: string): Result {
  const view = getDocument(ctx, { documentId });
  if (!view.ok) return view;
  const document = (view as unknown as {
    document: {
      type: string;
      number: string | null;
      contactId: string | null;
      currency: string;
      totalMinor: number;
      dueDate: string | null;
    };
  }).document;
  if (document.type !== documentKind) {
    return err('kind_mismatch', { documentId, expected: documentKind, actual: document.type });
  }
  const contact = contactOf(ctx, document.contactId);
  const locale = localeForContact(contact.lang);
  const values: Record<string, string> = {
    contact_name: contact.name,
    company_name: companyNameOf(ctx),
    currency: document.currency,
    amount_total: formatMoneyMinor(document.totalMinor, document.currency),
    invoice_number: document.number ?? '',
    quote_number: document.number ?? '',
    due_date: formatDateCh(document.dueDate),
    valid_until: '',
    // C02 stores only the token's HASH, so a preview cannot know the link (spec §0 item 8d).
    accept_link: '(Link folgt beim Versand)',
  };
  if (documentKind === 'quote') {
    const cols = ctx.store.db
      .prepare("SELECT valid_until FROM document WHERE workspace_id = ? AND id = ? AND type = 'quote'")
      .get(ctx.workspaceId, documentId) as { valid_until: string | null } | undefined;
    values['valid_until'] = formatDateCh(cols?.valid_until ?? null);
  }
  const flags = contact.email === null || contact.email.length === 0 ? ['needs_customer_email'] : [];
  const attachment = documentKind === 'invoice' ? 'invoice.pdf' : 'quote.pdf';
  return ok({
    messages: [
      messageFor(ctx, documentKind, locale, values, contact.email, document.contactId, [attachment], flags),
    ],
    sample: false,
  });
}

function previewDunningRun(ctx: WorkspaceContext, runId: string, onlyContactId: string | null): Result {
  const run = ctx.store.db
    .prepare('SELECT id, run_date FROM dunning_run WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, runId) as { id: string; run_date: string } | undefined;
  if (run === undefined) return err('not_found', { runId });
  const items = ctx.store.db
    .prepare(
      `SELECT debtor_id, level, overdue_minor, number, document_id
         FROM dunning_item WHERE workspace_id = ? AND run_id = ? ORDER BY debtor_id`,
    )
    .all(ctx.workspaceId, runId) as {
    debtor_id: string;
    level: number;
    overdue_minor: number;
    number: string | null;
    document_id: string;
  }[];
  const currency = baseCurrencyOf(ctx);
  const byDebtor = new Map<string, typeof items>();
  for (const item of items) {
    if (onlyContactId !== null && item.debtor_id !== onlyContactId) continue;
    const group = byDebtor.get(item.debtor_id) ?? [];
    group.push(item);
    byDebtor.set(item.debtor_id, group);
  }
  const messages: PreviewMessage[] = [];
  for (const [debtorId, group] of byDebtor) {
    const contact = contactOf(ctx, debtorId);
    const locale = localeForContact(contact.lang);
    const values: Record<string, string> = {
      contact_name: contact.name,
      company_name: companyNameOf(ctx),
      currency,
      dunning_level: String(Math.max(...group.map((i) => i.level))),
      overdue_total: formatMoneyMinor(
        group.reduce((sum, i) => sum + i.overdue_minor, 0),
        currency,
      ),
      invoice_numbers: group.map((i) => i.number ?? i.document_id).join(', '),
      run_date: formatDateCh(run.run_date),
    };
    // A15's own P9 name for a missing transport target on a debtor (never a minted synonym).
    const flags = contact.email === null || contact.email.length === 0 ? ['needs_email_transport'] : [];
    messages.push(messageFor(ctx, 'dunning_run', locale, values, contact.email, debtorId, ['mahnung.pdf'], flags));
  }
  return ok({ messages, sample: false });
}

function baseCurrencyOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { base_currency: string | null } | undefined;
  return row?.base_currency ?? 'CHF';
}

export interface RecordDispatchInput {
  documentKind: string;
  documentId?: string;
  dunningRunId?: string;
  contactId?: string | null;
  recipientEmail?: string | null;
  channel: string;
  locale: string;
  subjectResolved: string;
  bodyResolved: string;
  defaulted: boolean;
  outcome: string;
  degradeReason?: string | null;
}

/**
 * The SHARED logging delegate the three send pipelines call once per recipient (spec §10.4): the
 * `renderWithTemplate` shape applied to logging. The caller hands over what it already knows and
 * this records it verbatim; it is NOT an MCP tool because it has no independent caller. It opens no
 * transaction of its own: a caller inside a unit (A11's recordSent) gets the row in THE SAME WRITE
 * as the send's own status transition, and a caller outside one gets a single atomic INSERT. The
 * log append rides the send verbs' own idempotency: a replayed send never reaches this call, so it
 * never double-logs.
 */
export function recordDispatch(ctx: WorkspaceContext, input: RecordDispatchInput): void {
  ctx.store.db
    .prepare(
      `INSERT INTO dispatches
         (id, workspace_id, document_kind, document_id, dunning_run_id, contact_id, recipient_email,
          channel, locale, subject_resolved, body_resolved, dispatch_text_defaulted, outcome,
          degrade_reason, actor, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.ids.next('dsp'),
      ctx.workspaceId,
      input.documentKind,
      input.documentId ?? null,
      input.dunningRunId ?? null,
      input.contactId ?? null,
      input.recipientEmail ?? null,
      input.channel,
      input.locale,
      input.subjectResolved,
      input.bodyResolved,
      input.defaulted ? 1 : 0,
      input.outcome,
      input.degradeReason ?? null,
      ctx.actor,
      ctx.clock.now(),
    );
}

interface DispatchRow {
  id: string;
  workspace_id: string;
  document_kind: string;
  document_id: string | null;
  dunning_run_id: string | null;
  contact_id: string | null;
  recipient_email: string | null;
  channel: string;
  locale: string;
  subject_resolved: string;
  body_resolved: string;
  dispatch_text_defaulted: number;
  outcome: string;
  degrade_reason: string | null;
  actor: string;
  sent_at: string;
}

function mapDispatch(row: DispatchRow): Record<string, unknown> {
  return {
    dispatchId: row.id,
    documentKind: row.document_kind,
    documentId: row.document_id,
    dunningRunId: row.dunning_run_id,
    contactId: row.contact_id,
    recipientEmail: row.recipient_email,
    channel: row.channel,
    locale: row.locale,
    subjectResolved: row.subject_resolved,
    bodyResolved: row.body_resolved,
    dispatchTextDefaulted: row.dispatch_text_defaulted === 1,
    outcome: row.outcome,
    degradeReason: row.degrade_reason,
    actor: row.actor,
    // ISO timestamp, machine-neutral per P11: the GUI formats, the wire does not.
    sentAt: row.sent_at,
  };
}

export interface ListDispatchesInput {
  documentKind?: string;
  contactId?: string;
  outcome?: string;
  from?: string;
  to?: string;
  savedViewId?: string;
}

/**
 * The Protokoll read model (P5), newest first, with G00's saved-view seam like every sibling list
 * verb. It also answers the editor's Textbausteine state in one read (`texts`, all saved slots):
 * the §10.5 "the editor reads through the upsert surface's list shape" rule without a fourth tool.
 */
export function listDispatches(ctx: WorkspaceContext, input: ListDispatchesInput): Result {
  const applied = applySavedView(ctx, 'dispatch', {
    documentKind: input.documentKind,
    contactId: input.contactId,
    outcome: input.outcome,
    from: input.from,
    to: input.to,
    savedViewId: input.savedViewId,
  });
  if (!applied.ok) return applied;
  const filter = applied.filter as ListDispatchesInput;
  if (filter.documentKind !== undefined && !KIND_SET.has(filter.documentKind)) {
    return err('unknown_document_kind', { documentKind: filter.documentKind, known: [...DISPATCH_TEXT_KINDS] });
  }
  if (filter.outcome !== undefined && !DISPATCH_OUTCOMES.includes(filter.outcome)) {
    return err('invalid_input', { field: 'outcome', allowed: [...DISPATCH_OUTCOMES] });
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM dispatches
        WHERE workspace_id = ?
          AND (? IS NULL OR document_kind = ?)
          AND (? IS NULL OR contact_id = ?)
          AND (? IS NULL OR outcome = ?)
          AND (? IS NULL OR sent_at >= ?)
          AND (? IS NULL OR sent_at <= ?)
        ORDER BY sent_at DESC, id DESC`,
    )
    .all(
      ctx.workspaceId,
      filter.documentKind ?? null,
      filter.documentKind ?? null,
      filter.contactId ?? null,
      filter.contactId ?? null,
      filter.outcome ?? null,
      filter.outcome ?? null,
      filter.from ?? null,
      filter.from ?? null,
      filter.to ?? null,
      // An inclusive day upper bound: a bare date must cover that whole day's timestamps.
      filter.to !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(filter.to) ? `${filter.to}T23:59:59.999Z` : (filter.to ?? null),
    ) as DispatchRow[];
  const texts = ctx.store.db
    .prepare('SELECT * FROM dispatch_texts WHERE workspace_id = ? ORDER BY document_kind, locale')
    .all(ctx.workspaceId) as DispatchTextRow[];
  return ok({ dispatches: rows.map(mapDispatch), texts: texts.map(mapText) });
}
