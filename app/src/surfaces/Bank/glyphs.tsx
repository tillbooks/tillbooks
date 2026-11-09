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

/** A receipt on the line: the paperclip (D142). Always beside its count or its word. */
export function PaperclipGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M20.5 11.5 12.4 19.6a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
    </svg>
  );
}




/** Money in: an arrow arriving at the lower left. */
export function InGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M17 7 7 17" />
      <path d="M7 9v8h8" />
    </svg>
  );
}

/** Money out: an arrow leaving at the upper right. */
export function OutGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </svg>
  );
}

/** Kontoauszug holen: an arrow into a tray. */
export function FetchGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4 17v2.5h16V17" />
    </svg>
  );
}

/** The (i) that opens an explanation. */
export function InfoGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.5v.01" />
    </svg>
  );
}

/**
 * D167: the counterparty's standard. Filled when one is set (the ★ before a prefilled account and the
 * set toggle), an outline when none is (the ☆ that sets it). The control or the tooltip says it in words.
 */
export function StandardGlyph({ filled = true, ...props }: GlyphProps & { filled?: boolean }) {
  return (
    <svg {...base(props)} strokeWidth={1.5}>
      <path d="M12 3.2l2.75 5.6 6.15.9-4.45 4.35 1.05 6.1L12 17.25 6.5 20.15l1.05-6.1L3.1 9.7l6.15-.9z" fill={filled ? 'currentColor' : 'none'} />
    </svg>
  );
}

/** A filter: three lines narrowing (the toolbar's one "Filter" menu, D167). */
export function FilterGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 6h16" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </svg>
  );
}

/** The caret of a menu button. */
export function CaretGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 9.5 12 15.5 18 9.5" />
    </svg>
  );
}
