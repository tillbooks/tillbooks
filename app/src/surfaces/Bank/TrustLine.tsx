/**
 * The balance line: does the bank equal the books (spec L4; the judge's outcome 3), in B2's form (the
 * owner's pick of 01.10.2026, "Worte auf Wunsch"): one line that says the one number, and an (i) that
 * opens the rest.
 *
 *   ⚠ Differenz CHF 312.40 (i)        or, when the difference is 0:   ✓ Keine Differenz (i)
 *
 * An account that cannot be judged says why in two or three words on the line ("Noch kein Kontoauszug"),
 * the full sentence in its card (critic F10: the line is the account and the one figure, no more).
 *
 * The card holds the engine's identity, Bank = Buchhaltung + offene Zeilen + Differenz, each figure the
 * engine's own summary at the latest statement date, then the paragraph on what makes a difference (an
 * ignored line whose money is not on the books, an entry no line backs, a difference accepted at a match,
 * a line matched to an entry dated after the statement), the statement's date and the open lines as a
 * door into the list. Nothing is explained away and nothing is recounted here. An account that cannot be
 * judged says so in words, and the identity is not drawn for it.
 *
 * SEVERAL ACCOUNTS IN VIEW (D152, owner, 02.10.2026): one line per account cost 25 words above the first
 * bank line with three accounts (budget 20). With two or more accounts in view, `TrustSummary` says the
 * whole in ONE line ("2 Konten mit Differenz · 1 ohne Kontoauszug", or "Alle Konten abgestimmt"), and its
 * (i) card lists every account with its figure. Each account's row there is a disclosure that opens the
 * very card content its own line had (the equation, the explanation, the statement date, the open lines),
 * so the card stays a list of short facts until the person asks for one account's words (DESIGN.md P4).
 * One account in view keeps its own line, unchanged.
 *
 * A MISSING STATEMENT (A36 §4.7, D150): an account with an open statement gap says so in its card
 * content, so in both shapes: one line in A36's own words (`gapTitle`, "Auszug 2 fehlt (21.09.2026 bis
 * 22.09.2026)") and "Lücke schliessen", the door to the repair dialog (`gapRepairHref`). The gaps come
 * from the read the Übersicht band and the repair dialog make (`useStatementGaps`). The resting line
 * gains no words. A gap is a warning in A36 (the band's lamp turns warn), and a line has exactly ONE
 * status glyph (D152, "one glyph, no contradictions"): with a gap, the line's own glyph BECOMES the warn
 * glyph, replacing the ✓, and its accessible name is the gap alone ("Ein Kontoauszug fehlt"): the
 * words beside it already say the rest, so a screen reader hears each fact once. A difference keeps its one warn glyph as it was. The summary line follows the same rule: a
 * gap on any account in view makes its glyph warn. The words stay in the card (DESIGN.md "Words on
 * demand").
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { useT, formatDate, formatMoney } from '../../i18n';
import type { BankAccountBalance } from './model';
import { trustView, type TrustView } from './model';
import { BalancedGlyph, CaretGlyph, UnknownGlyph, WarnGlyph } from './glyphs';
import { plural } from './lookups';
import { InfoCard } from './InfoCard';
import { gapRepairHref, gapTitle, type StatementGapDto } from './statementGaps';
import { statementKeyOf, useStatementGaps } from './useStatementGaps';

type T = ReturnType<typeof useT>;

/** The line's few words for one account: its difference, "Keine Differenz", or why it cannot be judged. */
function headlineOf(t: T, balance: BankAccountBalance, v: TrustView): string {
  if (v.tone === 'difference') return t('bankInbox.trust.differenceShort', { amount: formatMoney(Math.abs(v.difference ?? 0), balance.currency) });
  if (v.tone === 'ok' || v.tone === 'pending') return t('bankInbox.trust.noDifference');
  return t(`bankInbox.trust.unknownShort.${balance.reason ?? 'inconsistent'}`);
}

/**
 * The line's ONE status glyph. A difference warns as it always did. An open statement gap (A36) turns
 * any other glyph into the warn glyph. It is named for the gap alone ("Ein Kontoauszug fehlt"): the
 * words beside it carry the rest, and repeating them in the name would make a screen reader say them twice.
 */
function ToneGlyph({ tone, gaps = [] }: { tone: TrustView['tone']; gaps?: readonly StatementGapDto[] }) {
  const t = useT();
  if (tone === 'difference') return <WarnGlyph className="bank-trust__glyph bank-trust__glyph--warn" size={16} />;
  if (gaps.length > 0) {
    return <WarnGlyph className="bank-trust__glyph bank-trust__glyph--warn" size={16} aria-hidden={false} role="img" aria-label={t('bankInbox.trust.gapMark')} />;
  }
  if (tone === 'ok' || tone === 'pending') return <BalancedGlyph className="bank-trust__glyph bank-trust__glyph--ok" size={16} />;
  return <UnknownGlyph className="bank-trust__glyph" size={16} />;
}

