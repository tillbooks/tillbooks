// @ts-check
/**
 * The §H-ENUM MIRROR guard: a list the Studio offers is the list the engine admits.
 *
 * THE DEFECT THIS EXISTS FOR. `app/src/surfaces/Customization/Customization.tsx` says so about
 * itself, in the docblock over its own copy of the entity registry: "MIRRORED, NOT INVENTED: this is
 * `ENTITY_KINDS` in `src/core/customization/entities.ts` [...] a drift here costs a rejection the
 * operator can read rather than a silent wrong write. A registry read verb would remove the mirror
 * entirely and is the right follow-up." The read verb is not coming: it would be an eleventh G00 tool
 * bought to move eight string literals across a process boundary that the type checker cannot see
 * across anyway. What the repo does instead, three times already in this directory, is derive both
 * sides and fail when they disagree. This is the fourth.
 *
 * The mirror is not one place and it is not new. The Studio restates the engine's closed enumerations
 * in at least nine files, because the browser deliberately does not import engine code (better-sqlite3
 * is native and Node-only, and `studio-sees-payloads.test.mjs` holds that line). Every one of those
 * restatements is a hand-copied list that nothing compares to its source. Two of them are load-bearing
 * enough to have already gone wrong in ways this guard would have caught the day they landed, and both
 * are recorded under KNOWN AND NOT GUARDED below rather than quietly left out.
 *
 * WHAT IS ASSERTED, AND WHY IT IS SHAPED THIS WAY.
 *
 *  1. BOTH SIDES ARE DERIVED. The engine's members are IMPORTED from `dist/`, so they are the values
 *     the shipped artifact carries and not a transcription of them. The Studio's members are read off
 *     its own AST by the TypeScript compiler. Nothing in this file spells a member name. That is the
 *     whole design constraint: a guard carrying a hand-written expected list would be a THIRD mirror,
 *     and it would be the exact defect it exists to catch. Adding a ninth entity kind or a tenth field
 *     type therefore needs no edit here, and a guard that needed one would be teaching the next author
 *     that drift is normal and the fix is to re-copy.
 *
 *  2. MEMBERS ARE COMPARED AS SETS, NOT AS SEQUENCES. The engine's order is definition order; the
 *     Studio's is display order, and it is entitled to differ (`TAX_CODE_KINDS` and the VatSettings
 *     union already disagree on where `zero` and `exempt` sit, and neither is wrong). The property
 *     that matters is that the Studio offers no value the engine would refuse and hides none it would
 *     accept. Asserting order would fail on legitimate reordering and teach people to disable this.
 *
 *  3. THE REGISTRY IS THE ONLY HAND-WRITTEN PART, and a sweep polices it. `MIRRORS` names WHICH
 *     Studio symbol answers to WHICH engine export. That pairing genuinely cannot be derived. So a
 *     reverse sweep reads every committed app source for a top-level declaration whose name matches a
 *     known engine enum export and requires it to be either registered or explicitly acknowledged,
 *     with a reason, in `NOT_A_MIRROR`. Adding a new copy of an engine list to the Studio without
 *     saying so is the failure mode this half exists for, and it is how the BankAccounts entry below
 *     was found rather than guessed at.
 *
 * KNOWN AND NOT GUARDED, deliberately, each for a stated reason:
 *
 *   - The A24 capability enum against the Studio's `capability.*` LABELS. Guarded, but not here:
 *     `test/access/studio-labels-every-capability.test.mjs` owns it, and after weighing the fold on
 *     30.07.2026 that is the right home rather than an accident of who landed first. The pairing there
 *     is engine-enum-to-JSON-CATALOGUE, resolved down a dotted path because `diagnostics.read` is
 *     stored nested, which is a different access pattern from every row below (each of which reads a
 *     DECLARED symbol out of a TypeScript AST). Two of its three tests are not engine-to-Studio
 *     comparisons at all: one checks locale-to-locale key parity, the other that every capability
 *     GROUP has a label. Folding would make this file grow a second extractor and a second comparison
 *     semantics to absorb properties it does not assert, and its subject line would stop being true.
 *     A guard with one thesis is worth more than a guard with three.
 *   - `app/src/surfaces/VatSettings/model.ts` mirrors `TAX_CODE_KINDS`, `VAT_METHODS` and
 *     `VAT_TIMINGS`, and they all AGREE today. Not registered only because that surface is being
 *     edited concurrently and a guard keyed to symbol names would fight the edit. Three rows, no other
 *     work, once it settles.
 *   - The engine's own `AUDIT_ACTIONS` (`src/core/ledger/auditLog.ts`) calls itself "the single
 *     §H-ENUM source of truth for `audit_log.action`", carries six members, is read by nothing, and
 *     the engine emits sixteen. `app/src/surfaces/Periods/audit-vocabulary.ts` carries the real
 *     sixteen and is guarded by its own vitest suite scraping `src/`. The drift there is on the ENGINE
 *     side and it is not a Studio mirror, so it does not belong in this file.
 *
 * HOW IT STAYS NON-VACUOUS. This repo has collected fourteen vacuous LOADING tests and six
 * unfalsifiable assertions, so nothing here concludes from silence. Every registry row is proved to
 * RESOLVE on both sides before any comparison is believed, the extractor is re-proved every run
 * against a synthetic source in each of the four shapes it claims to read, and the comparator is
 * re-proved every run to actually report a removed member and an added one by name. A row whose
 * Studio symbol was renamed away fails as "not found", never as "agrees".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

import ts from 'typescript';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The pairings. `engine` is a module under `dist/` and an export it carries; `studio` is a committed
 * source under `app/` and a top-level symbol declared in it.
 *
 * MEMBERS ARE NEVER SPELLED HERE. Adding a value to any engine enum below needs no edit to this file;
 * adding a NEW mirror does, and the sweep at the bottom is what forces that.
 *
 * @type {readonly { engine: { module: string, export: string }, studio: { file: string, symbol: string }, note: string }[]}
 */
