/**
 * D178 N2 (A39 §18.4): the facts card at the top of the /bank detail area.
 *
 * The owner's review (21.10.2026): the facts should read better, "with icons and less text". The card is
 * the line as the bank delivered it, before anything is decided about it:
 *
 *   - its title: the counterparty in 600 and the signed amount (the sign in `--t-danger` for money out,
 *     the figure in ink, tabular), the D177 panel's title moved here;
 *   - then ONE line per fact, a calm glyph naming the fact's kind and the value. The fact's name is a
 *     `<dt>` for assistive tech; a sighted reader reads the glyph and, where two values could be confused
 *     (the two dates, the references), a short dim word before the value. No prose, nothing cut.
 *
 * Every figure and text is the engine's. The statement facts of D178 points 3 and 4 (the bank code, the
 * separate texts, the references, FX) are OPTIONAL (`statementFacts.ts`): a line imported before them, or a
 * develop without them, shows the facts it has and nothing empty.
 *
 * The `.bank-facts` list and its `data-fact` keys keep the D177 names (`date`, `text`, `reference`, `iban`,
 * `account`, `receipts`), so the existing suites and the flows read the same facts where they were.
 */
import type { ReactNode } from 'react';

import { useI18n, useT, formatDate, formatMoney } from '../../i18n';
import {
  BankGlyph,
  CalendarGlyph,
  ExchangeGlyph,
  HashGlyph,
  NoteGlyph,
  PersonGlyph,
  TagGlyph,
  TextLinesGlyph,
  VOCABULARY,
} from '../../components/icons';
import type { BankInboxLine } from './model';
import { formatIban, formatReference } from './model';
import type { Lookups } from './lookups';
import { partyOf, plural } from './lookups';
import { bankCodeText, hasFxFacts, lineFactsOf, type StudioLineFacts } from './statementFacts';
import { useDetailArea } from './DetailArea';

export interface FactsCardProps {
  line: BankInboxLine;
  lookups: Lookups;
  /** The id the card's title carries: the detail area is labelled by it. */
  titleId: string;
  /** Name the Bankkonto: the inbox shows lines of several accounts. */
  showAccount: boolean;
  /** The Belege count opens the line's Belege (absent: the count is said, not offered). */
  onReceipts?: () => void;
}

interface Fact {
  key: string;
  glyph: ReactNode;
  /** The fact's name, for assistive tech (the glyph says it to the eye). */
  name: string;
  value: ReactNode;
}

/** A short dim word before a value, where two values of one kind sit on a line ("Valuta", "E2E"). */
function Tag({ children }: { children: ReactNode }) {
  return <span className="bank-fact__tag">{children}</span>;
}

function fxValue(t: ReturnType<typeof useT>, facts: StudioLineFacts): ReactNode {
  const parts: ReactNode[] = [];
  if (facts.instructed !== null) {
    parts.push(
      <span key="instructed" className="t-money">
        {formatMoney(Math.abs(facts.instructed.amountMinor), facts.instructed.currency)}
      </span>,
    );
  }
  const rate = facts.exchange?.rate ?? null;
  if (rate !== null) {
    parts.push(
      <span key="rate">
        <Tag>{t('bankInbox.facts.fxRate')}</Tag> <span className="t-num">{rate}</span>
      </span>,
    );
  }
  const effective = facts.exchange?.effectiveRate ?? null;
  if (effective !== null && effective !== rate) {
    parts.push(
      <span key="effective">
        <Tag>{t('bankInbox.facts.fxEffective')}</Tag> <span className="t-num">{effective}</span>
      </span>,
    );
  }
  const fee = facts.fee ?? (facts.chargesTotal === null ? null : { ...facts.chargesTotal, included: null });
  if (fee !== null) {
    parts.push(
      <span key="fee">
        <Tag>{t('bankInbox.facts.fxFee')}</Tag> <span className="t-money">{formatMoney(Math.abs(fee.amountMinor), fee.currency)}</span>
      </span>,
    );
  }
  return parts.flatMap((p, i) => (i === 0 ? [p] : [<span key={`sep-${i}`} className="bank-fact__sep" aria-hidden="true">{' · '}</span>, p]));
}

