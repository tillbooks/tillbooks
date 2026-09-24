/**
 * DataTable: the one ledger/list table for the Studio (D118 B2), so sixty surfaces stop hand-rolling
 * a `<table>` and its overflow, sticky header, density and five states, and the per-surface CSS that
 * duplicates all of it can be deleted as each surface adopts this.
 *
 * What it settles, each because a surface got it differently:
 *
 *   - **A table frame owns the horizontal overflow.** The `<table>` lives inside a frame that
 *     scrolls sideways (thin, tokenised, gutter reserved), so a wide ledger never shoves the page
 *     body sideways. Journal rendered its table with no frame at all; this makes the frame the rule.
 *     A frame that overflows SAYS so (K-19, D137): its scrollbar is always drawn and a soft edge sits
 *     on each side that has more to show, because a cut-off column that looks like the table's end is
 *     not scrolling.
 *   - **The header sticks.** `thead th` is `position: sticky`, so the column labels stay while a long
 *     ledger scrolls under them.
 *   - **The row is a number, not its content** (K-20). Every row is `--t-row-h` (36px Komfortabel,
 *     32px Kompakt) with `--t-cell-pad-x` sides, the head strip `--t-row-head-h`, and a cell that holds
 *     a control drops its vertical padding so the control never grows the row. Numeric type reads
 *     `--t-font-table`, all keyed off the root `data-density`.
 *   - **Money right-aligns with tabular figures and never wraps** (K-18). A `numeric` column aligns to
 *     the end, carries the shared `.t-num` class, and holds its value, sign and currency on one line.
 *     Text left-aligns. Nothing centres, per the design law.
 *   - **Heads are quiet** (K-23): 12px, weight 500, dim ink, sentence case, right-aligned over money.
 *   - **Selection is the pill on every cell** (K-24): `--t-accent-soft` on each cell of a selected or
 *     current row and the accent ink on its leading cell. No side bar, no ring, no hole.
 *   - **One opener and one overflow per row** (K-21). `rowHref` makes the leading cell a real link
 *     and the whole row its click target; `onRowClick` keeps the row itself as the control (a drawer
 *     opener). `rowActions` puts every other verb behind ONE trailing overflow, destructive last.
 *   - **All five states live here.** loading, empty, error and the data itself; permission-denied is
 *     the caller's (it hides the surface, not the table). The loading state is the table's own shape
 *     (K-34): the head strip and the rows at the height they will take, invisible for the first 200ms
 *     and, once shown, kept at least 300ms.
 *
 * Sorting is optional and CONTROLLED: pass `sort` and `onSortChange` and the sortable headers become
 * buttons that report `aria-sort`.
 *
 * The identifying column is the ROW HEADER: its body cell is a `<th scope="row">`, so a screen reader
 * announces the row's own value (the invoice number, the contact name) alongside each column header
 * rather than the column name alone. It defaults to the first identifying column; a column opts in or
 * out explicitly with `rowHeader` (see `DataTableColumn.rowHeader`).
 */
import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';

import { EmptyState } from './states/EmptyState';
import { ErrorBanner } from './states/ErrorBanner';
import { useRevealAfterDelay, useSkeletonHold } from './states/useSkeletonTiming';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';
import { SortNeutralGlyph, SortUpGlyph, SortDownGlyph, ChevronRightGlyph } from './icons';
import { useT } from '../i18n';
import type { Err } from '../lib/client';
import './DataTable.css';

/** Where a column's content sits. No `center`: text left-aligns, money right-aligns (design law). */
export type ColumnAlign = 'start' | 'end';

