/**
 * The Dateien surface's glyphs: one mark per mime kind, plus the retention lock and the pending badge.
 *
 * Every status on this screen is GLYPH PLUS TEXT and never colour alone (WCAG 2.2 AA, and the design
 * law's own rule). So each mark here is decorative and `aria-hidden`, with the adjacent label carrying
 * the meaning: a lock beside the word "Gesetzlich" survives a screen reader and a colour-blind viewer
 * alike, and a lock on its own survives neither.
 *
 * Never an emoji. An emoji is a font-dependent picture that changes size, colour and meaning across
 * platforms, and the design law names the shared glyph set for exactly that reason.
 */
import type { SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function frame({ size = 16, ...rest }: GlyphProps) {
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

/** A generic file: a sheet with a folded corner. */
function OtherGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

/** A PDF: the sheet, with lines where the text is. */
function PdfGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7M8.5 16.5h4.5" />
    </svg>
  );
}

/** An image: the frame with a horizon and a sun. */
function ImageGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="M21 16l-5-4.5L7 19" />
    </svg>
  );
}

/** A spreadsheet: the grid. */
function SheetGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M3 15h18M9.5 4v16M15 4v16" />
    </svg>
  );
}

/** Plain text: the sheet, with every line full. */
function TextGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 12h7M8.5 15h7M8.5 18h4" />
    </svg>
  );
}

const MIME_GLYPHS = {
  pdf: PdfGlyph,
  image: ImageGlyph,
  sheet: SheetGlyph,
  text: TextGlyph,
  other: OtherGlyph,
} as const;

export function MimeGlyph({ kind, ...rest }: { kind: keyof typeof MIME_GLYPHS } & GlyphProps) {
  const Glyph = MIME_GLYPHS[kind];
  return <Glyph {...rest} />;
}

/** The retention lock: a closed padlock. Always beside the word, never instead of it. */
export function LockGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
    </svg>
  );
}

/** A pending deletion: a bin with a clock's worth of waiting in front of it. */
export function PendingGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <path d="M5 7h14M10 7V5h4v2" />
      <path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
      <path d="M12 11.5v3.5l2 1" />
    </svg>
  );
}

/** A folder, for the tree rail's rows. */
export function FolderGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** The version chain, for the history section's heading. */
export function VersionsGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="7" cy="6.5" r="2.5" />
      <circle cx="7" cy="17.5" r="2.5" />
      <path d="M7 9v6" />
      <path d="M11 6.5h9M11 17.5h9" />
    </svg>
  );
}
