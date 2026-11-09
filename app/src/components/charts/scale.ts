/**
 * The chart primitive's geometry: pure functions, no DOM, so the shapes are unit-tested as numbers.
 */

/** A linear map from `[d0, d1]` onto `[r0, r1]`. A zero-width domain maps everything to `r0`. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  return (v) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** The smallest 1-2-5 step value at or above `v` (the top gridline), 1 for nothing. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(v));
  const n = v / power;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * power;
}

/** An annular sector from angle `a0` to `a1` (radians, 0 at twelve o'clock, clockwise). */
export function arcPath(cx: number, cy: number, outer: number, inner: number, a0: number, a1: number): string {
  const point = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return [
    `M${point(outer, a0)}`,
    `A${outer},${outer} 0 ${large} 1 ${point(outer, a1)}`,
    `L${point(inner, a1)}`,
    `A${inner},${inner} 0 ${large} 0 ${point(inner, a0)}`,
    'Z',
  ].join(' ');
}

/**
 * The donut's segments: each positive value's start and end angle, a `gap` (radians) cut between
 * neighbours so touching fills stay apart. A single segment is drawn as a full ring minus a hair, since
 * an arc from 0 to 2π has no extent in SVG.
 */
export function donutAngles(values: readonly number[], gap = 0.03): { a0: number; a1: number }[] {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total <= 0) return values.map(() => ({ a0: 0, a1: 0 }));
  const positive = values.filter((v) => v > 0).length;
  const cut = positive > 1 ? gap : 0;
  const full = Math.PI * 2 - 0.0001;
  let at = 0;
  return values.map((v) => {
    const sweep = (Math.max(0, v) / total) * Math.PI * 2;
    let segment = { a0: at, a1: at };
    if (v > 0 && positive === 1) segment = { a0: 0, a1: full };
    else if (v > 0) segment = { a0: at + cut / 2, a1: Math.max(at + cut / 2, Math.min(full, at + sweep - cut / 2)) };
    at += sweep;
    return segment;
  });
}

/** A polyline path through `points` (already in view coordinates). */
export function linePath(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}
