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
 *   - **The header sticks.** `thead th` is `position: sticky`, so the column labels stay while a long
 *     ledger scrolls under them.
 *   - **Density is a token, not a prop.** Row height and padding read `--t-control-h` / `--t-row-pad-y`
 *     and numeric type reads `--t-font-table`, all keyed off the root `data-density`, so the one
 *     global toggle (B3) tightens every table at once and Kompakt lands on the D116 32px floor.
 *   - **Money right-aligns with tabular figures.** A `numeric` column aligns to the end and carries
 *     the shared `.t-num` class (tokens.css), which is the tabular-nums, density-aware money class.
 *     Text left-aligns. Nothing centres, per the design law.
 *   - **All five states live here.** loading, empty, error and the data itself; permission-denied is
 *     the caller's (it hides the surface, not the table). The caller passes `loading`/`error`/`rows`
 *     and DataTable renders the shared state primitives, so a surface never re-implements them.
 *
 * Sorting is optional and CONTROLLED: pass `sort` and `onSortChange` and the sortable headers become
 * buttons that report `aria-sort`. Row opening is optional: pass `onRowClick` and each row becomes a
 * keyboard-activatable open affordance with an accessible name from `rowLabel`.
 *
 * The identifying column is the ROW HEADER: its body cell is a `<th scope="row">`, so a screen reader
 * announces the row's own value (the invoice number, the contact name) alongside each column header
 * rather than the column name alone. It defaults to the first identifying column; a column opts in or
 * out explicitly with `rowHeader` (see `DataTableColumn.rowHeader`).
 */
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { Skeleton } from './states/Skeleton';
import { EmptyState } from './states/EmptyState';
import { ErrorBanner } from './states/ErrorBanner';
import { SortNeutralGlyph, SortUpGlyph, SortDownGlyph, ChevronRightGlyph } from './icons';
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
   * class. Overrides `align` to `'end'` unless `align` is given explicitly.
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
  /** The read is in flight: render the shared loading placeholder. The caller owns the read. */
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
  /** Open a row (e.g. a DetailDrawer). Makes each row a keyboard-activatable affordance. */
  onRowClick?: (row: Row) => void;
  /** The accessible name for a clickable row. Required in spirit whenever `onRowClick` is set. */
  rowLabel?: (row: Row) => string;
  /**
   * A per-row class hook for row-level state (overdue, matched/unmatched, selected). Its return is
   * JOINED with the base row class, never replaces it; a falsy return adds nothing. The consumer owns
   * the class and its `--t-*` state styles: DataTable ships no state CSS.
   * Example: `rowClassName={(r) => (r.overdue ? 'ledger-row--overdue' : undefined)}`.
   */
  rowClassName?: (row: Row, index: number) => string | undefined;
  /** Number of skeleton rows to show while loading. */
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
  const [overflows, setOverflows] = useState(false);
  const columnCount = columns.length;
  const rowCount = groups !== undefined ? groups.reduce((n, g) => n + g.rows.length, 0) : rows.length;
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const measure = (): void => setOverflows(frame.scrollWidth > frame.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    const table = frame.firstElementChild;
    if (table !== null) observer.observe(table);
    return () => observer.disconnect();
  }, [columnCount, rowCount, loading, error]);
  // Loading and error take the whole area: a header over a skeleton or an error would be a lie about
  // what is on screen. The loading placeholder is the shared Skeleton, whose role="status"/aria-busy
  // announcement is covered by its own test.
  if (loading) return <Skeleton rows={skeletonRows} height={40} />;
  if (error !== undefined) return <ErrorBanner error={error} onRetry={onRetry} />;
  // Empty is "nothing to lay out": no groups in the grouped model, or no rows in the flat one. An
  // empty group array reads as empty; a group carrying a header but no rows is the caller's choice
  // to show, so it is NOT treated as empty.
  const isEmpty = groups !== undefined ? groups.length === 0 : rows.length === 0;
  if (isEmpty) return <>{emptyState ?? <EmptyState />}</>;

  // The column whose body cell is the row header (`<th scope="row">`), computed once for the table so
  // the flat and grouped bodies agree. Undefined when no column qualifies (see `rowHeaderKeyOf`).
  const rowHeaderKey = rowHeaderKeyOf(columns);

  // One row renderer, shared by the flat and grouped bodies so they never drift. `index` is the
  // global row index (across groups), so `rowClassName`'s index contract is the same in both modes.
  // `depth` indents the first cell for a tree; 0 in the flat model.
  const renderRow = (row: Row, index: number, depth: number) => {
    const clickable = onRowClick !== undefined;
    const extra = rowClassName?.(row, index);
    const className = [
      'data-table-row',
      clickable ? 'data-table-row--clickable' : undefined,
      extra || undefined,
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <tr
        key={rowKey(row)}
        className={className}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable && rowLabel !== undefined ? rowLabel(row) : undefined}
        onClick={clickable ? () => onRowClick(row) : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onRowClick(row);
                }
              }
            : undefined
        }
      >
        {columns.map((column, columnIndex) => {
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
          };
          // The identifying column is a `<th scope="row">`: a screen reader then pairs each cell with
          // the row's own value (RE-001, Muster AG) as well as the column header. Every other cell is
          // a plain `<td>`. See `rowHeaderKeyOf` for how the column is chosen.
          return rowHeaderKey !== undefined && column.key === rowHeaderKey ? (
            <th key={column.key} {...cellProps} scope="row">
              {column.render(row)}
            </th>
          ) : (
            <td key={column.key} {...cellProps}>
              {column.render(row)}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <div ref={frameRef} className="data-table-frame" data-overflow={overflows ? '' : undefined}>
      <table className="data-table">
        {caption !== undefined && <caption className="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
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
          </tr>
        </thead>
        <tbody>
          {groups !== undefined
            ? renderGroupedBody({
                groups,
                columnCount: columns.length,
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
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
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
