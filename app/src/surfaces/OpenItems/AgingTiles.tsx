/**
 * The aging chips: the bucket subtotals, and each one a filter (D-S1, INV-3).
 *
 * TILES BECAME CHIPS (D152, the owner's pick for this surface). Four 100px cards stood between the
 * header and the list, so 2 of 23 rows were visible at 1280x800. They are now the shared FilterChips
 * on one row, each chip carrying its bucket label AND its base-currency amount, so the breakdown is
 * still read at a glance and still ties to the header total. A chip filters the list to its bucket and
 * pressing it again clears the filter: the chip is its own way back, so there is no second "Alle
 * anzeigen" beside it (one action, one place). One bucket at a time, as the `?bucket=` URL always was.
 * A chip whose bucket holds no row is absent (it would filter to nothing), unless it is the one
 * filtered to, which stays so it can be released. The row count is not on the chip: the list under it
 * is the count.
 *
 * WHY TILES (NOW CHIPS) AND NOT THE BAR THE SPEC ASKS FOR. A bucket subtotal can be NEGATIVE: a parked Guthaben
 * carries a negative open and is filed into the first bucket, so a workspace holding CHF 2'000.00 of
 * fresh invoices and CHF 2'500.00 of customer credit has a first bucket of -500.00. A stacked bar has
 * no honest width for that, and every available treatment is a lie (clamp, absolute value, or a
 * negative width). Tiles survived it with no special case, and the chips that replaced them still do:
 * a chip prints "CHF -500.00" like any other figure, holds the German label at full length, and is a
 * filter. Owner decision B1.
 *
 * THE FIGURE IS THE BASE-CURRENCY ONE, ALWAYS. `bucketTotals` sums FACE amounts, so in a workspace
 * holding francs and euros it is a number with no unit, and prefixing it `CHF` would fabricate a
 * figure on the one surface that spends a whole section policing exactly that. `baseBucketTotals`
 * (finding F11, landed) is the breakdown that ties to the header total, and it ties in every
 * workspace rather than only in single-currency ones.
 *
 * THE COUNT IS DERIVED, NEVER FOUR. `boundariesDays` yields `length + 1` buckets, so a workspace
 * configuring [15, 30] gets three chips and one configuring [30, 60, 90, 120] gets five. The row
 * wraps, and the popover caps the boundary list at five so the group tops out at six chips.
 */
import { useT, formatMoney } from '../../i18n';
import { FilterChips, type FilterChip } from '../../components/FilterChips';
import { bucketKeysFor, bucketLabel, type OpenItem } from './model';

export interface AgingTilesProps {
  boundaries: readonly number[];
  /** Base-currency subtotals per bucket key, as the engine reduces them. */
  baseBucketTotals: Record<string, number>;
  baseCurrency: string;
  /** The rows in view, to leave out a bucket that holds none. */
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
  const chips: FilterChip[] = bucketKeysFor(boundaries).flatMap((key, index) => {
    if (key !== selected && !items.some((item) => item.bucket === key)) return [];
    const label = bucketLabel(boundaries, index);
    return [
      {
        value: key,
        label: t('openItems.tiles.chip', {
          bucket: t(label.key, label.params),
          amount: formatMoney(baseBucketTotals[key] ?? 0, baseCurrency),
        }),
      },
    ];
  });

  return (
    <FilterChips
      className="oi-chips"
      label={t('openItems.tiles.label')}
      chips={chips}
      selected={selected === null ? [] : [selected]}
      // One bucket at a time: the chip just pressed wins, and releasing the pressed one clears.
      onChange={(next) => onSelect(next.find((value) => value !== selected) ?? null)}
    />
  );
}
