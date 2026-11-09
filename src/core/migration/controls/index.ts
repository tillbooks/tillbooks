/**
 * G11, the assembled control registry: one row per kind, in the spec §4 table order. `check.ts`
 * iterates THIS array and derives every status generically; adding a control is one module plus one
 * row here plus a fixture, and nothing anywhere switches on a kind.
 *
 * NO PLUGIN MAY REGISTER A CONTROL (spec §6b Fixed): this array is a compile-time constant with no
 * registration seam, deliberately, because a third party defining what "the books tie out" means is
 * exactly the thing an auditor could look at.
 */

export {
  CONTROL_KINDS,
  CONTROL_STATUSES,
  CHECK_RUNS,
  isControlKind,
  isControlStatus,
} from './registry.js';
export type {
  ControlKind,
  ControlStatusValue,
  CheckRun,
  ControlEnv,
  ControlFinding,
  ControlModule,
  SourceFileFact,
} from './registry.js';

import type { ControlModule } from './registry.js';
import { trialBalanceBalanced, trialBalanceMatchesSource } from './trialBalance.js';
import { arControl } from './arControl.js';
import { apControl } from './apControl.js';
import { bankControl } from './bankControl.js';
import { vatBalanceAtCutover } from './vatBalance.js';
import { rowCount } from './rowCount.js';
import { documentIntegrity } from './documentIntegrity.js';
import { sourceAsAt } from './sourceAsAt.js';

export const CONTROL_REGISTRY: readonly ControlModule[] = [
  trialBalanceBalanced,
  trialBalanceMatchesSource,
  arControl,
  apControl,
  bankControl,
  vatBalanceAtCutover,
  rowCount,
  documentIntegrity,
  sourceAsAt,
];