const MIRRORS = [
  {
    engine: { module: 'dist/core/customization/entities.js', export: 'ENTITY_KIND_IDS' },
    studio: { file: 'app/src/surfaces/Customization/Customization.tsx', symbol: 'ENTITY_KINDS' },
    note: 'G00 OP3. The Anpassung surface renders one panel per registered entity kind; the engine refuses anything else with `unknown_entity_kind`.',
  },
  {
    engine: { module: 'dist/core/search/registry.js', export: 'SEARCHABLE_KIND_IDS' },
    studio: { file: 'app/src/surfaces/Search/model.ts', symbol: 'SEARCHABLE_KIND_IDS' },
    note: 'G07. The scope chips and the palette groups; the engine refuses anything else with `unknown_entity_kind` naming this roster.',
  },
  {
    engine: { module: 'dist/core/plugins/enums.js', export: 'PLUGIN_SOURCES' },
    studio: { file: 'app/src/surfaces/Extensions/model.ts', symbol: 'PLUGIN_SOURCES' },
    note: 'G02. Where a manifest came from (local file or a configured registry); install refuses anything else with `invalid_input`.',
  },
  {
    engine: { module: 'dist/core/accruals/index.js', export: 'ACCRUAL_KINDS' },
    studio: { file: 'app/src/surfaces/Periods/accrual-model.ts', symbol: 'ACCRUAL_KINDS' },
    note: 'A38. The four OR 958b kinds the editor offers; the engine refuses anything else with `invalid_kind` naming the four.',
  },
  {
    engine: { module: 'dist/core/accruals/index.js', export: 'PROVISION_REASONS' },
    studio: { file: 'app/src/surfaces/Periods/accrual-model.ts', symbol: 'PROVISION_REASONS' },
    note: 'A38. The Art. 960e reason list the provision drawer offers; the engine refuses anything else with `invalid_reason` naming the eight.',
  },
  {
    engine: { module: 'dist/core/plugins/enums.js', export: 'PLUGIN_STATUSES' },
    studio: { file: 'app/src/surfaces/Extensions/model.ts', symbol: 'PLUGIN_STATUSES' },
    note: 'G02. The plugin lifecycle badge on the Erweiterungen card (glyph + label); installed/disabled/incompatible are the only states the engine writes.',
  },
  {
    engine: { module: 'dist/core/plugins/enums.js', export: 'PLUGIN_CAPABILITY_KINDS' },
    studio: { file: 'app/src/surfaces/Extensions/model.ts', symbol: 'PLUGIN_CAPABILITY_KINDS' },
    note: 'G02. The four registries a manifest capability may join; the manifest schema is fixed (§6b), so a fifth kind is a core release.',
  },
  {
    engine: { module: 'dist/core/customization/fields.js', export: 'FIELD_TYPES' },
    studio: { file: 'app/src/surfaces/Customization/Customization.tsx', symbol: 'FIELD_TYPES' },
    note: 'G00 OP7. The type picker on "Feld definieren"; `defineField` answers `invalid_type` with the engine list attached.',
  },
  {
    engine: { module: 'dist/core/sales/document.js', export: 'DOCUMENT_TYPES' },
    studio: { file: 'app/src/surfaces/Documents/model.ts', symbol: 'DOCUMENT_TYPES' },
    note: 'A10. The type tabs on the Documents list.',
  },
  {
    engine: { module: 'dist/core/sales/document.js', export: 'DOCUMENT_STATUSES' },
    studio: { file: 'app/src/surfaces/Documents/model.ts', symbol: 'DocumentStatus' },
    note: 'A10, the P7 state machine. A union type rather than an array, which is why the extractor reads both shapes.',
  },
  {
    engine: { module: 'dist/core/setup/enums.js', export: 'LEGAL_FORMS' },
    studio: { file: 'app/src/surfaces/Setup/CompanyProfile.tsx', symbol: 'LEGAL_FORMS' },
    note: 'A00 §H-ENUM. The Rechtsform picker; compliance-fixed, so a spec that extends it adds the value in the engine.',
  },
  {
    engine: { module: 'dist/core/setup/enums.js', export: 'CURRENCIES' },
    studio: { file: 'app/src/surfaces/Contacts/model.ts', symbol: 'CURRENCIES' },
    note: 'A09. `validateContactFields` really does gate on this set: GBP was a fourth option here once and could only ever produce `invalid_currency`.',
  },
  {
    engine: { module: 'dist/core/setup/enums.js', export: 'CURRENCIES' },
    studio: { file: 'app/src/surfaces/Items/model.ts', symbol: 'CURRENCIES' },
    note: 'A09, the item editor. Same engine set, second copy of it.',
  },
  {
    engine: { module: 'dist/core/accounts/kmuSeed.js', export: 'ACCOUNT_TYPES' },
    studio: { file: 'app/src/surfaces/Accounts/model.ts', symbol: 'ACCOUNT_TYPES' },
    note: 'A01. The Kontoart picker; `type` is frozen after creation, so offering a wrong one is unrecoverable by edit.',
  },
  {
    engine: { module: 'dist/core/accounts/kmuSeed.js', export: 'ACCOUNT_TYPES' },
    studio: { file: 'app/src/surfaces/Accounts/model.ts', symbol: 'AccountType' },
    note: 'A01. The union behind the array above, which every other Accounts type is keyed to.',
  },
  {
    engine: { module: 'dist/core/ledger/periods.js', export: 'SEALED_LOCK_REASONS' },
    studio: { file: 'app/src/surfaces/Periods/Periods.tsx', symbol: 'SEALED_REASONS' },
    note: 'A03. Decides whether a hard lock renders an active Unlock control. A reason missing here offers Unlock on a sealed period.',
  },
  {
    engine: { module: 'dist/core/sales/itemEnums.js', export: 'ITEM_KINDS' },
    studio: { file: 'app/src/surfaces/Items/model.ts', symbol: 'ITEM_KINDS' },
    note: 'D00. The Produkt/Dienstleistung picker in the item editor; the engine refuses anything else with invalid_kind, and D01/D02/D03 branch on the exact values.',
  },
  {
    engine: { module: 'dist/core/sales/itemEnums.js', export: 'ITEM_UNITS' },
    studio: { file: 'app/src/surfaces/Items/model.ts', symbol: 'ITEM_UNITS' },
    note: 'D00. The Einheit picker in the item editor; the engine refuses anything else with invalid_unit.',
  },
  {
    engine: { module: 'dist/core/projects/enums.js', export: 'PROJECT_STATUSES' },
    studio: { file: 'app/src/surfaces/Projects/model.ts', symbol: 'PROJECT_STATUSES' },
    note: 'B00. The status filter and the glyph/label chips on the Projekte list; the engine refuses anything else with invalid_status.',
  },
  {
    engine: { module: 'dist/core/time/enums.js', export: 'TIME_STATUSES' },
    studio: { file: 'app/src/surfaces/Time/model.ts', symbol: 'TIME_STATUSES' },
    note: 'B01. The glyph/label chips on the Zeit sheet; the engine refuses anything else with invalid_status.',
  },
  {
    engine: { module: 'dist/core/time/enums.js', export: 'RATE_CARD_SCOPES' },
    studio: { file: 'app/src/surfaces/Time/model.ts', symbol: 'RATE_CARD_SCOPES' },
    note: 'B01. The Geltung picker on the Tarife card; the engine refuses anything else with invalid_rate_card, and resolveRate precedence depends on exactly this set.',
  },
  {
    engine: { module: 'dist/core/checklists/runs.js', export: 'CHECKLIST_DERIVED_ITEM_STATUSES' },
    studio: { file: 'app/src/surfaces/Checklists/model.ts', symbol: 'ItemStatus' },
    note: 'G22 leg 2 (spec §10.1). The derived item status the run detail renders a word for; `excluded` is derived from a choice and never stored, and a Studio that lacks it would render an excluded row as open.',
  },
];

