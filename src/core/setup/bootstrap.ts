/**
 * A00 `bootstrapWorkspace`: the agent's one-call setup. Parses a short natural-language description
 * into config, mints the workspace (A00 `createWorkspace`), configures VAT (A05 `configureVat`) when
 * the description warrants it, and reports honestly:
 *  - `applied[]`: the fields it set from the description.
 *  - `needs[]`: what a complete Swiss setup still requires but the description could NOT provide. It
 *    NEVER fabricates a QR-IBAN or an MWST-Nr: if the description does not carry one, it lands in
 *    `needs`, never invented (a wrong statutory identifier is worse than a missing one).
 *
 * Idempotent on `idempotencyKey` (§H-IDEMPOTENT): re-running the same instruction returns the existing
 * workspace, never a second one. Parsing is deliberately conservative: an unrecognised hint is simply
 * not applied (and its field surfaces in `needs`), rather than guessed.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { SetupDeps } from './workspace.js';
import { createWorkspace } from './workspace.js';
import { makeContext } from '../context.js';
import { configureVat } from '../vat/index.js';

export interface BootstrapWorkspaceInput {
  description: string;
  /** An explicit name wins over the one parsed from the description. */
  name?: string;
  idempotencyKey: string;
}

interface ParsedConfig {
  name?: string;
  legalForm?: string;
  baseCurrency?: string;
  registered: boolean;
  vatMethod?: string;
  vatTiming?: string;
  mwstNo?: string;
}

const LEGAL_FORM_PATTERNS: [RegExp, string][] = [
  [/\beinzel(firma|unternehmen)?\b/i, 'einzelfirma'],
  [/\bgmbh\b/i, 'gmbh'],
  [/\bag\b/i, 'ag'],
];

/** Parse the free text conservatively; only set a field when a hint is unambiguous. */
export function parseBootstrapDescription(description: string, explicitName?: string): ParsedConfig {
  const text = typeof description === 'string' ? description : '';
  const parsed: ParsedConfig = { registered: false };

  for (const [re, form] of LEGAL_FORM_PATTERNS) {
    if (re.test(text)) {
      parsed.legalForm = form;
      break;
    }
  }

  const currency = /\b(CHF|EUR|USD)\b/.exec(text);
  if (currency?.[1]) parsed.baseCurrency = currency[1];

  if (/\bmwst|vat|steuerpflichtig|registered|register/i.test(text)) parsed.registered = true;

  // A VAT number in the ESTV shape; normalise to the `... MWST` form. NEVER fabricated: only lifted
  // verbatim from the description when present.
  const mwst = /CHE-\d{3}\.\d{3}\.\d{3}(?:\s*MWST)?/i.exec(text);
  if (mwst?.[0]) {
    parsed.mwstNo = `${mwst[0].replace(/\s*MWST$/i, '').toUpperCase()} MWST`;
    parsed.registered = true;
  }

  if (/\beffektiv|effective\b/i.test(text)) parsed.vatMethod = 'effektiv';
  else if (/\bsaldo|net.?tax\b/i.test(text)) parsed.vatMethod = 'saldo';
  // Declaring a VAT method means the business is VAT-registered.
  if (parsed.vatMethod !== undefined) parsed.registered = true;

  if (/\bvereinbart|accrual|soll\b/i.test(text)) parsed.vatTiming = 'soll';
  else if (/\bvereinnahmt|cash|ist\b/i.test(text)) parsed.vatTiming = 'ist';

  // Name: explicit wins; else the clause before the first comma, stripped of filler and the trailing
  // legal-form word kept (a name like "Muster GmbH" keeps "GmbH").
  const nameFromText = text
    .split(',')[0]
    ?.replace(/^\s*(wir sind|we(?:'re| are)|ich bin|i am)\s+(die|der|das|the|a|an)?\s*/i, '')
    .trim();
  const resolvedName = explicitName && explicitName.trim().length > 0 ? explicitName.trim() : nameFromText || undefined;
  if (resolvedName !== undefined && resolvedName.length > 0) parsed.name = resolvedName;

  return parsed;
}

export function bootstrapWorkspace(deps: SetupDeps, input: BootstrapWorkspaceInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const cfg = parseBootstrapDescription(input.description, input.name);
  if (cfg.name === undefined || cfg.name.length === 0) {
    return err('needs_name', { reason: 'no company name could be parsed; pass an explicit name' });
  }
  const name: string = cfg.name;

  // The whole bootstrap is one idempotent unit: minting + configuring replay together on a retry.
  return deps.store.rememberIdempotent('_system', input.idempotencyKey, 'bootstrap_workspace', () => {
    const applied: string[] = ['name'];
    const created = createWorkspace(deps, {
      name,
      ...(cfg.legalForm !== undefined ? { legalForm: cfg.legalForm } : {}),
      ...(cfg.baseCurrency !== undefined ? { baseCurrency: cfg.baseCurrency } : {}),
    });
    if (!created.ok) return created;
    const workspaceId = created.workspaceId as string;
    if (cfg.legalForm !== undefined) applied.push('legalForm');
    if (cfg.baseCurrency !== undefined) applied.push('baseCurrency');

    const ctx = makeContext(deps.store, { workspaceId, actor: deps.actor ?? 'system', clock: deps.clock, ids: deps.ids });

    // What a complete Swiss setup still requires but the description could not supply, never fabricated.
    const needs: string[] = [];

    // Configure VAT only when we have enough to do so honestly. Effektiv is rate-free and configurable
    // from prose; saldo needs a Saldosteuersatz that a description cannot supply, so it becomes a need
    // rather than a guessed rate.
    if (cfg.registered && cfg.vatMethod === 'effektiv') {
      const configured = configureVat(ctx, {
        method: 'effektiv',
        timing: cfg.vatTiming ?? 'soll',
        registered: true,
        ...(cfg.mwstNo !== undefined ? { vatNumber: cfg.mwstNo } : {}),
        idempotencyKey: `${input.idempotencyKey}:vat`,
      });
      if (configured.ok) {
        applied.push('vatMethod', 'vatTiming', 'registered');
        if (cfg.mwstNo !== undefined) applied.push('mwstNo');
      }
    } else if (cfg.registered && cfg.vatMethod === 'saldo') {
      needs.push('saldoRate'); // the Saldosteuersatz is a statutory value, never derived from prose.
      if (cfg.mwstNo !== undefined) {
        updateMwstNo(deps, workspaceId, cfg.mwstNo);
        applied.push('mwstNo');
      }
    } else if (cfg.mwstNo !== undefined) {
      // A number was given but no method: store the number so it is not lost, flag the method as needed.
      updateMwstNo(deps, workspaceId, cfg.mwstNo);
      applied.push('mwstNo');
    }

    if (cfg.registered && cfg.vatMethod === undefined) needs.push('vatMethod');
    if (cfg.registered && cfg.mwstNo === undefined) needs.push('mwstNo');
    // Required for a QR-bill (A11), never derivable from prose. An IBAN of EITHER kind will do
    // (M-2): a QR-IBAN gives a QRR reference, a plain IBAN gives SCOR, and both are valid bills, so
    // asking specifically for a QR-IBAN would state a requirement that does not exist and would tell
    // the large share of Swiss SMEs that have no QR-IBAN that they cannot be set up.
    needs.push('creditorAddress', 'creditorIban');

    return ok({ workspaceId, applied, needs });
  });
}

function updateMwstNo(deps: SetupDeps, workspaceId: string, mwstNo: string): void {
  deps.store.db.prepare('UPDATE workspace SET mwst_no = ?, vat_registered = 1 WHERE id = ?').run(mwstNo, workspaceId);
}
