/**
 * The closed icon vocabulary of Ruhig 3 (D154, DESIGN.md "Icon vocabulary").
 *
 * These twenty-two glyphs (D154's twelve, D177's five and D180's five), and only these, may stand alone on a button. Each means one thing everywhere,
 * and its German name is the button's accessible name and the first line of its tooltip, so the same
 * pencil never reads "Bearbeiten" here and "Ändern" there. `IconButton` takes a key of this table and
 * nothing else: a glyph outside it needs a word beside it, and a money commit (Buchen, Ausstellen,
 * Zahlung buchen, Periode sperren) or a destructive act (Stornieren, Löschen, Ignorieren) is never
 * here at all. Destructive acts live under Mehr.
 *
 * D177 (16.10.2026) adds five, for the bank line's Details panel, its row and its split: Aufteilen,
 * Abgleichen, Als Regel speichern, Ignorieren, and Position entfernen (a minus in a ring: a position of a
 * split, an edit of a draft; never a cross, since × on the bank line means Ignorieren only). Ignorieren is the one destructive act that may be a glyph, by the
 * owner's ruling (D177 point 5): on a bank line it is undone in one click from the status line.
 *
 * D180 (24.10.2026) adds five, for arranging the Übersicht in place: Anpassen (the header toggle into
 * edit mode), Fertig (its twin, which leaves it), Ausblenden and Einblenden (the eye on an item) and
 * Grösse ändern (a card's width, the bank item's size). None of them moves money or deletes anything:
 * each one is reversed by pressing the same control again.
 *
 * Drawn on the shared grid (24 viewBox, stroke 1.75, round caps), from the Ruhig 3 artifact. Decorative:
 * every glyph is `aria-hidden`, and the button carries the name.
 */
import type { ReactElement } from 'react';

import { glyphBase, type GlyphProps } from './base';

function EditGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M4.5 19.5l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.7 18.5z" />
      <path d="M14 6.8l3.2 3.2" />
    </svg>
  );
}

function AttachGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <g transform="rotate(40 12 12)">
        <path d="M15 7.5v8.5a3 3 0 0 1-6 0V6a2 2 0 0 1 4 0v9.5a1 1 0 0 1-2 0V8.5" />
      </g>
    </svg>
  );
}

function CommentGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M6 5h12a2.5 2.5 0 0 1 2.5 2.5v6.5a2.5 2.5 0 0 1-2.5 2.5h-6.5L7 19.8v-3.3H6A2.5 2.5 0 0 1 3.5 14V7.5A2.5 2.5 0 0 1 6 5z" />
    </svg>
  );
}

function FlagGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M6 20.5V4" />
      <path d="M6 4.5h11.5l-2.4 4 2.4 4H6" />
    </svg>
  );
}

function CopyGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5" />
      <path d="M15.5 8.5V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2" />
    </svg>
  );
}

function DownloadGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M12 4v10.5" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M5 19.5h14" />
    </svg>
  );
}

function OpenGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5L11.5 12.5" />
      <path d="M17.5 14v3.5a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 17.5V9.5A2.5 2.5 0 0 1 7 7h3.5" />
    </svg>
  );
}

function SearchGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5" />
    </svg>
  );
}

function FilterGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M4.5 7h15" />
      <path d="M7.5 12h9" />
      <path d="M10.5 17h3" />
    </svg>
  );
}

function MoreDotsGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CrossGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

function InfoGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.9" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Aufteilen (D177): one line forking into two. */
function SplitGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M4 12h6" />
      <path d="M10 12c3 0 4-5 8-5h2" />
      <path d="M10 12c3 0 4 5 8 5h2" />
      <path d="M17.5 4.5L20 7l-2.5 2.5" />
      <path d="M17.5 14.5L20 17l-2.5 2.5" />
    </svg>
  );
}

/** Abgleichen (D177): two links of a chain, the line tied to an entry already on the books. */
function LinkGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

/** Als Regel speichern (D177): the outline star a Buchungsregel is saved with. */
function RuleGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M12 3.2l2.75 5.6 6.15.9-4.45 4.35 1.05 6.1L12 17.25 6.5 20.15l1.05-6.1L3.1 9.7l6.15-.9z" />
    </svg>
  );
}

