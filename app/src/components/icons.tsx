/**
 * Shared inline-SVG glyphs for shell chrome and primitives (theme toggle, help affordance).
 *
 * Never emoji. Each glyph is decorative: the adjacent text or the trigger's `aria-label` carries the
 * meaning, so every glyph is `aria-hidden` and `focusable="false"`. Colour comes from `currentColor`
 * so a token-backed class sets it, and no hex ever appears here.
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

/** A sun: shown in dark mode, where the toggle switches to light. */
export function SunGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** A moon: shown in light mode, where the toggle switches to dark. */
export function MoonGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

/** A question mark in a circle: the help affordance trigger. */
export function HelpGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** A plain cross: the close control on a Modal or a DetailDrawer. The button carries the label. */
export function CloseGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * A pair of chevrons: a sortable column that is not the active sort. The active direction swaps this
 * for a single chevron (`SortUpGlyph` / `SortDownGlyph`), so the state is a glyph and never colour
 * alone.
 */
export function SortNeutralGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
    </svg>
  );
}

/** A single up chevron: the column sorted ascending. */
export function SortUpGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

/** A single down chevron: the column sorted descending. */
export function SortDownGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * A right-pointing chevron: the collapsed state of a group disclosure in DataTable. The expanded
 * state rotates it a quarter turn to point down (a CSS transform on the open button), so the glyph
 * itself stays one shape and the direction reads as state, never colour alone.
 */
export function ChevronRightGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
