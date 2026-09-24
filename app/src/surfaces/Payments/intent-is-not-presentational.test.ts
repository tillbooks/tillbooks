/**
 * P9's structural claim, asserted rather than trusted.
 *
 * The decision (D38) says: "suppressing the dialog changes what a person sees and NEVER what the
 * wire requires". That sentence is easy to satisfy today by remembering to pass the token at both
 * call sites, and easy to break tomorrow with one refactor that threads the preference a little
 * further than it should go. These tests fail when it is broken.
 *
 * The strongest of them is the last: it reads `intent.ts` off DISK as text and asserts the module
 * never imports the preference module. A type-level test cannot see a coupling that a future author
 * introduces; a source scan can.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PAYMENT_INTENT,
  recordPaymentRequest,
  allocatePaymentRequest,
  reversePaymentRequest,
  previewPaymentRequest,
  type RecordPaymentFields,
} from './intent';
import { shouldConfirmPost, setConfirmPostSuppressed, CONFIRM_PREFERENCE_PREFIX } from './confirm-preference';

const HERE = dirname(fileURLToPath(import.meta.url));

const FIELDS: RecordPaymentFields = {
  workspaceId: 'ws_test',
  direction: 'incoming',
  date: '2026-07-19',
  amountMinor: 108100,
  bankAccountId: 'acc_2',
  counterpartyId: 'contact_1',
  reference: '210000000003139471430009017',
  allocations: [{ documentId: 'doc_1', amountMinor: 108100 }],
  idempotencyKey: 'idem-1',
};

describe('the intent token is on the wire, not in the dialog', () => {
  it('attaches record_payment intent with no caller parameter for it', () => {
    expect(recordPaymentRequest(FIELDS).intent).toBe('post_payment');
  });

  it('gives each write verb its OWN token, so one cannot be reused for another', () => {
    const record = recordPaymentRequest(FIELDS).intent;
    const allocate = allocatePaymentRequest({
      workspaceId: 'ws_test',
      paymentId: 'pay_1',
      allocations: [{ documentId: 'doc_1', amountMinor: 100 }],
      idempotencyKey: 'idem-2',
    }).intent;
    const reverse = reversePaymentRequest({
      workspaceId: 'ws_test',
      paymentId: 'pay_1',
      idempotencyKey: 'idem-3',
    }).intent;

    expect(new Set([record, allocate, reverse]).size).toBe(3);
    expect([record, allocate, reverse]).toEqual([
      'post_payment',
      'allocate_payment',
      'reverse_payment',
    ]);
  });

  it('never puts an intent on the read-only preview, which can therefore never post', () => {
    const body = previewPaymentRequest(FIELDS);
    expect('intent' in body).toBe(false);
  });
});

describe('the suppression preference cannot change the wire', () => {
  const WORKSPACE = 'ws_test';

  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('sends a byte-identical body whether the dialog is shown or suppressed', () => {
    setConfirmPostSuppressed(WORKSPACE, false);
    expect(shouldConfirmPost(WORKSPACE)).toBe(true);
    const shown = JSON.stringify(recordPaymentRequest(FIELDS));

    setConfirmPostSuppressed(WORKSPACE, true);
    expect(shouldConfirmPost(WORKSPACE)).toBe(false);
    const suppressed = JSON.stringify(recordPaymentRequest(FIELDS));

    expect(suppressed).toBe(shown);
    expect(JSON.parse(suppressed).intent).toBe(PAYMENT_INTENT.record);
  });

  it('keys the preference per workspace, so one set of books never answers for another', () => {
    setConfirmPostSuppressed('ws_alpha', true);
    expect(shouldConfirmPost('ws_alpha')).toBe(false);
    expect(shouldConfirmPost('ws_beta')).toBe(true);
    expect(window.localStorage.getItem(`${CONFIRM_PREFERENCE_PREFIX}:ws_alpha`)).toBe('suppressed');
  });

  it('fails SAFE to showing the dialog when localStorage throws', () => {
    const original = window.localStorage.getItem;
    // A hardened profile or Safari private browsing throws outright on access.
    window.localStorage.getItem = () => {
      throw new Error('SecurityError');
    };
    try {
      expect(shouldConfirmPost(WORKSPACE)).toBe(true);
    } finally {
      window.localStorage.getItem = original;
    }
  });

  it('treats an absent workspace as "ask", never as "suppressed"', () => {
    expect(shouldConfirmPost(null)).toBe(true);
  });
});

describe('the coupling that would make the claim false does not exist', () => {
  it('never lets the request builders import the presentation preference', () => {
    const source = readFileSync(join(HERE, 'intent.ts'), 'utf8');
    // The whole P9 guarantee rests on these two modules being unable to reach each other. A source
    // scan is what catches a future author threading the preference "just one level deeper".
    expect(source).not.toMatch(/from\s+'\.\/confirm-preference'/);
    expect(source).not.toMatch(/shouldConfirmPost|setConfirmPostSuppressed/);
  });

  it('offers no parameter through which a caller could withhold an intent', () => {
    // Every write builder's body carries the token as a literal, so there is no branch to take.
    const source = readFileSync(join(HERE, 'intent.ts'), 'utf8');
    expect(source).toMatch(/intent: PAYMENT_INTENT\.record/);
    expect(source).toMatch(/intent: PAYMENT_INTENT\.allocate/);
    expect(source).toMatch(/intent: PAYMENT_INTENT\.reverse/);
    // A builder taking `intent` as an argument is exactly the regression this forbids.
    expect(source).not.toMatch(/intent\??:\s*string/);
  });
});
