/**
 * The closed icon vocabulary of Ruhig 3 (D154, DESIGN.md "Icon vocabulary").
 *
 * These thirty-three glyphs (D154's twelve, D177's five, D180's five, A41.5's Freigeben, D186's Vergleichen and Verlauf, and D187's eight), and only these, may stand alone on a button. Each means one thing everywhere,
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
 * A41.5 (07.11.2026, the owner's ruling D184 point 7) adds Freigeben, a check in a ring: the bank inbox row's
 * approve. It is the one money commit that may stand as a glyph, and only there (DESIGN.md "Icon vocabulary").
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

/**
 * Freigeben (A41.5, the owner's ruling D184 point 7): a check in a ring, a bank line approved as TILL (or
 * the agent) proposes it. The one money commit that may be a glyph alone, on the bank inbox row only, like
 * Ignorieren's ruling (D177 point 5): the row says what it books in its own columns, the name says
 * "Buchen" or "Vorschlag freigeben", and the status line undoes it (Stornieren). Never Fertig's bare check.
 */
function ApproveGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8 12.3l2.7 2.7L16 9.7" />
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

/** D186: two columns side by side, the shorter one first: a figure set against another. */
function CompareGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M8 19V11M16 19V6" />
      <path d="M5 19h14" />
    </svg>
  );
}

/** D186: a line rising over time. */
function TrendGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M4 17l5-5 4 3 7-8" />
    </svg>
  );
}

/*
 * D187 (09.11.2026, the Ruhig sweep): eight more that may stand alone, the owner's picks. None moves
 * money or deletes anything. Hinzufügen adds a row or a position inside a form, never a surface's main
 * create action, which keeps its word (D154).
 */

/** Hinzufügen (D187): a plus in a ring, a row or a position added inside a form. */
function AddGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

/** Importieren (D187): an arrow entering a page from the left, a file brought in. */
function ImportGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13.5 3.5V9H19" />
      <path d="M2.5 14.5h8.5M8.5 12l2.5 2.5L8.5 17" />
    </svg>
  );
}

/** Wiederherstellen (D187): a clock with a turning-back arrow, a backup or an earlier state. */
function RestoreGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v3.7h3.7" />
      <path d="M12 8.5V12l2.5 1.5" />
    </svg>
  );
}

/** Einstellungen (D187): a gear, the settings of this page. Never the theme's sun. */
function SettingsGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M18.59 9.96L21.02 10.17V13.83L18.59 14.04L18.1 15.22L19.67 17.08L17.08 19.67L15.22 18.1L14.04 18.59L13.83 21.02H10.17L9.96 18.59L8.78 18.1L6.92 19.67L4.33 17.08L5.9 15.22L5.41 14.04L2.98 13.83V10.17L5.41 9.96L5.9 8.78L4.33 6.92L6.92 4.33L8.78 5.9L9.96 5.41L10.17 2.98H13.83L14.04 5.41L15.22 5.9L17.08 4.33L19.67 6.92L18.1 8.78Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Aktualisieren (D187): two arrows chasing round, fetch again (the bank, the rates). */
function RefreshGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9M4.5 12a7.5 7.5 0 0 1 13.2-4.9" />
      <path d="M17.7 3.5v3.6h-3.6M6.3 20.5v-3.6h3.6" />
    </svg>
  );
}

/** Sortieren (D187): an arrow up beside an arrow down, the order of a list. */
function SortGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M8 4.5v15M4.5 8L8 4.5 11.5 8" />
      <path d="M16 19.5v-15M12.5 16l3.5 3.5 3.5-3.5" />
    </svg>
  );
}

/** Ordner öffnen (D187): a folder, a file picked on this device. */
function FolderGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** Teilen (D187): three joined nodes, a document sent to someone. */
function ShareGlyph(props: GlyphProps) {
  return (
    <svg {...glyphBase(props)}>
      <circle cx="17.5" cy="6" r="2.5" />
      <circle cx="6.5" cy="12" r="2.5" />
      <circle cx="17.5" cy="18" r="2.5" />
      <path d="M8.7 10.8l6.6-3.6M8.7 13.2l6.6 3.6" />
    </svg>
  );
}

/** One entry of the vocabulary: the name a person reads and the glyph drawn for it. */
export interface VocabularyEntry {
  /** The accessible name and the tooltip's first line. A verb or a noun of action, never a sentence. */
  name: string;
  glyph: (props: GlyphProps) => ReactElement;
}

/** The thirty-three, in the order DESIGN.md lists them. Frozen: a new key is a design-law change. */
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
  approve: { name: 'Freigeben', glyph: ApproveGlyph },
  compare: { name: 'Vergleichen', glyph: CompareGlyph },
  trend: { name: 'Verlauf', glyph: TrendGlyph },
  add: { name: 'Hinzufügen', glyph: AddGlyph },
  import: { name: 'Importieren', glyph: ImportGlyph },
  restore: { name: 'Wiederherstellen', glyph: RestoreGlyph },
  settings: { name: 'Einstellungen', glyph: SettingsGlyph },
  refresh: { name: 'Aktualisieren', glyph: RefreshGlyph },
  sort: { name: 'Sortieren', glyph: SortGlyph },
  folder: { name: 'Ordner öffnen', glyph: FolderGlyph },
  share: { name: 'Teilen', glyph: ShareGlyph },
} satisfies Record<string, VocabularyEntry>);

/** A key of the closed vocabulary: the only thing `IconButton` accepts as its icon. */
export type VocabularyIcon = keyof typeof VOCABULARY;