/**
 * App-file declarations whose NAME collides with an engine enum export but which are NOT mirrors of
 * it. Each needs a reason, because the sweep below treats an unexplained collision as a new mirror.
 *
 * @type {readonly { file: string, symbol: string, why: string }[]}
 */
const NOT_A_MIRROR = [
  {
    file: 'app/src/surfaces/BankAccounts/BankAccountEditor.tsx',
    symbol: 'CURRENCIES',
    why:
      'Its docblock claims to mirror "the currencies the engine admits" and that claim is FALSE for ' +
      'this field. A19 validates a bank account currency with `isCurrencyCode` (`src/core/fx/rateMath.ts`, ' +
      '`/^[A-Z]{3}$/`), never with `setup/enums.ts CURRENCIES`, which `src/core/banking/` does not ' +
      'import at all. So a GBP Bankkonto is engine-legal and unreachable through this picker. Whether ' +
      'the three-way picker is the right product answer is a UX call and not this guard\'s to make; ' +
      'binding it to CURRENCIES here would encode the false claim instead of the real rule.',
  },
];

/** Every committed source under `app/src`, from git rather than a directory walk. */
function committedAppSources() {
  return execFileSync('git', ['ls-files', 'app/src/**/*.ts', 'app/src/**/*.tsx'], { env: cleanGitEnv(),
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

/**
 * The engine's members for one export, normalised to a sorted array of strings.
 *
 * Read from the BUILT artifact, because the root suites run against `dist/` and a source-text scrape
 * would be a second parser to keep honest. `Set` and readonly-array spellings are both in use across
 * the engine's enum modules, so both are accepted; anything else returns undefined and is reported by
 * the resolution test rather than silently treated as empty.
 *
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function normaliseEngineMembers(value) {
  const items = value instanceof Set ? [...value] : Array.isArray(value) ? value : undefined;
  if (items === undefined) return undefined;
  if (!items.every((item) => typeof item === 'string')) return undefined;
  return [...items].sort();
}

/**
 * The string members of a type node, when it is a closed union of string literals.
 *
 * @param {import('typescript').TypeNode} node
 * @returns {string[] | undefined}
 */
function unionMembers(node) {
  /** @param {import('typescript').TypeNode} member */
  const literal = (member) =>
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : undefined;

  const parts = ts.isUnionTypeNode(node) ? [...node.types] : [node];
  /** @type {string[]} */
  const found = [];
  for (const part of parts) {
    const text = literal(part);
    if (text === undefined) return undefined;
    found.push(text);
  }
  return found;
}

/**
 * The string members of an initializer expression, through the four spellings the Studio uses:
 * `['a']`, `['a'] as const`, `new Set(['a'])`, and a parenthesised form of any of them.
 *
 * @param {import('typescript').Expression | undefined} node
 * @returns {string[] | undefined}
 */
function initializerMembers(node) {
  if (node === undefined) return undefined;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return initializerMembers(node.expression);
  }
  if (ts.isNewExpression(node)) {
    const callee = node.expression;
    if (!ts.isIdentifier(callee) || callee.text !== 'Set') return undefined;
    return initializerMembers(node.arguments === undefined ? undefined : node.arguments[0]);
  }
  if (!ts.isArrayLiteralExpression(node)) return undefined;

  /** @type {string[]} */
  const found = [];
  for (const element of node.elements) {
    if (!ts.isStringLiteral(element)) return undefined;
    found.push(element.text);
  }
  return found;
}

/**
 * The members a Studio source declares for a symbol, sorted, or undefined when the symbol is absent or
 * is not a shape this guard can read.
 *
 * TOP LEVEL ONLY, and that is deliberate rather than a limitation: an enumeration the whole surface is
 * keyed to belongs at module scope, and a symbol that moved inside a component comes back as "not
 * found", which fails loudly instead of passing quietly.
 *
 * @param {string} text
 * @param {string} fileName
 * @param {string} symbol
 * @returns {string[] | undefined}
 */
function studioMembers(text, fileName, symbol) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === symbol) {
      const members = unionMembers(statement.type);
      return members === undefined ? undefined : [...members].sort();
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== symbol) continue;
      const members = initializerMembers(declaration.initializer);
      return members === undefined ? undefined : [...members].sort();
    }
  }
  return undefined;
}

