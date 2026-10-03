/**
 * 领域事件信封字段约定。
 *
 * @typedef {Object} DomainEvent
 * @property {string} event_id 事件标识，即幂等键：重复投递不得重复生效
 * @property {string} event_type
 * @property {string} aggregate_type
 * @property {string} aggregate_id
 * @property {string} occurred_at 业务发生时间（含时区偏移），离线补录以此对账
 * @property {number} version 同一聚合内从 1 开始严格递增
 * @property {string} summary
 */

export const domainEventFields = Object.freeze([
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
]);

/** 已登记事件类型，与 contracts/domain.schema.json 的枚举保持一致。 */
export const EVENT_TYPES = Object.freeze([
  "PLAN_CONFIRMED",
  "CAPACITY_CHANGED",
  "SESSION_RESERVED",
  "SESSION_LOCKED",
  "SESSION_CLOSED",
  "TRANSFER_PROPOSED",
  "TRANSFER_ACCEPTED",
  "TREATMENT_RECONCILED",
  "ROUTE_STATUS_CHANGED",
  "SETTLEMENT_RECORDED",
]);

/** 已登记聚合类型，与 contracts/domain.schema.json 的枚举保持一致。 */
export const AGGREGATE_TYPES = Object.freeze([
  "treatment_plan",
  "resource_capacity",
  "dialysis_session",
  "transfer_handoff",
  "route_status",
  "settlement",
]);

/** 场次结案原因：实际治疗 / 未到 / 途中风险 / 临时住院，分别结案。 */
export const CLOSURE_REASONS = Object.freeze([
  "TREATED",
  "NO_SHOW",
  "EN_ROUTE_RISK",
  "TEMP_ADMISSION",
]);

/** 场次状态机：RESERVED → LOCKED → TRANSFERRED（被转运取代）→ CLOSED（结案）。 */
export const SESSION_STATUSES = Object.freeze([
  "RESERVED",
  "LOCKED",
  "TRANSFERRED",
  "CLOSED",
]);

/** 道路通行状态：畅通 / 管制（须护送转运）/ 封闭（替代机构不可达）。 */
export const ROAD_STATUSES = Object.freeze(["OPEN", "RESTRICTED", "CLOSED"]);

/** 交接状态：已提出 → 已接收（明确接收并取得最少必要临床资料，方算交接完成）。 */
export const HANDOFF_STATUSES = Object.freeze(["PROPOSED", "ACCEPTED"]);

/** 交接完成所需的最少必要临床资料字段。 */
export const MIN_CLINICAL_PACKET_FIELDS = Object.freeze([
  "patient_id",
  "plan_id",
  "prescription_version",
  "infection_zone",
  "duration_minutes",
  "last_treatment_at",
]);
