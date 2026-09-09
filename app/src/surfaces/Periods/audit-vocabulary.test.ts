/**
 * The guard that stops a raw `audit.action.*` key ever reaching a user again.
 *
 * Two halves, and both must hold:
 *   1. TRANSLATED: every kind and action in the mirror has a de-CH and an en string.
 *   2. COMPLETE: the mirror covers every audit emission in the engine source. A new
 *      `ctx.audit.record({ entityKind: 'invoice', action: 'issue' })` in `src/` fails this suite
 *      until the vocabulary and both locales are extended.
 *
 * Half 2 reads `src/` from disk rather than importing it: the browser bundle must never touch engine
 * code (better-sqlite3 is native and Node-only), but a Node-side test may read the files as text.
 *
 * THE KIND SCRAPE ALSO RESOLVES SINGLE-LEVEL CONST INDIRECTION, and that hardening exists for a
 * shipped defect (kaizen K-6): src/core/procurement/landed_cost.ts emits its kind through
 * `const SOURCE_DOC_TYPE = 'landed_cost_voucher'` and `entityKind: SOURCE_DOC_TYPE, entityId: ...`,
 * the one indirected kind among the literal emitters. The literal-only scrape was blind to it, the
 * vocabulary and both locales lacked the kind, and /periods crashed in dev (tStrict throws) while
 * prod rendered a humanised English key. `entityKind: <IDENT>` with an `entityId:` sibling is now
 * scraped too, the identifier resolved to its string literal within the same file, so the next
 * const-indirected kind fails this suite by name instead of crashing the AuditPanel.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, type Messages } from '../../i18n';
import { AUDIT_ENTITY_KINDS, AUDIT_ACTIONS } from './audit-vocabulary';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../src');

/** Resolve a dot-path against a message tree, mirroring the resolver in `i18n/index.tsx`. */
function resolve(tree: Messages, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Every non-test `.ts` file under the engine root, read as text. */
function engineSources(dir = ENGINE_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...engineSources(path));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push(readFileSync(path, 'utf8'));
    }
  }
  return out;
}

const SOURCES = engineSources();

/**
 * Kinds are direct literals: `entityKind: 'workspace'`. Actions reach the record FOUR ways, and all
 * four are scraped: a literal alongside the kind, a mapper (`action: auditAction(...)`), a
 * conditional expression in the field or assigned to a variable named `action` and emitted as
 * shorthand, and a plain `const action = 'x'` indirection.
 *
 * THE CONDITIONAL SCRAPE IS A CORRECTION, not a convenience. E01's `record_event`
 * (src/core/sign/signRequests.ts) emits `view` and `decline` through
 * `const action = to === 'viewed' ? 'view' : to === 'declined' ? 'decline' : 'expire';` followed by
 * a shorthand `action,` in the record object. The literal-only scrape was blind to that shape: both
 * words were registered by hand, deleting `decline` from the vocabulary would have kept this suite
 * green, and `view` was covered only by coincidence (F02's literal `action: 'view'` in
 * src/core/portal/grants.ts). Only BRANCH literals count (`? 'view'`, `: 'decline'`): a condition
 * operand like
 * `'viewed'` names a state being compared against, never an action being emitted, and the
 * false-alarm test below holds that line. The variable scrape is scoped to the exact name `action`
 * inside a source that calls `audit.record` at all, so `const action = getAction(name)` in the API
 * layer stays out of scope.
 *
 * THE KIND SCRAPE REQUIRES AN `entityId:` SIBLING, and that narrowing is a correction rather than a
 * convenience. Until G01 landed, `entityKind: 'x'` anywhere in the engine WAS an audit emission, and
 * the scrape relied on it. G01's `core/automation/events.ts` introduced a second, unrelated use of
 * the same field name: its registry rows say which OP3 entity kind a TRIGGER EVENT is about, and they
 * are not audit records at all. The wide pattern reported `contact`, `document` and `journal_entry`
 * as uncovered audit kinds, which is a false alarm on three kinds the audit log has never emitted
 * (the journal emits `entry`, not `journal_entry`, which is the tell).
 *
 * Every real emission is an `AuditPort.record({ entityKind, entityId, action, actor, at })` call, so
 * the sibling is a property of the thing being scraped rather than of how it happens to be written.
 * Measured on the tree that landed this: the narrowed pattern keeps all TEN kinds the wide one found
 * in real emissions and drops exactly the three registry rows. A future emission that somehow omits
 * `entityId` would be missed, which is a MISS and never a false alarm, and it is not representable:
 * the port's type requires the field.
 */
