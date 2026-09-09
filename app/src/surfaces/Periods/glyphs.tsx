/**
 * Inline SVG glyphs for the Periods surface (A03 §6).
 *
 * Status is glyph PLUS text, never colour alone: each glyph here is decorative (the adjacent label
 * carries the meaning), so it is `aria-hidden` and `focusable="false"`. `currentColor` lets a
 * token-backed class set the colour, so no hex ever appears here. Never emoji.
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

/** An open padlock: the period is open (neutral). */
export function OpenLockGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </svg>
  );
}

/** A closed padlock: a soft (reversible) lock. */
export function SoftLockGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** A padlock with a seal dot: a hard (legally sealed) lock. */
export function HardLockGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A check inside a circle: the audit hash chain verifies. */
export function ChainVerifiedGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  );
}

/** A cross inside a circle: the audit hash chain is broken. */
export function ChainBrokenGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6" />
      <path d="M15 9l-6 6" />
    </svg>
  );
}
