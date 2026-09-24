/**
 * The guard that stops a LOADING-state test being vacuous again.
 *
 * THE DEFECT THIS EXISTS FOR. Fourteen tests across ten files were written in one shape: render the
 * surface against a never-answering transport, assert `role="status"`, return. Every surface here
 * initialises `loading` to `true`, so the skeleton is on screen at the FIRST COMMIT, before any
 * effect has fired. The assertion therefore could not tell a read in flight from a read that never
 * started, from a surface with no read at all. Two of the fourteen asserted ABSENCE, where a dead
 * component is indistinguishable from a loading one. All fourteen would have stayed green while
 * their surface quietly stopped asking the engine for anything.
 *
 * They are fixed and `test-transport.ts` now makes the correct form the easy one. But a convention
 * enforced by an audit that happened once is a convention that decays with the next surface. This
 * suite enforces it mechanically, and it enforces it the way `Periods/audit-vocabulary.test.ts` and
 * the i18n literal-key scan do: by reading the test sources from DISK as text. Importing them would
 * run them; parsing them as text is what lets a test make a claim about every other test.
 *
 * THE RULE. A block classified as a LOADING-state test must either PROVE the request it is
 * asserting over really went in flight, or carry the explicit opt-out below. There is no third way
 * and no silent exception inside the matcher.
 *
 * WHAT COUNTS AS CLASSIFIED (any one of three arms, because a title is prose and prose drifts):
 *   T  the title names the loading state ("LOADING:", "loading", "skeleton", "in flight", ...)
 *   B  the body holds the surface open with a transport that never answers
 *   A  the body asserts the loading affordance itself (role="status", aria-busy)
 * The arms overlap heavily on purpose. Today every A-classified block is also T-classified, so the
 * A arm costs nothing in false positives and covers the case a future test is named creatively.
 *
 * WHAT COUNTS AS PROOF (either):
 *   1. `transport.started(...)`, the shared seam. This is the form the convention wants, because it
 *      fails by NAME ("it asked list_contacts, never list_accounts") instead of by timeout.
 *   2. A request counter the fake transport increments and the block then asserts on
 *      (`qrRequests += 1` in the handler, `expect(qrRequests).toBe(1)` in the test). Three tests
 *      predate the seam and prove it this way, which is evidence of exactly the same fact.
 *
 * FALSE POSITIVES are loud and cheap: the suite names the block and the author either adds the
 * proof or registers the opt-out. FALSE NEGATIVES are silent, which is why the classifier is
 * deliberately wide and the proof deliberately narrow. The residual gap is honest and worth naming:
 * a test that hangs its transport through some helper this scan does not recognise, is titled
 * without any of the loading vocabulary, AND asserts the skeleton through neither `role="status"`
 * nor `aria-busy`, would slip all three arms. Nothing in the app is written that way today.
 *
 * THE OPT-OUT. A block that genuinely has no request to prove carries, inside its own body:
 *
 *     // LOADING-PROOF-EXEMPT: <one line saying why the assertion cannot be vacuous>
 *
 * and is registered in `EXEMPTIONS` below with the same reason, verbatim. The marker alone is not
 * enough: registering it is what puts a second pair of eyes on the escape hatch, and an exemption
 * that is no longer needed fails here rather than rotting in place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_SRC = dirname(fileURLToPath(import.meta.url));

/**
 * This file is excluded from its own scan, by exact path rather than by pattern.
 *
 * It is the guard, not a surface test: it necessarily contains every word and every shape it
 * searches for, and scanning itself would flag its own fixtures. Naming the one file here is the
 * visible form of that exclusion; a pattern like "skip anything with `convention` in the name"
 * would quietly widen over time.
 */
const SELF = join(APP_SRC, 'loading-state-convention.test.ts');

// --- reading the tests off disk -------------------------------------------------------------------

function testFiles(dir: string = APP_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(entry.name) && path !== SELF) out.push(path);
  }
  return out.sort();
}

interface Block {
  /** Path relative to `app/src`, which is how `EXEMPTIONS` addresses a test. */
  file: string;
  /** The `it(...)` title, exactly as written. */
  title: string;
  /** The block's source text, comments included, from its opening brace to its closing one. */
  body: string;
}

