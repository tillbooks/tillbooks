/**
 * A25 review/export glyphs: one small line glyph per role, drawn in `currentColor` so a token-backed
 * class sets the colour. Decorative (the adjacent text carries the meaning), so every glyph is
 * `aria-hidden` and `focusable="false"`. Never emoji, never a hex. Status is glyph PLUS text
 * everywhere; the accent is never spent here (approved rides `--t-success`, per D115).
 */
import type { SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...rest }: GlyphProps) {
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

/** Approved: a check. The one go/confirmed signal, rendered in `--t-success` (never a second accent). */
export function CheckGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

/** Open: a neutral hollow dot. Not yet reviewed. */
export function DotGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  );
}

/** Flagged: a neutral flag on a pole. Questioned, not an alarm colour. */
export function FlagGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 21V4" />
      <path d="M6 5h11l-2.5 3.5L17 12H6" />
    </svg>
  );
}

/** Comment: a speech bubble, the Prüfvermerk thread. */
export function CommentGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5h16v11H9l-4 4v-4H4z" />
    </svg>
  );
}

/** Download: an arrow into a tray, the export action. */
export function DownloadGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4v10" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}
