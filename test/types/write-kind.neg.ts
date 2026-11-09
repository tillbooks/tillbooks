/**
 * D159/D160, a NEGATIVE type test: the registration kind refuses a write that does not declare its
 * reversibility class AND its consequence tag.
 *
 * Read by `tsconfig.test.json` (its `include` names `test/types/**\/*.ts`), so `npm run typecheck`
 * judges it. Each `@ts-expect-error` below must be USED: if `ActionKind` ever starts accepting a bare,
 * untagged or malformed write, the directive goes unused, TS2578 fires and the typecheck fails. The
 * positive lines hold the other direction, so a set that refused everything could not pass either.
 *
 * Nothing here runs: `npm test` only picks up `*.test.mjs`.
 */

import type {
  ActionKind,
  ClassifiedWriteKind,
  ConsequenceTag,
  ExemptConsequenceTag,
  GatedConsequenceTag,
  STRICT_ACTION_KIND,
} from '../../src/api/actionKind.js';

// The registry's kind IS the strict set: nothing transitional is left.
export const sameSet: STRICT_ACTION_KIND = 'read' as ActionKind;
export const sameSetBack: ActionKind = 'read' as STRICT_ACTION_KIND;

// A read, or a write that declares its class and its tag.
export const strictRead: ActionKind = 'read';
export const reversibleInternal: ActionKind = 'write:reversible:internal';
export const correctableBooks: ActionKind = 'write:correctable:books';
export const finalErase: ActionKind = 'write:final:erase';
export const finalHumanOnly: ClassifiedWriteKind = 'write:final:human-only';
export const reversibleUiState: ClassifiedWriteKind = 'write:reversible:ui-state';
export const correctablePreWorkspace: ClassifiedWriteKind = 'write:correctable:pre-workspace';

// @ts-expect-error D159: a bare write, the pre-codemod form, no longer compiles.
export const bareWrite: ActionKind = 'write';

// @ts-expect-error D160: a class without its consequence tag is not a kind.
export const untagged: ActionKind = 'write:final';

// @ts-expect-error D159: only the three catalogue classes exist.
export const unknownClass: ActionKind = 'write:undoable:books';

// @ts-expect-error D160: the tags are a closed union.
export const unknownTag: ActionKind = 'write:final:money';

// @ts-expect-error D160: the tag is not optional once its separator is written.
export const emptyTag: ActionKind = 'write:final:';

// @ts-expect-error D159: the order is class, then tag.
export const swapped: ActionKind = 'write:books:final';

// @ts-expect-error a read carries no class or tag.
export const taggedRead: ActionKind = 'read:final:books';

// The exemption reasons are closed: a gated tag is not an exemption, and an invented reason is neither.
export const exempt: ExemptConsequenceTag = 'stop';
// @ts-expect-error D160.2: `books` is gated, never an exemption reason.
export const gatedAsExempt: ExemptConsequenceTag = 'books';
// @ts-expect-error D160.2: no reason outside the closed list.
export const inventedReason: ConsequenceTag = 'harmless';
export const gated: GatedConsequenceTag = 'outbound';
// @ts-expect-error D160.1: an exemption reason is not a gated tag.
export const exemptAsGated: GatedConsequenceTag = 'internal';