/** Every top-level const or type-alias name a Studio source declares, paired with its file. */
function declaredTopLevelNames(/** @type {string} */ rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true);
  /** @type {string[]} */
  const names = [];
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) names.push(statement.name.text);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    }
  }
  return names;
}

/** The engine modules this file pairs against, loaded once. */
const ENGINE_MODULES = new Map(
  await Promise.all(
    [...new Set(MIRRORS.map((m) => m.engine.module))].map(
      /** @returns {Promise<[string, Record<string, unknown>]>} */
      async (module) => [module, await import(join(ROOT, module))],
    ),
  ),
);

/**
 * The engine members for a registry row.
 *
 * @param {{ module: string, export: string }} engine
 * @returns {string[] | undefined}
 */
function engineMembers(engine) {
  const namespace = ENGINE_MODULES.get(engine.module);
  return namespace === undefined ? undefined : normaliseEngineMembers(namespace[engine.export]);
}

/** A registry row's Studio members, read from disk. */
function studioMembersFor(/** @type {{ file: string, symbol: string }} */ studio) {
  return studioMembers(readFileSync(join(ROOT, studio.file), 'utf8'), studio.file, studio.symbol);
}

// ---------------------------------------------------------------------------------------------
// The corpus is real
// ---------------------------------------------------------------------------------------------