export interface DataTableColumn<Row> {
  /** Stable identifier, used as the React key, the sort key and `aria-sort`'s column. */
  key: string;
  /** The column label, already humanized and translated by the caller. */
  header: string;
  /** The cell content for a row. */
  render: (row: Row) => ReactNode;
  /**
   * Money or number column: aligns to the end and carries the shared `.t-num` tabular, density-aware
   * class, and never wraps (K-18). Overrides `align` to `'end'` unless `align` is given explicitly.
   */
  numeric?: boolean;
  /** Explicit alignment; defaults to `'end'` for a numeric column, `'start'` otherwise. */
  align?: ColumnAlign;
  /** Make the header a sort control. Requires `sort`/`onSortChange` to do anything. */
  sortable?: boolean;
  /** Hide the header text visually (still read by assistive tech), for an actions column. */
  headerHidden?: boolean;
  /**
   * Make this column the ROW HEADER: its body cell renders as `<th scope="row">` instead of `<td>`,
   * so a screen reader announces the row's identifying value (the invoice number, the contact name)
   * alongside each column header, not just the column name. Exactly one column is the row header per
   * table. When no column opts in with `true`, the first identifying column (the first that is not
   * `numeric` and not `headerHidden`) is used by default; pass `false` on that column to suppress the
   * default without moving it elsewhere.
   */
  rowHeader?: boolean;
  /** An optional fixed column width (any CSS length). */
  width?: string;
}

/** The current sort, owned by the caller. */
export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

/**
 * One cell of the optional totals row, addressed by the COLUMN key it sits under. It inherits that
 * column's alignment and its `.t-num` tabular class, so a column total lands under its column the
 * same way the data does: a sum in the `amount` column right-aligns with tabular figures, a label
 * in the leading text column left-aligns. A column with no footer cell renders an empty foot cell.
 */
export interface DataTableFooterCell {
  /** The key of the column this cell sits under; it inherits that column's alignment and numeric. */
  key: string;
  /** The cell content, e.g. a formatted column total or a `Total` label. */
  content: ReactNode;
}

/**
 * A group of rows under a spanning header, for the optional grouped/tree mode. A caller passes
 * `groups` INSTEAD of the flat `rows`: the two are mutually exclusive, and when both are given the
 * grouped model wins. A tree (chart of accounts, project phases) is flattened into an ordered list
 * of groups, each carrying its `depth` for indentation, so the render stays a flat table body.
 */
export interface DataTableGroup<Row> {
  /** Stable identifier: the React key, and the key the collapse state is tracked by. */
  key: string;
  /** The group header content, spanning every column in one `<td>`. Already localized. */
  header: ReactNode;
  /** The rows in this group. May be empty (an empty group still shows its header). */
  rows: Row[];
  /** Nesting depth for a tree, 0 at the top. Indents the header and its rows. Defaults to 0. */
  depth?: number;
}

/**
 * Checkbox selection (K-14, K-24): a leading column of real checkboxes, each in a `.check-cell`
 * label so the target is the dense-band size while the box stays native. A selected row wears the
 * selection pill on every cell. The caller owns the selected set.
 */
export interface DataTableSelection<Row> {
  /** Whether the row is selected. Drives its checkbox and its selected treatment. */
  isSelected: (row: Row) => boolean;
  /** Toggle one row. */
  onToggle: (row: Row) => void;
  /** The row checkbox's accessible name, e.g. "Rechnung RE-001 auswählen". */
  label: (row: Row) => string;
  /** A row that cannot be selected right now (blocked, already batched): its checkbox is disabled. */
  isDisabled?: (row: Row) => boolean;
  /**
   * The header cell's name: the select-all checkbox's label when `onToggleAll` is given, else the
   * column's visually hidden header text. Required, because a checkbox column needs a name.
   */
  allLabel: string;
  /**
   * Select or clear every selectable row. Given, the header holds a select-all checkbox that reads
   * checked when all are selected and mixed when some are.
   */
  onToggleAll?: (next: boolean) => void;
}

