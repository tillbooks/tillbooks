/**
 * The rail icon for each surface. One small line glyph per NavIconName, drawn in `currentColor` so
 * the active-pill accent flows through with no extra styling. Decorative: the adjacent label carries
 * the meaning, so every glyph is `aria-hidden` and `focusable="false"`. No hex, ever.
 */
import type { ReactElement, SVGProps } from 'react';

import type { NavIconName } from './nav';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function frame({ size = 18, ...rest }: IconProps) {
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

/** Übersicht (F00): a four-tile dashboard grid. */
function OverviewIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** Setup: a sliders / controls glyph. */
function SetupIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="18" r="2" />
    </svg>
  );
}

/** Accounts: a chart of accounts as a stacked ledger. */
function AccountsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </svg>
  );
}

/** Journal: an open book of entries. */
function JournalIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 1-2-2z" />
      <path d="M20 5a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 0 2-2z" />
    </svg>
  );
}

/** Periods: a calendar of accounting periods. */
function PeriodsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9h16M9 3v4M15 3v4" />
    </svg>
  );
}

/** VAT: a percent glyph for the tax surface. */
function VatIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M6 18L18 6" />
      <circle cx="7.5" cy="7.5" r="2" />
      <circle cx="16.5" cy="16.5" r="2" />
    </svg>
  );
}

/** Contacts: a person card. */
function ContactsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="12" cy="9" r="3" />
      <path d="M6 19a6 6 0 0 1 12 0" />
    </svg>
  );
}

/** Items: a tagged product. */
function ItemsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M4 13l7-7a2 2 0 0 1 1.4-.6H18a2 2 0 0 1 2 2v5.6a2 2 0 0 1-.6 1.4l-7 7a2 2 0 0 1-2.8 0l-5.6-5.6a2 2 0 0 1 0-2.8z" />
      <path d="M15.5 8.5h.01" />
    </svg>
  );
}

/** Documents: a stacked sheet with lines (a Beleg). */
function DocumentsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  );
}

/** Payments: banknotes, the money that moved. The Bank group's glyph (P1). */
function PaymentsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  );
}

/** Open items: an outstanding invoice with a clock on it. The Verkauf group's second glyph. */
function OpenItemsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6" />
      <path d="M6 8h7M6 12h5" />
      <circle cx="17" cy="16" r="4.5" />
      <path d="M17 14v2l1.5 1" />
    </svg>
  );
}

/** Bank accounts: the register, drawn as a bank front. Sits beside Zahlungen in the Bank group. */
function BankAccountsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M3 9.5 12 4l9 5.5" />
      <path d="M5 10v8M10 10v8M14 10v8M19 10v8" />
      <path d="M3 20.5h18" />
    </svg>
  );
}

/**
 * Auswertungen: a sheet with a totalled column and a rule above the total.
 *
 * Deliberately NOT a bar chart or a pie: A08 returns statements rather than series, and a chart glyph
 * would promise the dashboards F00 owns and this surface does not have.
 */
function ReportsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M5.5 3.5h13a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M8 7.5h8M8 11h5M8 14.5h5" />
      <path d="M13.5 17.5h3" />
    </svg>
  );
}

/**
 * A24 Zugriff: two people, not a padlock.
 *
 * The padlock belongs to the permission-denied STATE, where it says "this is closed to you". The
 * rail item is the opposite thing: a screen about who is here. Reusing the lock would make the one
 * glyph mean both "denied" and "access management", and the shared `LockGlyph` already owns the first.
 */
function MembersIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3.25 3.25 0 0 1 0 4.8" />
      <path d="M17.5 14.6a5.5 5.5 0 0 1 3 4.9" />
    </svg>
  );
}

/** Customization: a base row with two fields grown onto it, which is what a custom field is. */
function CustomizationIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 13h8M8 16.5h5" />
    </svg>
  );
}

/**
 * G01 Automatisierungen: one thing leading to another, not a gearwheel and not a robot.
 *
 * A gear is "settings" everywhere in software and would collide with Setup; a robot would say the
 * rules are the agent's, which is exactly the misreading this capability must not invite (a rule
 * runs as the person who wrote it). Two nodes and an arrow is what a trigger and an action are.
 */
function AutomationsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="18" cy="17.5" r="2.5" />
      <path d="M6 9v6a3 3 0 0 0 3 3h6.2" />
      <path d="M13.2 15.2 15.5 18l-2.3 2.4" />
    </svg>
  );
}

/**
 * Kreditoren (A17): an inbound document. The arrow points INTO the sheet, which is the one thing that
 * distinguishes a bill received from an invoice issued, and the Documents glyph next to it in the rail
 * has no arrow at all.
 */
/**
 * Recurring invoices (Serien): a document with a repeat arrow, because the surface is the standing
 * instruction that re-produces one, not the documents themselves (those live on Belege).
 */
function RecurringIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M9 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8" />
      <path d="M8 8h5M8 12h4" />
      <path d="M13.5 17a4.5 4.5 0 1 1 1.3 3.2" />
      <path d="M13.5 21v-4h4" />
    </svg>
  );
}