/**
 * Every `it(...)` / `test(...)` block in a file, with its body.
 *
 * The scan is a small tokenizer rather than a regex over lines, because the bodies contain braces
 * inside strings, template literals and regex literals (`/.{1,4}/g` is in this very repo), and a
 * naive brace count walks off the end of the file at the first one. Strings, template literals with
 * nested `${}`, comments and regex literals are all skipped, so the braces that ARE counted are the
 * ones the parser would count. `it.each`, `it.skip` and `test(` are all recognised.
 */
function blocksIn(source: string): Omit<Block, 'file'>[] {
  const found: Omit<Block, 'file'>[] = [];
  const braces: number[] = [];
  const pending: { title: string; brace: number }[] = [];
  let i = 0;
  let prev = '';
  const n = source.length;

  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // An `it(`/`test(` opener. Matched before the string arm so the title is read here, not skipped.
    const opener = /^(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])/.exec(source.slice(i, i + 40));
    if (opener !== null && !/[\w$.'"`]/.test(source[i - 1] ?? '')) {
      const quote = opener[1];
      let j = i + opener[0].length;
      let title = '';
      while (j < n && source[j] !== quote) {
        if (source[j] === '\\') {
          title += source[j + 1];
          j += 2;
          continue;
        }
        title += source[j];
        j += 1;
      }
      // The body's brace is the next one opened; it is bound when that brace is seen.
      pending.push({ title, brace: -1 });
      i = j + 1;
      prev = quote;
      continue;
    }

    const c = source[i];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && source[i] !== c) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      prev = c;
      continue;
    }
    if (c === '`') {
      i += 1;
      let depth = 0;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source.slice(i, i + 2) === '${') {
          depth += 1;
          i += 2;
          continue;
        }
        if (source[i] === '}' && depth > 0) {
          depth -= 1;
          i += 1;
          continue;
        }
        if (source[i] === '`' && depth === 0) break;
        i += 1;
      }
      i += 1;
      prev = '`';
      continue;
    }
    // A `/` after an operator or an opening bracket starts a regex; after a value it is division.
    if (c === '/' && '(,=:[!&|?{};+-*%~^'.includes(prev)) {
      i += 1;
      let inClass = false;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '\n') break;
        else if (source[i] === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      prev = '/';
      continue;
    }
    if (c === '{') {
      for (const p of pending) if (p.brace === -1) p.brace = i;
      braces.push(i);
      i += 1;
      prev = c;
      continue;
    }
    if (c === '}') {
      const opened = braces.pop();
      for (let k = pending.length - 1; k >= 0; k -= 1) {
        if (pending[k].brace === opened) {
          found.push({ title: pending[k].title, body: source.slice(opened, i + 1) });
          pending.splice(k, 1);
        }
      }
      i += 1;
      prev = c;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return found;
}

function allBlocks(): Block[] {
  return testFiles().flatMap((path) => {
    const file = relative(APP_SRC, path);
    return blocksIn(readFileSync(path, 'utf8')).map((b) => ({ file, ...b }));
  });
}

// --- the rule -------------------------------------------------------------------------------------

/** T: the title names the loading state. */
const LOADING_TITLE = /\bloading\b|\bskeleton\b|\bin flight\b|\bpending\b|\bbusy\b|\bspinner\b/i;

