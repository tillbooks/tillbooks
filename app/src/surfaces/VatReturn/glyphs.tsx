/**
 * A07's glyphs. Line art in `currentColor`, decorative, so the adjacent text always carries the
 * meaning: a status on this surface is never signalled by colour or by an icon alone.
 */
import type { SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement> & { size?: number };

function frame({ size = 16, ...rest }: Props) {
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

/** The warn glyph beside an unexplained difference. Paired with the word, never used alone. */
export function WarnGlyph(props: Props) {
  return (
    <svg {...frame(props)}>
      <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
      <path d="M12 10v4" />
      <path d="M12 17.2h.01" />
    </svg>
  );
}

/** The agrees / explained glyph. A tick, in body text colour: an all-clear state gets no colour. */
export function CheckGlyph(props: Props) {
  return (
    <svg {...frame(props)}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  );
}

/** The disclosure chevron on the bridge and on a Ziffer row. Rotated by CSS when open. */
export function ChevronGlyph(props: Props) {
  return (
    <svg {...frame(props)}>
      <path d="M9 5.5 15.5 12 9 18.5" />
    </svg>
  );
}

/** The outward link on step 4 of the journey: this one leaves TILL, and it says so. */
export function ExternalGlyph(props: Props) {
  return (
    <svg {...frame(props)}>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" />
    </svg>
  );
}

/** The lock on a filed period. */
export function LockGlyph(props: Props) {
  return (
    <svg {...frame(props)}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="1.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
