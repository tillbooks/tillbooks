/**
 * Decorative inline glyphs for the Contacts surface.
 *
 * Each is `aria-hidden` and `focusable="false"`: the adjacent text carries the meaning, so a status
 * (party role, QR-readiness, archived) is never signalled by icon or colour alone (WCAG 2.2, spec
 * A09 §6). `currentColor` keeps every colour on a token-backed class, so no hex ever appears here.
 */
import type { SVGProps } from 'react';

import type { ActivityKind, ContactKind, PartyRole } from './model';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 14, ...rest }: GlyphProps) {
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

/** A person, marking a customer. */
export function CustomerGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

/** A building, marking a vendor. */
export function VendorGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15" />
      <path d="M15 9h3a1 1 0 0 1 1 1v10" />
      <path d="M3 20h18" />
      <path d="M8 8h.01M11 8h.01M8 12h.01M11 12h.01" />
    </svg>
  );
}

/** Two overlapping people, marking a party that is both customer and vendor. */
export function BothGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19a6 6 0 0 1 12 0" />
      <path d="M16 6.5a3 3 0 0 1 0 5.8" />
      <path d="M17 14.5a6 6 0 0 1 4 4.5" />
    </svg>
  );
}

/** Pick the role glyph for a party role. */
export function RoleGlyph({ role, ...props }: GlyphProps & { role: PartyRole }) {
  if (role === 'vendor') return <VendorGlyph {...props} />;
  if (role === 'both') return <BothGlyph {...props} />;
  return <CustomerGlyph {...props} />;
}

// --- C00, the CRM kind and activity glyphs -----------------------------------------------------
// Every one is decorative and paired with a text label at the call site, so a kind is never
// signalled by glyph or colour alone (WCAG 2.2 AA, spec C00 §6: "glyph+label everywhere").

/** An office block, marking a company contact. */
export function CompanyGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 20V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v14" />
      <path d="M15 11h4a1 1 0 0 1 1 1v8" />
      <path d="M2 20h20" />
      <path d="M7 9h.01M11 9h.01M7 13h.01M11 13h.01M7 17h.01M11 17h.01" />
    </svg>
  );
}

/** A single human, marking a person contact. */
export function PersonGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="7.5" r="3.5" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

/** Pick the kind glyph for a contact kind. */
export function KindGlyph({ kind, ...props }: GlyphProps & { kind: ContactKind }) {
  return kind === 'person' ? <PersonGlyph {...props} /> : <CompanyGlyph {...props} />;
}

/** A pencil, marking a logged note. */
export function NoteGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" />
      <path d="M13.5 7.5 16.5 10.5" />
    </svg>
  );
}

/** A handset, marking a logged call. */
export function CallGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4 5.5a2 2 0 0 1 2-2z" />
    </svg>
  );
}

/** An envelope, marking a logged email. */
export function EmailGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="5.5" width="18" height="13" rx="1.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

/** Two figures at a table, marking a logged meeting. */
export function MeetingGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="7" r="2.5" />
      <circle cx="16" cy="7" r="2.5" />
      <path d="M3.5 14a4.5 4.5 0 0 1 9 0" />
      <path d="M11.5 14a4.5 4.5 0 0 1 9 0" />
      <path d="M3 18h18" />
    </svg>
  );
}

/** A ticked box, marking a logged task. */
export function TaskGlyph(props: GlyphProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="m8 12.5 2.5 2.5L16 9.5" />
    </svg>
  );
}

/** Pick the timeline glyph for an activity kind. */
export function ActivityGlyph({ kind, ...props }: GlyphProps & { kind: ActivityKind }) {
  if (kind === 'call') return <CallGlyph {...props} />;
  if (kind === 'email') return <EmailGlyph {...props} />;
  if (kind === 'meeting') return <MeetingGlyph {...props} />;
  if (kind === 'task') return <TaskGlyph {...props} />;
  return <NoteGlyph {...props} />;
}