export function FactsCard({ line, lookups, titleId, showAccount, onReceipts }: FactsCardProps) {
  const t = useT();
  const { locale } = useI18n();
  // In the drawer the drawer's own title names the counterparty: the card's title says the amount alone.
  const inDrawer = useDetailArea()?.placement === 'drawer';
  const facts = lineFactsOf(line);
  const account = lookups.bankById.get(line.bankAccountId);
  const rows: Fact[] = [];

  // The two dates: the booking date first, the value date labelled (D178 point 4: both shown).
  if (line.bookingDate !== null || line.valueDate !== null) {
    rows.push({
      key: 'date',
      glyph: <CalendarGlyph size={16} />,
      name: t('bankInbox.facts.dates'),
      value: (
        <>
          {line.bookingDate !== null && <span className="t-num">{formatDate(line.bookingDate)}</span>}
          {line.valueDate !== null && (
            <span className="bank-fact__second">
              {line.bookingDate !== null && <span className="bank-fact__sep" aria-hidden="true">{' · '}</span>}
              <Tag>{t('bankInbox.facts.valuta')}</Tag> <span className="t-num">{formatDate(line.valueDate)}</span>
            </span>
          )}
        </>
      ),
    });
  }
  if (line.counterparty.iban !== null) {
    rows.push({ key: 'iban', glyph: <PersonGlyph size={16} />, name: t('bankInbox.facts.iban'), value: <span className="t-num">{formatIban(line.counterparty.iban)}</span> });
  }
  // Bankbeschreibung and Zusätzliche Info as SEPARATE facts (D178 point 4). Without the statement facts the
  // one merged text A39 has always read is the description.
  const bankText = facts?.bankText ?? line.remittance.text;
  if (bankText !== null) rows.push({ key: 'text', glyph: <TextLinesGlyph size={16} />, name: t('bankInbox.facts.text'), value: bankText });
  const shown = new Set([bankText ?? '']);
  for (const [key, value] of [
    ['info', facts?.additionalInfo ?? null],
    ['entry', facts?.entryInfo ?? null],
  ] as const) {
    if (value === null || shown.has(value)) continue;
    shown.add(value);
    rows.push({ key, glyph: <NoteGlyph size={16} />, name: t('bankInbox.facts.info'), value });
  }
  // The references, each its own line, each with its short word.
  if (line.remittance.referenceValue !== null) {
    rows.push({
      key: 'reference',
      glyph: <HashGlyph size={16} />,
      name: t('bankInbox.facts.reference'),
      value: (
        <>
          <Tag>{t(line.remittance.referenceKind === 'QRR' ? 'bankInbox.facts.qrRef' : 'bankInbox.facts.reference')}</Tag> <span className="t-num">{formatReference(line.remittance.referenceKind, line.remittance.referenceValue)}</span>
        </>
      ),
    });
  }
  const e2e = facts?.refs.endToEndId ?? line.remittance.endToEndId;
  if (e2e !== null && e2e !== 'NOTPROVIDED') {
    rows.push({
      key: 'e2e',
      glyph: <HashGlyph size={16} />,
      name: t('bankInbox.facts.e2eLong'),
      value: (
        <>
          <Tag>{t('bankInbox.facts.e2e')}</Tag> {e2e}
        </>
      ),
    });
  }
  const servicer = facts?.refs.accountServicerRef ?? null;
  if (servicer !== null) {
    rows.push({
      key: 'bankref',
      glyph: <HashGlyph size={16} />,
      name: t('bankInbox.facts.bankRefLong'),
      value: (
        <>
          <Tag>{t('bankInbox.facts.bankRef')}</Tag> {servicer}
        </>
      ),
    });
  }
  const code = facts?.bankCode ?? null;
  const codeText = code === null ? null : bankCodeText(code);
  if (code !== null && (code.label !== null || codeText !== null)) {
    const label = code.label === null ? null : locale === 'en' ? code.label.en : code.label['de-CH'];
    rows.push({
      key: 'code',
      glyph: <TagGlyph size={16} />,
      name: t('bankInbox.facts.code'),
      value: (
        <>
          {label ?? codeText}
          {label !== null && codeText !== null && <span className="bank-fact__dim"> ({codeText})</span>}
        </>
      ),
    });
  }
  if (facts !== null && hasFxFacts(facts)) {
    rows.push({ key: 'fx', glyph: <ExchangeGlyph size={16} />, name: t('bankInbox.facts.fx'), value: fxValue(t, facts) });
  }
  if (showAccount && account !== undefined) {
    rows.push({ key: 'account', glyph: <BankGlyph size={16} />, name: t('bankInbox.facts.account'), value: account.name });
  }
  if (line.receiptCount > 0) {
    const Clip = VOCABULARY.attach.glyph;
    const words = plural(t, 'bankInbox.facts.receipts', line.receiptCount);
    rows.push({
      key: 'receipts',
      glyph: <Clip size={16} />,
      name: t('bankInbox.receipts.title'),
      value:
        onReceipts === undefined ? (
          words
        ) : (
          <button type="button" className="link-inline bank-fact__link" onClick={onReceipts}>
            {words}
          </button>
        ),
    });
  }

  const out = line.amountMinor < 0;
  return (
    // A plain block: the detail area around it is the region, labelled by this card's title.
    <div className="bank-facts bank-facts-card" data-facts-for={line.bankTxnId}>
      <h2 id={titleId} className="bank-panel__title bank-facts__title">
        <span className={inDrawer ? 'visually-hidden' : 'bank-panel__party'}>{partyOf(t, line)}</span>
        <span className="bank-panel__amount bank-facts__amount t-money">
          {/* The sign in danger ink, the figure in ink (DESIGN.md "Money"); the minus is read out. */}
          {out && <span className="bank-amount__sign">{'−'}</span>}
          {formatMoney(Math.abs(line.amountMinor), line.currency)}
        </span>
      </h2>
      {rows.length > 0 && (
        <dl className="bank-facts__list">
          {rows.map((r) => (
            <div key={r.key} className="bank-facts__row" data-fact={r.key}>
              {/* The glyph names the fact to the eye; the words name it to assistive tech. */}
              <dt className="bank-fact__glyph">
                <span aria-hidden="true">{r.glyph}</span>
                <span className="visually-hidden">{r.name}</span>
              </dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
