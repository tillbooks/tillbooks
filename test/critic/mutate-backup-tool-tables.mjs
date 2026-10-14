// Critic probe (backup-tool-tables, 13.10.2026): mutation runner over the BUILT dist. Each mutation
// reverts one piece of 7764263a in dist/, runs the given test files, records which tests bite, and
// restores the file. Not a node:test suite (it is not picked up by the gate's globs: no .test. suffix).
// Usage: node test/critic/mutate-backup-tool-tables.mjs <test files...>   (ONLY=M1,M3 to subset)
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testFiles = process.argv.slice(2);
const SS = `${root}/dist/core/store/schemaShape.js`;
const PO = `${root}/dist/core/data/portability.js`;
const orig = { [SS]: readFileSync(SS, 'utf8'), [PO]: readFileSync(PO, 'utf8') };
const M = [
  ['M1 predicate: isTillTable drops only sqlite_', SS, "return !/^sqlite_/i.test(name) && !name.startsWith('_');", 'return !/^sqlite_/i.test(name);'],
  ['M2 portability allTables back to raw sqlite_master', PO, 'return tillTables(db);', `return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);`],
  ['M3 fingerprintMatches strict (TILL shape only)', SS, 'return recorded === schemaFingerprint(schemaShapeOf(snap, { includeForeignTables: true }));', 'return false;'],
  ['M4 fingerprintMatches accepts anything', SS, 'if (recorded === schemaFingerprint(schemaShapeOf(snap)))', 'if (true)'],
  ['M5 copySchemaDdl skip removed', SS, 'if (!isTillTable(o.name) || !isTillTable(o.tbl_name))', 'if (/^sqlite_/i.test(o.name))'],
  ['M6 copySchemaDdl skips by name only (not tbl_name)', SS, 'if (!isTillTable(o.name) || !isTillTable(o.tbl_name))', 'if (!isTillTable(o.name))'],
  ['M7 shapeGap filter removed', SS, 'Object.keys(need).filter(isTillTable).sort()', 'Object.keys(need).sort()'],
  ['M8 schemaShapeOf default = whole file', SS, 'opts.includeForeignTables === true ? fileTables(db) : tillTables(db)', 'fileTables(db)'],
  ['M9 verify fingerprint check removed', PO, '!fingerprintMatches(manifest.schemaFingerprint, snap)', 'false'],
];
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
try {
  for (const [name, file, from, to] of M) {
    if (only && !only.some((o) => name.startsWith(`${o} `))) continue;
    if (!orig[file].includes(from)) {
      console.log(`${name}: ANCHOR NOT FOUND`);
      continue;
    }
    writeFileSync(file, orig[file].replace(from, to));
    let out = '';
    try {
      out = execFileSync('node', ['--test', ...testFiles], {
        cwd: root,
        env: { ...process.env, TILL_SUPPORT_DIR: `${root}/.tmp-support` },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      out = (e.stdout ?? '') + (e.stderr ?? '');
    }
    const pass = /ℹ pass (\d+)/.exec(out)?.[1];
    const fail = /ℹ fail (\d+)/.exec(out)?.[1];
    const failed = [...new Set([...out.matchAll(/^\s*✖ (.+?) \(\d/gm)].map((m) => m[1]))];
    console.log(`${name}: pass ${pass} fail ${fail}${failed.length ? `\n   bitten by: ${failed.join(' | ')}` : ''}`);
    writeFileSync(file, orig[file]);
  }
} finally {
  writeFileSync(SS, orig[SS]);
  writeFileSync(PO, orig[PO]);
}
