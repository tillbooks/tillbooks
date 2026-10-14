#!/usr/bin/env node
// @ts-check
/**
 * D144, the offline evaluation harness for a `decide()` model (DEV-ONLY: nothing in the product
 * imports it, and it ships no data).
 *
 * It measures what the owner needs to know before a model may reach the bank inbox: accuracy, the
 * expected calibration error (does "82 %" mean right 82 % of the time?), the Brier score, the share of
 * lines it could take at a fixed error budget, and how many lines clear the inbox's 50 % floor
 * (`metrics.mjs`).
 *
 *   node scripts/eval/decide-eval.mjs --data <set.jsonl> --out <dir> (--adapter <module.mjs> | --baseline uniform|prior)
 *       [--error-budget 0.02] [--bins 10] [--floor 0.5] [--limit N]
 *
 * THE DATASET IS PRIVATE AND STAYS PRIVATE. A real evaluation set is a person's booking history, so
 * this script REFUSES to read a file git tracks, or one inside a repository that git does not ignore,
 * and REFUSES to write anywhere but a git-ignored directory or a place outside every repository. Both
 * are checked against the repository that CONTAINS the path (a worktree nested in a checkout is judged
 * by the checkout its path belongs to), after every symlink is resolved, and a check git cannot run
 * refuses (critic C9); a result FILE that is a link is refused too, and never opened through (critic
 * R2-1). The outputs hold ids, answers and probabilities, never a state.
 *
 * One JSON object per line: `{ "id"?: string, "state": string | object, "options": string[],
 * "answer": number | string, "question"?: string }`, `answer` being the index or the label of the
 * option a person actually chose.
 *
 * `--adapter` names a module exporting `decide(state, questions)` (the `Op6Adapter.decide` contract,
 * E05 §10.1), either directly, as `adapter.decide`, or on its default export, plus an optional
 * `modelRef`. `--baseline uniform` answers every option equally; `--baseline prior` answers each
 * option's share among the gold answers seen so far (a floor any real model must beat).
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { gitEnv } from '../lib/git-env.mjs';
import { evaluate } from './metrics.mjs';

const SUM_TOLERANCE = 0.001;

/** @param {string} message @returns {never} */
function fail(message) {
  throw new EvalRefusal(message);
}

export class EvalRefusal extends Error {}

/**
 * `abs` with every symlink resolved (critic C9): the nearest existing ancestor through `realpathSync`,
 * the not-yet-existing rest appended. A guard that judged the spelled path would let an ignored name
 * that links into a tracked directory carry the results there.
 * @param {string} abs @returns {string}
 */
function realOf(abs) {
  let dir = abs;
  /** @type {string[]} */
  const rest = [];
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) break;
    rest.unshift(basename(dir));
    dir = up;
  }
  return join(realpathSync(dir), ...rest);
}

/**
 * The repository that contains `real` (judged from its nearest existing directory), or null when none.
 * FAILS CLOSED (critic C9): when git cannot answer but a `.git` sits in an ancestor, the path is inside
 * a repository nobody can judge, and it is refused rather than treated as "outside every repository".
 * @param {string} real @returns {string | null}
 */
function repositoryOf(real) {
  let dir = real;
  while (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env: gitEnv(), encoding: 'utf8' });
  if (r.status === 0) return realpathSync(r.stdout.trim());
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) fail(`refused: git could not judge ${real}, which sits inside the repository at ${d}.`);
    if (dirname(d) === d) return null;
  }
}

/**
 * Run git in `top` and answer its exit status, 0 or 1. Anything else (git itself failed) is a refusal:
 * a check that cannot run is not a check that passed (critic C9).
 * @param {string} top @param {string[]} args @returns {{ status: 0 | 1, stdout: string }}
 */
