// A43 section 5, the CLI: `till settlement validate <file>` and `till settlement schema`. They open no book
// and write nothing (HOME is a throwaway directory that must stay empty). SYNTHETIC DATA ONLY.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CASES } from './contract-corpus.mjs';

const BIN = new URL('../../bin/till.mjs', import.meta.url).pathname;
const SCHEMA = readFileSync(new URL('../../schemas/till-settlement-v1.schema.json', import.meta.url), 'utf8');

function run(args, home) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TILL_DB_PATH: undefined } });
}

test('till settlement schema prints the committed schema; validate answers by exit code and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'till-cli-'));
  try {
    const schema = run(['settlement', 'schema'], home);
    assert.equal(schema.status, 0);
    assert.equal(schema.stdout, SCHEMA);

    const good = join(home, 'good.json');
    writeFileSync(good, JSON.stringify(CASES[1].doc));
    const ok = run(['settlement', 'validate', good], home);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).valid, true);

    const bad = join(home, 'bad.json');
    writeFileSync(bad, JSON.stringify(CASES.find((c) => c.refusal === 'unknown_kind').doc));
    const refused = run(['settlement', 'validate', bad], home);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).refused[0].code, 'unknown_kind');

    const wrongSchema = join(home, 'v2.json');
    writeFileSync(wrongSchema, JSON.stringify(CASES.find((c) => c.refusal === 'unsupported_schema').doc));
    const whole = run(['settlement', 'validate', wrongSchema], home);
    assert.equal(whole.status, 1);
    assert.equal(JSON.parse(whole.stdout).error, 'unsupported_schema');

    // Another workspace currency by flag: the same file now refuses every CHF event.
    const eur = run(['settlement', 'validate', good, '--currency', 'EUR'], home);
    assert.equal(eur.status, 1);
    assert.equal(JSON.parse(eur.stdout).refused[0].code, 'currency_mismatch');

    assert.equal(run(['settlement', 'validate'], home).status, 2, 'no file is a usage error');
    assert.equal(run(['settlement', 'validate', join(home, 'missing.json')], home).status, 2);
    assert.equal(run(['settlement', 'nope'], home).status, 2);

    // A file over the reader's cap is refused by its size, before it is read (critic L1).
    const big = join(home, 'big.json');
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 32));
    const tooBig = run(['settlement', 'validate', big], home);
    assert.equal(tooBig.status, 2);
    assert.match(tooBig.stderr, /is over \d+ bytes/);

    assert.deepEqual(readdirSync(home).sort(), ['bad.json', 'big.json', 'good.json', 'v2.json'], 'no ~/.till, no book, nothing written');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
