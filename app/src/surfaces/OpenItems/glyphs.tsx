/**
 * Decorative inline glyphs for the Offene-Posten surface.
 *
 * Every one is `aria-hidden` and `focusable="false"` by default and the adjacent text carries the
 * meaning, so no status on this surface is signalled by icon or colour alone. `CheckGlyph` is the
 * one exception and it takes an `aria-label` from its caller, because the passing reconciliation
 * statement is a glyph plus a sentence and the glyph is part of what is being said.
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

/** The reconciliation mark. Quiet and uncoloured: an all-clear state does not get an accent. */
export function CheckGlyph({ 'aria-label': label, ...rest }: GlyphProps) {
  const props = base(rest);
  return (
    <svg
      {...props}
      {...(label === undefined ? {} : { 'aria-label': label, 'aria-hidden': undefined, role: 'img' })}
    >
      <path d="M4 12.5 9 17.5 20 6.5" />
    </svg>
  );
}

/** The mismatch mark, on the one band that carries colour on this surface. */
export function WarnGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5h.01" />
    </svg>
  );
}

/** A calendar, marking the historical cut-off band. */
export function CalendarGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
    </svg>
  );
}

/** The expander chevron on a customer row. Rotated by CSS when the row is open. */
export function ChevronGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