export interface DataTableProps<Row> {
  /** The columns, left to right. */
  columns: DataTableColumn<Row>[];
  /**
   * The rows to render in the flat model. Empty (with `loading` false and no `error`) shows the
   * empty state. Ignored when `groups` is given (the grouped model is used instead). Optional so a
   * grouped caller can omit it; a flat caller passes it exactly as before.
   */
  rows?: Row[];
  /**
   * The optional grouped/tree model: a list of groups, each a spanning header over its own rows.
   * Pass this INSTEAD of `rows`. When present it drives the body and `rows` is ignored. Absent, the
   * flat `rows` path is used unchanged.
   */
  groups?: DataTableGroup<Row>[];
  /**
   * Make each group header a WCAG disclosure (a button reporting `aria-expanded`) that collapses and
   * expands its rows. Only meaningful with `groups`. Collapse state is held internally; seed the
   * initially-collapsed groups with `defaultCollapsedGroups`.
   */
  collapsibleGroups?: boolean;
  /** Group keys collapsed on first render (uncontrolled). Ignored unless `collapsibleGroups`. */
  defaultCollapsedGroups?: string[];
  /** A stable key per row. */
  rowKey: (row: Row) => string;
  /**
   * A visually-hidden `<caption>` naming the table for assistive tech. Recommended: a bare grid of
   * numbers with no name is hard to place by screen reader.
   */
  caption?: string;
  /** The read is in flight: render the table's own loading shape. The caller owns the read. */
  loading?: boolean;
  /** The read failed: render the shared error banner with an optional retry. */
  error?: Err;
  /** Retry handler for the error state. */
  onRetry?: () => void;
  /**
   * What to show when there are no rows. A ReactNode for full control, or omit for the shared
   * `EmptyState` with its default copy. Not shown while loading or on error.
   */
  emptyState?: ReactNode;
  /** The current sort. Pass with `onSortChange` to enable sortable headers. */
  sort?: SortState | null;
  /** Called when a sortable header is activated. Toggles direction on the active column. */
  onSortChange?: (next: SortState) => void;
  /**
   * Open a row in place (a DetailDrawer). The row itself becomes the control: focusable, named by
   * `rowLabel`, opened by click, Enter and Space. For a row that opens another ROUTE, use `rowHref`.
   */
  onRowClick?: (row: Row) => void;
  /** The accessible name for a clickable row. Required in spirit whenever `onRowClick` is set. */
  rowLabel?: (row: Row) => string;
  /**
   * The route a row opens (K-21). The leading cell's content becomes a real link (the Tab stop, in
   * the text ink at weight 500), and a click anywhere else on the row follows it. Takes precedence
   * over `onRowClick` on the same row. Return undefined for a row that opens nothing.
   */
  rowHref?: (row: Row) => string | undefined;
  /**
   * The one row the view is currently showing (a master/detail pane, a focused period). It wears the
   * selection pill and reports `aria-current`. At most one row should answer true.
   */
  isRowCurrent?: (row: Row) => boolean;
  /** Checkbox selection: a leading checkbox column and the selection pill (K-14, K-24). */
  selection?: DataTableSelection<Row>;
  /**
   * Every verb a row offers besides opening it (K-21), behind ONE trailing overflow. Destructive
   * items (`danger`) are moved last, below a separator. An empty list renders no trigger.
   */
  rowActions?: (row: Row) => OverflowMenuItem[];
  /** The overflow trigger's accessible name per row, e.g. "Aktionen für RE-001". Required with `rowActions`. */
  rowActionsLabel?: (row: Row) => string;
  /**
   * A per-row class hook for row-level state (overdue, matched/unmatched). Its return is JOINED with
   * the base row class, never replaces it; a falsy return adds nothing. The consumer owns the class
   * and its `--t-*` state styles. Selection is NOT a class: use `selection` or `isRowCurrent`, which
   * paint the one selection treatment.
   * Example: `rowClassName={(r) => (r.overdue ? 'ledger-row--overdue' : undefined)}`.
   */
  rowClassName?: (row: Row, index: number) => string | undefined;
  /** Number of placeholder rows to show while the read is in flight. */
  skeletonRows?: number;
  /**
   * An optional totals row rendered in a real `<tfoot>`, one cell per column, each addressed by the
   * column key so it inherits that column's alignment and tabular class (see `DataTableFooterCell`).
   * Ledger tables (Journal, OpenItems, Reports, Fx) use it for a column-total row. When omitted, no
   * `<tfoot>` is rendered, so existing tables are unchanged.
   */
  footer?: DataTableFooterCell[];
}

function alignOf<Row>(column: DataTableColumn<Row>): ColumnAlign {
  return column.align ?? (column.numeric ? 'end' : 'start');
}

/**
 * The key of the column that owns the row header, or undefined when none qualifies. A column that
 * opts in with `rowHeader: true` wins; otherwise the first identifying column (not `numeric`, not
 * `headerHidden`, not explicitly opted out with `rowHeader: false`) is the default. A table of only
 * numbers or hidden columns gets no row header rather than a forced one on an unidentifying cell.
 */
