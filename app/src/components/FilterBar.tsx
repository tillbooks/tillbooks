/**
 * FilterBar: the standard filter/search row above a DataTable (D118 B2).
 *
 * Every list surface hand-rolled this row with a different class and a different label idiom
 * (`contacts-controls`, `items-controls`, a submit-to-apply `journal-filters` form). This settles
 * the common case: a hand-rolled search input plus a slot for the surface's own select/segmented
 * filters, and one Clear affordance so a filtered-empty list is never a dead end.
 *
 * The search input stays hand-rolled and depends on nothing (D2/D3). An ANCHORED COMBOBOX filter (a
 * popup listbox that has to position against its trigger) is deliberately NOT built here: hand-rolling
 * one to the APG is 500+ lines, which is exactly the Base UI trigger the dependency law names (D1). A
 * surface that needs one drops it into the `children` slot; adopting Base UI for it is a separate,
 * triggered decision, not something this primitive pulls in.
 *
 * Controlled: the caller owns `searchValue` and the filter state behind `children`.
 */
import { type ReactNode } from 'react';

import './FilterBar.css';

export interface FilterBarProps {
  /** The search text, owned by the caller. */
  searchValue: string;
  /** Called on every keystroke in the search field. */
  onSearchChange: (value: string) => void;
  /**
   * The accessible label for the search field AND the search landmark. The field's visible label is
   * hidden (the placeholder and the magnifier carry the affordance), so this is what a screen reader
   * announces.
   */
  searchLabel: string;
  /** Placeholder copy for the search field. */
  searchPlaceholder?: string;
  /** The surface's own filters: selects, segmented toggles, checkboxes. Sits beside the search. */
  children?: ReactNode;
  /**
   * Clear every filter and the search. When given, a Clear control appears while a filter is active,
   * so a filtered-empty list always has a way back.
   */
  onClear?: () => void;
  /** The label for the Clear control. */
  clearLabel?: string;
  /**
   * Whether any filter is active, which drives the Clear control's visibility. When omitted, it is
   * derived from the search field alone (non-empty). Pass it when a select/segment can be active
   * while the search box is empty.
   */
  active?: boolean;
}

export function FilterBar({
  searchValue,
  onSearchChange,
  searchLabel,
  searchPlaceholder,
  children,
  onClear,
  clearLabel,
  active,
}: FilterBarProps) {
  const showClear = onClear !== undefined && (active ?? searchValue.trim() !== '');

  return (
    <div className="filter-bar" role="search" aria-label={searchLabel}>
      <label className="filter-bar-search">
        <span className="visually-hidden">{searchLabel}</span>
        <input
          type="search"
          className="field filter-bar-input"
          value={searchValue}
          placeholder={searchPlaceholder}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>
      {children !== undefined && <div className="filter-bar-slot">{children}</div>}
      {showClear && (
        <button type="button" className="btn btn--ghost btn--sm filter-bar-clear" onClick={onClear}>
          {clearLabel}
        </button>
      )}
    </div>
  );
}
