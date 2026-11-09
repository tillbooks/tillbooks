/**
 * The guard that keeps every surface's refusal wording on ONE path (critic R5-1).
 *
 * THE DEFECT THIS EXISTS FOR. The engine marks a refusal raised after the call had already saved
 * (`partial`, and `completed` when it saved whole: a newer TILL moved the book on right after the
 * commit). Round 4 taught six faces to read those flags; round 5 then found about twenty more
 * surfaces that turned `error.error` into their own sentence by hand and never looked at them. The
 * payments drawer said "Die Zahlung konnte nicht gebucht werden." beside a button that posted the
 * payment again; the MWST-Saldierung said "Es wurde nichts verändert." for a settlement it had
 * booked. Fixing them one by one was a third enumeration, and the next surface would have been the
 * next finding.
 *
 * So the wording has one door, `refusalText` in `components/states/refusalText.ts` (and
 * `ErrorBanner`, which asks the same question first): the shared sentence for a newer-book or
 * after-save refusal, then the surface's own words where its catalogue has them, then its fallback.
 * This suite reads every surface source from DISK as text and fails when one builds an error key by
 * hand, which is the only way to word a refusal without going through that door:
 *
 *   R1  a template literal that builds an error key from a runtime value (`ns.error.${code}`)
 *   R2  the same key built by string concatenation (`'ns.error.' + code`)
 *   R3  the generic `errors.fallback` sentence, written directly instead of left to `refusalText`
 *
 * Comments are stripped first, so prose that names these shapes does not count.
 *
 * THE RESIDUAL, named honestly: a surface can still word a refusal with a STATIC own key for an
 * unrecognised code (`t('ns.error.generic')` at the end of a hand-written mapper) without matching any
 * of the three shapes. Text cannot tell that from a legitimate static sentence (a transport failure,
 * a local validation). `refusalText`'s `fallback` option exists so such a mapper is one call, and
 * every mapper that existed on 26.09.2026 was moved onto it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_SRC = dirname(fileURLToPath(import.meta.url));
const SURFACES = join(APP_SRC, 'surfaces');

/**
 * Surface directories the scan does not read, each with its reason. Kept deliberately short: empty
 * since the bank inbox (A39, 26.09.2026) routed its refusals through `refusalText` and `ErrorBanner`.
 */
const EXEMPT_DIRS: ReadonlyArray<{ dir: string; reason: string }> = [];

const RULES: ReadonlyArray<{ id: string; what: string; pattern: RegExp }> = [
  { id: 'R1', what: 'an error key built from a runtime value in a template', pattern: /`[A-Za-z0-9_.]*\b(?:errors?|err)\.\$\{/ },
  { id: 'R2', what: 'an error key built by string concatenation', pattern: /['"][A-Za-z0-9_.]*\b(?:errors?|err)\.['"]\s*\+/ },
  { id: 'R3', what: 'the generic errors.fallback sentence written by hand', pattern: /['"`]errors\.fallback['"`]/ },
];

/** Block comments (JSX ones included) and line comments; `://` in a URL is not a comment. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function violationsIn(source: string): Array<{ rule: string; line: number; text: string }> {
  const out: Array<{ rule: string; line: number; text: string }> = [];
  stripComments(source)
    .split('\n')
    .forEach((text, index) => {
      for (const rule of RULES) {
        if (rule.pattern.test(text)) out.push({ rule: rule.id, line: index + 1, text: text.trim() });
      }
    });
  return out;
}

function surfaceSources(dir: string = SURFACES): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === SURFACES && EXEMPT_DIRS.some((e) => e.dir === entry.name)) continue;
      out.push(...surfaceSources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out.sort();
}

describe('refusal rendering: every surface words a refusal through refusalText (critic R5-1)', () => {
  it('the detector bites on each shape and passes the one path (so a green scan is not vacuous)', () => {
    const bad = [
      "setToast(t(`stock.error.${resp.body.error}`));",
      "return t(`procurement.match.error.${code}`) || code;",
      "message={t(`payroll.err.${error.error}`)}",
      "return t('tasks.error.' + error.error);",
      "return t('errors.fallback');",
      "  : t(\"errors.fallback\")}",
    ];
    for (const line of bad) expect(violationsIn(line), line).not.toHaveLength(0);
    const good = [
      "setToast(refusalText(t, resp.body, { own: 'stock.error' }));",
      "return refusalText(t, error, { own: 'tasks.error', known, fallback: 'tasks.error.generic' });",
      "return t('payment.error.unexpected');",
      "// a comment that says t(`ns.error.${code}`) and 'errors.fallback' in prose",
      "{/* JSX prose: `errors.${code}` */}",
      "const href = 'https://example.org/x'; const ok = t('a.b');",
    ];
    for (const line of good) expect(violationsIn(line), line).toHaveLength(0);
  });

  it('no surface builds an error key by hand or writes the generic fallback itself', () => {
    const files = surfaceSources();
    // The scan reads the real tree: a moved directory would otherwise pass an empty scan.
    expect(files.length).toBeGreaterThan(200);
    const found: string[] = [];
    let onePath = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (/\brefusalText\(/.test(source)) onePath += 1;
      for (const v of violationsIn(source)) {
        found.push(`${relative(APP_SRC, file)}:${v.line} ${v.rule} ${v.text}`);
      }
    }
    expect(found, `Word these refusals through refusalText (components/states):\n${found.join('\n')}`).toEqual([]);
    // Every mapper moved onto the one path on 26.09.2026 (about fifty files); a sudden drop means the
    // helper was renamed or bypassed, not that the surfaces stopped wording refusals.
    expect(onePath).toBeGreaterThanOrEqual(45);
  });

  it('each exemption names its reason', () => {
    for (const exempt of EXEMPT_DIRS) expect(exempt.reason.length).toBeGreaterThan(20);
  });
});
