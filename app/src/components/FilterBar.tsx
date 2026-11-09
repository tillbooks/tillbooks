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

import { useT } from '../i18n';
import { IconButton } from './IconButton';
import { OverflowMenu } from './OverflowMenu';
import { ChevronDownGlyph, VOCABULARY } from './icons';
import './FilterBar.css';

const AddGlyph = VOCABULARY.add.glyph;

/**
 * D187 (the owner's pick "Listen A"): a facet the list can be narrowed by. While it holds a value it
 * shows as a chip after the search (its option's words, a menu to change it, an x to remove it); while
 * it holds none it is offered under "+ Filter". So a filtered list always says how it is filtered, and
 * facets nobody uses take no room.
 */
export interface FilterFacet {
  /** Stable identity, the React key. */
  key: string;
  /** The facet's name ("Status"): the menu heading and the chip's accessible name. */
  label: string;
  /** The values, in display order. A switch-like facet ("Archivierte") has one. */
  options: readonly { value: string; label: string }[];
  /** The chosen value, or null while the facet is off. */
  value: string | null;
  /** Called with the new value, or null when the chip is removed. */
  onChange: (value: string | null) => void;
}

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
  /** D187: the facets, shown as removable chips while set and offered under "+ Filter" while not. */
  facets?: readonly FilterFacet[];
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
  facets,
}: FilterBarProps) {
  const anyFacet = (facets ?? []).some((f) => f.value !== null);
  const showClear = onClear !== undefined && (active ?? (searchValue.trim() !== '' || anyFacet));

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
      {facets !== undefined && facets.length > 0 && <FacetChips facets={facets} />}
      {children !== undefined && <div className="filter-bar-slot">{children}</div>}
      {showClear && (
        <button type="button" className="btn btn--ghost btn--sm filter-bar-clear" onClick={onClear}>
          {clearLabel}
        </button>
      )}
    </div>
  );
}

/**
 * The set facets as chips, then "+ Filter" for the rest (D187). Its own component so the words it needs
 * come from the i18n context only when a list has facets.
 */
function FacetChips({ facets }: { facets: readonly FilterFacet[] }) {
  const t = useT();
  const set = facets.filter((f) => f.value !== null);
  const unset = facets.filter((f) => f.value === null);
  return (
    <>
      {set.map((facet) => {
        const chosen = facet.options.find((o) => o.value === facet.value);
        return (
          <span key={facet.key} className="facet-chip">
            {facet.options.length > 1 ? (
              <OverflowMenu
                label={t('calm.filterChange', { facet: facet.label })}
                triggerLabel={
                  <>
                    {chosen?.label ?? facet.value}
                    <ChevronDownGlyph size={14} />
                  </>
                }
                triggerClassName="facet-chip-value"
                items={facet.options.map((o) => ({
                  key: o.value,
                  label: o.label,
                  checked: o.value === facet.value,
                  onSelect: () => facet.onChange(o.value),
                }))}
              />
            ) : (
              <span className="facet-chip-value">{chosen?.label ?? facet.label}</span>
            )}
            <IconButton
              icon="close"
              small
              name={t('calm.filterRemove')}
              context={facet.label}
              onClick={() => facet.onChange(null)}
            />
          </span>
        );
      })}
      {unset.length > 0 && (
        <OverflowMenu
          label={t('calm.filterAddLabel')}
          triggerLabel={
            <>
              <AddGlyph size={14} />
              {t('calm.filterAdd')}
            </>
          }
          triggerClassName="facet-chip-add"
          items={unset.flatMap((facet) =>
            facet.options.map((o) => ({
              key: `${facet.key}:${o.value}`,
              group: facet.options.length > 1 ? facet.label : undefined,
              label: o.label,
              onSelect: () => facet.onChange(o.value),
            })),
          )}
        />
      )}
    </>
  );
}
