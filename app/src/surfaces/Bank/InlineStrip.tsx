/**
 * D195 (owner, v12 point 5): the context of an opened line, in the strip under its row, each piece under the
 * column it explains. Nothing in it is a second form: the row above is the editor.
 *
 *  - Under Gegenpartei: the bank's own text, the Valuta, the amount in its original currency (the rate on
 *    hover), a QR reference when there is one, and a quiet "Referenz kopieren".
 *  - Under Buchen auf: ONE short source line, only when it says something ("Vorschlag vom Agenten", "MWST aus
 *    dem Beleg übernommen", a rule's name), then Soll and Haben: shown directly at one or two lines, behind
 *    "Soll und Haben (n)" when longer. A line booked by a turnover preset shows its payout's composition instead.
 *  - Under MWST and Betrag: the receipt as a small thumbnail (a click opens it full size) with its name and its
 *    VAT figure; an unread receipt offers "Beleg lesen"; no receipt, "Beleg anhängen".
 *
 * A line in an editor the row cannot hold (Mit Buchung abgleichen, a rule's amounts, Ignorieren with a note)
 * shows that editor here instead, beside the facts (`panel`).
 */
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, formatDate, formatMoney } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import { CopyButton } from '../../components/CopyButton';
import { Modal } from '../../components/Modal';
import { BelegPreview, type BelegPreviewFile } from '../../components/BelegPreview';
import { PaperclipGlyph } from './glyphs';
import type { BankInboxLine, DraftTarget, LineVorschlag, RowDraft } from './model';
import { askMinor, bookTargetOf, isComputedAsIs } from './model';
import type { Lookups } from './lookups';
import { accountLabel, detailOf } from './lookups';
import { lineFactsOf } from './statementFacts';
import { ruleName } from './rules';
import { bankComposeRequest, previewLinesOf, vatAccountIdsOf, type PreviewLine } from './bankCompose';
import { useBankCompose, useTargetCompose } from './useBankCompose';
import { RefusalNote } from './RefusalNote';
import type { RefusalAction } from './errors';
import { PayoutComposition } from './PayoutComposition';
import { vatCheckOf } from './InlineRow';

/** How many Soll/Haben lines show directly; more stay behind "Soll und Haben (n)". */
export const LEGS_SHOWN_DIRECTLY = 2;

// --- facts ---------------------------------------------------------------------------------------------

/**
 * D195 (owner: "do not repeat yourself"): the row's second line under the counterparty is cut by its column
 * (an ellipsis shows). Measured on the row the strip belongs to; without layout (a test DOM) nothing is cut.
 */
function useRowTextCut(bankTxnId: string): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    let row: HTMLElement | null = null;
    for (const r of document.querySelectorAll<HTMLElement>('tr.bank-row')) if (r.dataset.line === bankTxnId) row = r;
    const second = row?.querySelector<HTMLElement>('.bank-cell--party .bank-two__b') ?? null;
    setCut(second !== null && second.scrollWidth > second.clientWidth + 1);
  }, [bankTxnId]);
  return cut;
}

function StripFacts({ line }: { line: BankInboxLine }) {
  const t = useT();
  const facts = lineFactsOf(line);
  const full = facts?.bankText ?? facts?.additionalInfo ?? line.remittance.text ?? facts?.entryInfo ?? null;
  // The bank's text shows here only when it says more than the row's second line already does: that line is
  // cut, or the whole text is another (longer) one. Otherwise the strip starts at the Valuta.
  const rowText = detailOf(line);
  const cut = useRowTextCut(line.bankTxnId);
  const text = full !== null && (cut || full.trim() !== rowText.trim()) ? full : null;
  const instructed = facts?.instructed ?? null;
  const foreign = instructed !== null && instructed.currency !== line.currency ? instructed : null;
  const rate = facts?.exchange?.rate ?? null;
  const qr = line.remittance.referenceValue !== null && line.remittance.referenceKind !== '' && line.remittance.referenceKind !== 'NON' ? line.remittance.referenceValue : null;
  const ref = facts?.refs.accountServicerRef ?? line.entryRef ?? facts?.refs.endToEndId ?? line.remittance.endToEndId ?? null;
  return (
    <div className="bank-strip__facts">
      {text !== null && <p className="bank-strip__text">{text}</p>}
      <dl className="bank-kv">
        {line.valueDate !== null && (
          <>
            <dt>{t('bankInbox.facts.valuta')}</dt>
            <dd className="t-num">{formatDate(line.valueDate)}</dd>
          </>
        )}
        {foreign !== null && (
          <>
            <dt>{t('bankInbox.inline.original')}</dt>
            <dd className="t-num">
              {rate !== null ? (
                <Tooltip content={t('bankInbox.inline.rate', { rate })}>
                  <span tabIndex={0}>{formatMoney(foreign.amountMinor, foreign.currency)}</span>
                </Tooltip>
              ) : (
                formatMoney(foreign.amountMinor, foreign.currency)
              )}
            </dd>
          </>
        )}
        {qr !== null && (
          <>
            <dt>{t('bankInbox.inline.qr')}</dt>
            <dd className="t-num">{qr}</dd>
          </>
        )}
      </dl>
      {ref !== null && <CopyButton value={ref} idleText={t('bankInbox.inline.copyRef')} label={t('bankInbox.inline.copyRefLabel', { ref })} className="bank-strip__link" />}
    </div>
  );
}

