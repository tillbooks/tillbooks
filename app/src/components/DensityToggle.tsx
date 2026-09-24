/**
 * The density toggle: one icon button that flips Komfortabel and Kompakt (D118 B3).
 *
 * The twin of `ThemeToggle`, sitting beside it in the rail footer. Like that control it shows the
 * glyph of the state it switches TO (tight rows when it will compact, roomy rows when it will
 * relax), which reads as "tap to go there". It is icon-only, so it carries an `aria-label` naming
 * the destination density and a real inline-SVG glyph, never emoji. `aria-pressed` exposes the
 * compact state to assistive tech (Kompakt is the pressed/denser state).
 */
import { useDensity } from '../app/density';
import { useT } from '../i18n';

/** Roomy rows: the Komfortabel glyph (two well-spaced bars). Shown while Kompakt is active, because
 *  the button then relaxes the density. currentColor, so it inherits the button ink. */
function ComfortableRowsGlyph() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 8h16" />
      <path d="M4 16h16" />
    </svg>
  );
}

/** Tight rows: the Kompakt glyph (four close bars). Shown while Komfortabel is active, because the
 *  button then compacts the density. */
function CompactRowsGlyph() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6h16" />
      <path d="M4 11h16" />
      <path d="M4 16h16" />
      <path d="M4 21h16" />
    </svg>
  );
}

export function DensityToggle() {
  const { density, toggle } = useDensity();
  const t = useT();
  const isCompact = density === 'kompakt';
  return (
    <button
      type="button"
      className="density-toggle"
      onClick={toggle}
      aria-label={isCompact ? t('density.toComfortable') : t('density.toDense')}
      aria-pressed={isCompact}
    >
      {isCompact ? <ComfortableRowsGlyph /> : <CompactRowsGlyph />}
    </button>
  );
}
