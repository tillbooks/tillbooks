/**
 * The bank inbox's glyphs: one stroke (1.75), one 24px grid, `currentColor`, decorative. The word
 * beside each glyph (or the control's accessible name) carries the meaning, so every glyph is
 * `aria-hidden`: status is glyph PLUS text, never either alone (DESIGN.md "Status").
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

/** Sure: a reference proves the match. */
export function SureGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)} strokeWidth={2.25}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  );
}

/** Learned: a rule or the last booking of this counterparty pre-filled it. */
export function LearnedGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 10a8 8 0 0 1 14-4l2 2" />
      <path d="M20 3v5h-5" />
      <path d="M20 14a8 8 0 0 1-14 4l-2-2" />
      <path d="M4 21v-5h5" />
    </svg>
  );
}

/** Check: a plausible match nothing proves; look before you book. */
export function CheckGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13" />
      <path d="M12 16.5v.01" />
    </svg>
  );
}

/** Open: no proposal yet. */
export function OpenGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

/** Edited: the person changed the proposal. */
export function EditedGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

/** The agent: a diamond with a centre point (the Provenance mark). */
export function AgentGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4l8 8-8 8-8-8z" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** Balanced: bank equals books. */
export function BalancedGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)} strokeWidth={2.25}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  );
}

/** A difference or a gap: the warning triangle. */
export function WarnGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5 2.5 20h19L12 3.5z" />
      <path d="M12 10v4" />
      <path d="M12 17v.01" />
    </svg>
  );
}

/** Cannot be judged: a dashed circle. */
export function UnknownGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
    </svg>
  );
}

/** The search field's magnifier. */
export function SearchGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5 21 21" />
    </svg>
  );
}

/** Back to the proposal. */
export function BackGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

/** Remove a split position. */
export function RemoveGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** The bank: the drawer face (the TILL mark's vocabulary). */
export function BankGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="6" width="18" height="12" rx="1" />
      <path d="M3 12h18" />
      <path d="M10 15h4" />
    </svg>
  );
}
