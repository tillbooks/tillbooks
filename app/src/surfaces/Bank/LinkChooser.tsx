/**
 * "Mit bestehender Buchung abgleichen": the money is already on the books (booked by hand, or as the
 * payment of a bill), only the link to its bank line is missing (spec A39 §4.3 `existing_entry`; the
 * owner's "link to an entry that exists", walk B9). PICK, NEVER TYPE (the judge's outcome 6): the
 * candidates are the postings on this bank's ledger account within 30 days, read from the ledger
 * (`general_ledger`), the same amount first and nearest in date, searchable by text, date or amount.
 * A posting with another amount stays pickable, with the difference named, because a Skonto or a
 * rounding is real; the engine then records the difference (`acceptDifference`).
 */
import { useId, useMemo, useState } from 'react';

import { useT, formatDate, formatMoney } from '../../i18n';
import type { BankInboxLine, DraftTarget } from './model';
import { daysBetween, lineDate } from './model';
import type { Lookups } from './lookups';
import { useClaimedEntries, useLedgerLines } from './panelData';
import { plural } from './lookups';
import { SearchGlyph } from './glyphs';

export interface LinkChooserProps {
  workspaceId: string;
  line: BankInboxLine;
  lookups: Lookups;
  /** Entries other decided lines already hold (from the loaded inbox), shown as taken. */
  claimedEntryIds: ReadonlySet<string>;
  initial: string | null;
  busy: boolean;
  canPost: boolean;
  onMatch: (target: DraftTarget) => void;
  onCancel: () => void;
}

