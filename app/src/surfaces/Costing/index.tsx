/**
 * The Costing component library (B03): NO route of its own (the `Vat/` shape). The Projects
 * surface mounts `ProjectProfitability` on its detail panel; styles ride this entry so the one
 * consumer carries the CSS.
 */
import './Costing.css';

export { ProjectProfitability } from './ProjectProfitability';
export type { ProjectPl, BudgetVsActual, ProjectProfitabilityProps } from './ProjectProfitability';
