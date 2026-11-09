#!/usr/bin/env node
/**
 * Saldenliste -> opening-balances CSV (the bexio cutover transform).
 *
 * WHY THIS EXISTS. A Swiss Saldenliste / Bilanz export states ONE signed balance per account
 * (`Kontonummer;Name;Saldo`). TILL's opening-balance import and the G11 `trial_balance` tie-out
 * control read DEBIT/CREDIT columns (`account,debitMinor,creditMinor`), never a `Saldo`/`balance`
 * column, and `opening_balances` does not consume the column map. A column preset cannot bridge this
 * (it cannot split one signed column into two), so a Saldenliste needs this one transform before it
 * can be discovered as an `opening_balances` source:
 *
 *     debitMinor  = max( Saldo, 0)      // assets / expenses carry debit balances
 *     creditMinor = max(-Saldo, 0)      // equity / liabilities / income carry credit balances
 *
 * TWO NON-OBVIOUS RULES this enforces, learned from a real bexio Bilanz export:
 *
 *  1. GROUP ROWS ARE EXCLUDED. A bexio Bilanz/Saldenliste is HIERARCHICAL: it lists collective
 *     "Gruppe" rows (Umlaufvermögen, Flüssige Mittel, ...) alongside the postable leaf accounts.
 *     Importing a group subtotal AS an account double-counts its children. A Saldenliste alone cannot
 *     tell a group from a leaf, so this script requires the CHART export too (Kontoart == "Gruppe" is
 *     the group signal) and keeps only postable leaf accounts.
 *  2. A BALANCED RESULT IS ASSERTED. A closed balance sheet sums to zero (assets positive, equity +
 *     liabilities negative). A non-zero total is reported and the script exits non-zero, never a
 *     silent import of a half-open position.
 *
 * This is the interim, reviewable path. The permanent fix (make opening_balances / trial_balance
 * consume a signed `balance` column through the map, excluding group accounts) is a money-path engine
 * change tracked separately.
 *
 * USAGE (run after `npm run build`: it uses the built xlsx reader for .xlsx inputs)
 *   node scripts/migration/saldenliste-to-opening.mjs <saldenliste.(xlsx|csv)> <chart.(xlsx|csv)> [> opening.csv]
 *
 *   Output (stdout): `account,debitMinor,creditMinor`, the shape `migration_discover_source` reads for
 *   an `opening_balances` step. A summary goes to stderr, so a redirect captures only the CSV.
 *
 * PRIVACY: this reads your live figures and writes them out verbatim (only re-shaped). Keep both files
 * in your gitignored retention area; neither belongs in the repo.
 */
import { readFileSync } from 'node:fs';
import { parseXlsx } from '../../dist/core/migration/adapters/xlsx.js';

const ACCOUNT_HEADERS = ['kontonummer', 'konto', 'nummer', 'account', 'compte', 'conto', 'kontonr'];
const SALDO_HEADERS = ['saldo', 'solde', 'saldochf', 'balance', 'betrag'];
const KONTOART_HEADERS = ['kontoart', 'kontotyp', 'typ', 'accounttype'];

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Read an .xlsx (built parser) or a delimited text file into {headers, rows}. */
function readTable(path) {
  if (path.toLowerCase().endsWith('.xlsx')) {
    const res = parseXlsx(new Uint8Array(readFileSync(path)), {});
    if (res.ok === false || res.kind === 'failure') { process.stderr.write(`error: cannot read ${path}: ${JSON.stringify(res)}\n`); process.exit(1); }
    return { headers: res.headers, rows: res.rows };
  }
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length < 1) { process.stderr.write(`error: ${path} is empty\n`); process.exit(1); }
  const counts = { ';': (lines[0].match(/;/g) || []).length, '\t': (lines[0].match(/\t/g) || []).length, ',': (lines[0].match(/,/g) || []).length };
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const headers = lines[0].split(delim).map((h) => h.trim());
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(delim);
    return Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
  return { headers, rows };
}

/** Locate a column by a candidate list of normalised header names; exit if absent. */
function colKey(headers, candidates, label, path) {
  const hit = headers.find((h) => candidates.includes(norm(h)));
  if (hit === undefined) { process.stderr.write(`error: ${path}: no ${label} column found among headers: ${headers.join(' | ')}\n`); process.exit(1); }
  return hit;
}

function amountMinor(raw) {
  const cleaned = String(raw).replace(/'/g, '').replace(/\s/g, '').replace(/,/g, '.').trim();
  if (cleaned === '') return 0;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function main() {
  const [saldenlistePath, chartPath] = process.argv.slice(2);
  if (!saldenlistePath || !chartPath) {
    process.stderr.write('usage: node scripts/migration/saldenliste-to-opening.mjs <saldenliste.(xlsx|csv)> <chart.(xlsx|csv)> [> opening.csv]\n');
    process.exit(2);
  }

  // 1. The chart tells us which account numbers are postable leaves (Kontoart != "Gruppe").
  const chart = readTable(chartPath);
  const nrKey = colKey(chart.headers, ACCOUNT_HEADERS, 'account-number', chartPath);
  const artKey = colKey(chart.headers, KONTOART_HEADERS, 'Kontoart', chartPath);
  const postable = new Set();
  let groupCount = 0;
  for (const r of chart.rows) {
    const acc = String(r[nrKey] ?? '').trim();
    if (acc === '') continue;
    if (norm(r[artKey]) === norm('Gruppe')) { groupCount++; continue; }
    postable.add(acc);
  }

  // 2. The Saldenliste supplies the signed balances; keep only postable leaves.
  const sl = readTable(saldenlistePath);
  const accKey = colKey(sl.headers, ACCOUNT_HEADERS, 'account-number', saldenlistePath);
  const saldoKey = colKey(sl.headers, SALDO_HEADERS, 'Saldo', saldenlistePath);
  const out = [];
  let sumDebit = 0, sumCredit = 0, droppedGroup = 0, droppedZero = 0, droppedUnknown = 0;
  for (const r of sl.rows) {
    const account = String(r[accKey] ?? '').trim();
    if (account === '') continue;
    const saldo = amountMinor(r[saldoKey]);
    if (Number.isNaN(saldo)) { process.stderr.write(`error: account ${account}: unparseable Saldo "${r[saldoKey]}"\n`); process.exit(1); }
    if (!postable.has(account)) { droppedGroup++; continue; } // a group subtotal or an account not in the chart
    if (saldo === 0) { droppedZero++; continue; }
    const debitMinor = saldo > 0 ? saldo : 0;
    const creditMinor = saldo < 0 ? -saldo : 0;
    sumDebit += debitMinor;
    sumCredit += creditMinor;
    out.push(`${account},${debitMinor},${creditMinor}`);
  }

  process.stdout.write('account,debitMinor,creditMinor\n' + out.join('\n') + '\n');
  const balanced = sumDebit === sumCredit;
  process.stderr.write(
    `saldenliste-to-opening: ${out.length} postable leaf accounts kept; dropped ${droppedGroup} group/non-chart, ${droppedZero} zero. ` +
      `(chart: ${postable.size} postable, ${groupCount} Gruppe.) ` +
      `sum debit ${(sumDebit / 100).toFixed(2)} / credit ${(sumCredit / 100).toFixed(2)} CHF. ` +
      `${balanced ? 'BALANCED.' : `NOT BALANCED (difference ${((sumDebit - sumCredit) / 100).toFixed(2)} CHF) - not a closed balance sheet; check the export date/scope before importing.`}\n`,
  );
  if (!balanced) process.exit(1);
}

main();