export function LinkChooser({ workspaceId, line, lookups, claimedEntryIds, initial, busy, canPost, onMatch, onCancel }: LinkChooserProps) {
  const t = useT();
  const baseId = useId();
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const { candidates, loading, failed } = useLedgerLines(workspaceId, line, bankLedger);
  // Which entries other lines of this Bankkonto already hold (the open tab carries no decisions).
  const held = useClaimedEntries(workspaceId, line.bankAccountId);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(initial);
  // An accepted difference states its reason (critic A39-12): the books keep why they differ.
  const [reason, setReason] = useState('');
  const date = lineDate(line) ?? '';

  const { same, other } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (c: (typeof candidates)[number]) =>
      q === '' ||
      `${c.description ?? ''} ${c.ref ?? ''} ${formatDate(c.date)} ${(Math.abs(c.signedMinor) / 100).toFixed(2)} ${formatMoney(Math.abs(c.signedMinor), line.currency)}`
        .toLowerCase()
        .includes(q);
    const byDistance = (a: (typeof candidates)[number], b: (typeof candidates)[number]) => daysBetween(a.date, date) - daysBetween(b.date, date);
    const visible = candidates.filter(hit).sort(byDistance);
    return {
      same: visible.filter((c) => c.signedMinor === line.amountMinor),
      other: visible.filter((c) => c.signedMinor !== line.amountMinor && Math.sign(c.signedMinor) === Math.sign(line.amountMinor)).slice(0, 12),
    };
  }, [candidates, query, line.amountMinor, line.currency, date]);

  const chosen = [...same, ...other].find((c) => c.entryId === picked) ?? null;
  const difference = chosen === null ? 0 : line.amountMinor - chosen.signedMinor;

  const renderCandidate = (c: (typeof candidates)[number]) => {
    const taken = claimedEntryIds.has(c.entryId) || held.has(c.entryId);
    const days = daysBetween(c.date, date);
    return (
      <li key={c.entryId}>
        <label className="bank-choice" data-checked={picked === c.entryId ? 'true' : 'false'} data-taken={taken ? 'true' : 'false'}>
          <input type="radio" name={`${baseId}-entry`} checked={picked === c.entryId} disabled={taken} onChange={() => setPicked(c.entryId)} />
          <span className="bank-choice__text">
            <span className="bank-choice__title">{c.description ?? t('bankInbox.target.entry')}</span>
            <span className="bank-choice__meta t-num">
              {formatDate(c.date)}
              {' · '}
              {days === 0 ? t('bankInbox.link.sameDay') : plural(t, 'bankInbox.link.daysApart', days, { days })}
              {taken ? ` · ${t('bankInbox.link.taken')}` : ''}
            </span>
          </span>
          <span className="bank-choice__amount t-num">{formatMoney(c.signedMinor, line.currency)}</span>
        </label>
      </li>
    );
  };

  return (
    <form
      className="bank-mode bank-link"
      aria-labelledby={`${baseId}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen === null || busy) return;
        const shown = { entryDate: chosen.date, ...(chosen.description !== null ? { entryText: chosen.description } : {}) };
        if (difference === 0) onMatch({ kind: 'existing_entry', entryId: chosen.entryId, acceptDifference: false, ...shown });
        else if (reason.trim() !== '') onMatch({ kind: 'existing_entry', entryId: chosen.entryId, acceptDifference: true, differenceReason: reason.trim(), ...shown });
      }}
    >
      <h3 id={`${baseId}-title`} className="bank-mode__title">
        {t('bankInbox.link.title')}
      </h3>
      <p className="bank-mode__lead">{t('bankInbox.link.lead')}</p>
      <label className="bank-search" htmlFor={`${baseId}-q`}>
        <SearchGlyph size={16} className="bank-search__glyph" />
        <span className="bank-search__label">{t('bankInbox.search.label')}</span>
        <input id={`${baseId}-q`} type="search" className="bank-search__input" placeholder={t('bankInbox.link.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {loading ? (
        <p className="bank-mode__note" role="status">
          {t('bankInbox.link.loading')}
        </p>
      ) : failed || bankLedger === null ? (
        <p className="bank-mode__note">{t('bankInbox.link.readFailed')}</p>
      ) : same.length === 0 && other.length === 0 ? (
        <p className="bank-mode__note">{t('bankInbox.link.none', { amount: formatMoney(Math.abs(line.amountMinor), line.currency) })}</p>
      ) : (
        <div className="bank-link__lists">
          {same.length > 0 && (
            <fieldset className="bank-fieldset">
              <legend className="bank-section-title">{t('bankInbox.link.sameAmount')}</legend>
              <ul className="bank-choices">{same.map(renderCandidate)}</ul>
            </fieldset>
          )}
          {other.length > 0 && (
            <fieldset className="bank-fieldset">
              <legend className="bank-section-title">{t('bankInbox.link.otherAmount')}</legend>
              <ul className="bank-choices">{other.map(renderCandidate)}</ul>
            </fieldset>
          )}
        </div>
      )}
      {chosen !== null && difference !== 0 && (
        <>
          <p className="bank-mode__warn">{t('bankInbox.link.difference', { amount: formatMoney(Math.abs(difference), line.currency) })}</p>
          <label className="bank-field" htmlFor={`${baseId}-reason`}>
            <span className="bank-field__label">{t('bankInbox.compare.differenceReason', { amount: formatMoney(Math.abs(difference), line.currency) })}</span>
            <textarea
              id={`${baseId}-reason`}
              className="field bank-textarea"
              rows={2}
              maxLength={500}
              value={reason}
              placeholder={t('bankInbox.compare.differenceReasonHint')}
              aria-invalid={reason.trim() === '' || undefined}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </>
      )}
      {chosen !== null && <p className="bank-mode__consequence">{t('bankInbox.link.consequence')}</p>}
      <div className="bank-mode__actions">
        <button type="submit" className="btn btn--secondary bank-touch bank-commit" disabled={chosen === null || busy || !canPost || (difference !== 0 && reason.trim() === '')}>
          {busy ? t('bankInbox.row.busy') : difference !== 0 ? t('bankInbox.link.matchWithDifference') : t('bankInbox.row.match')}
        </button>
        <button type="button" className="btn btn--ghost bank-touch" onClick={onCancel}>
          {t('bankInbox.panel.cancel')}
        </button>
      </div>
    </form>
  );
}
