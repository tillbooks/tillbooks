/**
 * Decorative inline glyphs for the Accounts surface.
 *
 * Each is `aria-hidden` and `focusable="false"`: the adjacent text carries the meaning, so status is
 * never signalled by icon or colour alone (WCAG 2.2, spec A01 §6). `currentColor` keeps every colour
 * on a token-backed class, so no hex ever appears here.
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

/** A tag, marking the neutral account-type badge. */
export function TagGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12V5a1 1 0 0 1 1-1h7l8 8-8 8z" />
      <path d="M8.5 8.5h.01" />
    </svg>
  );
}

/** An archive box, marking an archived row. */
export function ArchiveGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 7h18v3H3z" />
      <path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
      <path d="M9 13h6" />
    </svg>
  );
}