test('the corpus is real: the app sources resolve and the registry is not empty', () => {
  const sources = committedAppSources();
  assert.ok(
    sources.length >= 100,
    `only ${sources.length} app sources found: the glob is wrong, and the sweep below is vacuous`,
  );
  assert.ok(
    MIRRORS.length >= 10,
    `${MIRRORS.length} mirrors registered. Rows are added when a mirror is found and removed only ` +
      'when the mirror itself is deleted; a shrinking registry means someone silenced this guard ' +
      'rather than fixing what it caught.',
  );
});

test('every registered mirror RESOLVES on both sides, so no row is silently skipped', () => {
  /** @type {string[]} */
  const broken = [];
  for (const mirror of MIRRORS) {
    const engine = engineMembers(mirror.engine);
    const studio = studioMembersFor(mirror.studio);
    if (engine === undefined || engine.length === 0) {
      broken.push(
        `${mirror.engine.module} has no readable string enumeration exported as \`${mirror.engine.export}\`. ` +
          'Either it was renamed, or it stopped being a Set / readonly string array. Run `npm run build` first: ' +
          'this reads `dist/`.',
      );
    }
    if (studio === undefined || studio.length === 0) {
      broken.push(
        `${mirror.studio.file} declares no readable top-level \`${mirror.studio.symbol}\`. Either the mirror ` +
          'was renamed or removed (delete the row, and say so), or it moved inside a function, or it is now ' +
          'built by an expression this extractor cannot read.',
      );
    }
  }
  assert.deepEqual(
    broken,
    [],
    `a registered mirror could not be read, so its comparison below proves nothing:\n  ${broken.join('\n  ')}`,
  );
});