function git(top, args) {
  const r = spawnSync('git', ['-C', top, ...args], { env: gitEnv(), encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) fail(`refused: git ${args[0]} failed in ${top}, so the path cannot be judged.`);
  return { status: /** @type {0 | 1} */ (r.status), stdout: r.stdout ?? '' };
}

/**
 * Refuse a dataset a repository tracks or does not ignore.
 * @param {string} path @returns {string} the resolved (real) path
 */
export function guardDataset(path) {
  const real = realOf(resolve(path));
  const top = repositoryOf(real);
  if (top === null) return real;
  const rel = relative(top, real);
  if (git(top, ['ls-files', '--error-unmatch', '--', rel]).status === 0) {
    fail(`refused: ${rel} is tracked by git in ${top}. An evaluation set is private data: keep it in a git-ignored place or outside every repository.`);
  }
  if (git(top, ['check-ignore', '-q', '--', rel]).status !== 0) {
    fail(`refused: ${rel} is not git-ignored in ${top}, so it could be committed. Move it to a git-ignored place or outside every repository.`);
  }
  return real;
}

/**
 * Refuse an output directory that git tracks anything in or does not ignore.
 * @param {string} path @returns {string} the resolved (real) path
 */
export function guardOutputDir(path) {
  const real = realOf(resolve(path));
  const top = repositoryOf(real);
  if (top === null) return real;
  const rel = relative(top, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) fail(`refused: ${real} is the root of ${top}.`);
  if (git(top, ['ls-files', '--', rel]).stdout.trim() !== '') fail(`refused: git tracks files under ${rel} in ${top}. Results go to a git-ignored place.`);
  if (git(top, ['check-ignore', '-q', '--', rel]).status !== 0 && git(top, ['check-ignore', '-q', '--', `${rel}/probe.json`]).status !== 0) {
    fail(`refused: ${rel} is not git-ignored in ${top}, so a result written there could be committed.`);
  }
  return real;
}

/**
 * Refuse a result path that exists and is not a regular file (critic R2-1): the output DIRECTORY is
 * judged by its real path, but a link sitting at `metrics.json` inside it would carry the write anywhere.
 * @param {string} path
 */
function guardResultFile(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return; // absent: it will be created as a regular file
  }
  if (!st.isFile()) fail(`refused: ${path} exists and is not a regular file (a link or a directory); results are never written through one.`);
}

/**
 * Write one result file without following a link at its name: O_NOFOLLOW makes the open itself fail on
 * a link planted between the check above and this write.
 * @param {string} path @param {string} text
 */
function writeResult(path, text) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o644);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} text
 * @returns {{ id: string, state: string, options: string[], answer: number, question: string }[]}
 */
export function parseDataset(text) {
  const out = [];
  const lines = text.split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    /** @type {Record<string, unknown>} */
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      fail(`line ${i + 1}: not JSON`);
    }
    const options = rec.options;
    if (!Array.isArray(options) || options.length < 2 || !options.every((o) => typeof o === 'string' && o.length > 0)) {
      fail(`line ${i + 1}: options must be at least two non-empty strings`);
    }
    const opts = /** @type {string[]} */ (options);
    const answer = typeof rec.answer === 'number' ? rec.answer : opts.indexOf(String(rec.answer));
    if (!Number.isInteger(answer) || answer < 0 || answer >= opts.length) fail(`line ${i + 1}: answer is not one of the options`);
    const state = typeof rec.state === 'string' ? rec.state : JSON.stringify(rec.state);
    if (state === undefined || state.length === 0) fail(`line ${i + 1}: no state`);
    out.push({
      id: typeof rec.id === 'string' ? rec.id : String(i + 1),
      state,
      options: opts,
      answer,
      question: typeof rec.question === 'string' ? rec.question : 'Welche Option trifft zu?',
    });
  }
  return out;
}