// --- why: the source and Soll/Haben ---------------------------------------------------------------------

/** The one source line, or null when it would say nothing new (never "Betrag stimmt"). */
export function sourceWords(t: ReturnType<typeof useT>, l: Lookups, line: BankInboxLine, draft: RowDraft | undefined, vorschlag: LineVorschlag | undefined): string | null {
  const bits: string[] = [];
  if (vorschlag !== undefined && (draft === undefined || draft.source === 'agent')) bits.push(t('bankInbox.inline.source.agent'));
  const fromReceipt = (line.proposal as (typeof line.proposal & { vatFromReceipt?: unknown }) | null)?.vatFromReceipt;
  if (fromReceipt !== undefined && fromReceipt !== null && (draft === undefined || draft.source === 'proposal')) bits.push(t('bankInbox.inline.source.vatFromReceipt'));
  const ruleId = draft?.target?.kind === 'rule' ? draft.target.standardId : draft?.source === 'proposal' ? line.standardId : null;
  if (ruleId !== null && ruleId !== undefined) {
    const rule = l.standardById.get(ruleId);
    if (rule !== undefined) bits.push(t('bankInbox.inline.source.rule', { name: ruleName(t, rule) }));
  }
  return bits.length === 0 ? null : bits.join(' · ');
}

/** "6570 / 1020": a compose answer as pairs against the bank, when every other line stands opposite the bank. */
interface LegPair {
  key: string;
  label: string;
  route: string;
  minor: number;
}
function pairsOf(lines: readonly PreviewLine[], bankLedger: string | null, vatIds: ReadonlySet<string>, l: Lookups, vatWord: string): LegPair[] | null {
  const bank = lines.filter((x) => x.accountId === bankLedger);
  if (bankLedger === null || bank.length !== 1) return null;
  const bankDebit = (bank[0]?.debit ?? 0) > 0;
  const others = lines.filter((x) => x.accountId !== bankLedger);
  if (others.some((x) => (x.debit > 0) === bankDebit)) return null;
  const num = (id: string) => l.chartById.get(id)?.number ?? accountLabel(l, id);
  return others.map((x, i) => ({
    key: `${x.accountId}-${i}`,
    label: vatIds.has(x.accountId) ? vatWord : '',
    route: bankDebit ? `${num(bankLedger)} / ${num(x.accountId)}` : `${num(x.accountId)} / ${num(bankLedger)}`,
    minor: Math.max(x.debit, x.credit),
  }));
}

