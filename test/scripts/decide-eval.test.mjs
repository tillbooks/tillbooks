// @ts-check
// D144, the offline decide() evaluation harness (scripts/eval/). The metrics are pinned on hand-built
// predictions; the path guards are proven on a THROWAWAY git repository (a tracked file, an ignored
// directory, an un-ignored file) so no test ever writes into this checkout; one end-to-end run over a
// synthetic set in a temp directory outside every repository. SYNTHETIC DATA ONLY: every record below is
// invented here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv, TEMP_REPO_GIT } from '../lib/git-env.mjs';
import { accuracy, expectedCalibrationError, brierScore, automationAtErrorBudget, atFloor, evaluate } from '../../scripts/eval/metrics.mjs';
import { guardDataset, guardOutputDir, parseDataset, run, EvalRefusal } from '../../scripts/eval/decide-eval.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('metrics: accuracy, ECE, Brier, automation at an error budget, the floor', () => {
  const preds = [
    { probabilities: [0.9, 0.1], answer: 0 },
    { probabilities: [0.9, 0.1], answer: 0 },
    { probabilities: [0.6, 0.4], answer: 1 },
    { probabilities: [0.3, 0.7], answer: 1 },
  ];
  assert.equal(accuracy(preds), 0.75);
  // Bins of width 0.1: {0.9: 2 right}, {0.6: 0 right}, {0.7: 1 right}.
  const ece = (2 / 4) * Math.abs(1 - 0.9) + (1 / 4) * Math.abs(0 - 0.6) + (1 / 4) * Math.abs(1 - 0.7);
  assert.ok(Math.abs(expectedCalibrationError(preds, 10) - ece) < 1e-12);
  const brier = (2 * (0.01 + 0.01) + (0.36 + 0.36) + (0.09 + 0.09)) / 4;
  assert.ok(Math.abs(brierScore(preds) - brier) < 1e-12);
  // Most confident first: 0.9, 0.9, 0.7 are right, 0.6 is wrong. At 0 % error, 3 of 4 at threshold 0.7.
  assert.deepEqual(automationAtErrorBudget(preds, 0), { rate: 0.75, lines: 3, threshold: 0.7 });
  assert.deepEqual(automationAtErrorBudget(preds, 0.25), { rate: 1, lines: 4, threshold: 0.6 });
  assert.deepEqual(atFloor(preds, 0.65), { coverage: 0.75, accuracy: 1 });
  // Ties are never split by a threshold: [0.8 right, 0.8 wrong] at 0 % takes nothing.
  assert.deepEqual(automationAtErrorBudget([{ probabilities: [0.8, 0.2], answer: 0 }, { probabilities: [0.8, 0.2], answer: 1 }], 0), { rate: 0, lines: 0, threshold: null });
  const report = evaluate(preds);
  assert.equal(report.n, 4);
  assert.equal(report.errorBudget, 0.02);
  assert.equal(report.floor, 0.5);
  assert.deepEqual(evaluate([]).automation, { rate: 0, lines: 0, threshold: null });
});

test('dataset: labels or indices, a state object is serialised, a bad line is refused by its number', () => {
  const rows = parseDataset(
    [
      JSON.stringify({ id: 'a', state: { direction: 'out' }, options: ['6500 Bürokosten', '6200 Fahrzeug'], answer: '6200 Fahrzeug' }),
      '',
      JSON.stringify({ state: 'Kiosk', options: ['x', 'y'], answer: 0 }),
    ].join('\n'),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.answer, 1);
  assert.equal(rows[0]?.state, '{"direction":"out"}');
  assert.equal(rows[1]?.id, '3');
  assert.throws(() => parseDataset('{"state":"s","options":["x"],"answer":0}'), /line 1: options/);
  assert.throws(() => parseDataset('{"state":"s","options":["x","y"],"answer":"z"}'), /line 1: answer/);
  assert.throws(() => parseDataset('nope'), /line 1: not JSON/);
});

test('guards: a tracked or un-ignored dataset is refused, and so is an output that could be committed', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'till-eval-repo-')));
  const env = cleanGitEnv(TEMP_REPO_GIT);
  execFileSync('git', ['init', '-q', repo], { env });
  writeFileSync(join(repo, '.gitignore'), 'private/\n');
  writeFileSync(join(repo, 'tracked.jsonl'), '{}\n');
  execFileSync('git', ['-C', repo, 'add', '.gitignore', 'tracked.jsonl'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed'], { env });
  mkdirSync(join(repo, 'private'));
  writeFileSync(join(repo, 'private', 'set.jsonl'), '{}\n');
  writeFileSync(join(repo, 'loose.jsonl'), '{}\n');

  assert.throws(() => guardDataset(join(repo, 'tracked.jsonl')), (e) => e instanceof EvalRefusal && /is tracked by git/.test(e.message));
  assert.throws(() => guardDataset(join(repo, 'loose.jsonl')), (e) => e instanceof EvalRefusal && /is not git-ignored/.test(e.message));
  assert.equal(guardDataset(join(repo, 'private', 'set.jsonl')), join(repo, 'private', 'set.jsonl'));

  assert.throws(() => guardOutputDir(join(repo, 'results')), (e) => e instanceof EvalRefusal && /not git-ignored/.test(e.message));
  assert.throws(() => guardOutputDir(repo), (e) => e instanceof EvalRefusal && /root/.test(e.message));
  assert.equal(guardOutputDir(join(repo, 'private', 'out')), join(repo, 'private', 'out'));

  // And this checkout: its tracked docs are never an output, its package.json never a dataset.
  assert.throws(() => guardOutputDir(join(ROOT, 'docs')), EvalRefusal);
  assert.throws(() => guardDataset(join(ROOT, 'package.json')), EvalRefusal);
});

