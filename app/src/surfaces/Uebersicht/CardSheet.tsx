/**
 * D204 rule 2 (owner, 15.11.2026): "I don't want to open a separate page where I can check boxes to bring
 * back KPIs ... displayed as a sheet ... with live preview, so I can click around and see exactly which
 * KPIs will be displayed."
 *
 * The card sheet: a side sheet over the LIVE Übersicht. Every item the page can show (the suggestions, the
 * key figures, the bank item, the cards) is one row: a small preview glyph, its name and a switch. A
 * switch shows or hides the item on the page behind at once (the page plays Arrive and leave), and the
 * change is saved as it is made through the person's preferences: there is no Speichern. A live search on
 * top filters the rows as you type, with a filtered-empty state and "Filter zurücksetzen" (D204, Find it,
 * then act).
 *
 * It is NOT modal: the page stays visible and live beside it, nothing is dimmed and the focus is not
 * trapped. It takes the focus when it opens (the search), gives it back to its opener when it closes,
 * and Escape closes it.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../../i18n';
import { IconButton } from '../../components/IconButton';
import { VOCABULARY } from '../../components/icons';

const SearchGlyph = VOCABULARY.search.glyph;

export interface CardSheetRow {
  id: string;
  name: string;
  /** The preview glyph: the key figure's own mark, or the card's. */
  glyph: string;
  on: boolean;
  /** The heading the row sits under. */
  group: string;
}

export interface CardSheetProps {
  rows: readonly CardSheetRow[];
  onToggle: (id: string) => void;
  onClose: () => void;
}

/** Lower case, accents folded, so "ubersicht" finds "Übersicht". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function CardSheet({ rows, onToggle, onClose }: CardSheetProps) {
  const t = useT();
  const titleId = useId();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Take the focus on open; give it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => {
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, []);

  const shown = useMemo(() => {
    const q = fold(query.trim());
    return q === '' ? rows : rows.filter((row) => fold(row.name).includes(q));
  }, [rows, query]);

  const groups = useMemo(() => {
    const out: { name: string; rows: CardSheetRow[] }[] = [];
    for (const row of shown) {
      const at = out.find((g) => g.name === row.group);
      if (at === undefined) out.push({ name: row.group, rows: [row] });
      else at.rows.push(row);
    }
    return out;
  }, [shown]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (query !== '') setQuery('');
    else onClose();
  };

  return (
    <div className="uebersicht-sheet panel motion-reveal--right" role="dialog" aria-modal="false" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="uebersicht-sheet__head">
        <h2 id={titleId} className="uebersicht-sheet__title">
          {t('dashboard.sheet.title')}
        </h2>
        <IconButton icon="close" small context={t('dashboard.sheet.close')} onClick={onClose} />
      </div>
      <div className="uebersicht-sheet__search">
        <SearchGlyph size={16} className="uebersicht-sheet__search-glyph" />
        <label htmlFor={searchId} className="visually-hidden">
          {t('dashboard.sheet.search')}
        </label>
        <input
          id={searchId}
          ref={searchRef}
          type="search"
          className="field"
          placeholder={t('dashboard.sheet.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="uebersicht-sheet__body">
        {groups.length === 0 ? (
          <div className="uebersicht-sheet__empty">
            <p>{t('dashboard.sheet.none')}</p>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setQuery('')}>
              {t('dashboard.sheet.reset')}
            </button>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.name} className="uebersicht-sheet__group" aria-label={g.name}>
              <h3 className="uebersicht-sheet__group-name">{g.name}</h3>
              <ul className="uebersicht-sheet__rows">
                {g.rows.map((row) => (
                  <li key={row.id}>
                    <button type="button" role="switch" aria-checked={row.on} className="uebersicht-sheet__row" data-sheet-row={row.id} onClick={() => onToggle(row.id)}>
                      <span className="uebersicht-sheet__glyph" aria-hidden="true">
                        {row.glyph}
                      </span>
                      <span className="uebersicht-sheet__name">{row.name}</span>
                      <span className="uebersicht-sheet__track" aria-hidden="true">
                        <span className="uebersicht-sheet__thumb" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