/**
 * The action words in the BRANCHES of a conditional expression: `cond ? 'view' : 'decline'`.
 * A branch literal follows a `?` or a `:`; a condition operand (`to === 'viewed'`) follows an
 * operator, so it never matches. Chained ternaries fall out for free: every branch of
 * `a ? 'view' : b ? 'decline' : 'expire'` is preceded by exactly one of the two markers.
 */
function branchLiterals(expr: string): string[] {
  return [...expr.matchAll(/[?:]\s*'([a-z_]+)'/g)].map(([, word]) => word);
}

function scrapeEmissions(sources: readonly string[] = SOURCES): {
  kinds: Set<string>;
  actions: Set<string>;
} {
  const kinds = new Set<string>();
  const actions = new Set<string>();

  for (const source of sources) {
    for (const [, kind] of source.matchAll(/entityKind:\s*'([a-z_]+)',[\s\S]{0,120}?entityId:/g)) {
      kinds.add(kind);
    }

    // A kind emitted through a const, the I05 landed-cost shape (the K-6 defect, see the header):
    //   `const SOURCE_DOC_TYPE = 'landed_cost_voucher'; ... audit.record({ entityKind: SOURCE_DOC_TYPE, ... })`.
    // Single-level resolution within the same file: the identifier's `const NAME = 'literal'`
    // declaration is looked up in this source, and an identifier without one is ignored (a MISS
    // would surface as an uncovered kind elsewhere, never as a false alarm here). Unlike the
    // literal scrape, an `entityId:` sibling is NOT narrow enough for the indirected shape: the
    // A26 attention providers build `AttentionItem` rows with `entityKind: <CONST>, entityId:`
    // that are queue items and not audit records at all (`dunning_run`, `agent_action`), so this
    // pattern anchors on the `audit.record({` call itself.
    for (const [, ident] of source.matchAll(
      /audit\.record\(\{[\s\S]{0,120}?entityKind:\s*([A-Za-z_$][\w$]*)\s*[,}]/g,
    )) {
      const decl = new RegExp(`\\b(?:const|let)\\s+${ident}\\s*=\\s*'([a-z_]+)'`).exec(source);
      if (decl !== null) kinds.add(decl[1]);
    }

    // A literal action in the same record object as an entityKind, in either order.
    for (const [, action] of source.matchAll(
      /entityKind:\s*'[a-z_]+'[\s\S]{0,200}?action:\s*'([a-z_]+)'/g,
    )) {
      actions.add(action);
    }

    // A conditional action in the same record object: `action: cond ? 'view' : 'decline'`. Only
    // the branch literals count; the condition's operands are states, not actions.
    for (const [, expr] of source.matchAll(
      /entityKind:\s*'[a-z_]+'[\s\S]{0,200}?action:\s*([^,\n]*\?[^,\n]*)/g,
    )) {
      for (const word of branchLiterals(expr)) actions.add(word);
    }

    // An action assigned to a variable and emitted as shorthand, the E01 `record_event` shape:
    //   `const action = to === 'viewed' ? 'view' : 'expire'; ... record({ ..., action, ... })`.
    // Scoped to the exact name `action` in a source that records audit events at all: the API
    // layer's `const action = getAction(name)` carries no branch literal and no `audit.record`.
    if (source.includes('audit.record')) {
      for (const [, expr] of source.matchAll(/\b(?:const|let)\s+action\s*=\s*([^;]+);/g)) {
        const literal = /^\s*'([a-z_]+)'\s*$/.exec(expr);
        if (literal !== null) actions.add(literal[1]);
        else for (const word of branchLiterals(expr)) actions.add(word);
      }
    }

    // The `auditAction(source)` mapper: every string it can return is an audit action.
    const mapper = /function auditAction\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
    if (mapper !== null) {
      for (const [, action] of mapper[1].matchAll(/return\s*'([a-z_]+)'/g)) actions.add(action);
    }
  }
  return { kinds, actions };
}

describe('the scraper mechanism proves itself, every run', () => {
  // Each probe is a shape the engine really uses (or refused to use, for the false-alarm case),
  // run against a SYNTHETIC source so a regression in the scraper fails here by name instead of
  // as a silently shrunken action set. The ternary probes are the regression guard for the E01
  // blindness: before the conditional scrape landed, both returned an empty set and this suite
  // stayed green while `view` and `decline` were only covered by hand.
  it('extracts BOTH branches of a ternary assigned to `action`, and no condition operand', () => {
    const synthetic = [
      "const action = to === 'viewed' ? 'view' : to === 'declined' ? 'decline' : 'expire';\n" +
        "ctx.audit.record({ entityKind: 'sign_request', entityId: row.id, action, actor: ctx.actor, at: now });\n",
    ];
    const { actions } = scrapeEmissions(synthetic);
    expect([...actions].sort()).toEqual(['decline', 'expire', 'view']);
  });

  it('extracts both branches of an inline conditional in the action field', () => {
    const synthetic = [
      "ctx.audit.record({ entityKind: 'sign_request', entityId: row.id, action: sealed ? 'lock' : 'unlock', actor: ctx.actor, at: now });\n",
    ];
    const { actions } = scrapeEmissions(synthetic);
    expect([...actions].sort()).toEqual(['lock', 'unlock']);
  });

  it('extracts a plain `const action` indirection', () => {
    const synthetic = [
      "const action = 'archive';\n" +
        "ctx.audit.record({ entityKind: 'bank_account', entityId: row.id, action, actor: ctx.actor, at: now });\n",
    ];
    const { actions } = scrapeEmissions(synthetic);
    expect([...actions]).toEqual(['archive']);
  });

  it('raises no false alarm on an `action` variable in a source that never records audit events', () => {
    // The API layer's `const action = getAction(name)` and G01's
    // `const action = isPlainObject(patch.action) ? patch.action : undefined` must stay invisible:
    // neither carries a branch literal in an audit-recording source.
    const synthetic = ["const action = flagged ? 'looks_like_one' : 'but_is_not';\n"];
    const { actions } = scrapeEmissions(synthetic);
    expect([...actions]).toEqual([]);
  });

  it('resolves a const-indirected entityKind within the same file', () => {
    const synthetic = [
      "const SOURCE_DOC_TYPE = 'landed_cost_voucher';\n" +
        "ctx.audit.record({ entityKind: SOURCE_DOC_TYPE, entityId: voucherId, action: 'post', actor: ctx.actor, at: now });\n",
    ];
    const { kinds } = scrapeEmissions(synthetic);
    expect([...kinds]).toEqual(['landed_cost_voucher']);
  });

  it('ignores an entityKind identifier with no const declaration in the file', () => {
    // Cross-file indirection is out of scope by design: it would be a MISS (an uncovered kind
    // surfaces in the coverage assertions below), never a false alarm minted from a guessed name.
    const synthetic = [
      "ctx.audit.record({ entityKind: kindFromCaller, entityId: row.id, action: 'create', actor: ctx.actor, at: now });\n",
    ];
    const { kinds } = scrapeEmissions(synthetic);
    expect([...kinds]).toEqual([]);
  });

  it('raises no false alarm on a const-indirected entityKind outside an audit.record call', () => {
    // The A26 attention providers build queue items with `entityKind: <CONST>, entityId:` that are
    // never audit records: `dunning_run` and `agent_action` must stay invisible to this guard.
    const synthetic = [
      "const DUNNING_RUN_ENTITY_KIND = 'dunning_run';\n" +
        "items.push({ queueId: 'dunning_run', entityKind: DUNNING_RUN_ENTITY_KIND, entityId: String(r.runId) });\n",
    ];
    const { kinds } = scrapeEmissions(synthetic);
    expect([...kinds]).toEqual([]);
  });

  it('sees the real I05 const-indirected kind emission in the engine source', () => {
    // The K-6 defect this hardening exists for: src/core/procurement/landed_cost.ts emits
    // `entityKind: SOURCE_DOC_TYPE` and the literal-only scrape saw no emission at all, so
    // `landed_cost_voucher` was missing from the vocabulary and /periods crashed on rich data.
    const { kinds } = scrapeEmissions();
    expect(
      kinds.has('landed_cost_voucher'),
      'the I05 const-indirected kind `landed_cost_voucher` was not scraped',
    ).toBe(true);
  });

  it('sees the real E01 ternary emission in the engine source', () => {
    // The gap this hardening closed: src/core/sign/signRequests.ts `record_event` emits `view`
    // and `decline` through a status ternary and a shorthand `action,`, and the literal-only
    // scrape saw neither emission. Measured on the tree that landed this: `decline` was absent
    // from the old scraped set outright (this assertion FAILED), while `view` was present only
    // by coincidence, through F02's literal `action: 'view'` in src/core/portal/grants.ts. Both
    // are asserted so that neither E01 branch ever again depends on another capability's literal.
    const { actions } = scrapeEmissions();
    expect(actions.has('view'), 'the E01 ternary branch `view` was not scraped').toBe(true);
    expect(actions.has('decline'), 'the E01 ternary branch `decline` was not scraped').toBe(true);
  });
});

describe('audit vocabulary', () => {
  it('has a de-CH and an en translation for every entity kind', () => {
    for (const locale of ['de-CH', 'en'] as const) {
      const missing = AUDIT_ENTITY_KINDS.filter(
        (kind) => resolve(CATALOG[locale], `audit.entityKind.${kind}`) === undefined,
      );
      expect(missing, `untranslated entity kinds in ${locale}`).toEqual([]);
    }
  });

  it('has a de-CH and an en translation for every action', () => {
    for (const locale of ['de-CH', 'en'] as const) {
      const missing = AUDIT_ACTIONS.filter(
        (action) => resolve(CATALOG[locale], `audit.action.${action}`) === undefined,
      );
      expect(missing, `untranslated actions in ${locale}`).toEqual([]);
    }
  });

  it('covers every entity kind the engine emits', () => {
    const { kinds } = scrapeEmissions();
    expect(kinds.size, 'the engine scan found no audit emissions at all').toBeGreaterThan(0);
    // Widen the LIST, not the item. `as never` on `k` would make this `includes` call accept
    // anything at all, including a scraper that started yielding something other than strings.
    const covered: readonly string[] = AUDIT_ENTITY_KINDS;
    const uncovered = [...kinds].filter((k) => !covered.includes(k));
    expect(uncovered, 'engine entity kinds missing from AUDIT_ENTITY_KINDS').toEqual([]);
  });

  it('covers every action the engine emits', () => {
    const { actions } = scrapeEmissions();
    expect(actions.size, 'the engine scan found no audit actions at all').toBeGreaterThan(0);
    const covered: readonly string[] = AUDIT_ACTIONS;
    const uncovered = [...actions].filter((a) => !covered.includes(a));
    expect(uncovered, 'engine actions missing from AUDIT_ACTIONS').toEqual([]);
  });
});
