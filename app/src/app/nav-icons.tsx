/**
 * The rail icon for each surface, and the rail's own glyphs. One small line glyph per NavIconName,
 * drawn in `currentColor` so the active-pill accent flows through with no extra styling. Decorative:
 * the adjacent label carries the meaning, so every glyph is `aria-hidden` and `focusable="false"`. No
 * hex, ever.
 *
 * ONE `<svg>` FOR THE WHOLE RAIL (D154's one-glyph-module rule, D178). Each name maps to the SHAPES
 * inside one shared frame, so the rail's own glyphs (the favourite star, the drag grip, the chevron,
 * the move and rename arrows, the Menü glyph) live here beside the surface icons instead of in an
 * inline `<svg>` per component. `test/style/icon-vocabulary-guard.test.mjs` counts the frames.
 */
import type { ReactNode, SVGProps } from 'react';

import type { NavIconName } from './nav';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const SHAPES: Readonly<Record<NavIconName, ReactNode>> = {
  /** Übersicht (F00): a four-tile dashboard grid. */
  overview: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  /** Agent (A35): a speech bubble with a spark, the "talk to your books" surface. */
  agent: (
    <>
      <path d="M4 5h16v10H9l-4 4v-4H4z" />
      <path d="M12 8l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
    </>
  ),
  /** Suche (G07): a magnifier. */
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </>
  ),
  /** Setup: a sliders / controls glyph. */
  setup: (
    <>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="18" r="2" />
    </>
  ),
  /** Migration: an arrow crossing a threshold, a book moving across into TILL. */
  migration: (
    <>
      <path d="M4 4v16" />
      <path d="M9 12h11" />
      <path d="M16 8l4 4-4 4" />
    </>
  ),
  /**
   * A24 Zugriff: two people, not a padlock.
   *
   * The padlock belongs to the permission-denied STATE, where it says "this is closed to you". The
   * rail item is the opposite thing: a screen about who is here. Reusing the lock would make the one
   * glyph mean both "denied" and "access management", and the shared `LockGlyph` already owns the first.
   */
  members: (
    <>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3.25 3.25 0 0 1 0 4.8" />
      <path d="M17.5 14.6a5.5 5.5 0 0 1 3 4.9" />
    </>
  ),
  /** Customization: a base row with two fields grown onto it, which is what a custom field is. */
  customization: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 13h8M8 16.5h5" />
    </>
  ),
  /**
   * G01 Automatisierungen: one thing leading to another, not a gearwheel and not a robot.
   *
   * A gear is "settings" everywhere in software and would collide with Setup; a robot would say the
   * rules are the agent's, which is exactly the misreading this capability must not invite (a rule
   * runs as the person who wrote it). Two nodes and an arrow is what a trigger and an action are.
   */
  automations: (
    <>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="18" cy="17.5" r="2.5" />
      <path d="M6 9v6a3 3 0 0 0 3 3h6.2" />
      <path d="M13.2 15.2 15.5 18l-2.3 2.4" />
    </>
  ),
  /** Accounts: a chart of accounts as a stacked ledger. */
  accounts: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </>
  ),
  /** Journal: an open book of entries. */
  journal: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 1-2-2z" />
      <path d="M20 5a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 0 2-2z" />
    </>
  ),
  /** Periods: a calendar of accounting periods. */
  periods: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9h16M9 3v4M15 3v4" />
    </>
  ),
  /** VAT: a percent glyph for the tax surface. */
  vat: (
    <>
      <path d="M6 18L18 6" />
      <circle cx="7.5" cy="7.5" r="2" />
      <circle cx="16.5" cy="16.5" r="2" />
    </>
  ),
  /** Fremdwährung (A22): two currencies swapping, drawn as a pair of curved exchange arrows. */
  fx: <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  /** Contacts: a person card. */
  contacts: (
    <>
      <circle cx="12" cy="9" r="3" />
      <path d="M6 19a6 6 0 0 1 12 0" />
    </>
  ),
  /** Items: a tagged product. */
  items: (
    <>
      <path d="M4 13l7-7a2 2 0 0 1 1.4-.6H18a2 2 0 0 1 2 2v5.6a2 2 0 0 1-.6 1.4l-7 7a2 2 0 0 1-2.8 0l-5.6-5.6a2 2 0 0 1 0-2.8z" />
      <path d="M15.5 8.5h.01" />
    </>
  ),
  /**
   * Files: a folder, because the surface leads with the filing tree.
   *
   * Deliberately NOT a sheet of paper with a folded corner: that is the documents glyph two rows down
   * in this same rail, and two nearly identical page glyphs in one navigation is a texture rather than
   * a pair of destinations. The tree is what distinguishes this screen from Belege, so the tree is what
   * the glyph shows.
   */
  files: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 11h18" />
    </>
  ),
  /** Documents: a stacked sheet with lines (a Beleg). */
  documents: (
    <>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  /** Payments: banknotes, the money that moved. The Bank group's glyph (P1). */
  payments: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  /** Open items: an outstanding invoice with a clock on it. The Verkauf group's second glyph. */
  openItems: (
    <>
      <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6" />
      <path d="M6 8h7M6 12h5" />
      <circle cx="17" cy="16" r="4.5" />
      <path d="M17 14v2l1.5 1" />
    </>
  ),
  /**
   * Dunning: a bell, the reminder. Deliberately not an envelope (Belege and the send verb already own
   * mail-shaped metaphors) and not an exclamation badge (a standing rail glyph must not shout).
   */
  dunning: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5" />
      <path d="M4 16h16" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  /** Bank accounts: the register, drawn as a bank front. Sits beside Zahlungen in the Bank group. */
  bankAccounts: (
    <>
      <path d="M3 9.5 12 4l9 5.5" />
      <path d="M5 10v8M10 10v8M14 10v8M19 10v8" />
      <path d="M3 20.5h18" />
    </>
  ),
  /**
   * Reconciliation: two opposing arrows meeting, the bank line and the book line converging.
   * Deliberately not a checkmark (the settled glyph owns that) and not a magnifier (search owns it).
   */
  reconciliation: (
    <>
      <path d="M4 9h13" />
      <path d="M14 6l3 3-3 3" />
      <path d="M20 15H7" />
      <path d="M10 12l-3 3 3 3" />
    </>
  ),
  /**
   * Auswertungen: a sheet with a totalled column and a rule above the total.
   *
   * Deliberately NOT a bar chart or a pie: A08 returns statements rather than series, and a chart glyph
   * would promise the dashboards F00 owns and this surface does not have.
   */
  reports: (
    <>
      <path d="M5.5 3.5h13a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M8 7.5h8M8 11h5M8 14.5h5" />
      <path d="M13.5 17.5h3" />
    </>
  ),
  /**
   * Kreditoren (A17): an inbound document. The arrow points INTO the sheet, which is the one thing that
   * distinguishes a bill received from an invoice issued, and the Documents glyph next to it in the rail
   * has no arrow at all.
   */
  bills: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6" />
      <path d="M9.5 14.5 12 17l2.5-2.5" />
    </>
  ),
  /**
   * Recurring invoices (Serien): a document with a repeat arrow, because the surface is the standing
   * instruction that re-produces one, not the documents themselves (those live on Belege).
   */
  recurring: (
    <>
      <path d="M9 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8" />
      <path d="M8 8h5M8 12h4" />
      <path d="M13.5 17a4.5 4.5 0 1 1 1.3 3.2" />
      <path d="M13.5 21v-4h4" />
    </>
  ),
  /** Projects: a briefcase, the B00 master (judge round 1 L5: the flag it was is D154's "Markieren"). */
  projects: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="M3 12.5h18" />
    </>
  ),
  /** Time: a clock face, the B01 timesheet. */
  time: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  /** E03 Aufgaben: a checklist, two items ticked. */
  tasks: (
    <>
      <path d="M3.5 5.5 5 7l3-3" />
      <path d="M11 6h9.5" />
      <path d="M3.5 12.5 5 14l3-3" />
      <path d="M11 13h9.5" />
      <rect x="3.5" y="17.5" width="4" height="4" rx="1" />
      <path d="M11 20h9.5" />
    </>
  ),
  /** C01 Pipeline: a funnel, the canonical deals glyph. */
  deals: <path d="M3.5 4.5h17l-6.5 8v6l-4 2v-8z" />,
  /** Inventory: stacked crates on a shelf, the D01 Lager. */
  inventory: (
    <>
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 7v10l9 4 9-4V7" />
      <path d="M12 11v10" />
    </>
  ),
  /** E02 Personal: two people, the canonical HR/team glyph. */
  personal: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M15 20a4.5 4.5 0 0 1 6.5-4" />
    </>
  ),
  /** Korrespondenz: an envelope, the local mail index. Same stroke grammar as every sibling glyph. */
  correspondence: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),

  // --- The rail's own glyphs (D178) --------------------------------------------------------------
  /** The favourite star, outlined: "pin this page". */
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.2 9.7l5.9-.9z" />,
  /** The favourite star, filled: "this page is pinned". */
  starFilled: <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.2 9.7l5.9-.9z" fill="currentColor" />,
  /** Menü: three rows of a list, the section header's glyph under the `icon_14` header style. */
  menu: <path d="M5 7h14M5 12h14M5 17h14" />,
  /** The drag grip: two columns of dots, pointer-only and hidden from assistive tech. */
  grip: <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />,
  /** The disclosure chevron: points right, rotates down when its node is open (CSS). */
  chevron: <path d="M9 6l6 6-6 6" />,
  /** Move up (the WCAG 2.5.7 keyboard and single-pointer reorder). */
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  /** Move down. */
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  /** Rename a favourite (its alias). */
  rename: (
    <>
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 7.5l3 3" />
    </>
  ),
};

/** Render the glyph for a nav item (or a rail control) by its icon name, in the one shared frame. */
export function NavIcon({ name, size = 18, ...rest }: { name: NavIconName } & IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {SHAPES[name]}
    </svg>
  );
}
