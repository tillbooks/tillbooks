/**
 * The aging tiles: the bucket subtotals, and each one a filter (D-S1, INV-3).
 *
 * WHY TILES AND NOT THE BAR THE SPEC ASKS FOR. A bucket subtotal can be NEGATIVE: a parked Guthaben
 * carries a negative open and is filed into the first bucket, so a workspace holding CHF 2'000.00 of
 * fresh invoices and CHF 2'500.00 of customer credit has a first bucket of -500.00. A stacked bar has
 * no honest width for that, and every available treatment is a lie (clamp, absolute value, or a
 * negative width). Tiles survive it with no special case, carry a row COUNT as well as an amount,
 * hold the German labels at full length, and are each a filter. Owner decision B1.
 *
 * THE FIGURE IS THE BASE-CURRENCY ONE, ALWAYS. `bucketTotals` sums FACE amounts, so in a workspace
 * holding francs and euros it is a number with no unit, and prefixing it `CHF` would fabricate a
 * figure on the one surface that spends a whole section policing exactly that. `baseBucketTotals`
 * (finding F11, landed) is the breakdown that ties to the header total, and it ties in every
 * workspace rather than only in single-currency ones.
 *
 * THE COUNT IS DERIVED, NEVER FOUR. `boundariesDays` yields `length + 1` buckets, so a workspace
 * configuring [15, 30] gets three tiles and one configuring [30, 60, 90, 120] gets five. The row is a
 * wrapping grid, and the popover caps the boundary list at five so the group tops out at seven
 * choices including "Alle anzeigen".
 */
import { useT, formatMoney } from '../../i18n';
import { bucketKeysFor, bucketLabel, type OpenItem } from './model';

export interface AgingTilesProps {
  boundaries: readonly number[];
  /** Base-currency subtotals per bucket key, as the engine reduces them. */
  baseBucketTotals: Record<string, number>;
  baseCurrency: string;
  /** The rows in view, for the per-tile count. Counts are unit-free and therefore always true. */
  items: readonly OpenItem[];
  /** The bucket currently filtered to, or null for all of them. */
  selected: string | null;
  onSelect: (bucket: string | null) => void;
}

export function AgingTiles({
  boundaries,
  baseBucketTotals,
  baseCurrency,
  items,
  selected,
  onSelect,
}: AgingTilesProps) {
  const t = useT();
  const keys = bucketKeysFor(boundaries);

  return (
    <div className="oi-tiles" role="group" aria-label={t('openItems.tiles.label')}>
      {keys.map((key, index) => {
        const label = bucketLabel(boundaries, index);
        const count = items.filter((item) => item.bucket === key).length;
        const on = selected === key;
        return (
          <button
            key={key}
            type="button"
            className={`oi-tile${on ? ' oi-tile--on' : ''}`}
            aria-pressed={on}
            onClick={() => onSelect(on ? null : key)}
          >
            <span className="oi-tile-label">{t(label.key, label.params)}</span>
            <span className="oi-tile-amount t-money">{formatMoney(baseBucketTotals[key] ?? 0, baseCurrency)}</span>
            <span className="oi-tile-count">{t('openItems.bucket.count', { n: count })}</span>
          </button>
        );
      })}
      {selected !== null && (
        <button type="button" className="btn btn--ghost btn--sm oi-tile-reset" onClick={() => onSelect(null)}>
          {t('openItems.showAll')}
        </button>
      )}
    </div>
  );
}