/** One gap in the card: A36's own title, and the door to its repair. */
function GapLine({ gap }: { gap: StatementGapDto }) {
  const t = useT();
  const titleId = useId();
  return (
    <>
      <p id={titleId} className="bank-trust__hint bank-trust__gap">
        {gapTitle(t, gap)}
      </p>
      <Link to={gapRepairHref(gap)} className="btn btn--secondary btn--sm bank-trust__open" aria-describedby={titleId}>
        {t('attention.act.closeGap')}
      </Link>
    </>
  );
}

/** True when one account's card has anything to say. */
function hasDetails(v: TrustView, gaps: readonly StatementGapDto[]): boolean {
  const figures = v.tone !== 'unknown' && v.bank !== null && v.books !== null && v.difference !== null;
  return figures || v.tone === 'unknown' || v.openCount > 0 || v.statementDate !== null || gaps.length > 0;
}

/** One account's card content: the sentence, the identity, the explanation, the date, the gaps, the open lines. */
function TrustDetails({ balance, gaps, onShowOpen }: { balance: BankAccountBalance; gaps: readonly StatementGapDto[]; onShowOpen: () => void }) {
  const t = useT();
  const v = trustView(balance);
  const c = balance.currency;
  const m = (minor: number) => formatMoney(Math.abs(minor), c);
  const figures = v.tone !== 'unknown' && v.bank !== null && v.books !== null && v.difference !== null;
  return (
    <>
      <p className="bank-trust__card-title">{t(v.tone === 'difference' ? 'bankInbox.trust.difference' : v.tone === 'unknown' ? `bankInbox.trust.unknown.${balance.reason ?? 'inconsistent'}` : v.tone === 'ok' ? 'bankInbox.trust.ok' : 'bankInbox.trust.pending', { amount: m(v.difference ?? 0) })}</p>
      {figures && (
        <p className="bank-trust__figures t-num">
          <span className="bank-trust__term">{t('bankInbox.trust.bank')}</span>
          <span className="bank-trust__amount">{formatMoney(v.bank as number, c)}</span>
          <span className="bank-trust__op" aria-hidden="true">
            =
          </span>
          <span className="bank-trust__term">{t('bankInbox.trust.books')}</span>
          <span className="bank-trust__amount">{formatMoney(v.books as number, c)}</span>
          {v.openSum !== 0 && (
            <>
              <span className="bank-trust__op" aria-hidden="true">
                {v.openSum < 0 ? '−' : '+'}
              </span>
              <span className="bank-trust__term">{t('bankInbox.trust.openTerm')}</span>
              <span className="bank-trust__amount">{m(v.openSum)}</span>
            </>
          )}
          {v.difference !== 0 && (
            <>
              <span className="bank-trust__op bank-trust__op--warn" aria-hidden="true">
                {(v.difference as number) < 0 ? '−' : '+'}
              </span>
              <span className="bank-trust__term bank-trust__term--warn">{t('bankInbox.trust.differenceTerm')}</span>
              <span className="bank-trust__amount bank-trust__amount--warn">{m(v.difference as number)}</span>
            </>
          )}
          {/* The sentence a screen reader hears: the operators are glyphs above. */}
          <span className="visually-hidden">
            {t(v.difference === 0 ? 'bankInbox.trust.sentence' : 'bankInbox.trust.sentenceDifference', {
              bank: formatMoney(v.bank as number, c),
              books: formatMoney(v.books as number, c),
              open: formatMoney(v.openSum, c),
              difference: formatMoney(v.difference as number, c),
            })}
          </span>
        </p>
      )}
      {v.tone === 'difference' && <p className="bank-trust__hint">{t('bankInbox.trust.differenceHint')}</p>}
      {v.statementDate !== null && <p className="bank-trust__hint">{t('bankInbox.trust.asOf', { date: formatDate(v.statementDate) })}</p>}
      {gaps.map((g) => (
        <GapLine key={g.gapId} gap={g} />
      ))}
      {v.openCount > 0 && (
        <button type="button" className="btn btn--secondary btn--sm bank-trust__open" onClick={onShowOpen}>
          {plural(t, 'bankInbox.trust.openLines', v.openCount, { amount: formatMoney(v.openSum, c) })}
        </button>
      )}
    </>
  );
}

export interface TrustLineProps {
  balance: BankAccountBalance;
  /** Show the account's name: more than one account is in the book. */
  named: boolean;
  onShowOpen: () => void;
}