/** @param {unknown} answer @param {number} n @returns {number[] | null} */
function validDistribution(answer, n) {
  if (!Array.isArray(answer) || answer.length !== 1) return null;
  const ps = /** @type {Record<string, unknown>} */ (answer[0]).probabilities;
  if (!Array.isArray(ps) || ps.length !== n) return null;
  if (!ps.every((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1)) return null;
  const sum = ps.reduce((s, p) => s + p, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
  return ps.map((p) => p / sum);
}

/**
 * The decider under evaluation.
 * @param {{ adapter?: string, baseline?: string }} args
 * @returns {Promise<{ modelRef: string, decide: (state: string, questions: unknown[]) => unknown, observe?: (label: string) => void }>}
 */
async function loadDecider(args) {
  if (args.adapter !== undefined) {
    const mod = await import(pathToFileURL(resolve(args.adapter)).href);
    const candidate = [mod.decide, mod.adapter?.decide, mod.default?.decide, typeof mod.default === 'function' ? mod.default : undefined].find(
      (f) => typeof f === 'function',
    );
    if (candidate === undefined) fail(`refused: ${args.adapter} exports no decide(state, questions)`);
    const modelRef = mod.modelRef ?? mod.adapter?.modelRef ?? mod.default?.modelRef ?? args.adapter;
    const owner = mod.adapter ?? mod.default ?? mod;
    return { modelRef: String(modelRef), decide: (s, q) => candidate.call(owner, s, q) };
  }
  if (args.baseline === 'uniform') {
    return {
      modelRef: 'baseline:uniform',
      decide: (_s, qs) => qs.map((q) => {
        const n = /** @type {{ options: string[] }} */ (q).options.length;
        return { id: /** @type {{ id: string }} */ (q).id, type: 'choice', probabilities: Array.from({ length: n }, () => 1 / n) };
      }),
    };
  }
  if (args.baseline === 'prior') {
    /** @type {Map<string, number>} */
    const seen = new Map();
    return {
      modelRef: 'baseline:prior',
      decide: (_s, qs) => qs.map((q) => {
        const opts = /** @type {{ options: string[] }} */ (q).options;
        const weights = opts.map((o) => 1 + (seen.get(o) ?? 0));
        const sum = weights.reduce((a, b) => a + b, 0);
        return { id: /** @type {{ id: string }} */ (q).id, type: 'choice', probabilities: weights.map((w) => w / sum) };
      }),
      observe: (label) => seen.set(label, (seen.get(label) ?? 0) + 1),
    };
  }
  return fail('refused: name a model with --adapter <module.mjs>, or a --baseline (uniform | prior)');
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === undefined || !key.startsWith('--')) fail(`unexpected argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${key} needs a value`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

/**
 * Run one evaluation. Returns the report it wrote.
 * @param {string[]} argv
 */
export async function run(argv) {
  const args = parseArgs(argv);
  if (args.data === undefined) fail('refused: --data <set.jsonl> is required');
  if (args.out === undefined) fail('refused: --out <dir> is required (a git-ignored directory, or one outside every repository)');
  const dataPath = guardDataset(args.data);
  const outDir = guardOutputDir(args.out);
  const decider = await loadDecider({ ...(args.adapter !== undefined ? { adapter: args.adapter } : {}), ...(args.baseline !== undefined ? { baseline: args.baseline } : {}) });

  const raw = readFileSync(dataPath, 'utf8');
  let records = parseDataset(raw);
  if (args.limit !== undefined) records = records.slice(0, Number(args.limit));

  /** @type {{ probabilities: number[], answer: number }[]} */
  const preds = [];
  const rows = [];
  let failed = 0;
  let millis = 0;
  for (const r of records) {
    const question = { id: 'q', type: 'choice', text: r.question, options: r.options };
    const started = process.hrtime.bigint();
    let ps = null;
    try {
      ps = validDistribution(decider.decide(r.state, [question]), r.options.length);
    } catch {
      ps = null;
    }
    millis += Number(process.hrtime.bigint() - started) / 1e6;
    if (ps === null) failed += 1;
    else preds.push({ probabilities: ps, answer: r.answer });
    rows.push({ id: r.id, answer: r.answer, probabilities: ps });
    decider.observe?.(/** @type {string} */ (r.options[r.answer]));
  }

  const metrics = evaluate(preds, {
    ...(args['error-budget'] !== undefined ? { errorBudget: Number(args['error-budget']) } : {}),
    ...(args.bins !== undefined ? { bins: Number(args.bins) } : {}),
    ...(args.floor !== undefined ? { floor: Number(args.floor) } : {}),
  });
  const report = {
    modelRef: decider.modelRef,
    dataset: { sha256: createHash('sha256').update(raw).digest('hex'), records: records.length, answered: preds.length, failed },
    meanLatencyMs: records.length === 0 ? 0 : millis / records.length,
    metrics,
  };
  mkdirSync(outDir, { recursive: true });
  const metricsPath = join(outDir, 'metrics.json');
  const predictionsPath = join(outDir, 'predictions.jsonl');
  // Both result paths are judged BEFORE either is written, so a refusal writes nothing.
  for (const target of [metricsPath, predictionsPath]) guardResultFile(target);
  writeResult(metricsPath, `${JSON.stringify(report, null, 2)}\n`);
  writeResult(predictionsPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''));
  return report;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  run(process.argv.slice(2)).then(
    (report) => {
      const m = report.metrics;
      process.stdout.write(
        `${report.modelRef}: n=${m.n} accuracy=${m.accuracy.toFixed(3)} ece=${m.ece.toFixed(3)} brier=${m.brier.toFixed(3)} ` +
          `automation@${m.errorBudget}=${m.automation.rate.toFixed(3)} (threshold ${m.automation.threshold ?? 'none'}) ` +
          `floor ${m.floor}: coverage=${m.atFloor.coverage.toFixed(3)} accuracy=${m.atFloor.accuracy === null ? 'none' : m.atFloor.accuracy.toFixed(3)} failed=${report.dataset.failed}\n`,
      );
    },
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(e instanceof EvalRefusal ? 2 : 1);
    },
  );
}