function StripLegs({ workspaceId, line, lookups, target }: { workspaceId: string; line: BankInboxLine; lookups: Lookups; target: DraftTarget | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const direct = target?.kind === 'accounts' && (target.viaAccountId ?? '') === '' ? target : null;
  const viaOrRule =
    target !== null && ((target.kind === 'accounts' && (target.viaAccountId ?? '') !== '') || (target.kind === 'rule' && target.asks.every((a) => isComputedAsIs(a) || askMinor(a) !== null))) ? target : null;
  const legs = useBankCompose(workspaceId, direct !== null && direct.legs.every((g) => g.accountId !== '') ? bankComposeRequest(line, direct.legs, bankLedger) : null, { currency: line.currency });
  const routed = useTargetCompose(workspaceId, line.bankTxnId, viaOrRule === null ? null : bookTargetOf(viaOrRule));
  const state = direct !== null ? legs : routed;
  if (state.status !== 'answered' || !state.answer.composed) return null;
  const lines = previewLinesOf(state.answer);
  const vatIds = vatAccountIdsOf(state.answer);
  const pairs = pairsOf(lines, bankLedger, vatIds, lookups, t('bankInbox.inline.vatLeg'));
  const money = (minor: number) => formatMoney(minor, line.currency).slice(line.currency.length + 1);
  const count = pairs?.length ?? lines.length;
  const table =
    pairs !== null ? (
      <table className="bank-mini">
        <tbody>
          {pairs.map((p) => (
            <tr key={p.key}>
              <td className="bank-mini__label">{p.label}</td>
              <td className="t-num">{p.route}</td>
              <td className="bank-mini__num t-num">{money(p.minor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <table className="bank-mini">
        <thead>
          <tr>
            <th scope="col">{t('bankInbox.legs.account')}</th>
            <th scope="col" className="bank-mini__num">{t('bankInbox.legs.debit')}</th>
            <th scope="col" className="bank-mini__num">{t('bankInbox.legs.credit')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((x, i) => (
            <tr key={`${x.accountId}-${i}`}>
              <td>{accountLabel(lookups, x.accountId)}</td>
              <td className="bank-mini__num t-num">{x.debit > 0 ? money(x.debit) : ''}</td>
              <td className="bank-mini__num t-num">{x.credit > 0 ? money(x.credit) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  if (count <= LEGS_SHOWN_DIRECTLY) return table;
  return (
    <>
      <button type="button" className="bank-strip__link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t('bankInbox.inline.legsToggle', { count })}
      </button>
      {open && table}
    </>
  );
}

// --- the receipt --------------------------------------------------------------------------------------

function useLinkedFiles(workspaceId: string, line: BankInboxLine): BelegPreviewFile[] | null {
  const client = useClient();
  const [files, setFiles] = useState<{ key: string; files: BelegPreviewFile[] } | null>(null);
  const key = `${line.bankTxnId}:${line.receiptCount}:${line.belegAssignment?.files.length ?? 0}`;
  const any = line.receiptCount > 0 || (line.belegAssignment?.files.length ?? 0) > 0;
  useEffect(() => {
    if (!any) return undefined;
    let live = true;
    void client.call('files_list_linked', { workspaceId, entityKind: 'bank_txn', entityId: line.bankTxnId }).then(({ body }) => {
      if (!live) return;
      const raw = isErr(body) ? [] : (body as unknown as { files?: unknown }).files;
      const parsed: BelegPreviewFile[] = [];
      for (const f of Array.isArray(raw) ? (raw as unknown[]) : []) {
        const r = typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : null;
        if (r !== null && typeof r.id === 'string') parsed.push({ fileId: r.id, filename: typeof r.filename === 'string' ? r.filename : '' });
      }
      setFiles({ key, files: parsed });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, line.bankTxnId, key, any]);
  if (!any) return [];
  return files !== null && files.key === key ? files.files : null;
}

/** A41.8 (`feat/receipt-vat-proposal`): the receipt's own VAT, when the engine sends it on the line. */
function receiptVatWords(t: ReturnType<typeof useT>, line: BankInboxLine): string | null {
  const rv = (line as BankInboxLine & { receiptVat?: { rateBp?: unknown; amountMinor?: unknown; currency?: unknown } | null }).receiptVat ?? null;
  if (rv === null || typeof rv.amountMinor !== 'number') return null;
  const currency = typeof rv.currency === 'string' ? rv.currency : line.currency;
  const amount = formatMoney(rv.amountMinor, currency).slice(currency.length + 1);
  if (rv.amountMinor === 0) return t('bankInbox.inline.receiptNoVat');
  return typeof rv.rateBp === 'number' && rv.rateBp > 0 ? t('bankInbox.inline.receiptVatRate', { rate: rv.rateBp / 100, amount }) : t('bankInbox.inline.receiptVat', { amount });
}

function StripReceipt({ workspaceId, line, canAttach, onAttach, onAssignCandidate, reader }: { workspaceId: string; line: BankInboxLine; canAttach: boolean; onAttach: () => void; onAssignCandidate: (() => void) | null; reader: ReactNode }) {
  const t = useT();
  const files = useLinkedFiles(workspaceId, line);
  const [view, setView] = useState<'none' | 'full' | 'read'>('none');
  if (files === null) return null;
  const file = files[0];
  if (file === undefined) {
    const candidate = line.belegCandidates?.length === 1 ? line.belegCandidates[0]?.files[0] : undefined;
    if (candidate !== undefined && onAssignCandidate !== null) {
      return (
        <div className="bank-doc">
          <span className="bank-doc__text">
            <span className="bank-doc__name">{candidate.filename}</span>
            <button type="button" className="bank-strip__link" onClick={onAssignCandidate}>
              {t('bankInbox.inline.assignCandidate')}
            </button>
          </span>
        </div>
      );
    }
    if (!canAttach) return null;
    return (
      <button type="button" className="bank-doc__attach" onClick={onAttach}>
        <PaperclipGlyph size={16} />
        {t('bankInbox.inline.attach')}
      </button>
    );
  }
  const unread = vatCheckOf(line) === 'unread';
  const vat = receiptVatWords(t, line);
  const name = file.filename !== '' ? file.filename : t('belegPreview.unnamed');
  return (
    <div className="bank-doc">
      <span className="bank-doc__text">
        <span className="bank-doc__name">{name}</span>
        {unread ? (
          <button type="button" className="bank-strip__link" onClick={() => setView('read')}>
            {t('bankInbox.inline.readReceipt')}
          </button>
        ) : (
          vat !== null && <span className="t-num">{vat}</span>
        )}
      </span>
      <button type="button" className="bank-doc__thumb" aria-label={t('bankInbox.inline.openReceipt', { name })} onClick={() => setView('full')}>
        <i />
        <i style={{ width: '70%' }} />
        <i />
        <i style={{ width: '50%' }} />
      </button>
      <Modal open={view !== 'none'} onClose={() => setView('none')} title={name} closeLabel={t('bankInbox.panel.close')}>
        {view === 'read' ? reader : <BelegPreview workspaceId={workspaceId} files={files} />}
      </Modal>
    </div>
  );
}

// --- the strip ------------------------------------------------------------------------------------------

export interface InlineStripProps {
  workspaceId: string;
  line: BankInboxLine;
  draft: RowDraft | undefined;
  lookups: Lookups;
  vorschlag: LineVorschlag | undefined;
  /** The line books by a turnover preset: its payout's composition shows instead of Soll and Haben. */
  presetActive: boolean;
  /** Leading cells before Gegenpartei: the pick box and the date (2) on the open tab, the date alone (1) elsewhere. */
  lead: number;
  /** An editor the row cannot hold, shown beside the facts instead of the source, Soll/Haben and receipt. */
  panel: ReactNode | null;
  refusal: Err | null;
  onRefusalAction: (action: RefusalAction) => void;
  canAttach: boolean;
  onAttach: () => void;
  onAssignCandidate: (() => void) | null;
  /** "Beleg lesen": the receipt with its figures to confirm (the line's LineBeleg). */
  reader: ReactNode;
}

export function InlineStrip({ workspaceId, line, draft, lookups, vorschlag, presetActive, lead, panel, refusal, onRefusalAction, canAttach, onAttach, onAssignCandidate, reader }: InlineStripProps) {
  const t = useT();
  const target = draft?.target ?? null;
  const source = sourceWords(t, lookups, line, draft, vorschlag);
  return (
    <tr className="bank-strip" data-strip-for={line.bankTxnId}>
      <td className="bank-strip__lead" colSpan={lead} />
      <td className="bank-strip__cell bank-strip__cell--facts">
        <StripFacts line={line} />
      </td>
      {panel !== null ? (
        <td className="bank-strip__cell bank-strip__cell--panel" colSpan={5}>
          {panel}
        </td>
      ) : (
        <>
          <td className="bank-strip__cell bank-strip__cell--why">
            <div className="bank-strip__why">
              {source !== null && <p className="bank-strip__source">{source}</p>}
              {presetActive ? <PayoutComposition workspaceId={workspaceId} bankTxnId={line.bankTxnId} currency={line.currency} /> : <StripLegs workspaceId={workspaceId} line={line} lookups={lookups} target={target} />}
              {refusal !== null && <RefusalNote error={refusal} context={{ currency: line.currency, lineState: line.state }} onAction={onRefusalAction} />}
            </div>
          </td>
          <td className="bank-strip__cell bank-strip__cell--doc" colSpan={3}>
            {!presetActive && <StripReceipt workspaceId={workspaceId} line={line} canAttach={canAttach} onAttach={onAttach} onAssignCandidate={onAssignCandidate} reader={reader} />}
          </td>
          <td className="bank-strip__cell" />
        </>
      )}
    </tr>
  );
}