/** One account in view: its own line, as B2 drew it. */
export function TrustLine({ balance, named, onShowOpen }: TrustLineProps) {
  const t = useT();
  const v = trustView(balance);
  const gaps = useStatementGaps(statementKeyOf([balance])).get(balance.bankAccountId) ?? [];
  return (
    <section className="bank-trust" data-tone={v.tone} aria-label={t('bankInbox.trust.label', { name: balance.name })}>
      <p className="bank-trust__headline">
        <ToneGlyph tone={v.tone} gaps={gaps} />
        {named && <span className="bank-trust__account">{balance.name}</span>}
        <span className="bank-trust__words t-num">{headlineOf(t, balance, v)}</span>
      </p>
      {hasDetails(v, gaps) && (
        <InfoCard label={t('bankInbox.trust.cardLabel', { name: balance.name })}>
          <TrustDetails balance={balance} gaps={gaps} onShowOpen={onShowOpen} />
        </InfoCard>
      )}
    </section>
  );
}

export interface TrustSummaryProps {
  balances: readonly BankAccountBalance[];
  /** The open lines of one account, as its own line's card offered them. */
  onShowOpen: (bankAccountId: string) => void;
}

/** One account's row in the summary card: its name and figure, a disclosure for its own card content. */
function SummaryRow({ balance, gaps, onShowOpen }: { balance: BankAccountBalance; gaps: readonly StatementGapDto[]; onShowOpen: () => void }) {
  const t = useT();
  const v = trustView(balance);
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const words = headlineOf(t, balance, v);
  if (!hasDetails(v, gaps)) {
    return (
      <li className="bank-trust-sum__row" data-tone={v.tone}>
        <span className="bank-trust-sum__fact">
          <ToneGlyph tone={v.tone} />
          <span className="bank-trust__account">{balance.name}</span>
          <span className="bank-trust__words t-num">{words}</span>
        </span>
      </li>
    );
  }
  return (
    <li className="bank-trust-sum__row" data-tone={v.tone}>
      <button
        type="button"
        className="bank-trust-sum__fact bank-trust-sum__toggle"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={t('bankInbox.trust.summary.rowLabel', { name: balance.name, state: words })}
        onClick={() => setOpen((o) => !o)}
      >
        <ToneGlyph tone={v.tone} gaps={gaps} />
        <span className="bank-trust__account">{balance.name}</span>
        <span className="bank-trust__words t-num">{words}</span>
        <CaretGlyph className="bank-trust-sum__caret" size={16} />
      </button>
      <div id={detailsId} className="bank-trust-sum__details" hidden={!open}>
        <TrustDetails balance={balance} gaps={gaps} onShowOpen={onShowOpen} />
      </div>
    </li>
  );
}

/** Two or more accounts in view: ONE line for all of them, every account in its (i) card (D152). */
export function TrustSummary({ balances, onShowOpen }: TrustSummaryProps) {
  const t = useT();
  const views = balances.map((b) => ({ b, v: trustView(b) }));
  const gapsByAccount = useStatementGaps(statementKeyOf(balances));
  const gapsInView = balances.flatMap((b) => gapsByAccount.get(b.bankAccountId) ?? []);
  const differing = views.filter(({ v }) => v.tone === 'difference').length;
  const noStatement = views.filter(({ b, v }) => v.tone === 'unknown' && b.reason === 'no_statement').length;
  const unjudged = views.filter(({ b, v }) => v.tone === 'unknown' && b.reason !== 'no_statement').length;
  const parts = [
    ...(differing > 0 ? [plural(t, 'bankInbox.trust.summary.difference', differing)] : []),
    ...(noStatement > 0 ? [plural(t, 'bankInbox.trust.summary.noStatement', noStatement)] : []),
    ...(unjudged > 0 ? [plural(t, 'bankInbox.trust.summary.unjudged', unjudged)] : []),
  ];
  const tone: TrustView['tone'] = differing > 0 ? 'difference' : noStatement + unjudged > 0 ? 'unknown' : 'ok';
  const headline = parts.length === 0 ? t('bankInbox.trust.summary.allBalanced') : parts.join(' · ');
  return (
    <section className="bank-trust" data-tone={tone} aria-label={t('bankInbox.trust.summary.label')}>
      <p className="bank-trust__headline">
        <ToneGlyph tone={tone} gaps={gapsInView} />
        <span className="bank-trust__words t-num">{headline}</span>
      </p>
      <InfoCard label={t('bankInbox.trust.summary.cardLabel')} className="bank-trust-sum__info">
        <ul className="bank-trust-sum__list">
          {views.map(({ b }) => (
            <SummaryRow key={b.bankAccountId} balance={b} gaps={gapsByAccount.get(b.bankAccountId) ?? []} onShowOpen={() => onShowOpen(b.bankAccountId)} />
          ))}
        </ul>
      </InfoCard>
    </section>
  );
}