/** Ignorieren (D177 point 5): a cross, set apart from Schliessen by its smaller reach. */
function IgnoreGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
    </svg>
  );
}

/**
 * Position entfernen (D177, final judge FAIL 2): a minus in a ring, a position taken out of a draft (never
 * a posted record). Never a cross: on the bank line × means Ignorieren only (the owner's rule).
 */
function RemoveGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12h7" />
    </svg>
  );
}

/** Anpassen (D180): two sliders, the arrangement of a surface opened for editing. */
function CustomizeGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M4 8h8.5M17.5 8H20" />
      <circle cx="15" cy="8" r="2.5" />
      <path d="M4 16h2.5M11.5 16H20" />
      <circle cx="9" cy="16" r="2.5" />
    </svg>
  );
}

/** Fertig (D180): a check, the edit mode closed. It ends an arrangement; it never commits money. */
function DoneGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Einblenden (D180): an open eye, a hidden item shown again. */
function ShowGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M2.75 12S6 5.75 12 5.75 21.25 12 21.25 12 18 18.25 12 18.25 2.75 12 2.75 12z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

/** Ausblenden (D180): the eye struck through, an item taken off the page without losing its place. */
function HideGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M2.75 12S6 5.75 12 5.75 21.25 12 21.25 12 18 18.25 12 18.25 2.75 12 2.75 12z" />
      <circle cx="12" cy="12" r="2.75" />
      <path d="M4.5 4.5l15 15" />
    </svg>
  );
}

/** Grösse ändern (D180): two arrows apart between two edges, an item made wider or narrower. */
function ResizeGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M4 6v12M20 6v12" />
      <path d="M7.5 12h9" />
      <path d="M10 9.5L7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5" />
    </svg>
  );
}

/** One entry of the vocabulary: the name a person reads and the glyph drawn for it. */
export interface VocabularyEntry {
  /** The accessible name and the tooltip's first line. A verb or a noun of action, never a sentence. */
  name: string;
  glyph: (props: GlyphProps) => ReactElement;
}

/** The twenty-two, in the order DESIGN.md lists them. Frozen: a new key is a design-law change. */
export const VOCABULARY = Object.freeze({
  edit: { name: 'Bearbeiten', glyph: EditGlyph },
  attach: { name: 'Anhängen', glyph: AttachGlyph },
  comment: { name: 'Kommentieren', glyph: CommentGlyph },
  flag: { name: 'Markieren', glyph: FlagGlyph },
  copy: { name: 'Kopieren', glyph: CopyGlyph },
  download: { name: 'Herunterladen', glyph: DownloadGlyph },
  open: { name: 'Öffnen', glyph: OpenGlyph },
  search: { name: 'Suchen', glyph: SearchGlyph },
  filter: { name: 'Filter', glyph: FilterGlyph },
  more: { name: 'Mehr', glyph: MoreDotsGlyph },
  close: { name: 'Schliessen', glyph: CrossGlyph },
  info: { name: 'Info', glyph: InfoGlyph },
  split: { name: 'Aufteilen', glyph: SplitGlyph },
  link: { name: 'Abgleichen', glyph: LinkGlyph },
  rule: { name: 'Als Regel speichern', glyph: RuleGlyph },
  ignore: { name: 'Ignorieren', glyph: IgnoreGlyph },
  remove: { name: 'Position entfernen', glyph: RemoveGlyph },
  customize: { name: 'Anpassen', glyph: CustomizeGlyph },
  done: { name: 'Fertig', glyph: DoneGlyph },
  hide: { name: 'Ausblenden', glyph: HideGlyph },
  show: { name: 'Einblenden', glyph: ShowGlyph },
  resize: { name: 'Grösse ändern', glyph: ResizeGlyph },
} satisfies Record<string, VocabularyEntry>);

/** A key of the closed vocabulary: the only thing `IconButton` accepts as its icon. */
export type VocabularyIcon = keyof typeof VOCABULARY;
