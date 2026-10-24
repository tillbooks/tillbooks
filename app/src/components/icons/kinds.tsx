/**
 * D178, Pendenzen's SECTION glyphs: what a section holds, by area (the bank, the books, sales, the system)
 * or by kind (things to approve, to do, to note).
 *
 * Section heads only (the fresh-eyes judge, N4 H1): a row carries no glyph, its lead column holds a
 * Vorschlag's batch box or nothing, so the kind is said once, by its section. Deliberately NONE of the
 * twenty-two action glyphs of `vocabulary.tsx` (those mean an act and may stand alone on a button), no box
 * that could read as a checkbox beside the real ones, and no currency symbol in a franc book. Drawn on the
 * shared grid (`base.ts`: 24 viewBox, stroke 1.75, round caps, `currentColor`), decorative and
 * `aria-hidden`: the section's name beside it says what it is.
 */
import type { ReactElement } from 'react';

import { glyphBase as base, type GlyphProps } from './base';

/** A bank front: the Bank area. */
function BankKindGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 9.5L12 5l8 4.5" />
      <path d="M6 10.5v6.5M10 10.5v6.5M14 10.5v6.5M18 10.5v6.5" />
      <path d="M4 19.5h16" />
    </svg>
  );
}

/** An open ledger: Buchhaltung. */
function LedgerKindGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 7c-2-1.5-4.5-2-8-2v12c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2V5c-3.5 0-6 .5-8 2z" />
      <path d="M12 7v12" />
    </svg>
  );
}

/** A sheet with lines and a folded corner: Verkauf, an invoice. */
function SalesKindGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4" />
      <path d="M9 12h6M9 15.5h6" />
    </svg>
  );
}

/** Two sliders: System, the settings behind the work. */
function SystemKindGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 8h3M11 8h9M4 16h9M17 16h3" />
      <circle cx="9" cy="8" r="2" />
      <circle cx="15" cy="16" r="2" />
    </svg>
  );
}

/** A seal with a tick: Genehmigen, a decision someone signs off. Round, never a box. */
function ApproveKindGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.6 12.2l2.3 2.3 4.5-4.7" />
    </svg>
  );
}

/** A flag on its pole: Erledigen, a step someone carries out. */
function TodoKindGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6.5 20.5v-16" />
      <path d="M6.5 5h11l-2.5 4 2.5 4h-11" />
    </svg>
  );
}

/** A bell: Hinweise, something to look at. */
function NoteKindGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" />
      <path d="M10.5 20h3" />
    </svg>
  );
}

export const KIND_GLYPHS = {
  bank: BankKindGlyph,
  ledger: LedgerKindGlyph,
  sales: SalesKindGlyph,
  system: SystemKindGlyph,
  approve: ApproveKindGlyph,
  todo: TodoKindGlyph,
  note: NoteKindGlyph,
} as const satisfies Record<string, (props: GlyphProps) => ReactElement>;

export type KindGlyph = keyof typeof KIND_GLYPHS;
