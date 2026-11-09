/**
 * THE STUDIO'S ONE CHART PRIMITIVE (D178): hand-rolled SVG, zero dependencies, extracted from the A40
 * liquidity chart (`surfaces/CreditorPayments/LiquidityChart.tsx`, which now renders through it).
 *
 * What every chart shares, and only that: a `<figure>`, ONE inline SVG with `role="img"` whose
 * `aria-label` is a one-sentence summary, a legend in the `<figcaption>` (identity is never colour
 * alone), and a table twin in a `<details>` that carries every value the chart draws, so nothing is
 * chart-only. The marks are the caller's children; the geometry helpers live in `./scale.ts`.
 *
 * Colours are tokens only (`--t-chart-in`, `--t-chart-out`, the text and border tokens), never a hex.
 * Motion is the level's (`.chart-grow`, `.chart-draw` in `styles/motion.css`): a mark opts in by class.
 */
import type { ReactNode } from 'react';

import './charts.css';

export interface ChartFigureProps {
  /** The viewBox size; the SVG scales to its container. */
  width: number;
  height: number;
  /** One sentence the SVG answers to assistive tech (and the table's hidden caption). */
  summary: string;
  /** The marks. */
  children: ReactNode;
  /** The legend, rendered in the figcaption. */
  legend?: ReactNode;
  /** The disclosure's label ("Als Tabelle") and the table's head and body rows. */
  tableLabel: string;
  tableHead: ReactNode;
  tableBody: ReactNode;
  /** `none` stretches to the container (a line over days); the default keeps the aspect ratio. */
  preserveAspectRatio?: string;
  /** Anything between the SVG and the legend (axis labels as HTML). */
  after?: ReactNode;
  className?: string;
  svgClassName?: string;
  legendClassName?: string;
  tableClassName?: string;
}

export function ChartFigure({
  width,
  height,
  summary,
  children,
  legend,
  tableLabel,
  tableHead,
  tableBody,
  preserveAspectRatio,
  after,
  className = 'chart',
  svgClassName = 'chart-svg',
  legendClassName = 'chart-legend',
  tableClassName = 'chart-table',
}: ChartFigureProps) {
  return (
    <figure className={className}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        {...(preserveAspectRatio === undefined ? {} : { preserveAspectRatio })}
        role="img"
        aria-label={summary}
        className={svgClassName}
      >
        {children}
      </svg>
      {after}
      {legend === undefined ? null : <figcaption className={legendClassName}>{legend}</figcaption>}
      <details className={tableClassName}>
        <summary>{tableLabel}</summary>
        <table className="data-table">
          <caption className="visually-hidden">{summary}</caption>
          <thead>{tableHead}</thead>
          <tbody>{tableBody}</tbody>
        </table>
      </details>
    </figure>
  );
}
