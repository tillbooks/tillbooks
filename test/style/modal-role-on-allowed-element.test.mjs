// @ts-check
/**
 * `role="dialog"` AND `role="alertdialog"` MAY ONLY LAND ON AN ELEMENT THAT PERMITS THEM.
 *
 * THE DEFECT THIS EXISTS FOR. Five drawers across four surfaces rendered
 * `<aside role="dialog" aria-modal="true">`. W3C "ARIA in HTML" gives `aside` an implicit role of
 * `complementary` and permits only a closed list of explicit roles on it, and `dialog` is not on
 * that list, so axe reports every one of them as `aria-allowed-role`. Two were fixed in
 * `BankAccounts` and three more in `Accounts`, `Contacts` and `Items`, and the three were still
 * shipping weeks after the first pair because nothing looked for the shape.
 *
 * WHY THE axe SUITES DID NOT CATCH IT, which is the part worth remembering. Each of those surfaces
 * DID have an axe block, and every one of them was green. They ran with the drawer CLOSED. The
 * offending element was never in the accessibility tree the audit read, so the audit was not wrong
 * and was not broken: it was pointed at markup that did not contain the defect. A per-surface audit
 * only covers the states somebody remembered to open, and "somebody remembered" is not a mechanism.
 * This file is the mechanism: it reads the source, so a drawer nobody opens is still judged.
 *
 * WHY A SOURCE SCAN AND NOT MORE axe BLOCKS. An axe block proves one rendered state of one surface.
 * The rule here is a property of the markup itself and holds in every state, so asserting it once
 * over the whole tree is both cheaper and stronger. A new surface gets covered the moment it is
 * committed, with nobody having to remember to open its drawer in a test.
 *
 * THE PERMITTED HOSTS, quoted from the spec rather than recalled. From
 * https://www.w3.org/TR/html-aria/, "Document conformance requirements for use of ARIA attributes
 * in HTML", fetched 2026-07-26:
 *
 *     aside     implicit `role=complementary`; allowed: "Roles: feed, none, note, presentation,
 *               region or search. (complementary is also allowed, but NOT RECOMMENDED.)"
 *     div       implicit `role=generic`; allowed: "If a direct child of a dl element, only
 *               presentation or none. Otherwise, any role, though generic SHOULD NOT be used."
 *     span      implicit `role=generic`; allowed: "Any role, though generic SHOULD NOT be used."
 *               And of the term itself: "Where a cell in the third column includes the term Any
 *               role it indicates that any role value MAY be used on the element."
 *     section   implicit `role=region` when it has an accessible name, else `role=generic`;
 *               allowed: "Roles: alert, alertdialog, application, banner, complementary,
 *               contentinfo, dialog, document, feed, group, log, main, marquee, navigation, none,
 *               note, presentation, search, status or tabpanel."
 *     dialog    implicit `role=dialog`; allowed: "Role: alertdialog. (dialog is also allowed, but
 *               NOT RECOMMENDED.)"
 *     form      implicit `role=form`; allowed: "Roles: none, presentation or search. (form is also
 *               allowed, but NOT RECOMMENDED.)"
 *
 * So `div`, `span`, `section` and the native `dialog` element may host a modal role, and `aside`
 * and `form` may not. `form` is listed above on purpose: it is the plausible-looking wrong answer
 * for a drawer that wraps a form, and the spec forecloses it.
 *
 * `span` IS ON THAT LIST BECAUSE THE SPEC PUTS IT THERE, not because this repo wanted it. The first
 * run of this guard reported `app/src/components/HelpHint.tsx:65 <span role="dialog">` as a
 * violation, and the probe was what was wrong: `span` carries the same "Any role" allowance as
 * `div`, so the help popover was correct all along and was left alone. Anything added to
 * ALLOWED_HOSTS after this must arrive the same way, with the spec text quoted above it. Widening
 * the list to silence a red run is how this guard stops meaning anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The ARIA roles that make an element a modal. Both carry the same host restriction. */
const MODAL_ROLES = new Set(['dialog', 'alertdialog']);

