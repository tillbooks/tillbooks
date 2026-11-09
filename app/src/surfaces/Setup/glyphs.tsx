/**
 * Surface-local glyphs for the Setup surface.
 *
 * Each glyph is decorative: the adjacent text carries the meaning, so every glyph is `aria-hidden`
 * and `focusable="false"`. Colour comes from `currentColor` via a token-backed class, never a hex.
 */
import type { SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 20, ...rest }: GlyphProps) {
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

/** A check inside a circle: the saved / confirmed signal (teal, per the one-accent rule). */
export function CheckCircleGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  );
}

/** A question mark inside a circle: the help affordance next to the creditor IBAN field. */
export function HelpGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" />
      <path d="M12 16.5h.01" />
    </svg>
  );
}
