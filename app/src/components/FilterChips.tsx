/**
 * FilterChips: toggle any number of facets on and off (K-11, D137).
 *
 * Status Offen / Bezahlt / Überfällig, a document type, a tag: a multi-select narrowing of the list
 * underneath, where several facets may hold at once and none is also fine. It replaces the
 * `.search-chip`, `.invalerts__chip` and the per-surface `aria-pressed` pill families.
 *
 * What it settles:
 *   - **Toggle buttons in a named group.** Each chip is a real `<button>` with `aria-pressed`, inside
 *     a `role="group"` named by `label`. A chip is a switch for one facet, so it is not a radio (more
 *     than one may hold) and not a tab (it narrows the list, it does not change the view).
 *   - **The pill tint when on.** A chosen facet is a selected item, one of the three things the accent
 *     is for: `--t-accent-soft` ground with accent ink, the same pill as the nav and the tabs. At rest
 *     it is a quiet hairline pill in dim ink.
 *   - **24px, round, with a 32px hit area.** The chip is small because a row of them sits in a filter
 *     bar; its target reaches the D116 dense band through an invisible extension, so it stays easy to
 *     hit without making the bar taller.
 *   - **An optional count** after the label, in tabular figures, for "how many rows this facet holds".
 *
 * Controlled: the caller owns `selected` and replaces it in `onChange`. The array handed back keeps
 * the chips' own order, so a URL built from it does not churn with the click order.
 */
import './FilterChips.css';

export interface FilterChip<V extends string = string> {
  /** The facet value reported in the selection; also the React key. */
  value: V;
  /** The visible label, already translated by the caller. */
  label: string;
  /** An optional number shown after the label, e.g. how many rows the facet holds. */
  count?: number;
}

export interface FilterChipsProps<V extends string = string> {
  /** The facets, in display order. */
  chips: readonly FilterChip<V>[];
  /** The facets currently on, owned by the caller. */
  selected: readonly V[];
  /** Called with the new selection, in the chips' display order. */
  onChange: (selected: V[]) => void;
  /** The group's accessible name ("Status"). */
  label: string;
  /** An extra class on the group, for layout only. */
  className?: string;
}

export function FilterChips<V extends string = string>({
  chips,
  selected,
  onChange,
  label,
  className,
}: FilterChipsProps<V>) {
  const on = new Set<V>(selected);

  const toggle = (value: V) => {
    const next = new Set(on);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(chips.map((chip) => chip.value).filter((v) => next.has(v)));
  };

  return (
    <div
      role="group"
      aria-label={label}
      className={className === undefined ? 'filter-chips' : `filter-chips ${className}`}
    >
      {chips.map((chip) => {
        const pressed = on.has(chip.value);
        return (
          <button
            key={chip.value}
            type="button"
            aria-pressed={pressed}
            className="filter-chip"
            onClick={() => toggle(chip.value)}
          >
            <span className="filter-chip-label">{chip.label}</span>
            {chip.count !== undefined && (
              <span className="filter-chip-count t-num">{chip.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