/** E03 Aufgaben: a checklist, one item ticked. */
function DealsIcon(props: IconProps) {
  // C01, Pipeline: a funnel, the canonical deals glyph.
  return (
    <svg {...frame(props)}>
      <path d="M3.5 4.5h17l-6.5 8v6l-4 2v-8z" />
    </svg>
  );
}

// E02, Personal: two people, the canonical HR/team glyph.
function PersonalIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M15 20a4.5 4.5 0 0 1 6.5-4" />
    </svg>
  );
}

function TasksIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M3.5 5.5 5 7l3-3" />
      <path d="M11 6h9.5" />
      <path d="M3.5 12.5 5 14l3-3" />
      <path d="M11 13h9.5" />
      <rect x="3.5" y="17.5" width="4" height="4" rx="1" />
      <path d="M11 20h9.5" />
    </svg>
  );
}

function CorrespondenceIcon(props: IconProps) {
  // An envelope: the local mail index. Same stroke grammar as every sibling glyph.
  return (
    <svg {...frame(props)}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

function BillsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6" />
      <path d="M9.5 14.5 12 17l2.5-2.5" />
    </svg>
  );
}

/**
 * Files: a folder, because the surface leads with the filing tree.
 *
 * Deliberately NOT a sheet of paper with a folded corner: that is `DocumentsIcon` two rows down in
 * this same rail, and two nearly identical page glyphs in one navigation is a texture rather than a
 * pair of destinations. The tree is what distinguishes this screen from Belege, so the tree is what
 * the glyph shows.
 */
function FilesIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 11h18" />
    </svg>
  );
}

/**
 * Dunning: a bell, the reminder. Deliberately not an envelope (Belege and the send verb already own
 * mail-shaped metaphors) and not an exclamation badge (a standing rail glyph must not shout).
 */
function DunningIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5" />
      <path d="M4 16h16" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}

/**
 * Reconciliation: two opposing arrows meeting, the bank line and the book line converging.
 * Deliberately not a checkmark (the settled glyph owns that) and not a magnifier (search owns it).
 */
function ReconciliationIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M4 9h13" />
      <path d="M14 6l3 3-3 3" />
      <path d="M20 15H7" />
      <path d="M10 12l-3 3 3 3" />
    </svg>
  );
}

function MigrationIcon(props: IconProps) {
  // An arrow crossing a threshold: a book moving across into TILL.
  return (
    <svg {...frame(props)}>
      <path d="M4 4v16" />
      <path d="M9 12h11" />
      <path d="M16 8l4 4-4 4" />
    </svg>
  );
}

/** Projects: a milestone flag on a baseline, the B00 master. */
function ProjectsIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M6 21V4" />
      <path d="M6 4h11l-2.5 3.5L17 11H6" />
      <path d="M4 21h5" />
    </svg>
  );
}

/** Time: a clock face, the B01 timesheet. */
function TimeIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

/** Inventory: stacked crates on a shelf, the D01 Lager. */
function InventoryIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 7v10l9 4 9-4V7" />
      <path d="M12 11v10" />
    </svg>
  );
}

/** Suche (G07): a magnifier. */
function SearchIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </svg>
  );
}

/** Fremdwährung (A22): two currencies swapping, drawn as a pair of curved exchange arrows. */
function FxIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </svg>
  );
}

/** Agent (A35): a speech bubble with a spark, the "talk to your books" surface. */
function AgentIcon(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M4 5h16v10H9l-4 4v-4H4z" />
      <path d="M12 8l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
    </svg>
  );
}

const ICONS: Record<NavIconName, (props: IconProps) => ReactElement> = {
  agent: AgentIcon,
  search: SearchIcon,
  setup: SetupIcon,
  migration: MigrationIcon,
  members: MembersIcon,
  customization: CustomizationIcon,
  automations: AutomationsIcon,
  accounts: AccountsIcon,
  journal: JournalIcon,
  periods: PeriodsIcon,
  vat: VatIcon,
  fx: FxIcon,
  contacts: ContactsIcon,
  items: ItemsIcon,
  files: FilesIcon,
  documents: DocumentsIcon,
  payments: PaymentsIcon,
  openItems: OpenItemsIcon,
  dunning: DunningIcon,
  bankAccounts: BankAccountsIcon,
  reconciliation: ReconciliationIcon,
  reports: ReportsIcon,
  bills: BillsIcon,
  recurring: RecurringIcon,
  projects: ProjectsIcon,
  time: TimeIcon,
  tasks: TasksIcon,
  deals: DealsIcon,
  inventory: InventoryIcon,
  personal: PersonalIcon,
  correspondence: CorrespondenceIcon,
  overview: OverviewIcon,
};

/** Render the glyph for a nav item by its icon name. */
export function NavIcon({ name, ...rest }: { name: NavIconName } & IconProps) {
  const Glyph = ICONS[name];
  return <Glyph {...rest} />;
}
