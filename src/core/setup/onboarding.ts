/**
 * A23 `onboardClient`: the Treuhänder's one-call mandate setup.
 *
 * COMPOSES, NEVER RE-IMPLEMENTS. A00's `createWorkspace` stays the one verb that mints a
 * `workspace_id` (§H-TENANT); this verb calls it, exactly as A00's own `bootstrapWorkspace` does.
 * What it adds over a bare `create_workspace` is the mandate shape a fiduciary actually needs on
 * day one, in one idempotent unit:
 *
 *   1. `createWorkspace` mints the row and seeds the A01 Kontenrahmen KMU chart.
 *   2. When a VAT method is supplied, A05's `seedTaxCodes` seeds the default Swiss tax-code set and
 *      A00's `setVatMethod` records the method/timing pair. `vatMethod` and `vatAccounting` travel
 *      together or the call is refused: guessing a timing would write a tax fact nobody stated.
 *   3. A24's `seatFirstOwner` seats the D13 actors as accepted `owner` rows in `workspace_member`,
 *      audit-stamped `claim_owner`. A bare `create_workspace` leaves the book unprovisioned (the
 *      persona-F solo case, where A24's step 1 grants everything); a Treuhänder onboarding a CLIENT
 *      is exactly the operator who wants the matrix authoritative from birth, because A24's own
 *      warning applies: once a second mandate exists, an unclaimed book is an open one.
 *
 * EVERY INPUT IS VALIDATED BEFORE THE MEMOIZED UNIT. `rememberIdempotent` memoizes whatever its
 * compute returns, errors included, and runs it inside one transaction; validating first means a
 * refusal is never memoized beside a minted row, and the whole mint+seed+seat either lands or rolls
 * back together (§H-IDEMPOTENT: re-submitting the same key returns the existing workspace, never a
 * duplicate client).
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { makeContext } from '../context.js';
import { seedTaxCodes } from '../vat/index.js';
import { seatFirstOwner } from '../access/index.js';
import { ledgerPorts } from '../ledger/index.js';
import type { SetupDeps } from './workspace.js';
import { createWorkspace, setVatMethod } from './workspace.js';
import { LEGAL_FORMS, VAT_METHODS, VAT_TIMINGS, CURRENCIES, isFiscalYearStart } from './enums.js';

export interface OnboardClientInput {
  name: string;
  legalForm?: string;
  fiscalYearStart?: string;
  baseCurrency?: string;
  vatMethod?: string;
  vatAccounting?: string;
  idempotencyKey: string;
}

export function onboardClient(deps: SetupDeps, input: OnboardClientInput): Result {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return err('invalid_name');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // The same refusals `createWorkspace` would give, raised BEFORE the memoized unit so a bad field
  // never mints, and never memoizes a failure either.
  if (input.legalForm !== undefined && !LEGAL_FORMS.has(input.legalForm)) {
    return err('invalid_legal_form', { legalForm: input.legalForm });
  }
  if (input.baseCurrency !== undefined && !CURRENCIES.has(input.baseCurrency)) {
    return err('invalid_currency', { baseCurrency: input.baseCurrency });
  }
  if (input.fiscalYearStart !== undefined && !isFiscalYearStart(input.fiscalYearStart)) {
    return err('invalid_fiscal_year_start', { fiscalYearStart: input.fiscalYearStart });
  }
  // The pair travels together: a method without its timing (or the reverse) would force a guess
  // about a tax fact, and a guessed statutory value is a defect, not a default.
  if ((input.vatMethod === undefined) !== (input.vatAccounting === undefined)) {
    return err('invalid_input', {
      field: input.vatMethod === undefined ? 'vatMethod' : 'vatAccounting',
    });
  }
  if (input.vatMethod !== undefined && !VAT_METHODS.has(input.vatMethod)) {
    return err('invalid_vat_method', { vatMethod: input.vatMethod });
  }
  if (input.vatAccounting !== undefined && !VAT_TIMINGS.has(input.vatAccounting)) {
    return err('invalid_vat_accounting', { vatAccounting: input.vatAccounting });
  }

  // Pre-workspace, so the memo lives in the '_system' namespace (the createWorkspace precedent),
  // and the whole mint+seed+seat replays as one unit.
  return deps.store.rememberIdempotent('_system', input.idempotencyKey, 'onboard_client', () => {
    const created = createWorkspace(deps, {
      name: input.name,
      ...(input.legalForm !== undefined ? { legalForm: input.legalForm } : {}),
      ...(input.baseCurrency !== undefined ? { baseCurrency: input.baseCurrency } : {}),
      ...(input.fiscalYearStart !== undefined ? { fiscalYearStart: input.fiscalYearStart } : {}),
    });
    if (!created.ok) return created;
    const workspaceId = created.workspaceId as string;

    // The REAL A03 audit port, so the seating's `claim_owner` rows land on the chain exactly as
    // they do when `inviteMember` provisions a workspace.
    const ctx = makeContext(deps.store, {
      workspaceId,
      actor: deps.actor ?? 'system',
      clock: deps.clock,
      ids: deps.ids,
      ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }),
    });

    if (input.vatMethod !== undefined && input.vatAccounting !== undefined) {
      // Seed first, then record the method: the same order Setup walks a human through, and both
      // idempotent (the seed is an upsert keyed by code, the method an absolute pair).
      const seeded = seedTaxCodes(ctx);
      if (!seeded.ok) return seeded;
      const method = setVatMethod(ctx, {
        vatMethod: input.vatMethod,
        vatAccounting: input.vatAccounting,
      });
      if (!method.ok) return method;
    }

    seatFirstOwner(ctx);
    return ok({ workspaceId });
  });
}
