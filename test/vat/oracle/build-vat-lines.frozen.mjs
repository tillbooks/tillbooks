// THE ORACLE, frozen on 02.10.2026 (D152 amendment). Not production code.
//
// A line-for-line JavaScript copy of `buildVatLines` from `src/core/vat/applyVat.ts` as it stood BEFORE it
// was refactored onto the counter-less `buildVatLineParts` (branch claude/ux-composer-a1 at 7cfc6d5).
// `test/vat/build-vat-lines-identity.test.mjs` holds the live builder byte-identical to this copy over
// every caller's shapes. Do not edit it to make a test pass: a difference is the finding.

import { computeLineTax } from '../../../dist/core/vat/index.js';

function accountByNumber(ctx, number) {
  const row = ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number);
  if (row === undefined) {
    throw new Error(`missing_vat_account: ${number}`);
  }
  return row.id;
}

export function frozenBuildVatLines(ctx, input) {
  const computed = computeLineTax(ctx, {
    amountMinor: input.amountMinor,
    amountIsGross: input.amountIsGross,
    taxCode: input.taxCode ?? null,
    supplyDate: input.supplyDate ?? null,
  });
  if (!computed.ok) {
    throw new Error(String(computed.error));
  }

  const kind = computed.kind;
  const net = computed.netMinor;
  const tax = computed.taxMinor;
  const gross = computed.grossMinor;
  const deductible = computed.deductible;
  const cc = input.costCenterId;
  const formLine = computed.formLine;
  const computedTrace = computed.trace;

  const withCc = (line) => (cc !== undefined ? { ...line, costCenter: cc } : line);
  const trace = {};
  if (computedTrace.taxCode !== null) trace.taxCode = computedTrace.taxCode;
  if (computedTrace.taxBaseMinor !== null) trace.taxBase = computedTrace.taxBaseMinor;
  if (computedTrace.taxAmountMinor !== null) trace.taxAmount = computedTrace.taxAmountMinor;
  if (computedTrace.taxCode !== null && input.supplyDate != null) trace.supplyDate = input.supplyDate;
  const inputVatAccount = () => accountByNumber(ctx, formLine === '405' ? '1171' : '1170');

  if ((kind === 'reverse_charge' || kind === 'import') && input.direction !== 'input') {
    throw new Error(`invalid_direction: ${kind} books on the input side, got '${input.direction}'`);
  }

  if (kind === 'reverse_charge') {
    const lines = [];
    lines.push(withCc({ account: input.revenueOrExpenseAccount, debit: net, ...trace }));
    lines.push(withCc({ account: input.counterAccount, credit: net }));
    lines.push({ account: accountByNumber(ctx, '2200'), credit: tax });
    if (deductible) {
      lines.push({ account: inputVatAccount(), debit: tax });
    } else {
      lines.push(withCc({ account: input.revenueOrExpenseAccount, debit: tax }));
    }
    return lines;
  }

  if (kind === 'import') {
    const importTaxLine = deductible
      ? { account: inputVatAccount(), debit: tax, ...trace }
      : withCc({ account: input.revenueOrExpenseAccount, debit: tax, ...trace });
    return [importTaxLine, withCc({ account: input.counterAccount, credit: tax })];
  }

  if (input.direction === 'output') {
    const lines = [
      withCc({ account: input.counterAccount, debit: gross }),
      withCc({ account: input.revenueOrExpenseAccount, credit: net, ...trace }),
    ];
    if (tax !== 0) lines.push({ account: accountByNumber(ctx, '2200'), credit: tax });
    return lines;
  }

  if (deductible && tax !== 0) {
    return [
      withCc({ account: input.revenueOrExpenseAccount, debit: net, ...trace }),
      { account: inputVatAccount(), debit: tax },
      withCc({ account: input.counterAccount, credit: gross }),
    ];
  }
  return [
    withCc({ account: input.revenueOrExpenseAccount, debit: gross, ...trace }),
    withCc({ account: input.counterAccount, credit: gross }),
  ];
}
