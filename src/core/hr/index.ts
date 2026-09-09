/** E02, HR-lite: the barrel every face resolves E02's verbs through. */

export { HR_SCHEMA_SQL } from './schema.js';
export {
  ABSENCE_KINDS,
  ABSENCE_STATUSES,
  CLAIM_STATUSES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_IDS,
  EXPENSE_CLAIM_SOURCE,
} from './enums.js';

export { upsertEmployee, getEmployee, listEmployees } from './employees.js';
export { recordAbsence, cancelAbsence, listAbsences } from './absences.js';
export {
  createClaim,
  upsertLine,
  submitClaim,
  approveClaim,
  rejectClaim,
  reimburseClaim,
  listClaims,
  getClaim,
} from './claims.js';