test('guards (critic C9): a symlink into a tracked directory is judged by where it points, and a broken repository refuses', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'till-eval-link-')));
  const env = cleanGitEnv(TEMP_REPO_GIT);
  execFileSync('git', ['init', '-q', repo], { env });
  writeFileSync(join(repo, '.gitignore'), 'private/\n');
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'readme.md'), 'tracked\n');
  writeFileSync(join(repo, 'docs', 'set.jsonl'), '{}\n');
  execFileSync('git', ['-C', repo, 'add', '.gitignore', 'docs/readme.md', 'docs/set.jsonl'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed'], { env });
  mkdirSync(join(repo, 'private'));
  symlinkSync(join(repo, 'docs'), join(repo, 'private', 'out'));
  symlinkSync(join(repo, 'docs', 'set.jsonl'), join(repo, 'private', 'set.jsonl'));
  assert.throws(() => guardOutputDir(join(repo, 'private', 'out')), (e) => e instanceof EvalRefusal && /tracks files under docs/.test(e.message));
  assert.throws(() => guardDataset(join(repo, 'private', 'set.jsonl')), (e) => e instanceof EvalRefusal && /tracked by git/.test(e.message));
  // A repository git cannot read (a corrupt .git) fails CLOSED, never "outside every repository".
  const broken = realpathSync(mkdtempSync(join(tmpdir(), 'till-eval-broken-')));
  writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/elsewhere\n');
  assert.throws(() => guardOutputDir(join(broken, 'out')), (e) => e instanceof EvalRefusal && /could not judge/.test(e.message));
});

test('guards (critic R2-1): a result FILE that is a link is refused, and nothing is written', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'till-eval-filelink-')));
  const set = join(dir, 'set.jsonl');
  writeFileSync(set, `${JSON.stringify({ id: 'r1', state: 'Kiosk', options: ['a', 'b'], answer: 0 })}\n`);
  const out = join(dir, 'out');
  mkdirSync(out);
  const elsewhere = join(dir, 'elsewhere.json');
  symlinkSync(elsewhere, join(out, 'predictions.jsonl'));
  await assert.rejects(run(['--data', set, '--out', out, '--baseline', 'uniform']), (e) => e instanceof EvalRefusal && /not a regular file/.test(e.message));
  assert.equal(existsSync(elsewhere), false, 'nothing was written through the link');
  assert.equal(existsSync(join(out, 'metrics.json')), false, 'both paths are judged before either is written');
});

test('end to end: a synthetic set outside every repository, a stub adapter and a baseline, results in the named directory only', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'till-eval-run-')));
  const set = join(dir, 'set.jsonl');
  const records = [
    { id: 'r1', state: 'Papeterie Büromaterial', options: ['6500 Bürokosten', '6200 Fahrzeugaufwand', '6570 Informatik'], answer: 0 },
    { id: 'r2', state: 'Garage Service Fahrzeugaufwand', options: ['6500 Bürokosten', '6200 Fahrzeugaufwand', '6570 Informatik'], answer: 1 },
    { id: 'r3', state: 'Hosting Informatik Lizenz', options: ['6500 Bürokosten', '6200 Fahrzeugaufwand', '6570 Informatik'], answer: 2 },
    { id: 'r4', state: 'Kiosk', options: ['6500 Bürokosten', '6200 Fahrzeugaufwand', '6570 Informatik'], answer: 0 },
  ];
  writeFileSync(set, records.map((r) => JSON.stringify(r)).join('\n'));
  const adapter = join(dir, 'adapter.mjs');
  writeFileSync(
    adapter,
    [
      "export const modelRef = 'stub-eval';",
      'export function decide(state, questions) {',
      '  return questions.map((q) => {',
      '    const s = q.options.map((o) => 1 + 4 * o.split(/\\s+/).filter((w) => w.length > 3 && state.includes(w)).length);',
      '    const sum = s.reduce((a, b) => a + b, 0);',
      "    return { id: q.id, type: 'choice', probabilities: s.map((v) => v / sum) };",
      '  });',
      '}',
    ].join('\n'),
  );
  const out = join(dir, 'out');
  const report = await run(['--data', set, '--out', out, '--adapter', adapter]);
  assert.equal(report.modelRef, 'stub-eval');
  assert.equal(report.dataset.records, 4);
  assert.equal(report.dataset.failed, 0);
  assert.equal(report.metrics.accuracy, 1, 'the stub reads the word the state shares with the right option; r4 ties and takes the first');
  const written = JSON.parse(readFileSync(join(out, 'metrics.json'), 'utf8'));
  assert.equal(written.metrics.n, 4);
  const preds = readFileSync(join(out, 'predictions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(preds[0]).sort(), ['answer', 'id', 'probabilities'], 'no state is copied into the results');

  const base = await run(['--data', set, '--out', join(dir, 'base'), '--baseline', 'uniform']);
  assert.equal(base.metrics.accuracy, 0.5, 'uniform takes the first option: r1 and r4 are right');
  await assert.rejects(run(['--data', set, '--out', join(dir, 'x')]), /--adapter/);
  await assert.rejects(run(['--out', join(dir, 'x'), '--baseline', 'uniform']), /--data/);
  assert.equal(existsSync(join(dir, 'x')), false, 'a refusal writes nothing');
});
