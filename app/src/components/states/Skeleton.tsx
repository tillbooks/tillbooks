/**
 * Loading state: a block that matches the real layout, never a bare spinner.
 *
 * `aria-busy` and a `role="status"` wrapper announce the load; the visible text label is
 * screen-reader-only so the layout stays clean. Widths/heights are caller-controlled so the skeleton
 * can trace the shape of whatever it stands in for.
 */
import { useT } from '../../i18n';

export interface SkeletonProps {
  /** Number of stacked blocks to render (e.g. table rows). */
  rows?: number;
  /** Height of each block. Must stay on the 8-pt grid. */
  height?: number;
  /** Optional label key override; defaults to the shared loading label. */
  labelKey?: string;
}

export function Skeleton({ rows = 3, height = 24, labelKey = 'states.loading.label' }: SkeletonProps) {
  const t = useT();
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{t(labelKey)}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span
          key={i}
          className="skeleton"
          style={{ height, marginBottom: 'var(--t-space-1)', width: i === rows - 1 ? '60%' : '100%' }}
        />
      ))}
    </div>
  );
}
