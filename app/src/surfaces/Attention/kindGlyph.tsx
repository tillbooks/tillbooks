/**
 * Which glyph a Pendenzen SECTION head carries (D178; the fresh-eyes judge, N4 H1): the area or the kind,
 * said once per section. Rows carry none. The glyphs live in the shared icon module
 * (`components/icons/kinds.tsx`); this file only maps a section key onto one of them.
 */
import { KIND_GLYPHS, type KindGlyph } from '../../components/icons';

const BY_SECTION: Readonly<Record<string, KindGlyph>> = {
  bank: 'bank',
  accounting: 'ledger',
  sales: 'sales',
  system: 'system',
  approve: 'approve',
  do: 'todo',
  note: 'note',
};

/** The glyph of a section head: the area, or the kind. */
export function sectionMarkOf(key: string): KindGlyph {
  return BY_SECTION[key] ?? 'system';
}

/** A section glyph at 16px, decorative (the section's name beside it says what it is). */
export function Mark({ mark, className }: { mark: KindGlyph; className?: string }) {
  const Glyph = KIND_GLYPHS[mark];
  return <Glyph size={16} className={className} />;
}
