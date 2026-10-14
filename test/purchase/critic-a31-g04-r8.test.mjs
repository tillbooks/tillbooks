/**
 * Critic checks, A31 bill identity v2 (`qrbill/identity.ts`), round 8 (non-author critic, 01.10.2026),
 * against `claude/g04-restore-chokepoint` ddeabae1. The report is
 * `docs/critique/g04-a31-restore-qr-critic-r8.md`. These pin what v2 must NOT split: one paper read by
 * the stored bytes' text layer and by a supplied payload is one identity. Synthetic payloads only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { billIdentity, isCurrentIdentity } from '../../dist/core/purchase/qrbill/identity.js';
import { locateSpcPayload } from '../../dist/core/purchase/captureParse.js';

const BASE = [
  'SPC', '0200', '1', 'CH9300762011623852957',
  'S', 'Beispiel Druckerei GmbH', 'Seeweg', '12', '6000', 'Luzern', 'CH',
  '', '', '', '', '', '', '',
  '88.20', 'CHF',
  '', '', '', '', '', '', '',
  'NON', '', 'Rechnung  DR-2026-17', 'EPD',
];

test('R8 check: a text layer that runs on past a 31-element symbol (receipt text, a page footer) is the same identity', () => {
  const symbol = BASE.join('\n');
  const page = `Zahlteil\n${symbol}\nEmpfangsschein\nKonto / Zahlbar an\nCH93 0076 2011 6238 5295 7`;
  assert.equal(billIdentity(locateSpcPayload(page)), billIdentity(symbol));
});

test('R8 check: with Swico S1 the text layer running past the symbol keeps one identity', () => {
  const symbol = [...BASE, '//S1/10/DR-2026-17/11/261001'].join('\n');
  const page = `${symbol}\nEmpfangsschein\nAnnahmestelle`;
  assert.equal(billIdentity(locateSpcPayload(page)), billIdentity(symbol));
});

test('R8 check: CR+LF, a BOM, message whitespace and case, trailing breaks do not split one paper', () => {
  const id = billIdentity(BASE.join('\n'));
  assert.equal(billIdentity(`﻿${BASE.join('\r\n')}\r\n`), id);
  const spaced = [...BASE];
  spaced[29] = ' rechnung DR-2026-17 ';
  assert.equal(billIdentity(spaced.join('\n')), id);
});

test('R8 check: v1 values are never compared as current, v2 values always are', () => {
  assert.equal(isCurrentIdentity('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), false);
  assert.equal(isCurrentIdentity(null), false);
  assert.equal(isCurrentIdentity(billIdentity(BASE.join('\n'))), true);
});

test('R8 note (not graded): a 31-element symbol followed, in the text layer, by a line that opens with `//` IS split', () => {
  // Pinned so the limit is visible: the `EPD` + `//` guard reads the next text line as billing
  // information. A page line opening with `//` right after the symbol is not a realistic layout.
  const symbol = BASE.join('\n');
  assert.notEqual(billIdentity(locateSpcPayload(`${symbol}\n//www.beispiel.ch`)), billIdentity(symbol));
});