// ---------------------------------------------------------------------------------------------
// The mechanism proves itself, every run
// ---------------------------------------------------------------------------------------------

test('mechanism: the extractor reads all four spellings the Studio actually uses', () => {
  const cases = [
    ['plain array', "export const A: readonly string[] = ['b', 'a'];\n", 'A'],
    ['as const', "const A = ['b', 'a'] as const;\n", 'A'],
    ['new Set', "const A = new Set(['b', 'a']);\n", 'A'],
    ['union type', "export type A = 'b' | 'a';\n", 'A'],
  ];
  for (const [label, text, symbol] of cases) {
    assert.deepEqual(
      studioMembers(String(text), 'probe.ts', String(symbol)),
      ['a', 'b'],
      `the extractor could not read the ${String(label)} spelling, so any registry row using it would ` +
        'fail as "not found" and accuse the code of a drift that is really a hole in this parser.',
    );
  }
});

test('mechanism: the extractor reports NOT FOUND rather than empty, which is what makes silence safe', () => {
  assert.equal(
    studioMembers("const OTHER = ['a'];\n", 'probe.ts', 'ABSENT'),
    undefined,
    'a symbol that is not declared came back as something other than undefined, so a renamed mirror ' +
      'would compare as an empty list instead of failing.',
  );
  assert.equal(
    studioMembers('const A = buildIt();\n', 'probe.ts', 'A'),
    undefined,
    'an initializer this extractor cannot read came back readable. A shape it does not understand must ' +
      'be reported, never guessed at.',
  );
  assert.equal(
    studioMembers("function f() { const A = ['a']; return A; }\n", 'probe.ts', 'A'),
    undefined,
    'a declaration nested inside a function was read as a top-level one.',
  );
});

test('mechanism: the comparator really names a missing member and an extra one', () => {
  // The verdict below reads an empty difference as agreement. That reading is only safe if a real
  // difference is reported, which is the one thing a comparator bug would silently take away.
  const engine = ['a', 'b', 'c'];
  assert.deepEqual(
    engine.filter((m) => !['a', 'c'].includes(m)),
    ['b'],
    'a member present in the engine and absent from the Studio was not reported as missing',
  );
  assert.deepEqual(
    ['a', 'b', 'c', 'd'].filter((m) => !engine.includes(m)),
    ['d'],
    'a member the Studio offers and the engine does not admit was not reported as extra',
  );
});

test('mechanism: the engine side really comes from `dist/`, not from a re-read of the source', () => {
  // Cheap, and it catches the failure a green guard cannot otherwise tell from success: a path that
  // drifted onto `src/`, which `npm run build` would then never refresh.
  for (const mirror of MIRRORS) {
    assert.ok(
      mirror.engine.module.startsWith('dist/'),
      `${mirror.engine.module} is not under dist/. Root suites run against the BUILT engine; a row ` +
        'pointed at src/ would compare the Studio to code that was never compiled.',
    );
  }
  assert.equal(
    normaliseEngineMembers('not an enumeration'),
    undefined,
    'a non-enumeration normalised to something readable, so a renamed export would compare as empty',
  );
});

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

