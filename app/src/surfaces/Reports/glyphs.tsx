/**
 * Decorative inline glyphs for the Auswertungen surface.
 *
 * Every one is `aria-hidden` and `focusable="false"` by default and the adjacent text carries the
 * meaning, so no status here is signalled by icon or colour alone. `CheckGlyph` and `AlertGlyph` take
 * an `aria-label` from their caller, because the reconciliation statement is a glyph plus a sentence
 * and there the glyph is part of what is being said.
 *
 * `currentColor` throughout, so every colour stays on a token-backed class and no hex appears here.
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

function labelled({ 'aria-label': label, ...rest }: GlyphProps) {
  const props = base(rest);
  return label === undefined ? props : { ...props, 'aria-label': label, 'aria-hidden': undefined, role: 'img' };
}

/** The reconciliation mark. Quiet and uncoloured: an all-clear state does not get an accent. */
export function CheckGlyph(props: GlyphProps) {
  return (
    <svg {...labelled(props)}>
      <path d="M4 12.5 9 17.5 20 6.5" />
    </svg>
  );
}

/** The mismatch mark. The band around it carries the colour; this only carries the shape. */
export function AlertGlyph(props: GlyphProps) {
  return (
    <svg {...labelled(props)}>
      <path d="M12 4 2.5 20.5h19L12 4Z" />
      <path d="M12 10v4" />
      <path d="M12 17.5v.01" />
    </svg>
  );
}

/** The collapse chevron on a section heading. Rotated by CSS, never by a second glyph. */
export function ChevronGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 5l7 7-7 7" />
    </svg>
  );
}
