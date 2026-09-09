/**
 * Decorative inline glyphs for the VatSettings surface.
 *
 * Each is `aria-hidden` and `focusable="false"`: the adjacent text carries the meaning, so a status
 * is never signalled by icon or colour alone (WCAG 2.2, spec A05 §6). `currentColor` keeps every
 * colour on a token-backed class, so no hex ever appears here.
 */
import type { SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 14, ...rest }: GlyphProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...rest,
  };
}

/** A check inside a circle, marking a saved state. */
export function CheckCircleGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  );
}
