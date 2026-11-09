/**
 * Loading state: a block that matches the real layout, never a bare spinner.
 *
 * `aria-busy` and a `role="status"` wrapper announce the load; the visible text label is
 * screen-reader-only so the layout stays clean. Heights, widths and the grid are caller-controlled so
 * the skeleton traces the shape of whatever it stands in for (K-34, D137): a stack of rows by
 * default, or a grid of tiles with `columns` (the Übersicht's eight 4 x 2 tiles are
 * `rows={8} columns={4} height={114}`), and a fixed `width` for a field or a figure.
 *
 * Nothing appears before 200ms: the region is in the DOM from the first commit (so the load is
 * announced and testable at once) but invisible until `useRevealAfterDelay` reveals it, so a
 * ten-millisecond local read never flashes a skeleton. A caller that wants the 300ms minimum on
 * screen keeps rendering this while `useSkeletonHold(loading)` is true.
 */
import type { CSSProperties } from 'react';

import { useT } from '../../i18n';
import { useRevealAfterDelay } from './useSkeletonTiming';
import './states.css';

export interface SkeletonProps {
  /** Number of blocks to render (table rows, or tiles when `columns` is set). */
  rows?: number;
  /** Height of each block, in px. Must stay on the 8-pt grid. */
  height?: number;
  /** Optional label key override; defaults to the shared loading label. */
  labelKey?: string;
  /**
   * Lay the blocks out as a grid of this many equal columns (tiles), instead of a stack of rows.
   * Omitted, the blocks stack full width with the last one shortened, like the end of a list.
   */
  columns?: number;
  /**
   * A fixed width for every block (px, or any CSS length): a field, a figure, a line of known length.
   * Omitted, blocks fill their row or their grid cell.
   */
  width?: number | string;
}

export function Skeleton({
  rows = 3,
  height = 24,
  labelKey = 'states.loading.label',
  columns,
  width,
}: SkeletonProps) {
  const t = useT();
  const revealRef = useRevealAfterDelay();
  const grid = columns !== undefined && columns > 0;
  const regionStyle: CSSProperties | undefined = grid
    ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
    : undefined;
  return (
    <div
      ref={revealRef}
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={grid ? 'skeleton-region skeleton-region--grid' : 'skeleton-region'}
      style={regionStyle}
      data-pending=""
    >
      <span className="visually-hidden">{t(labelKey)}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span
          key={i}
          className="skeleton"
          style={{
            height,
            marginBottom: grid ? undefined : 'var(--t-space-1)',
            // A stack reads as the end of a list with its last line short; a grid, a field or a
            // caller-sized block keeps the width it was given.
            width: width ?? (grid || i !== rows - 1 ? '100%' : '60%'),
          }}
        />
      ))}
    </div>
  );
}