function rowHeaderKeyOf<Row>(columns: DataTableColumn<Row>[]): string | undefined {
  const explicit = columns.find((column) => column.rowHeader === true);
  if (explicit !== undefined) return explicit.key;
  const auto = columns.find(
    (column) => column.rowHeader !== false && !column.numeric && !column.headerHidden,
  );
  return auto?.key;
}

/** The next sort when a header is activated: flip direction on the active column, else ascending. */
function nextSort(current: SortState | null | undefined, key: string): SortState {
  if (current != null && current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: 'asc' };
}

/** Destructive verbs last, in their given order, so the separator falls between the two piles. */
function dangerLast(items: OverflowMenuItem[]): OverflowMenuItem[] {
  return [...items.filter((item) => item.danger !== true), ...items.filter((item) => item.danger === true)];
}

/** Interactive elements that own their own click: a row click that lands on one is theirs. */
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="button"], [role="menu"], [role="menuitem"], [contenteditable="true"]';

/** The checkbox and overflow cells own their clicks: a press there never also opens the row. */
function stopRowClick(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation();
}

/** Set or clear a boolean data attribute without a React render (scroll-rate updates). */
function flag(node: HTMLElement, name: string, on: boolean): void {
  if (on) node.setAttribute(name, '');
  else node.removeAttribute(name);
}

