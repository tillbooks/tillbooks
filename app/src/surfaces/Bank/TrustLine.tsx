/**
 * The balance line: does the bank equal the books, in three numbers (spec L4; the judge's outcome 3).
 *
 *   Bank CHF 48'210.35 = Buchhaltung CHF 47'000.00 + offene Zeilen CHF 1'210.35
 *
 * One line per Bankkonto, straight from the engine's summary: the latest statement's closing balance,
 * the ledger balance of the linked account at that date, and the lines still open up to it. Whatever
 * those do not explain is the difference, named in money and never hidden: an ignored line whose money
 * is not on the books, an entry no line backs, a difference accepted at a match, and a line matched to
 * an entry dated after the statement (until the next statement, C18) all show there. An account that
 * cannot be judged says so and why, with the action that makes it judgeable (import a statement). The
 * open lines filter the inbox.
 */
import { useT, formatDate, formatMoney } from '../../i18n';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import type { BankAccountBalance } from './model';
import { formatIban, trustView } from './model';
import { BalancedGlyph, UnknownGlyph, WarnGlyph } from './glyphs';
import { plural } from './lookups';

export interface TrustLineProps {
  balance: BankAccountBalance;
  /** Show the account's name: more than one account is in view. */
  named: boolean;
  onShowOpen: () => void;
  onImport: () => void;
  canImport: boolean;
}

export function TrustLine({ balance, named, onShowOpen, onImport, canImport }: TrustLineProps) {
  const t = useT();
  const v = trustView(balance);
  const c = balance.currency;
  const m = (minor: number) => formatMoney(Math.abs(minor), c);

  const headline =
    v.tone === 'ok'
      ? t('bankInbox.trust.ok')
      : v.tone === 'pending'
        ? t('bankInbox.trust.pending')
        : v.tone === 'difference'
          ? t('bankInbox.trust.difference', { amount: m(v.difference ?? 0) })
          : t(`bankInbox.trust.unknown.${balance.reason ?? 'inconsistent'}`);

  const menu: OverflowMenuItem[] = [];
  if (canImport) menu.push({ key: 'import', label: t('bankInbox.trust.menu.import'), onSelect: onImport });

  const figures = v.tone !== 'unknown' && v.bank !== null && v.books !== null && v.difference !== null;

  return (
    <section className="bank-trust" data-tone={v.tone} aria-label={t('bankInbox.trust.label', { name: balance.name })}>
      <div className="bank-trust__main">
        <p className="bank-trust__headline">
          {v.tone === 'ok' || v.tone === 'pending' ? (
            <BalancedGlyph className="bank-trust__glyph bank-trust__glyph--ok" size={18} />
          ) : v.tone === 'difference' ? (
            <WarnGlyph className="bank-trust__glyph bank-trust__glyph--warn" size={18} />
          ) : (
            <UnknownGlyph className="bank-trust__glyph" size={18} />
          )}
          {named && (
            <span className="bank-trust__account">
              {balance.name}
              <span className="bank-trust__iban t-num">{formatIban(balance.iban)}</span>
            </span>
          )}
          <span className="bank-trust__words">{headline}</span>
        </p>
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
        {(v.openCount > 0 || v.statementDate !== null) && (
          <p className="bank-trust__breakdown">
            {v.openCount > 0 && (
              <span className="bank-trust__bit">
                <button type="button" className="bank-trust__open" onClick={onShowOpen}>
                  {plural(t, 'bankInbox.trust.openLines', v.openCount, { amount: formatMoney(v.openSum, c) })}
                </button>
              </span>
            )}
            {v.statementDate !== null && (
              <span className="bank-trust__stand">
                {v.openCount > 0 && <span aria-hidden="true"> · </span>}
                {t('bankInbox.trust.asOf', { date: formatDate(v.statementDate) })}
              </span>
            )}
          </p>
        )}
      </div>
      <div className="bank-trust__actions">
        {v.tone === 'unknown' && canImport && (balance.reason === 'no_statement' || balance.reason === 'no_balance') && (
          <button type="button" className="btn btn--secondary bank-touch" onClick={onImport}>
            {t('bankInbox.import.open')}
          </button>
        )}
        {menu.length > 0 && <OverflowMenu quiet label={t('bankInbox.trust.menu.label', { name: balance.name })} items={menu} />}
      </div>
    </section>
  );
}
