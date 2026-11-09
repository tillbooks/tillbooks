/**
 * F00's "Wartet auf dich" list (D90 D-2, extended 30.09.2026): the dashboard's top block names the
 * waiting work without becoming the work queue. The owner's ask: acts like "Unterschreibe den INI-Brief"
 * and "Schlüssel vergleichen" must not go unnoticed, so the block shows the total AND the leading rows
 * (at most `ATTENTION_TOP_LIMIT`), each a link straight to the surface that settles it, plus one link
 * into `/attention` for the rest. It is F00's composition of G15's verb: the engine ranks and words the
 * rows (urgency, then queue rank), the block only renders them.
 *
 * It is LIVE: it reads the shared store the rail count reads (`useAttentionSummary`), so the two never
 * disagree, and both refresh on the same cadence (a minute while visible, on focus, after a hub act).
 *
 * It carries its OWN loading, empty, denied and failed states, and never shows a fake zero: a denied
 * actor (`visibleQueues == 0`, `total: null`) renders nothing here (the padlock lives on the hub), a
 * failed read is a muted line with a retry, an all-clear (`total: 0`) is a quiet line.
 *
 * ONE LINE PER ITEM (B5 judge, D178): the row is the item's title; the engine's explanatory subtitle sits
 * behind the (i) beside it, so the block reads as a list and not as paragraphs. The Übersicht places
 * the block BELOW its title and key figures.
 *
 * ZERO ACCENT: the count is ink, the urgency is the shared Status glyph (its shape carries it, never
 * colour alone), and the only accent the block ever shows is the focus ring.
 */
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { ChevronRightGlyph } from '../../components/icons';
import { HelpHint } from '../../components/HelpHint';
import { Status, type StatusKind } from '../../components/Status';
import { announceAttentionChanged, useAttentionSummary, type AttentionTopItem, type AttentionUrgency } from '../Attention/attentionSummary';
import { itemSubtitle, itemTitle } from '../Attention/itemText';
import './AttentionStrip.css';

const URGENCY_KIND: Record<AttentionUrgency, StatusKind> = { overdue: 'warn', due: 'pending', open: 'neutral' };

function hrefOf(item: AttentionTopItem): string {
  const qs = new URLSearchParams(item.deepLink.params).toString();
  return qs === '' ? item.deepLink.route : `${item.deepLink.route}?${qs}`;
}

export function AttentionStrip() {
  const t = useT();
  const state = useAttentionSummary();

  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    // K-34 (D137): a placeholder in the strip's own measure, never a visible "wird geladen" sentence;
    // the sentence stays for screen readers only. Deliberately NOT a live region (`Skeleton` would
    // be one): the dashboard's own skeleton owns that, and two would make "the wall is loading"
    // ambiguous.
    return (
      <div className="att-strip att-strip--pending">
        <span className="skeleton att-strip-skeleton" aria-hidden="true" />
        <span className="visually-hidden">{t('dashboard.attentionStrip.loading')}</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="att-strip att-strip--muted">
        {t('dashboard.attentionStrip.error')}{' '}
        <button type="button" className="btn btn--ghost btn--sm" onClick={announceAttentionChanged}>
          {t('dashboard.attentionStrip.retry')}
        </button>
      </div>
    );
  }
  const { total, top } = state.data;
  // A denied actor is told nothing here (the hub's padlock is where that is explained).
  if (total === null) return null;
  if (total === 0) {
    return <div className="att-strip att-strip--muted">{t('dashboard.attentionStrip.allClear')}</div>;
  }
  const count = total > 99 ? '99+' : String(total);
  return (
    <section className="att-strip att-strip--list" aria-labelledby="att-strip-title">
      <div className="att-strip-head">
        <h2 id="att-strip-title" className="att-strip-count">
          {total === 1 ? t('dashboard.attentionStrip.countOne') : t('dashboard.attentionStrip.count', { count })}
        </h2>
        <Link to="/attention" className="att-strip-all">
          {t('dashboard.attentionStrip.all')}
          <ChevronRightGlyph className="att-strip-go" size={16} />
        </Link>
      </div>
      {top.length > 0 && (
        <ul className="att-strip-items">
          {top.map((item) => {
            const subtitle = itemSubtitle(t, item);
            const title = itemTitle(t, item);
            return (
              <li key={`${item.queueId}:${item.entityId}`} className="att-strip-row">
                <Link to={hrefOf(item)} className="att-strip-item">
                  <Status kind={URGENCY_KIND[item.urgency]} label={t(`attention.urgency.${item.urgency}`)} className="att-strip-urgency" />
                  <span className="att-strip-title">{title}</span>
                </Link>
                {subtitle !== null && subtitle !== '' ? (
                  <HelpHint label={t('dashboard.attentionStrip.more', { title })} title={title} body={subtitle} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
