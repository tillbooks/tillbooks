/**
 * G11, `document_integrity` (spec §4): the manifest's sha256 set proved against the E00 blobs. The
 * uploaded export IS the Beleg (US-G09.8, OR 957a Abs. 2 Ziff. 2), so a source file whose bytes no
 * longer hash to what discovery recorded is a broken evidence chain, `failed`, per file.
 *
 * The content is read back through E00's own verb, never off the filesystem: the adapters-and-core
 * no-file-I/O property (G09 §4) holds here too.
 */

import { getFileContent } from '../../files/files.js';
import type { ControlModule } from './registry.js';

export const documentIntegrity: ControlModule = {
  kind: 'document_integrity',
  declarable: false,
  appliesTo: () => true,
  compute(ctx, _plan, _step, env) {
    const findings = [];
    for (const file of env.files) {
      const content = getFileContent(ctx, { fileId: file.fileId });
      if (!content.ok) {
        findings.push({
          scope: file.fileId,
          computedMinor: null,
          inputsPresent: true,
          selfStatus: 'failed' as const,
          detail: `Beleg ${file.fileId} ist nicht mehr lesbar (${(content as { error?: string }).error ?? 'unbekannt'})`,
        });
        continue;
      }
      const now = content.sha256 as string;
      const recorded = file.sha256;
      const intact = recorded === null || recorded === now;
      findings.push({
        scope: file.fileId,
        computedMinor: null,
        inputsPresent: true,
        selfStatus: intact ? ('passed' as const) : ('failed' as const),
        detail: intact ? `sha256 unverändert (${now.slice(0, 12)}…)` : `sha256 weicht ab: erfasst ${recorded}, gelesen ${now}`,
      });
    }
    return findings;
  },
};
