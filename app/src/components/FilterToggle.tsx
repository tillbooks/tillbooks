/**
 * The list header's Filter icon with the count of what is on (D187, the Ruhig sweep; DESIGN.md "Lists").
 *
 * Facets nobody changes fold behind this one icon: it toggles the facet row open, and while any facet is
 * set it says how many beside the glyph, so a filtered list never looks like the whole list. The count
 * is part of the tooltip's context too, so a screen reader hears it with the name.
 *
 * Five surfaces hand-rolled this in the sweep (Contacts, OpenItems, Deals, Quotes, SalesOrders); this is
 * the one of them every list uses.
 */
import { IconButton } from './IconButton';

export interface FilterToggleProps {
  /** What the facets filter, in a few words ("Rolle, Art, Archivierte"): the tooltip's second line. */
  context: string;
  /** How many facets are set. Zero shows no count. */
  count: number;
  /** Whether the facet row is showing. */
  open: boolean;
  /** Called with the new open state. */
  onToggle: (open: boolean) => void;
}

export function FilterToggle({ context, count, open, onToggle }: FilterToggleProps) {
  return (
    <span className="filter-toggle">
      <IconButton icon="filter" context={count > 0 ? `${context} (${count})` : context} aria-expanded={open} onClick={() => onToggle(!open)} />
      {count > 0 && (
        <span className="filter-count t-num" aria-hidden="true">
          {count}
        </span>
      )}
    </span>
  );
}
