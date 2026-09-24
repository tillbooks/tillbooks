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

/*
 * The status set (K-22, D137). One family of six, all a 24-unit circle with one mark inside, drawn at
 * the `Status` primitive's 14px. The SHAPE carries the state for a colour-blind reader and on a
 * grayscale printout; colour only reinforces it. Never a text dingbat in its place.
 */

/** A check in a circle: done, paid, posted, accepted. */
export function StatusSuccessGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  );
}

/** An exclamation in a circle: needs attention (overdue, due soon, awaiting approval). */
export function StatusWarnGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </svg>
  );
}

/** A cross in a circle: failed, rejected, blocked. */
export function StatusDangerGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}

/** An empty circle: a neutral state with nothing to act on (draft, open). */
export function StatusNeutralGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

/** A clock face: in progress or scheduled (sent, running, planned). */
export function StatusPendingGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/** A dash in a circle: out of play (archived, paused, ended, cancelled). */
export function StatusInactiveGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12h7" />
    </svg>
  );
}

/** An arrow rising out of a tray: the FileDrop zone's upload mark. */
export function UploadGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/** A diamond with a centre point: a row the agent wrote (Provenance). Named in words beside it. */
export function AgentMarkGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4l8 8-8 8-8-8z" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** A small point: a quiet separator mark for a row a person or an import wrote (Provenance). */
export function PointGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** Three points in a row: the overflow trigger ("more actions"). The button carries the label. */
export function MoreGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="12" r="1.25" fill="currentColor" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" />
      <circle cx="18" cy="12" r="1.25" fill="currentColor" />
    </svg>
  );
}

/** A down chevron: a closed Select's caret. Decorative; the trigger's state is `aria-expanded`. */
export function ChevronDownGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 10l5 5 5-5" />
    </svg>
  );
}