/**
 * The HTML elements ARIA in HTML permits a modal role on. See the quoted spec text above.
 *
 * An ALLOWLIST and not a denylist of the elements we happen to have got wrong. A denylist would go
 * green on `<article role="dialog">`, `<nav role="dialog">` and every other sectioning element that
 * forbids it just as `aside` does, which is the same blind spot in a new costume.
 */
const ALLOWED_HOSTS = new Set(['div', 'span', 'section', 'dialog']);

/** Files whose markup this judges. */
const MARKUP_EXTENSIONS = new Set(['.tsx', '.jsx', '.html', '.astro']);

/**
 * The lowercased extension of a path, or `''` when it has none.
 *
 * @param {string} path repo-relative
 * @returns {string}
 */
function extensionOf(path) {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot <= 0 ? '' : last.slice(dot).toLowerCase();
}

/**
 * Every tracked markup file, repo-relative.
 *
 * `-z` because a path may legally contain a newline and git quotes such a path in the default
 * output, which a split on `\n` would turn into two files that do not exist.
 *
 * @returns {string[]}
 */
function markupFiles() {
  return execFileSync('git', ['ls-files', '-z'], { env: cleanGitEnv(), cwd: ROOT, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((f) => MARKUP_EXTENSIONS.has(extensionOf(f)));
}

/**
 * Every modal role in `source` together with the element it sits on.
 *
 * Found by locating each `role="dialog"` / `role="alertdialog"` and walking BACKWARDS to the
 * nearest tag name, rather than by parsing JSX forwards. A forward parse has to decide where an
 * opening tag ends, and a JSX attribute value can hold an arbitrary expression containing `>`, so
 * the forward version is the one with the interesting failure modes. The backward walk only has to
 * answer "which tag am I inside", and the answer is always the last tag opened before this point.
 *
 * A capitalised tag is a React component, not an HTML element. The role is then a prop and the host
 * element is wherever that component renders it, which this file cannot see, so those are returned
 * flagged rather than judged: see the assertion below, which refuses to pass them silently.
 *
 * @param {string} source
 * @param {string} file repo-relative, for the report
 * @returns {{ file: string, line: number, tag: string, role: string, isComponent: boolean }[]}
 */
function modalRoles(source, file) {
  /** @type {{ file: string, line: number, tag: string, role: string, isComponent: boolean }[]} */
  const found = [];
  // Single or double quoted, so a `.html` file using single quotes is not silently exempt. Built
  // from MODAL_ROLES rather than spelled out again, so the set stays the one place the roles live.
  const roleAt = new RegExp(`role\\s*=\\s*["'](${[...MODAL_ROLES].join('|')})["']`, 'g');
  const tagAt = /<([A-Za-z][A-Za-z0-9._-]*)(?=[\s/>])/g;

  for (const match of source.matchAll(roleAt)) {
    const at = match.index ?? 0;
    const before = source.slice(0, at);
    let tag = '';
    // The LAST tag opened before this role, which is the element the attribute belongs to.
    // `?? ''` on every capture: the root typecheck runs with `noUncheckedIndexedAccess`, so a group
    // is `string | undefined` even when the pattern cannot match without it.
    for (const t of before.matchAll(tagAt)) tag = t[1] ?? '';
    const initial = tag.slice(0, 1);
    found.push({
      file,
      line: before.split('\n').length,
      tag,
      role: match[1] ?? '',
      isComponent: initial !== '' && initial === initial.toUpperCase(),
    });
  }
  return found;
}

/** Every modal role in the tracked markup, with the element it sits on. */
function modalRolesInRepo() {
  return markupFiles().flatMap((file) => modalRoles(readFileSync(join(ROOT, file), 'utf8'), file));
}

/**
 * THE PRE-FIX SOURCES, PARKED AS FIXTURES RATHER THAN READ OUT OF GIT HISTORY.
 *
 * This used to be `git show 13457bd:<path>`. That worked for every developer and had NEVER ONCE
 * worked in CI, which is a combination worth naming because it hid for three days. `ci.yml` uses a
 * bare `actions/checkout@v4`, whose default is `fetch-depth: 1`, so the runner holds exactly one
 * commit and `git show` on any historical object fails. The old code read that failure as "the
 * history was probably squashed or rewritten" and said so in the assertion message, which sent the
 * next reader looking for a rewrite that had not happened. Reproduced deliberately with
 * `git clone --depth 1`: 5 pass, 1 fail, that exact message.
 *
 * Two repairs were on the table and the fixture is the better one, for a reason that outlives the
 * shallow clone. `CLAUDE.md` schedules the public repo `tillbooks/tillbooks` as a FRESH SQUASHED
 * HISTORY. Any guard that reads a commit hash out of this repo's history breaks permanently on that
 * day, and would then be misdiagnosed as exactly the thing the old message wrongly claimed. Raising
 * `fetch-depth` would fix CI and leave that landmine armed.
 *
 * THE FIXTURES ARE NOT HAND-TYPED IMITATIONS, and that was the whole value of reading git. They are
 * the historical blobs byte for byte, extracted with `git show` and committed, and `blobId` below
 * re-derives each one's git object id on every run and compares it to the id recorded here. A git
 * blob id is `sha1("blob " + length + "\0" + content)`, so this is a cryptographic proof that the
 * fixture is the real defective source, computed with no git dependency at all. Edit a fixture by
 * one byte and the suite says so.
 *
 * They are also the WHOLE files, not excerpts. The property being proved is that the detector finds
 * EXACTLY ONE violation in each, so it has to walk 200-odd lines of realistic JSX (including the
 * sibling `<div role="presentation">` immediately above the offending `<aside>`) without
 * over-reporting. An excerpt would assert something much weaker and quietly.
 *
 * The `.tsx.txt` suffix is load-bearing: `MARKUP_EXTENSIONS` sees `.txt` and leaves these out of the
 * scan corpus, so the guard proper does not report its own fixtures as live violations. That keeps
 * the corpus glob honest instead of carrying an exclusion rule for this directory.
 *
 * @typedef {{ path: string, fixture: string, blob: string }} PreFixSource
 */
const PRE_FIX_COMMIT = '13457bd5e109d909c6a8da3b26e4ba2e832bef10';
const PRE_FIX_DIR = 'test/style/fixtures/modal-role-pre-fix';

/**
 * The three drawers as they stood at `PRE_FIX_COMMIT`, whose subject is
 * "test(accounts,contacts,items): three axe blocks RED on an open drawer".
 *
 * @type {readonly PreFixSource[]}
 */
const PRE_FIX = [
  {
    path: 'app/src/surfaces/Accounts/AccountDrawer.tsx',
    fixture: 'AccountDrawer.tsx.txt',
    blob: '16b7ad5a1583a647975052b3eb95eed919e602e8',
  },
  {
    path: 'app/src/surfaces/Contacts/ContactEditor.tsx',
    fixture: 'ContactEditor.tsx.txt',
    blob: 'a422381389d28cc88ebd1539927a5b2665a79239',
  },
  {
    path: 'app/src/surfaces/Items/ItemEditor.tsx',
    fixture: 'ItemEditor.tsx.txt',
    blob: '02cf62f6c7deaea6407c333ae98eb976ec81889a',
  },
];

/**
 * The git blob object id of some bytes, computed without git.
 *
 * `sha1("blob " + <byte length> + "\0" + <content>)`, which is the object format itself rather than
 * a checksum of our own invention: the recorded ids are therefore readable by `git rev-parse` in any
 * full clone, and verifiable here in a clone with no history at all.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function blobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * A pre-fix source, proved verbatim before it is used for anything.
 *
 * @param {PreFixSource} entry
 * @returns {string}
 */
function preFixSource(entry) {
  const bytes = readFileSync(join(ROOT, PRE_FIX_DIR, entry.fixture));
  assert.equal(
    blobId(bytes),
    entry.blob,
    `${PRE_FIX_DIR}/${entry.fixture} is no longer the source this guard was written against. It is ` +
      `supposed to be \`${entry.path}\` at ${PRE_FIX_COMMIT.slice(0, 7)}, byte for byte, and its git ` +
      'blob id no longer matches the recorded one. Someone edited the fixture. Do not update the ' +
      'recorded id to match: re-extract it with `git show ' +
      `${PRE_FIX_COMMIT.slice(0, 7)}:${entry.path}\` in a full clone. A fixture that can be edited to ` +
      'suit the test is not evidence of anything.',
  );
  return bytes.toString('utf8');
}

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('the corpus is non-empty and holds the files the defect was found in', () => {
  // A guard whose glob quietly resolves to nothing passes forever.
  const files = markupFiles();
  assert.ok(
    files.length >= 50,
    `the scan corpus is ${files.length} markup files, far below this repo's size. \`git ls-files\` ` +
      'returned little or nothing, so a green verdict below would mean the scan found nothing ' +
      'because it read nothing.',
  );
  for (const drawer of [
    'app/src/surfaces/Accounts/AccountDrawer.tsx',
    'app/src/surfaces/Contacts/ContactEditor.tsx',
    'app/src/surfaces/Items/ItemEditor.tsx',
    'app/src/surfaces/BankAccounts/BankAccountEditor.tsx',
    'app/src/surfaces/Payments/PaymentAllocator.tsx',
  ]) {
    assert.ok(
      files.includes(drawer),
      `${drawer} is not in the corpus, and it is one of the exact files this guard exists for. ` +
        'Either it moved (update this list deliberately) or the filter above is excluding markup.',
    );
  }
});

test('the repo really does contain modal roles for the scan to judge', () => {
  // Distinguishes "every modal role is on a permitted element" from "the detector found no modal
  // roles at all", which are the same green verdict and completely different facts.
  const found = modalRolesInRepo();
  assert.ok(
    found.length >= 5,
    `the scan found only ${found.length} modal roles in the whole tree. This repo ships at least ` +
      'five drawers plus a confirm dialog, so the detector is not matching what it claims to match.',
  );
});

// -------------------------------------------------------------------------------------------
// The mechanism reddens
// -------------------------------------------------------------------------------------------

test('mechanism: the pre-fix source of all three drawers is caught', () => {
  // THE MUTATION PROOF, and it needs no mutation: the defective source really existed, and
  // `preFixSource` proves each fixture is that source byte for byte before this reads a line of it.
  for (const entry of PRE_FIX) {
    const found = modalRoles(preFixSource(entry), entry.path).filter(
      (f) => !ALLOWED_HOSTS.has(f.tag) && !f.isComponent,
    );
    assert.deepEqual(
      found.map((f) => `${f.tag} role=${f.role}`),
      ['aside role=dialog'],
      `this guard does not redden on ${entry.path} as it stood at ${PRE_FIX_COMMIT.slice(0, 7)}, ` +
        'which is the exact defect it was written for. It would therefore have passed over the bug ' +
        'it claims to catch.',
    );
  }
});

test('the pre-fix fixtures are whole files, so "exactly one violation" is a real constraint', () => {
  // Guards the fixture against being trimmed to the offending lines later, which would leave the
  // assertion above technically green while it stopped proving the thing that matters: that the
  // backward walk attributes the role correctly across a realistic file and does not over-report.
  // The `role="presentation"` sibling is named because it sits immediately above the bad `<aside>`
  // and is the nearest thing to a decoy the real source contains.
  for (const entry of PRE_FIX) {
    const source = preFixSource(entry);
    const lines = source.split('\n').length;
    assert.ok(
      lines >= 150,
      `${entry.fixture} is ${lines} lines. It is meant to be the WHOLE pre-fix file (200-odd lines), ` +
        'because the detector only earns the "exactly one violation" verdict by walking all of it.',
    );
    assert.ok(
      source.includes('role="presentation"'),
      `${entry.fixture} no longer carries the \`role="presentation"\` sibling that sits above the ` +
        'offending `<aside>`. Either the fixture was trimmed, or it is not the file it claims to be.',
    );
  }
});

test('the pre-fix fixtures stay OUT of the live scan corpus', () => {
  // The `.tsx.txt` suffix is what keeps the guard proper from reporting its own evidence as a live
  // violation. If someone renames a fixture to `.tsx`, the corpus swallows it and the real verdict
  // below goes red on markup that was never shipped, which is the most confusing possible failure.
  const corpus = markupFiles();
  const swallowed = corpus.filter((f) => f.startsWith(`${PRE_FIX_DIR}/`));
  assert.deepEqual(
    swallowed,
    [],
    `the scan corpus has swallowed this guard's own fixtures:\n  ${swallowed.join('\n  ')}\n` +
      'They are deliberately defective source kept as evidence, not shipped markup. Keep the ' +
      '`.txt` suffix so `MARKUP_EXTENSIONS` leaves them out; do not add an exclusion rule to the ' +
      'corpus glob, which would be a hole the next fixture directory could hide in.',
  );
});

test('mechanism: a permitted host is not reported, and neither is a lookalike', () => {
  // The negative half. Without it, "nothing found" is indistinguishable from "nothing looked".
  const clean = [
    '<div role="dialog" aria-modal="true">',
    '<section role="alertdialog">',
    '<dialog role="alertdialog">',
    // The shape of the real `HelpHint` popover, which the first run of this guard wrongly accused.
    '<span role="dialog" aria-label="Hinweis">',
    // Not a modal role at all, and must not be swept up by a loose match on `dialog`.
    '<aside role="complementary" aria-label="dialogue">',
    '<aside className="dialog-ish">',
  ].join('\n');
  assert.deepEqual(
    modalRoles(clean, 'synthetic.tsx').filter((f) => !ALLOWED_HOSTS.has(f.tag)),
    [],
    'a permitted host or a non-modal role was reported as a violation, so this guard would fail ' +
      'correct markup and get deleted for crying wolf',
  );

  // And the positive half over the same shapes, including the single-quoted spelling.
  const dirty = "<aside role='dialog'>\n<form role=\"alertdialog\">\n<nav role=\"dialog\">";
  assert.deepEqual(
    modalRoles(dirty, 'synthetic.tsx')
      .filter((f) => !ALLOWED_HOSTS.has(f.tag))
      .map((f) => f.tag),
    ['aside', 'form', 'nav'],
    'a forbidden host escaped the scan. `form` and `nav` are here because the spec forbids them ' +
      'exactly as it forbids `aside`, and a guard that only knows about `aside` has learned the ' +
      'incident rather than the rule.',
  );
});

// -------------------------------------------------------------------------------------------
// The guard proper
// -------------------------------------------------------------------------------------------

test('every modal role sits on an element that is not a React component', () => {
  // `<Drawer role="dialog">` puts the attribute out of this file's reach: the host element is
  // wherever that component spreads it. Rather than pass such a case silently, which is how a guard
  // becomes decorative, this fails and asks for the role to move onto the real element.
  const components = modalRolesInRepo().filter((f) => f.isComponent);
  assert.deepEqual(
    components.map((f) => `${f.file}:${f.line} <${f.tag} role="${f.role}">`),
    [],
    'a modal role is being passed to a React component, so no static check can tell which HTML ' +
      'element it lands on. Put `role="dialog"` on the `div`/`section`/`dialog` the component ' +
      'renders, and let the component take a plain prop instead.',
  );
});

test('every role="dialog" and role="alertdialog" sits on an element that permits it', () => {
  const violations = modalRolesInRepo()
    .filter((f) => !f.isComponent && !ALLOWED_HOSTS.has(f.tag))
    .map((f) => `${f.file}:${f.line} <${f.tag} role="${f.role}">`);

  assert.deepEqual(
    violations,
    [],
    'a modal role sits on an element that W3C "ARIA in HTML" does not allow it on, which axe ' +
      'reports as `aria-allowed-role`. Only `div`, `section` and the native `dialog` element may ' +
      'host `role="dialog"` or `role="alertdialog"`; `aside`, `article`, `nav`, `form` and the ' +
      'other sectioning elements may not, whatever the drawer looks like. Use a `div`: it permits ' +
      'any role, it is what the shipped drawers use, and the styling here is class-driven so ' +
      `nothing moves. Found: ${JSON.stringify(violations)}`,
  );
});
