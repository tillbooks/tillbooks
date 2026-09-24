/**
 * Inline SVG glyphs for the state primitives.
 *
 * Never emoji. Each glyph is decorative (the adjacent text carries the meaning), so it is
 * `aria-hidden` and marked `focusable="false"`. `currentColor` lets the caller set the colour via a
 * token-backed class, so no hex ever appears here.
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

/** An empty tray: nothing here yet. */
export function InboxGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 12h4l2 3h6l2-3h4" />
      <path d="M3 12l3-7h12l3 7v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** A warning triangle for the error banner. Paired with a text sign, never colour alone. */
export function AlertGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** A check mark for a completed action. Paired with a text sign, never colour alone. */
export function CheckGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** An "i" in a circle for a neutral, informational notice. */
export function InfoGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/** A closed padlock for permission-denied. */
export function LockGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
