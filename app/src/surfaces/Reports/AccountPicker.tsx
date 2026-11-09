/**
 * R-S6, the Kontoauswahl: a searchable list over `list_accounts` showing number and name, so the
 * account is chosen by SEEING it rather than by typing an id. Recognition over recall, and the id
 * never appears on screen at all.
 *
 * IT IS A SURFACE, SO IT OWNS ALL FIVE STATES, NOT TWO. An earlier draft of the design gave it only
 * the two interesting ones, which is how a picker ships as a blank div while its request is in
 * flight. `list_accounts` is a network read like any other and the canon does not exempt a popover:
 *
 *  - LOADING: skeleton rows at the picker's real row height, inside the open picker (R40).
 *  - ERROR: an inline error with a retry INSIDE the picker (R41). The Kontoblatt already on screen is
 *    left untouched: a failed account list is not a reason to blank a report that loaded fine.
 *  - EMPTY (search matched nothing): its own sentence and its own action (R42), distinct from
 *    anything that would claim the chart is empty.
 *  - SUCCESS: the list, archived accounts behind the "Archivierte anzeigen" toggle.
 *  - The chart being unseeded is NOT reachable here: `needs_chart` replaces the whole report body
 *    before this can open, so there is no sixth empty state pretending to be one.
 *
 * THE ARCHIVED QUESTION HAS ONE ANSWER IN THE PRODUCT, not two. An archived account still has a
 * Kontoblatt worth reading, because its history did not stop existing. So archived rows are hidden by
 * default behind a toggle, matching the shipped `BankAccounts` register rather than inventing a
 * second convention.
 *
 * A LIST OF BUTTONS, NOT A `<select>` AND NOT A `role="listbox"`. A native select cannot carry a
 * number and a name at different weights, cannot hold an "Archiviert" chip, and cannot be searched.
 * A `listbox`/`option` pair would be the APG shape for a value picker, but `option` does not admit
 * interactive children, so putting a real button inside each one is an axe `nested-interactive`
 * violation: the accessible shape here is a labelled list whose rows ARE the buttons, with
 * `aria-current` naming the chosen one.
 */
import { useMemo, useState } from 'react';

import { useT } from '../../i18n';
import { Skeleton } from '../../components/states';
import type { PickerAccount } from './model';

export interface AccountPickerProps {
  accounts: PickerAccount[] | null;
  loading: boolean;
  failed: boolean;
  selectedId: string | null;
  onPick: (accountId: string) => void;
  onRetry: () => void;
}

export function AccountPicker({
  accounts,
  loading,
  failed,
  selectedId,
  onPick,
  onRetry,
}: AccountPickerProps) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const visible = useMemo(() => {
    if (accounts === null) return [];
    const needle = search.trim().toLowerCase();
    return accounts.filter((account) => {
      if (account.archived && !showArchived) return false;
      if (needle === '') return true;
      return `${account.number} ${account.name}`.toLowerCase().includes(needle);
    });
  }, [accounts, search, showArchived]);

  return (
    <div className="rp-picker">
      <label className="rp-picker-search" htmlFor="rp-account-search">
        <span>{t('reports.picker.search')}</span>
        <input
          id="rp-account-search"
          className="field"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      <label className="rp-picker-toggle" htmlFor="rp-account-archived">
        <input
          id="rp-account-archived"
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        <span>{t('reports.picker.showArchived')}</span>
      </label>

      {loading ? (
        <div className="rp-picker-list">
          {/* Skeleton rows at the picker's real row height, never a blank popover and never a
              spinner in a list that already knows its shape (R40). */}
          <Skeleton rows={5} height={40} labelKey="reports.picker.loading" />
        </div>
      ) : failed ? (
        <div className="rp-picker-error">
          <p>{t('reports.error.accountList')}</p>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>
            {t('reports.error.transportRetry')}
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rp-picker-empty">
          <p>{t('reports.picker.noMatch')}</p>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSearch('')}>
            {t('reports.picker.clearSearch')}
          </button>
        </div>
      ) : (
        <ul className="rp-picker-list" aria-label={t('reports.picker.list')}>
          {visible.map((account) => (
            <li key={account.id}>
              <button
                type="button"
                className="rp-picker-option"
                aria-current={account.id === selectedId}
                onClick={() => onPick(account.id)}
              >
                <span className="rp-numeric-cell">{account.number}</span>
                <span>{account.name}</span>
                {account.archived && <span className="rp-chip">{t('reports.picker.archived')}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
