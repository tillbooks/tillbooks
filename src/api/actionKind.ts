/**
 * D159/D160: THE KIND A VERB IS REGISTERED UNDER. A write declares how far it can be undone AND what it
 * touches, on its own registration line:
 *
 *   ctxAction('archive_account', 'write:reversible:internal', ...)
 *   ctxAction('post_entry', 'write:correctable:books', ...)
 *   ctxAction('contacts_anonymise', 'write:final:erase', ...)
 *
 * The class is one of the catalogue's three words (`src/core/agent/consequences.ts`); the tag is one of
 * the closed D160 consequence tags (`src/core/agent/consequenceTag.ts`). `ctxAction` / `depsAction`
 * (`registry.ts`) split the string: `ActionDef.kind` stays `'read' | 'write'`, so the agent seam, A24 and
 * every suite read exactly what they read before, the class lands on `ActionDef.reversibility` and the
 * tag on `ActionDef.consequenceTag`. A malformed kind throws at load with the verb named.
 *
 * WHY THE TAG LIVES IN THE KIND STRING (and not in a sidecar map or a sixth argument): it is the only
 * place where a write with no tag is a COMPILE error. A sidecar keyed by verb name can only be checked
 * at load, because no type knows the set of verb names; a separate argument would be a second positional
 * slot on 449 call sites that a reader has to pair with the first. One literal carries the whole D159/D160
 * declaration, and `splitActionKind` is the runtime belt for a cast or a plain-JS caller.
 *
 * STRICT since the D159 codemod: a bare `'write'` (or a class with no tag) no longer compiles, and the
 * registry asserts at load that every write carries both (`assertEveryWriteIsClassified`).
 * `test/types/write-kind.neg.ts` holds the refusals.
 *
 * Type only: nothing here exists at runtime.
 */

import type { Reversibility as CatalogueReversibility } from '../core/agent/consequences.js';
import type { ConsequenceTag } from '../core/agent/consequenceTag.js';

export type { ConsequenceTag, ExemptConsequenceTag, GatedConsequenceTag } from '../core/agent/consequenceTag.js';

/**
 * How far a write can be undone (D158.3 / D159.3). One definition: this is the catalogue's own type.
 *   - `reversible`: a verb changes it back (a setting, an archive, a pause);
 *   - `correctable`: the act stands and a mistake is fixed by a new linked entry or document;
 *   - `final`: there is no way back inside TILL.
 */
export type Reversibility = CatalogueReversibility;

/** A classified, tagged write: `write:<class>:<tag>`, e.g. `write:correctable:books`. */
export type ClassifiedWriteKind = `write:${Reversibility}:${ConsequenceTag}`;

/** The kind set the registry accepts: a read, or a write WITH its class and its consequence tag. */
export type STRICT_ACTION_KIND = 'read' | ClassifiedWriteKind;

/** What `ctxAction` / `depsAction` accept: the strict set, and nothing else. */
export type ActionKind = STRICT_ACTION_KIND;
