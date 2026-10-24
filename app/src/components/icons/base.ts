/**
 * The one icon grid every TILL glyph is drawn on: a 24 viewBox, stroke 1.75, round caps and joins,
 * `currentColor` only (a token-backed class sets the colour, so no hex ever appears in a glyph).
 * Decorative by construction: `aria-hidden` and never focusable, because the button or the words next
 * to the glyph carry its meaning. DESIGN.md allows three sizes: 16, 20 and 24.
 */
import type { SVGProps } from 'react';

/** The three icon sizes DESIGN.md allows (12 and 14 retire as surfaces migrate). */
export type IconSize = 16 | 20 | 24;

export type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

export function glyphBase({ size = 18, ...rest }: GlyphProps) {
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
