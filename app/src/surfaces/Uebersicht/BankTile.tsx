/**
 * D178 point 12: the bank action as a TILE in the key-figure grid (the default) or as an action CARD
 * above it (`overview.bank_action`). The third place, the slim bar, is the D142 `BankBand`.
 *
 * The owner's complaint was that the old link to the waiting lines read as plain text. Here the tile
 * states ONE figure ("24 offen") and the way to the lines is a real button that names the act
 * ("Bankzeilen buchen", the B5 judge's wording). With nothing open the tile is quiet: the figure
 * dimmed, a plain "Zur Bank", no colour anywhere.
 *
 * Every figure is the engine's `bank_inbox` tile (the same per-line definitions `/bank` filters by),
 * read from the one `dashboard_overview` answer the wall already holds; nothing is recounted here, and
 * no figure counts up (a bank figure is something you act on, DESIGN.md Motion levels).
 */
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import './BankTile.css';

export interface BankTileFigures {
  waiting: number;
  open: number;
  /** The engine's decorative glyph for the tile. */
  glyph: string;
}

/** The `bank_inbox` tile's two figures, or null when the shape is not one this tile can read. */
export function bankFigures(tile: unknown): BankTileFigures | null {
  if (tile === null || typeof tile !== 'object') return null;
  const t = tile as { ok?: unknown; waiting?: unknown; open?: unknown; glyph?: unknown };
  if (t.ok !== true || typeof t.waiting !== 'number' || typeof t.open !== 'number') return null;
  return { waiting: t.waiting, open: t.open, glyph: typeof t.glyph === 'string' ? t.glyph : '' };
}

export function BankTile({ figures, variant }: { figures: BankTileFigures; variant: 'tile' | 'card' }) {
  const t = useT();
  const { open } = figures;
  const busy = open > 0;
  const titleId = `uebersicht-bank-${variant}`;
  return (
    <section
      className={`uebersicht-bank uebersicht-bank--${variant}${busy ? ' is-waiting' : ''}`}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="uebersicht-bank__head">
        <span aria-hidden="true" className="uebersicht-glyph">
          {figures.glyph}
        </span>
        <span className="uebersicht-label">{t('dashboard.bank.title')}</span>
      </h2>
      <p className="uebersicht-bank__figure t-num">{t(open === 1 ? 'dashboard.bank.openOne' : 'dashboard.bank.open', { count: open })}</p>
      <Link to="/bank" className={busy ? 'btn btn--secondary uebersicht-bank__action' : 'btn btn--ghost uebersicht-bank__action'}>
        {busy ? t('dashboard.bank.book') : t('dashboard.bank.toBank')}
      </Link>
    </section>
  );
}