test('every Studio mirror offers exactly the members its engine enumeration admits', () => {
  /** @type {string[]} */
  const drifted = [];
  for (const mirror of MIRRORS) {
    const engine = engineMembers(mirror.engine) ?? [];
    const studio = studioMembersFor(mirror.studio) ?? [];
    const missing = engine.filter((member) => !studio.includes(member));
    const extra = studio.filter((member) => !engine.includes(member));
    if (missing.length === 0 && extra.length === 0) continue;

    drifted.push(
      `${mirror.studio.file} \`${mirror.studio.symbol}\` has drifted from ` +
        `${mirror.engine.module} \`${mirror.engine.export}\`\n` +
        `      ${mirror.note}\n` +
        (missing.length > 0
          ? `      MISSING from the Studio (the engine admits it, no screen offers it): ${missing.join(', ')}\n`
          : '') +
        (extra.length > 0
          ? `      EXTRA in the Studio (offered on screen, the engine refuses it): ${extra.join(', ')}\n`
          : '') +
        `      engine: ${engine.join(', ')}\n` +
        `      studio: ${studio.join(', ')}`,
    );
  }

  assert.deepEqual(
    drifted,
    [],
    'the Studio and the engine disagree about what a closed enumeration contains:\n\n  ' +
      drifted.join('\n\n  ') +
      '\n\nFIX THE STUDIO, not this file. An EXTRA member is a control that can only ever produce a ' +
      'rejection, which is the dead end the Contacts surface removed GBP for. A MISSING one is a ' +
      'capability the engine has and no screen can reach. If the engine list is what changed, the ' +
      'mirror is what has to follow it: this guard carries no member names of its own precisely so ' +
      'that re-copying is the only available fix.',
  );
});

// ---------------------------------------------------------------------------------------------
// The sweep: a NEW mirror cannot appear unannounced
// ---------------------------------------------------------------------------------------------

test('no app file restates an engine enumeration without being registered or acknowledged', () => {
  // The registry above is the one hand-written thing in this file, so it needs its own ratchet.
  // Keyed on exact name collision with an engine enum export, which is how the BankAccounts entry in
  // NOT_A_MIRROR was found: it is narrow enough to be nearly free of false positives and wide enough
  // to catch the realistic failure, which is someone copying a list and naming it after its source.
  const engineNames = new Set(MIRRORS.map((m) => m.engine.export));
  const registered = new Set(MIRRORS.map((m) => `${m.studio.file}#${m.studio.symbol}`));
  const acknowledged = new Set(NOT_A_MIRROR.map((n) => `${n.file}#${n.symbol}`));

  /** @type {string[]} */
  const unannounced = [];
  for (const rel of committedAppSources()) {
    for (const name of declaredTopLevelNames(rel)) {
      if (!engineNames.has(name)) continue;
      const key = `${rel}#${name}`;
      if (registered.has(key) || acknowledged.has(key)) continue;
      unannounced.push(key);
    }
  }

  assert.deepEqual(
    unannounced,
    [],
    'an app file declares a top-level symbol named after an engine enumeration, and this guard has ' +
      `never been told about it:\n  ${unannounced.join('\n  ')}\n\n` +
      'If it really mirrors that engine export, add it to `MIRRORS` and it is guarded from now on. If ' +
      'it only shares the name, add it to `NOT_A_MIRROR` WITH A REASON. Do not delete the collision by ' +
      'renaming the symbol: the name is the honest part.',
  );
});

test('every acknowledged non-mirror still exists, so the exemption list cannot rot', () => {
  /** @type {string[]} */
  const stale = [];
  for (const entry of NOT_A_MIRROR) {
    if (studioMembers(readFileSync(join(ROOT, entry.file), 'utf8'), entry.file, entry.symbol) === undefined) {
      stale.push(`${entry.file}#${entry.symbol}`);
    }
    assert.ok(
      entry.why.length > 80,
      `${entry.file}#${entry.symbol} is exempted with a reason too short to be one. An exemption ` +
        'without an argument is just a hole.',
    );
  }
  assert.deepEqual(
    stale,
    [],
    `an entry in NOT_A_MIRROR no longer exists, so it is exempting nothing:\n  ${stale.join('\n  ')}\n` +
      'Delete the entry. A stale exemption is how a real mirror later slips in under a name that ' +
      'was cleared years ago.',
  );
});

test('the guard is reading the repo it names', () => {
  assert.ok(
    readFileSync(join(ROOT, 'package.json'), 'utf8').includes('"tillbooks"'),
    `ROOT resolved to ${relative(process.cwd(), ROOT)}, which is not this repo`,
  );
});
