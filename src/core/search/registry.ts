/**
 * G07, the SEARCHABLE kind roster: which entity kinds `search_global` fans out over, and how.
 *
 * A curated, code-level enumeration (§H-ENUM, single source), NOT a per-workspace toggle: the spec's
 * §6b fixes the mechanism because the excluded rows (journal entries, accounts, bank transactions,
 * period locks, ...) are not human-named records, and a workspace opting one in would degrade every
 * search with ledger noise. The Studio mirrors `SEARCHABLE_KIND_IDS` and the mirror is guarded by
 * `test/style/studio-mirrors-engine-enums.test.mjs`, so the chips a person is offered are exactly
 * the kinds this file admits.
 *
 * ONE ROW IS THE WHOLE OPT-IN, the G00 `ENTITY_KINDS` argument restated for search: a row names the
 * kind's base table, the columns a query substring-matches, the SQL expression that renders a hit's
 * human title, the A24 read capability that fences the kind (US-G07.5: a kind the actor cannot read
 * contributes zero rows and no signal), and the Studio route a hit opens in, so no GUI or agent ever
 * hardcodes "how do I open a `deal`". Nothing in `searchGlobal.ts` switches on a kind, and
 * `test/search/search-global.test.mjs` exercises every row, so a kind added tomorrow reddens the
 * suite until it is driven.
 *
 * THE E04-E07 CONFIDENTIALITY BOUNDARY IS STRUCTURAL (US-G07.6). The local-correspondence tables
 * (`mail_message`, `mail_thread`, `mail_draft`, `voice_exemplar`, `draft_run`) have no row here and
 * no toggle that could add one, so professional-secrecy material is unreachable through this
 * surface by construction; `test/search/search-global.test.mjs` holds the roster disjoint from
 * those tables and this module free of any E04-E07 import.
 *
 * `readCapability` IS COPIED FROM NOTHING: each value below is the same capability
 * `actionCapabilities.ts` puts on that kind's own list verb (`list_contacts`, `deals_list`, ...),
 * so a search hit is exactly as hard to see as the row it points at.
 */

import type { Capability } from '../access/capabilities.js';

/** One searchable kind. Declarative facts only: the fan-out in `searchGlobal.ts` reads, never switches. */
export interface SearchableKindDef {
  /** The stable OP3-aligned id used on the wire in `entityKinds` and on every result row. */
  readonly kind: string;
  /** The base table its records live in. Every one carries `workspace_id` (§H-TENANT) and `created_at`. */
  readonly table: string;
  /** The columns a query is substring-matched against (LIKE, escaped, case-insensitive for ASCII). */
  readonly matchColumns: readonly string[];
  /** SQL expression rendering the hit's human title (a column or a COALESCE over columns). */
  readonly titleSql: string;
  /**
   * The A24 read capability fencing this kind, the same one its own list verb declares. Asserted
   * per kind inside `searchGlobal` (the F00 dashboards posture): a refusal omits the kind silently.
   */
  readonly readCapability: Capability;
  /** The Studio route a hit of this kind opens in (English slug, like every Studio route). */
  readonly route: string;
  /** Extra WHERE fragment (no parameters), e.g. to keep archived or merged-away rows out. */
  readonly extraWhere?: string;
}

/**
 * The v1 roster: nine human-named kinds. The A10 `document` row covers quotes, orders, invoices and
 * credit notes at once (they are one table and one OP3 kind). Growing the roster is one row here
 * plus a seed line in `test/search/search-global.test.mjs`, the OP3 growth rule.
 */
export const SEARCHABLE_ENTITY_KINDS: readonly SearchableKindDef[] = [
  {
    kind: 'contact',
    table: 'contact',
    matchColumns: ['name', 'email'],
    titleSql: 'name',
    readCapability: 'read_master_data',
    route: '/contacts',
    extraWhere: 'archived = 0 AND merged_into_id IS NULL',
  },
  {
    kind: 'item',
    table: 'item',
    matchColumns: ['name', 'item_sku'],
    titleSql: 'name',
    readCapability: 'read_master_data',
    route: '/items',
    extraWhere: 'archived = 0',
  },
  {
    // The shared A10 row: number is NULL while draft, so the title degrades to the type, which is
    // honest (a draft has no number to find it by; its notes still match).
    kind: 'document',
    table: 'document',
    matchColumns: ['number', 'notes'],
    titleSql: "COALESCE(number, type)",
    readCapability: 'read_sales',
    route: '/documents',
  },
  {
    kind: 'project',
    table: 'project',
    matchColumns: ['name', 'code'],
    titleSql: 'name',
    readCapability: 'read_master_data',
    route: '/projects',
  },
  {
    kind: 'deal',
    table: 'deal',
    matchColumns: ['title'],
    titleSql: 'title',
    readCapability: 'deals.read',
    route: '/deals',
  },
  {
    kind: 'task',
    table: 'task',
    matchColumns: ['title', 'notes'],
    titleSql: 'title',
    readCapability: 'tasks.read',
    route: '/tasks',
  },
  {
    kind: 'vendor_bill',
    table: 'vendor_bill',
    matchColumns: ['vendor_reference', 'receipt_ref'],
    titleSql: 'COALESCE(vendor_reference, bill_date)',
    readCapability: 'read_books',
    route: '/bills',
  },
  {
    kind: 'sales_order',
    table: 'sales_order',
    matchColumns: ['number', 'notes'],
    titleSql: 'number',
    readCapability: 'read_sales',
    route: '/sales-orders',
  },
  {
    kind: 'po',
    table: 'purchase_order',
    matchColumns: ['number', 'note'],
    titleSql: 'number',
    readCapability: 'read_master_data',
    route: '/purchasing',
  },
];

const BY_KIND: ReadonlyMap<string, SearchableKindDef> = new Map(
  SEARCHABLE_ENTITY_KINDS.map((d) => [d.kind, d]),
);

/** The registry row for a kind, or undefined when it is not searchable. */
export function searchableKindDef(kind: unknown): SearchableKindDef | undefined {
  return typeof kind === 'string' ? BY_KIND.get(kind) : undefined;
}

/** Every searchable kind id, for the Studio's scope chips and for a refusal that names the roster. */
export const SEARCHABLE_KIND_IDS: readonly string[] = SEARCHABLE_ENTITY_KINDS.map((d) => d.kind);