export function DataTable<Row>({
  columns,
  rows = [],
  groups,
  collapsibleGroups = false,
  defaultCollapsedGroups,
  rowKey,
  caption,
  loading = false,
  error,
  onRetry,
  emptyState,
  sort,
  onSortChange,
  onRowClick,
  rowLabel,
  rowHref,
  isRowCurrent,
  selection,
  rowActions,
  rowActionsLabel,
  rowClassName,
  skeletonRows = 5,
  footer,
}: DataTableProps<Row>) {
  // Collapse state for the grouped disclosure is held here, not by the caller: it is presentational
  // and every consumer wanted the same behaviour. Seeded once from `defaultCollapsedGroups`.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(defaultCollapsedGroups ?? []),
  );
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // K-34: the placeholder stays up at least 300ms once it has shown, so a read that lands at 210ms
  // does not flicker the table in and out. A read inside the 200ms delay is never held.
  const showSkeleton = useSkeletonHold(loading);

  // F-04 (friction ledger, Phase 2): does the table actually overflow its frame sideways? The frame
  // becomes a horizontal scroll container ONLY when it does. A frame that is a scroll container is
  // also the nearest scrolling ancestor of the sticky `thead th`, so the header then resolves its
  // `top` against the frame instead of <main>: `top: var(--surface-header-height)` pushed the column
  // labels DOWN onto the first data row on every list surface (the Phase 1 critic measured the
  // displacement equal to the header height, to the pixel, on four surfaces). With the frame left
  // `overflow: visible` while the table fits, <main> is the one scrollport for the page header and
  // the column labels alike, and the offset is exact. Measured with a layout effect (before paint,
  // so there is no flash) and kept current by a ResizeObserver on the frame and the table. In jsdom
  // both widths are 0, which reads as "fits" (the common case) and the tests assert that reading.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const columnCount = columns.length;
  const rowCount = groups !== undefined ? groups.reduce((n, g) => n + g.rows.length, 0) : rows.length;

  // K-19: which sides still hide content. Updated on every scroll, so it writes attributes directly
  // rather than re-rendering a ledger per scroll event.
  const updateEdges = useCallback(() => {
    const frame = frameRef.current;
    const wrap = wrapRef.current;
    if (frame === null || wrap === null) return;
    const max = frame.scrollWidth - frame.clientWidth;
    flag(wrap, 'data-more-start', max > 1 && frame.scrollLeft > 1);
    flag(wrap, 'data-more-end', max > 1 && max - frame.scrollLeft > 1);
  }, []);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const measure = (): void => {
      setOverflows(frame.scrollWidth > frame.clientWidth);
      updateEdges();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    const table = frame.firstElementChild;
    if (table !== null) observer.observe(table);
    return () => observer.disconnect();
  }, [columnCount, rowCount, showSkeleton, error, updateEdges]);

  // Loading and error take the whole area: a header over an error would be a lie about what is on
  // screen. The loading shape is the table's own (head strip plus rows at their real height).
  if (showSkeleton) return <DataTableSkeleton rows={skeletonRows} />;
  // A table's error is always its read: the read title and sentence, never "check your input".
  if (error !== undefined) return <ErrorBanner error={error} onRetry={onRetry} context="read" />;
  // Empty is "nothing to lay out": no groups in the grouped model, or no rows in the flat one. An
  // empty group array reads as empty; a group carrying a header but no rows is the caller's choice
  // to show, so it is NOT treated as empty.
  const isEmpty = groups !== undefined ? groups.length === 0 : rows.length === 0;
  if (isEmpty) return <>{emptyState ?? <EmptyState />}</>;

  // The column whose body cell is the row header (`<th scope="row">`), computed once for the table so
  // the flat and grouped bodies agree. Undefined when no column qualifies (see `rowHeaderKeyOf`).
  const rowHeaderKey = rowHeaderKeyOf(columns);
  // The LEADING cell: the row header, else the first column. It carries the opener (K-21) and the
  // selection's accent ink (K-24).
  // A money column is never the opener: a figure must not turn into a link or take the accent ink
  // (C1 critic note). An all-numeric table therefore has no leading cell.
  const leadKey = rowHeaderKey ?? columns.find((column) => !column.numeric)?.key;
  const hasActions = rowActions !== undefined;
  const spanCount = columns.length + (selection !== undefined ? 1 : 0) + (hasActions ? 1 : 0);

  // Every row, flat, for the select-all state.
  const allRows = groups !== undefined ? groups.flatMap((group) => group.rows) : rows;
  const selectable = selection !== undefined
    ? allRows.filter((row) => selection.isDisabled?.(row) !== true)
    : [];
  const selectedCount = selection !== undefined ? selectable.filter((row) => selection.isSelected(row)).length : 0;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  const someSelected = selectedCount > 0 && !allSelected;

  // One row renderer, shared by the flat and grouped bodies so they never drift. `index` is the
  // global row index (across groups), so `rowClassName`'s index contract is the same in both modes.
  // `depth` indents the first cell for a tree; 0 in the flat model.
  const renderRow = (row: Row, index: number, depth: number) => {
    const href = rowHref?.(row);
    const opensRoute = href !== undefined;
    const clickable = opensRoute || onRowClick !== undefined;
    // The row itself is the control only for an in-place opener; a route opener's control is its link.
    const rowIsControl = !opensRoute && onRowClick !== undefined;
    const current = isRowCurrent?.(row) === true;
    const selected = current || selection?.isSelected(row) === true;
    const extra = rowClassName?.(row, index);
    const className = [
      'data-table-row',
      clickable ? 'data-table-row--clickable' : undefined,
      extra || undefined,
    ]
      .filter(Boolean)
      .join(' ');

    const onClick = (event: MouseEvent<HTMLTableRowElement>) => {
      // A click that ends a text selection is a reader copying a figure, not an open.
      if ((window.getSelection?.()?.toString() ?? '') !== '') return;
      if (opensRoute) {
        // A click on a control inside the row (the link itself, a surface's own button) is that
        // control's; anywhere else on the row follows the leading cell's link.
        if ((event.target as Element).closest(INTERACTIVE) !== null) return;
        event.currentTarget.querySelector<HTMLAnchorElement>('a.data-table-open')?.click();
        return;
      }
      onRowClick?.(row);
    };

    return (
      <tr
        key={rowKey(row)}
        className={className}
        data-selected={selected ? '' : undefined}
        aria-current={current ? 'true' : undefined}
        tabIndex={rowIsControl ? 0 : undefined}
        aria-label={rowIsControl && rowLabel !== undefined ? rowLabel(row) : undefined}
        onClick={clickable ? onClick : undefined}
        onKeyDown={
          rowIsControl
            ? (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onRowClick?.(row);
                }
              }
            : undefined
        }
      >
        {selection !== undefined && (
          <td className="data-table-check" onClick={stopRowClick}>
            <label className="check-cell">
              <input
                type="checkbox"
                aria-label={selection.label(row)}
                checked={selection.isSelected(row)}
                disabled={selection.isDisabled?.(row) === true}
                onChange={() => selection.onToggle(row)}
              />
            </label>
          </td>
        )}
        {columns.map((column, columnIndex) => {
          const lead = column.key === leadKey;
          const content = column.render(row);
          // Shared cell props (minus `key`, which React requires directly on the element), so the
          // row-header `<th>` and the plain `<td>` never drift on alignment, the tabular class or the
          // tree indentation.
          const cellProps = {
            'data-align': alignOf(column),
            className: column.numeric ? 't-num' : undefined,
            // Indent only the FIRST cell of a nested row, and only in the grouped tree model, so the
            // hierarchy reads down the leading column while the figures stay column-aligned.
            style:
              columnIndex === 0 && depth > 0
                ? ({ '--t-row-depth': depth } as CSSProperties)
                : undefined,
            'data-indented': columnIndex === 0 && depth > 0 ? '' : undefined,
            'data-lead': lead ? '' : undefined,
          };
          const body =
            lead && opensRoute ? (
              <Link className="data-table-open" to={href}>
                {content}
              </Link>
            ) : (
              content
            );
          // The identifying column is a `<th scope="row">`: a screen reader then pairs each cell with
          // the row's own value (RE-001, Muster AG) as well as the column header. Every other cell is
          // a plain `<td>`. See `rowHeaderKeyOf` for how the column is chosen.
          return rowHeaderKey !== undefined && column.key === rowHeaderKey ? (
            <th key={column.key} {...cellProps} scope="row">
              {body}
            </th>
          ) : (
            <td key={column.key} {...cellProps}>
              {body}
            </td>
          );
        })}
        {hasActions && (
          <td className="data-table-actions" data-align="end" onClick={stopRowClick}>
            <RowActions items={rowActions(row)} label={rowActionsLabel?.(row) ?? ''} />
          </td>
        )}
      </tr>
    );
  };

  return (
    <div ref={wrapRef} className="data-table-wrap">
      <div
        ref={frameRef}
        className="data-table-frame"
        data-overflow={overflows ? '' : undefined}
        onScroll={overflows ? updateEdges : undefined}
      >
        <table className="data-table">
          {caption !== undefined && <caption className="visually-hidden">{caption}</caption>}
          <thead>
            <tr>
              {selection !== undefined && (
                <th scope="col" className="data-table-check">
                  {selection.onToggleAll !== undefined ? (
                    <label className="check-cell">
                      <input
                        type="checkbox"
                        aria-label={selection.allLabel}
                        checked={allSelected}
                        disabled={selectable.length === 0}
                        ref={(node) => {
                          if (node !== null) node.indeterminate = someSelected;
                        }}
                        onChange={() => selection.onToggleAll?.(!allSelected)}
                      />
                    </label>
                  ) : (
                    <span className="visually-hidden">{selection.allLabel}</span>
                  )}
                </th>
              )}
              {columns.map((column) => {
                const align = alignOf(column);
                const active = sort != null && sort.key === column.key;
                const ariaSort = !column.sortable
                  ? undefined
                  : active
                    ? sort.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none';
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    data-align={align}
                    style={column.width !== undefined ? { width: column.width } : undefined}
                  >
                    {column.sortable && onSortChange !== undefined ? (
                      <button
                        type="button"
                        className="data-table-sort"
                        onClick={() => onSortChange(nextSort(sort, column.key))}
                      >
                        <span className={column.headerHidden ? 'visually-hidden' : undefined}>
                          {column.header}
                        </span>
                        <span className="data-table-sort-glyph" aria-hidden="true">
                          {active ? (
                            sort.direction === 'asc' ? (
                              <SortUpGlyph size={14} />
                            ) : (
                              <SortDownGlyph size={14} />
                            )
                          ) : (
                            <SortNeutralGlyph size={14} />
                          )}
                        </span>
                      </button>
                    ) : (
                      <span className={column.headerHidden ? 'visually-hidden' : undefined}>
                        {column.header}
                      </span>
                    )}
                  </th>
                );
              })}
              {hasActions && <ActionsHeader />}
            </tr>
          </thead>
          <tbody>
            {groups !== undefined
              ? renderGroupedBody({
                  groups,
                  columnCount: spanCount,
                  collapsibleGroups,
                  collapsed,
                  toggleGroup,
                  renderRow,
                })
              : rows.map((row, index) => renderRow(row, index, 0))}
          </tbody>
          {footer !== undefined && footer.length > 0 && (
            <tfoot>
              <tr className="data-table-foot-row">
                {selection !== undefined && <td className="data-table-check" />}
                {columns.map((column) => {
                  const cell = footer.find((entry) => entry.key === column.key);
                  return (
                    <td
                      key={column.key}
                      data-align={alignOf(column)}
                      className={column.numeric ? 't-num' : undefined}
                    >
                      {cell !== undefined ? cell.content : null}
                    </td>
                  );
                })}
                {hasActions && <td className="data-table-actions" />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {overflows && (
        <>
          <span className="data-table-edge data-table-edge--start" aria-hidden="true" />
          <span className="data-table-edge data-table-edge--end" aria-hidden="true" />
        </>
      )}
    </div>
  );
}

/**
 * The table's own loading shape (K-34): the head strip and `rows` rows at the height the real rows
 * will take (`--t-row-head-h`, `--t-row-h`), in the DOM at once so the read is announced, invisible
 * for the first 200ms so a fast local read never flashes it.
 */
function DataTableSkeleton({ rows }: { rows: number }) {
  const t = useT();
  const revealRef = useRevealAfterDelay();
  return (
    <div
      ref={revealRef}
      className="data-table-skeleton"
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-pending=""
    >
      <span className="visually-hidden">{t('states.loading.label')}</span>
      <div className="data-table-skeleton-head" aria-hidden="true" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="data-table-skeleton-row" aria-hidden="true">
          <span className="skeleton data-table-skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

/** The trailing actions column's header: named for assistive tech, silent on screen. */
function ActionsHeader() {
  const t = useT();
  return (
    <th scope="col" className="data-table-actions" data-align="end">
      <span className="visually-hidden">{t('dataTable.actions')}</span>
    </th>
  );
}

/** The one trailing overflow (K-21): every verb but opening, destructive last. Nothing when empty. */
function RowActions({ items, label }: { items: OverflowMenuItem[]; label: string }) {
  if (items.length === 0) return null;
  return <OverflowMenu label={label} items={dangerLast(items)} quiet />;
}

interface GroupedBodyConfig<Row> {
  groups: DataTableGroup<Row>[];
  columnCount: number;
  collapsibleGroups: boolean;
  collapsed: Set<string>;
  toggleGroup: (key: string) => void;
  renderRow: (row: Row, index: number, depth: number) => ReactNode;
}

/**
 * The grouped body: a spanning header per group, then that group's rows (indented one level past the
 * group's own depth), skipping the rows while the group is collapsed. The header is a WCAG disclosure
 * (a button reporting `aria-expanded`) when `collapsibleGroups` is set, and a plain spanning label
 * otherwise. `index` is kept global across groups so `rowClassName`'s contract holds in both modes.
 */
function renderGroupedBody<Row>({
  groups,
  columnCount,
  collapsibleGroups,
  collapsed,
  toggleGroup,
  renderRow,
}: GroupedBodyConfig<Row>): ReactNode {
  let index = 0;
  return groups.map((group) => {
    const depth = group.depth ?? 0;
    const isCollapsed = collapsibleGroups && collapsed.has(group.key);
    const headerStyle =
      depth > 0 ? ({ '--t-row-depth': depth } as CSSProperties) : undefined;
    const rowNodes = isCollapsed
      ? null
      : group.rows.map((row) => renderRow(row, index++, depth + 1));
    return (
      <Fragment key={group.key}>
        <tr className="data-table-group-row">
          <td
            colSpan={columnCount}
            className="data-table-group-cell"
            style={headerStyle}
            data-indented={depth > 0 ? '' : undefined}
          >
            {collapsibleGroups ? (
              <button
                type="button"
                className="data-table-group-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => toggleGroup(group.key)}
              >
                <span
                  className="data-table-group-chevron"
                  data-open={isCollapsed ? undefined : ''}
                  aria-hidden="true"
                >
                  <ChevronRightGlyph size={14} />
                </span>
                <span className="data-table-group-label">{group.header}</span>
              </button>
            ) : (
              <span className="data-table-group-label">{group.header}</span>
            )}
          </td>
        </tr>
        {rowNodes}
      </Fragment>
    );
  });
}

/** Re-exported so a caller can build a localized empty state without importing the states barrel. */
export { EmptyState };
export type { Err };
export type { OverflowMenuItem };
