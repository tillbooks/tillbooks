/**
 * O00 (D199), the RELEASE ART: one glyph per name in `RELEASE_ICONS` (`src/core/releases/notes.ts`), drawn on
 * a soft tile beside each What's new item, plus the three kind badges (new: plus, improved: arrow up, fixed:
 * check). The website draws the same path data (`web/src/lib/release-art.ts`) so a release reads the same in
 * the Studio and on tillbooks.ch; `test/releases/whats-new.test.mjs` holds this map to the list.
 *
 * Decorative only (`aria-hidden`): the item's title says what changed, and the kind rides as screen-reader
 * text. None of these is an action glyph, so none ever stands alone on a button.
 */
import type { ReactElement } from 'react';

import { glyphBase as base, type GlyphProps } from './base';

const PATHS = {
  sparkle: 'M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z',
  upgrade: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  bank: 'M3.5 10L12 4.5 20.5 10M5.5 10v8M10 10v8M14 10v8M18.5 10v8M3.5 20h17',
  ledger: 'M6 4h11a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2zM6 18a2 2 0 0 1 2-2h11M10 8.5h5',
  receipt: 'M6 3.5h12v17l-3-2-3 2-3-2-3 2zM9.5 8.5h5M9.5 12.5h5',
  vat: 'M18 6L6 18M9 7.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM18 16.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  asset: 'M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7zM4.5 7.7L12 12l7.5-4.3M12 12v8.5',
  agent: 'M5 9.5h14v8.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM12 9.5V5.5M12 5.5h.01M9.5 13.5h.01M14.5 13.5h.01M9.5 16.5h5',
  shield: 'M12 3.5l6.5 2.6v5.2c0 4.2-2.7 7.4-6.5 9.2-3.8-1.8-6.5-5-6.5-9.2V6.1zM9 12l2.2 2.2L15.2 10',
  export: 'M13 4.5h6.5V11M19.5 4.5L11 13M17.5 14.5V19.5h-12v-12H10',
  layout: 'M4.5 5.5h15v13h-15zM4.5 10h15M10 10v8.5',
  speed: 'M13.2 3.5L5.5 13.5h5.8L10.8 20.5l7.7-10h-5.8z',
} as const;

export type ReleaseIconName = keyof typeof PATHS;

const KIND_PATHS = {
  new: 'M12 5.5v13M5.5 12h13',
  improved: 'M12 19V5.5M6.5 11l5.5-5.5 5.5 5.5',
  fixed: 'M5.5 12.5l4.2 4.2 8.8-9.2',
} as const;

export type ReleaseKind = keyof typeof KIND_PATHS;

function glyph(d: string) {
  return function ReleaseGlyph(props: GlyphProps): ReactElement {
    return (
      <svg {...base(props)}>
        <path d={d} />
      </svg>
    );
  };
}

/** The art per name. Every key here is a `RELEASE_ICONS` name. */
export const RELEASE_GLYPHS: Readonly<Record<ReleaseIconName, (props: GlyphProps) => ReactElement>> = {
  sparkle: glyph(PATHS.sparkle),
  upgrade: glyph(PATHS.upgrade),
  bank: glyph(PATHS.bank),
  ledger: glyph(PATHS.ledger),
  receipt: glyph(PATHS.receipt),
  vat: glyph(PATHS.vat),
  asset: glyph(PATHS.asset),
  agent: glyph(PATHS.agent),
  shield: glyph(PATHS.shield),
  export: glyph(PATHS.export),
  layout: glyph(PATHS.layout),
  speed: glyph(PATHS.speed),
};

export const RELEASE_KIND_GLYPHS: Readonly<Record<ReleaseKind, (props: GlyphProps) => ReactElement>> = {
  new: glyph(KIND_PATHS.new),
  improved: glyph(KIND_PATHS.improved),
  fixed: glyph(KIND_PATHS.fixed),
};
