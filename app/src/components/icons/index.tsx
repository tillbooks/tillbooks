/**
 * The Studio's one icon module (Ruhig 3, D154): every shared glyph, drawn on the one grid in `base.ts`.
 *
 * Never emoji. Each glyph is decorative: the adjacent text or the trigger's `aria-label` carries the
 * meaning, so every glyph is `aria-hidden` and `focusable="false"`. Colour comes from `currentColor`
 * so a token-backed class sets it, and no hex ever appears here.
 *
 * `vocabulary.tsx` holds the glyphs that may stand alone on an `IconButton`. The glyphs below
 * are the shell, status and disclosure set: they sit beside words or inside a primitive that names
 * itself. A per-surface `glyphs.tsx` is migrated here in the E-step; `test/style/icon-vocabulary-guard`
 * refuses any new one.
 */
import { glyphBase as base, type GlyphProps } from './base';

export { glyphBase, type GlyphProps, type IconSize } from './base';
export { VOCABULARY, type VocabularyIcon, type VocabularyEntry } from './vocabulary';
export { KIND_GLYPHS, type KindGlyph } from './kinds';

/**
 * D177: a match, two arrows passing (⇄): a bank line tied to an entry already on the books. A source
 * glyph beside words (the Details panel's Woher line), never alone on a button.
 */
export function MatchGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 8.5h14l-3-3" />
      <path d="M19.5 15.5h-14l3 3" />
    </svg>
  );
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

// --- D178 N2 (A39 §18.4): the bank facts card's fact glyphs ---------------------------------------
// Each names the KIND of a fact on its line (a date, the counterparty's IBAN, the bank's text) beside the
// value, never alone on a button; the fact's name reaches assistive tech as words beside it. Calm strokes
// on the shared grid, so the card reads as one family with the vocabulary.

/** A calendar sheet: the booking and value dates. */
export function CalendarGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </svg>
  );
}

/** A person: the counterparty (its IBAN). */
export function PersonGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5a7 7 0 0 1 14 0" />
    </svg>
  );
}

/** Three text lines of falling length: the bank's own description of the movement. */
export function TextLinesGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 7h14M5 12h14M5 17h9" />
    </svg>
  );
}

/** A sheet with a folded corner: further information the bank delivered beside the main text. */
export function NoteGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6.5 4h7.5l4.5 4.5V18a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      <path d="M13.5 4v4.5H18M8.5 13h7M8.5 16.5h4.5" />
    </svg>
  );
}

/** A number sign: a reference (end-to-end, the bank's own, a QR reference). */
export function HashGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M9.5 4.5l-2 15M16.5 4.5l-2 15M5 9h15M4 15h15" />
    </svg>
  );
}

/** A tag: the bank transaction code and its label. */
export function TagGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5.5V11l8.5 8.5a1.5 1.5 0 0 0 2.1 0l4.9-4.9a1.5 1.5 0 0 0 0-2.1L11 4H5.5A1.5 1.5 0 0 0 4 5.5z" />
      <circle cx="8.5" cy="8.5" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Two arrows turning into each other: an exchange (the foreign amount, the rates, the fee). */
export function ExchangeGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M19 9.5A7.5 7.5 0 0 0 5.4 7.6M5 4.5v3.3h3.3" />
      <path d="M5 14.5a7.5 7.5 0 0 0 13.6 1.9M19 19.5v-3.3h-3.3" />
    </svg>
  );
}

/** A building with columns: the Bankkonto the line belongs to. */
export function BankGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 9.5L12 4.5l8 5M5 20h14M6.5 10.5v6.5M10 10.5v6.5M14 10.5v6.5M17.5 10.5v6.5" />
    </svg>
  );
}

/** Six points in two columns: a drag grip (the /bank detail area's header). Pointer-only, never named. */
export function GripGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="16" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="16" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * D180: an arrow turning back on itself, "Standard wiederherstellen". It always sits beside its word in
 * a menu row, never alone on a button (it is not in the vocabulary).
 */
export function ResetGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 12a7 7 0 1 0 2.05-4.95L5 9.1" />
      <path d="M5 4.75V9.1h4.35" />
    </svg>
  );
}

/**
 * D180: a bookmark, "Als Ansicht speichern". It always sits beside its word in a menu row, never alone
 * on a button (it is not in the vocabulary).
 */
export function SaveViewGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M7.5 4h9a1.5 1.5 0 0 1 1.5 1.5V20l-6-4-6 4V5.5A1.5 1.5 0 0 1 7.5 4z" />
    </svg>
  );
}