/** B: the body holds the surface open with a transport that never answers. */
const HANGING_TRANSPORT = /neverSettles|\bhang\(|new Promise<[^>]*>\(\(\) => \{\}\)|new Promise\(\(\) => \{\}\)/;

/** A: the body asserts the loading affordance itself. */
const LOADING_AFFORDANCE = /ByRole\(\s*'status'|aria-busy/;

/** The canonical proof: the shared seam from `test-transport.ts`. */
const STARTED_SEAM = /\.started\(/;

/** The opt-out marker. The reason may run onto the following comment lines (see `exemptionReason`). */
const EXEMPT_MARKER = /LOADING-PROOF-EXEMPT:/;

function isLoadingTest(block: Block): boolean {
  return (
    LOADING_TITLE.test(block.title) ||
    HANGING_TRANSPORT.test(block.body) ||
    LOADING_AFFORDANCE.test(block.body)
  );
}

/**
 * A request counter the fake transport increments and the block then asserts on. Both halves must be
 * present and name the SAME identifier: an increment nobody checks proves nothing, and an assertion
 * over something the transport never touched is not about the request.
 */
function assertsARequestCounter(body: string): boolean {
  const counters = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*(?:\+= 1|\+\+)/g)].map((m) => m[1]);
  return counters.some((name) => new RegExp(`expect\\(\\s*${name}\\b`).test(body));
}

function provesTheRequestStarted(block: Block): boolean {
  return STARTED_SEAM.test(block.body) || assertsARequestCounter(block.body);
}

/**
 * The reason a block declares for opting out, or null when it declares none.
 *
 * The reason may run onto the comment lines directly below the marker, so a sentence worth reading
 * does not have to fit in one 180-column line. It ends at the first line that is not a comment, or
 * at a blank comment line, which is what separates the reason from the test's ordinary commentary.
 */
function exemptionReason(block: Block): string | null {
  const lines = block.body.split('\n');
  const at = lines.findIndex((line) => EXEMPT_MARKER.test(line));
  if (at === -1) return null;

  const parts = [lines[at].replace(/^[\s\S]*LOADING-PROOF-EXEMPT:/, '').trim()];
  for (let i = at + 1; i < lines.length; i += 1) {
    const continued = /^\s*\/\/ ?(.*)$/.exec(lines[i]);
    if (continued === null || continued[1].trim() === '') break;
    parts.push(continued[1].trim());
  }
  return parts.join(' ').trim();
}

/**
 * Every block allowed to assert a loading state without proving a request, and why.
 *
 * Each entry must match a marker in the test's own body, verbatim. Seven is the whole list, and it
 * should stay roughly that size: an exemption is for a test with NO request to prove, never for a
 * test that would be inconvenient to fix.
 *
 * Three of the seven are G08's, and they share one cause worth naming once: `role="status"` is not
 * only the skeleton's role. `FeedbackDialog` announces a finished clipboard copy through the same
 * role, with no `aria-busy` on it, so the A arm of the classifier reaches three blocks whose
 * `role="status"` is a confirmation of something that already happened rather than a load in
 * flight. Two of those three additionally assert the transport was never called. Narrowing the A
 * arm to `aria-busy` would retire them, and would also retire the arm's whole reason for existing:
 * it is the one arm that still fires when a future test is titled creatively.
 */
const EXEMPTIONS: { file: string; title: string; reason: string }[] = [
  {
    file: 'surfaces/Migration/Migration.test.tsx',
    title: 'renders the shared no-workspace state, not a permanent skeleton, when no workspace is selected',
    reason:
      'workspaceId is null, so load() returns before any transport call; the assertion is that the surface renders the no-workspace state INSTEAD of reading, and there is nothing in flight to prove.',
  },
  {
    file: 'app/identity.test.tsx',
    title: 'is ABSENT while whoami is still loading (null), never a placeholder identity',
    reason:
      'IdentityChip reads whoami from CapabilitiesProvider context, and this test injects whoami=null directly through withCaps, so there is no transport and nothing in flight to prove.',
  },
  {
    file: 'app/identity.test.tsx',
    title: 'renders the surface while whoami is loading (null), never blanking a working ledger',
    reason:
      'IdentityGate reads whoami from CapabilitiesProvider context, and this test injects whoami=null directly through withCaps, so there is no transport and nothing in flight to prove.',
  },
  {
    file: 'surfaces/Operations/SyncHosting.test.tsx',
    title: 'CONSUMER READOUT: the honest ◌ no-readout line shows when publishing, never a green in-sync',
    reason:
      'the role=status here is the consumer-readout RESULT live region, not a loading affordance; the honest no-readout line it asserts can only exist after get_sync_contract really answered.',
  },
  {
    file: 'surfaces/Files/SignSection.test.tsx',
    title: 'renders the loading state',
    reason:
      'SignSection is presentational: the null requests prop the parent passes drives the skeleton, so there is no transport, no request, and nothing in flight to prove.',
  },
  {
    file: 'surfaces/Journal/ArchiveTab.test.tsx',
    title: 'keeps the purge behind the overflow on the periods view, and renders retention_active with the statute',
    reason:
      'the role=status here is the PURGE RESULT live region, not a loading affordance; the refusal it asserts can only exist after gl_archive_purge really answered.',
  },
  {
    file: 'surfaces/FixedAssets/AssetReconciliation.test.tsx',
    title: 'reports the balanced check when every account reconciles',
    reason:
      'the role=status here is the reconciliation RESULT live region, not a loading affordance; the balanced verdict it asserts can only exist after asset_reconciliation_check really answered.',
  },
  {
    file: 'components/states/states.test.tsx',
    title: 'announces the loading state and renders the requested block count',
    reason:
      'A component unit test: Skeleton is rendered directly with props, so there is no transport, ' +
      'no request, and nothing that could be in flight to prove.',
  },
  {
    file: 'surfaces/Journal/Journal.test.tsx',
    title: 'B3: holds Post while a VAT preview is in flight, so a stale figure can never be posted',
    reason:
      'The affordance is not the default here: Post is asserted ENABLED first, so the disable that ' +
      'follows can only come from a preview that really went in flight.',
  },
  {
    file: 'surfaces/Vat/TaxCodePicker.test.tsx',
    title: 'loading: renders a disabled real select inside the caller skeleton',
    reason:
      'The picker takes its loading state as a prop and the CALLER owns the read, so this test has ' +
      'no request of its own to prove.',
  },
  {
    file: 'surfaces/VatSettings/VatSettings.test.tsx',
    title: 'shows and KEEPS the "Gespeichert" confirmation after a config save, with no skeleton flash',
    reason:
      'A success-path test that names the skeleton only to assert its ABSENCE after a save. It ' +
      'reads the saved config before it asserts, so a surface that never read would fail earlier.',
  },
  {
    file: 'app/ErrorBoundary.test.tsx',
    title: 'produces a working mailto and clipboard payload with the transport dead',
    reason:
      'the only role="status" on this path is the "Bericht kopiert" confirmation, which carries ' +
      'no aria-busy and is not a skeleton. The crash path never consults the engine at all, which ' +
      'this block asserts, so there is no request to prove.',
  },
  {
    file: 'components/FeedbackDialog.test.tsx',
    title: 'SUCCESS: copying is an explicit press that names the consequence, never automatic',
    reason:
      'the role="status" awaited here is the "Bericht kopiert" confirmation, not a skeleton, and ' +
      'the press it confirms is a clipboard write that asks the engine for nothing. The assertion ' +
      'that follows is over the clipboard payload, so it cannot be vacuous.',
  },
  {
    file: 'components/FeedbackDialog.test.tsx',
    title: 'composes a working mailto and clipboard payload with no verb called',
    reason:
      'the role="status" awaited here is the "Bericht kopiert" confirmation, not a skeleton. This ' +
      'is the localOnly crash path, and the block asserts the transport was never called at all, ' +
      'so by construction there is no request that could be in flight.',
  },
];

const key = (b: { file: string; title: string }): string => `${b.file} :: ${b.title}`;

const BLOCKS = allBlocks();
const LOADING_TESTS = BLOCKS.filter(isLoadingTest);

// --- the suite ------------------------------------------------------------------------------------

describe('the scan itself can see the tests', () => {
  // A scan that silently matches nothing passes every assertion below it. These four are the
  // difference between "the convention holds" and "the parser broke and nobody noticed".
  it('reads a plausible number of test files and blocks off disk', () => {
    expect(testFiles().length).toBeGreaterThan(25);
    expect(BLOCKS.length).toBeGreaterThan(300);
  });

  it('classifies a plausible number of them as LOADING-state tests', () => {
    expect(LOADING_TESTS.length).toBeGreaterThanOrEqual(15);
  });

  it('finds the surfaces actually proving their read, not only the exempt ones', () => {
    const proving = LOADING_TESTS.filter(provesTheRequestStarted);
    expect(proving.length).toBeGreaterThanOrEqual(12);
    // The shared seam has to be the common case, or the convention is a convention in name only.
    expect(proving.filter((b) => STARTED_SEAM.test(b.body)).length).toBeGreaterThanOrEqual(12);
  });

  it('parses block bodies, not fragments', () => {
    for (const block of BLOCKS) {
      expect(block.body.startsWith('{'), key(block)).toBe(true);
      expect(block.body.endsWith('}'), key(block)).toBe(true);
    }
  });
});

describe('every LOADING-state test proves the request went in flight', () => {
  it('leaves no LOADING-state test asserting over a read it never watched', () => {
    const vacuous = LOADING_TESTS.filter(
      (b) => !provesTheRequestStarted(b) && exemptionReason(b) === null,
    ).map(key);

    expect(
      vacuous,
      'These tests assert a loading state without ever proving the request started. Every surface ' +
        'initialises `loading` to true, so the skeleton is on screen before any effect fires and ' +
        'the assertion would hold over a surface that reads nothing at all. Await ' +
        '`transport.started(<action>)` from `test-transport.ts` before asserting, or, if there is ' +
        'genuinely no request to prove, add a `LOADING-PROOF-EXEMPT:` marker and register it in ' +
        'EXEMPTIONS in this file.',
    ).toEqual([]);
  });
});

describe('the opt-out is explicit, registered and current', () => {
  const marked = BLOCKS.filter((b) => exemptionReason(b) !== null);

  it('registers every marker on disk, with its reason verbatim', () => {
    const onDisk = marked.map((b) => ({ file: b.file, title: b.title, reason: exemptionReason(b) }));
    const registered = EXEMPTIONS.map((e) => ({ ...e, reason: e.reason }));

    expect(onDisk.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      registered.sort((a, b) => key(a).localeCompare(key(b))),
    );
  });

  it('keeps no exemption a test no longer needs', () => {
    // A marker on a test that now proves its request is stale: it should come off, not linger and
    // make the next reader think the test is weaker than it is.
    const redundant = marked.filter(provesTheRequestStarted).map(key);
    expect(redundant, 'these carry an opt-out but already prove the request started').toEqual([]);
  });

  it('gives every exemption a reason worth reading', () => {
    for (const exemption of EXEMPTIONS) {
      expect(exemption.reason.length, key(exemption)).toBeGreaterThan(40);
    }
  });
});

/**
 * The guard, tested against sources it does not read from disk.
 *
 * A guard nobody has watched fire is not a guard. These run the matcher over the two shapes that
 * matter (the vacuous one this suite exists to catch, and the fixed one it must leave alone), so
 * the rule is demonstrated here rather than only asserted over the current tree.
 */
describe('the matcher fires on the shape it exists to catch', () => {
  const parse = (source: string): Block => ({ file: 'sample.test.tsx', ...blocksIn(source)[0] });

  const VACUOUS = `
    it('shows a loading skeleton while the list resolves', async () => {
      const client = new TillClient(neverSettles);
      render(<Accounts />);
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    });
  `;

  const FIXED = `
    it('shows a loading skeleton while the list resolves', async () => {
      const transport = watchReads(neverSettles);
      render(<Accounts />);
      await transport.started('list_accounts');
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    });
  `;

  const COUNTED = `
    it('LOADING: a skeleton while the QR read is in flight', async () => {
      let qrRequests = 0;
      renderDetail({ get_document: () => { qrRequests += 1; return hangs(); } });
      await waitFor(() => expect(qrRequests).toBe(1));
      expect(within(panel).getByRole('status')).toBeInTheDocument();
    });
  `;

  const UNRELATED = `
    it('renders every workspace as a row: name over id, currency and created date', async () => {
      renderPanel();
      expect(await screen.findByText('Muster Grafik')).toBeInTheDocument();
    });
  `;

  it('flags the vacuous shape: a skeleton asserted over a read nobody watched', () => {
    const block = parse(VACUOUS);
    expect(isLoadingTest(block)).toBe(true);
    expect(provesTheRequestStarted(block)).toBe(false);
    expect(exemptionReason(block)).toBeNull();
  });

  it('passes the fixed shape, which awaits the shared seam', () => {
    expect(provesTheRequestStarted(parse(FIXED))).toBe(true);
  });

  it('passes a test that proves the request with its own counter', () => {
    const block = parse(COUNTED);
    expect(isLoadingTest(block)).toBe(true);
    expect(provesTheRequestStarted(block)).toBe(true);
  });

  it('does not classify a test that has nothing to do with loading', () => {
    expect(isLoadingTest(parse(UNRELATED))).toBe(false);
  });

  it('reads the marker and its reason out of a block body', () => {
    const marked = parse(`
      it('loading: renders a disabled select', () => {
        // LOADING-PROOF-EXEMPT: the caller owns the read.
        renderPicker({ disabled: true });
      });
    `);
    expect(exemptionReason(marked)).toBe('the caller owns the read.');
  });

  it('counts braces inside strings, template literals and regex as text, not as structure', () => {
    // Every one of these used to walk a naive brace counter off the end of the block.
    const tricky = blocksIn(`
      it('handles a brace zoo', () => {
        const s = '{';
        const t = "}";
        const u = \`\${'{'}\`;
        expect('abcd'.match(/.{1,4}/g)).toHaveLength(1);
      });
      it('is a second block, which a broken counter would swallow', () => {
        expect(1).toBe(1);
      });
    `);
    expect(tricky.map((b) => b.title)).toEqual([
      'handles a brace zoo',
      'is a second block, which a broken counter would swallow',
    ]);
  });
});
