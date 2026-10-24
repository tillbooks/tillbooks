// CRITIC MUTATION HARNESS, D178 E2 round 3 (non-author): do the author's adapted round-2 probes still bite?
// Each mutation rewrites ONE compiled line under dist/ (never src/), runs the named probes, and restores the
// file. A mutation the probes do not catch is reported as SURVIVED. Not a test file (no .test.mjs suffix):
// run it by hand after `npm run build`: `node test/critic/e2-r3-mutate.mjs`.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBES = 'test/critic/e2-r2-probes.test.mjs';

const MUTATIONS = [
  {
    name: 'A: the proposal cap is gone (a flagged line keeps sure)',
    file: 'dist/core/banking/bankProposals.js',
    from: 'if (!pc.lazy.duplicatePending.has(row.id))',
    to: 'if (true)',
    probes: 'R2-1',
  },
  {
    name: 'B: the booking guard is gone (performBooking and its pre-draft screen)',
    file: 'dist/core/banking/bankBooking.js',
    from: 'const duplicate = duplicateDecisionPending(ctx, row.id);',
    to: 'const duplicate = null;',
    all: true,
    probes: 'R2-S3',
  },
  {
    name: 'C: auto_strong absorbs on money and booking day whatever the bank reference says',
    file: 'dist/core/banking/statementDedupe.js',
    from: 'const hit = (byRef.get(line.bankRef) ?? []).find(',
    to: 'const hit = [...byRef.values()].flat().find(',
    probes: 'R2-2',
  },
  {
    name: 'D: ask behaves like auto_strong (drops on a shared reference)',
    file: 'dist/core/banking/statementDedupe.js',
    from: "if (input.mode === 'auto_strong') {",
    to: 'if (true) {',
    probes: 'R2-2|R2-S1',
  },
  {
    name: 'E: naming uses a stored line up across imports (a line already named is not offered again)',
    file: 'dist/core/banking/statementDedupe.js',
    from: '.all(...params);',
    to: ".all(...params).filter((r) => ctx.store.db.prepare('SELECT 1 FROM bank_txn_duplicate_candidate WHERE workspace_id = ? AND existing_bank_txn_id = ?').get(ctx.workspaceId, r.id) === undefined);",
    probes: 'R2-6',
  },
];

// ROUND 4 (the re-cut): the author's adaptations of these probes, and the chokepoint behind the verbs.
if (process.argv.includes('--r4')) {
  MUTATIONS.length = 0;
  MUTATIONS.push(
    {
      name: 'F: a line on a fully covered day that matches nothing is not flagged',
      file: 'dist/core/banking/camtReconcile.js',
      from: "coverageFlag.set(l.index, { bankTxnId: null, reason: 'covered_period_new_line' });",
      to: ';',
      probes: 'R3-3',
      file2: 'test/critic/e2-r3-probes.test.mjs',
    },
    {
      name: 'G: the one-to-one movement match finds nothing (an overlap reads as new)',
      file: 'dist/core/banking/statementCoverage.js',
      from: 'if (keys.length === 0)',
      to: 'if (true)',
      probes: 'E2-C1|E2-C8',
      file2: 'test/critic/e2-dedupe-probes.test.mjs',
    },
    {
      name: 'H: the chokepoint trigger refuses nothing',
      file: 'dist/core/banking/camtSchema.js',
      from: "SELECT RAISE(ABORT, 'duplicate_decision_pending: the line is flagged as a possible duplicate and not decided');",
      to: 'SELECT 1;',
      probes: 'chokepoint',
      file2: 'test/banking/e2-coverage.test.mjs',
    },
  );
}

let survived = 0;
for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(m.from)) {
    console.log(`SKIPPED  ${m.name}: pattern not found`);
    continue;
  }
  writeFileSync(path, m.all ? original.split(m.from).join(m.to) : original.replace(m.from, m.to));
  try {
    const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=${m.probes}`, m.file2 ?? PROBES], {
      cwd: ROOT,
      env: { ...process.env, TILL_SUPPORT_DIR: join(ROOT, '.tmp-support') },
      encoding: 'utf8',
    });
    const failed = /ℹ fail [1-9]/.test(run.stdout);
    if (!failed) survived += 1;
    console.log(`${failed ? 'KILLED  ' : 'SURVIVED'} ${m.name} (probes ${m.probes})`);
  } finally {
    writeFileSync(path, original);
  }
}
process.exitCode = survived === 0 ? 0 : 1;
