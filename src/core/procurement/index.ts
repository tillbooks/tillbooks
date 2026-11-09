/**
 * The I-cluster (advanced procurement) engine barrel. I00 lands the requisition document; I01+ extend
 * the chain (advanced PO, goods receipt, three-way match).
 */

export {
  REQUISITION_STATUSES,
  REQUISITION_URGENCIES,
  evaluateApprovalPolicy,
  requisitionUpsert,
  requisitionSubmit,
  requisitionApprove,
  requisitionReject,
  requisitionReturn,
  requisitionConvertToPo,
  requisitionCancel,
  requisitionClose,
  requisitionGet,
  requisitionList,
  requisitionMyPendingApprovals,
} from './requisition.js';
export type {
  RequisitionStatus,
  RequisitionUrgency,
  RequisitionUpsertInput,
  RequisitionSimpleInput,
  RequisitionDecisionInput,
  RequisitionConvertInput,
  RequisitionCancelInput,
  RequisitionListInput,
} from './requisition.js';
export { PROCUREMENT_SCHEMA_SQL } from './schema.js';

// I02, the goods receipt: the reversible, inspection-aware document over the D02/I01 purchase order
// whose only stock path is J02's movement ledger.
export {
  goodsReceiptCreate,
  goodsReceiptUpsertLines,
  goodsReceiptPreview,
  goodsReceiptPost,
  goodsReceiptAcceptLines,
  goodsReceiptRejectLines,
  goodsReceiptReverse,
  goodsReceiptCancel,
  goodsReceiptGet,
  goodsReceiptList,
  goodsReceiptLinesForMatch,
  goodsReceiptGetConfig,
  goodsReceiptSetConfig,
  readReceiptConfig,
} from './receipt.js';
export type {
  GoodsReceiptCreateInput,
  GoodsReceiptUpsertLinesInput,
  GoodsReceiptSimpleInput,
  GoodsReceiptLineDecisionInput,
  GoodsReceiptReverseInput,
  GoodsReceiptCancelInput,
  GoodsReceiptListInput,
  GoodsReceiptSetConfigInput,
  ReceiptLineOpInput,
  ReceiptConfig,
} from './receipt.js';
export {
  GOODS_RECEIPT_STATUSES,
  RECEIPT_INSPECTION_STATUSES,
  RECEIPT_LINE_OPS,
  RECEIPT_EVENT_TYPES,
  RECEIPT_SOURCE_DOCUMENT_TYPE,
  isGoodsReceiptStatus,
  isReceiptInspectionStatus,
  isReceiptLineOp,
} from './receiptEnums.js';
export type { GoodsReceiptStatus, ReceiptInspectionStatus, ReceiptEventType, ReceiptLineOp } from './receiptEnums.js';
export { RECEIPT_SCHEMA_SQL } from './receiptSchema.js';

// I03, landed cost allocation: the voucher that capitalises freight/duty/handling onto inventory,
// writing value-only J02 landed_cost movements + one balanced A02 entry, fully reversible.
export {
  landedCostVoucherCreate,
  landedCostAllocatePreview,
  landedCostAllocateConfirm,
  landedCostReverse,
  landedCostList,
  landedCostGet,
} from './landed_cost.js';
export type {
  VoucherCreateInput,
  AllocatePreviewInput,
  AllocateConfirmInput,
  ReverseInput as LandedCostReverseInput,
  ListInput as LandedCostListInput,
} from './landed_cost.js';
export {
  ALLOCATION_METHODS,
  COMPONENT_TYPES,
  isAllocationMethod,
  isComponentType,
  allocate as allocateLandedCost,
} from './landedCostAllocator.js';
export type { AllocationMethod, ComponentType, AllocationPreview, AllocatorTarget } from './landedCostAllocator.js';
export { LANDED_COST_SCHEMA_SQL } from './landedCostSchema.js';
// I04, the three-way match: the pure calculator + the persistence/read verbs over the A17 bill <->
// I01 PO line <-> I02 receipt line triangle. Posts nothing; increments po_line.billed_qty only.
export {
  matchThreeWayEvaluate,
  matchThreeWayCreate,
  matchThreeWayOverride,
  matchThreeWayReverse,
  matchThreeWayGet,
  matchThreeWayList,
  matchThreeWayExceptions,
  matchStatusForBill,
  computeEvaluation,
  DEFAULT_TOLERANCE,
} from './threeWayMatch.js';
export type {
  MatchStatus,
  MatchTolerance,
  EvaluationStatus,
  LineStatus,
  EvaluationLine,
  MatchEvaluation,
  MatchThreeWayEvaluateInput,
  MatchThreeWayCreateInput,
  MatchThreeWayOverrideInput,
  MatchThreeWayReverseInput,
  MatchThreeWayGetInput,
  MatchThreeWayListInput,
  MatchThreeWayExceptionsInput,
  MatchStatusForBillInput,
} from './threeWayMatch.js';
export { THREE_WAY_MATCH_SCHEMA_SQL } from './threeWayMatchSchema.js';

// I05, supplier performance: a pure read model deriving OTIF, quantity, price and override metrics
// from the live I02 receipts and the D02 po_match trail. Owns no table and writes nothing.
export {
  PERFORMANCE_METRICS,
  METRIC_UNIT,
  DEFAULT_PERFORMANCE_CONFIG,
  isMetricId,
  resolveWindow,
  computeMetrics,
  normalise,
  overallScore,
  trafficLight,
  supplierScorecardGet,
  supplierPerformanceRank,
  supplierPerformanceTrend,
  supplierPerformanceExplain,
  supplierPerformanceAlerts,
} from './supplier-performance.js';
export type {
  MetricId,
  PerformanceConfig,
  PerformanceConfigOverride,
  Window as PerformanceWindow,
  RawMetrics,
  MetricView,
  ScorecardException,
  ScorecardInput,
  RankInput,
  TrendInput,
  ExplainInput,
  AlertsInput,
} from './supplier-performance.js';

// I06, procurement analytics & agent tools: ten PURE READS over the live I00-I05 + D02 documents
// (open commitments, match status, spend, supplier scorecard, requisition pipeline, GR/IR clearing,
// landed-cost variance, PO cycle, anomalies, PO history). Owns no table and writes nothing.
export {
  procurementOpenCommitments,
  procurementMatchStatus,
  procurementSpendSummary,
  procurementSupplierScorecard,
  procurementRequisitionPipeline,
  procurementGrirClearing,
  procurementLandedCostVariance,
  procurementPoCycle,
  procurementAnomalies,
  procurementPoHistory,
} from './analytics.js';
export type {
  OpenCommitmentsInput,
  MatchStatusInput,
  SpendSummaryInput,
  SupplierScorecardInput as AnalyticsSupplierScorecardInput,
  RequisitionPipelineInput,
  GrirClearingInput,
  LandedCostVarianceInput,
  PoCycleInput,
  AnomaliesInput,
  PoHistoryInput,
} from './analytics.js';
