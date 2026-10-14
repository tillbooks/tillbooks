/**
 * The composer's own glyphs (A1 Buchungssatz): the Beleg paperclip, the plus of a ghost "add" button and
 * the split of "Aufteilen". Drawn on the shared icon grid (24 viewBox, stroke 1.75, round caps) so they
 * sit beside the shared set without a second style. Decorative: the button's words or `aria-label`
 * carry the meaning, so every glyph is `aria-hidden` and never focusable. `currentColor` only, no hex.
 */
import type { SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: GlyphProps) {
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

/** A paperclip, tilted: attach a Beleg. */
export function PaperclipGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M15.5 7v8.5a3.5 3.5 0 0 1-7 0V6a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V8" transform="rotate(40 12 12)" />
    </svg>
  );
}

/** A plus: the quiet "+ Kostenstelle", "+ Referenz", "+ Zeile". */
export function PlusGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** One path forking into two: "Aufteilen", a Buchungssatz split into lines. */
export function SplitGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 20v-7M12 13L6 6M12 13l6-7M6 6v3M6 6h3M18 6v3M18 6h-3" />
    </svg>
  );
}
