/**
 * 高原透析连续调度：领域事件信封字段与稳定枚举。
 *
 * 设计基线（区域肾病质控中心要求）：
 * - 治疗连续性从患者倒推资源；医生确认的处方版本与周期不允许调度系统擅改。
 * - 每个场次同时占用六类资源：合格人员、透析机、水处理能力、耗材批次、感染分区、安全间隔。
 * - 紧急停机只锁定受影响场次；替代机构“明确接收 + 收到最少必要临床资料”才算交接完成。
 * - 未到、途中风险、临时住院、实际治疗分别结案；离线补录按发生时间对账，不多记一次透析。
 *
 * @typedef {Object} DomainEvent
 * @property {string} event_id       全局幂等键，重复提交不重复生效
 * @property {string} event_type     见 EVENT_TYPES
 * @property {string} aggregate_type 见 AGGREGATE_TYPES
 * @property {string} aggregate_id
 * @property {string} occurred_at    事件实际发生时间（离线补录的对账依据）
 * @property {number} version        聚合版本，自 1 严格递增
 * @property {string} summary
 * @property {Object} [payload]      事件业务载荷
 * @property {string} [causation_id] 上游事件/命令标识
 * @property {string} [recorded_at]  系统受理/补录时间
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

/** 已登记领域事件（只允许追加，不允许复用或改义）。 */
export const EVENT_TYPES = Object.freeze({
  /** 医生确认处方（含周期），aggregate=treatment_plan；处方版本只能被新的医生确认事件推进 */
  PLAN_CONFIRMED: "PLAN_CONFIRMED",
  /** 资源容量变化（人员班次/机器/水处理/耗材批次/感染分区），aggregate=resource_capacity */
  CAPACITY_CHANGED: "CAPACITY_CHANGED",
  /** 场次预留：一次同时占用六类资源，aggregate=dialysis_session */
  SESSION_RESERVED: "SESSION_RESERVED",
  /** 紧急停机声明，aggregate=disruption，只锁定受影响场次 */
  DISRUPTION_DECLARED: "DISRUPTION_DECLARED",
  /** 暴雪后道路通行/转运条件更新，aggregate=transport_route，决定替代机构可达性 */
  ROAD_STATUS_UPDATED: "ROAD_STATUS_UPDATED",
  /** 向替代机构提出借用名额请求，aggregate=transfer_handoff */
  TRANSFER_REQUESTED: "TRANSFER_REQUESTED",
  /** 替代机构明确答应接收（电话口头承诺在此落事件），aggregate=transfer_handoff */
  TRANSFER_ACCEPTED: "TRANSFER_ACCEPTED",
  /** 最少必要临床资料送达（处方版本/抗凝/感染筛查等），aggregate=transfer_handoff */
  MINIMAL_RECORD_SENT: "MINIMAL_RECORD_SENT",
  /** 接收 + 最小资料齐备，交接完成，aggregate=transfer_handoff */
  HANDOFF_COMPLETED: "HANDOFF_COMPLETED",
  /** 患者当次结局结案：未到/途中风险/临时住院/实际治疗，aggregate=treatment_occurrence */
  OCCURRENCE_CLOSED: "OCCURRENCE_CLOSED",
  /** 服务恢复后的跨院结算：借用名额、耗材、费用，aggregate=settlement */
  SETTLEMENT_RECORDED: "SETTLEMENT_RECORDED",
  /** 患者通知：当前地点、交通风险、下一次安排，aggregate=patient_notification */
  PATIENT_NOTIFIED: "PATIENT_NOTIFIED",
  /** 按发生时间对账（离线补录归位），aggregate=treatment_occurrence，绝不多记一次透析 */
  TREATMENT_RECONCILED: "TREATMENT_RECONCILED",
});

/** 聚合类型。 */
export const AGGREGATE_TYPES = Object.freeze({
  TREATMENT_PLAN: "treatment_plan",
  RESOURCE_CAPACITY: "resource_capacity",
  DIALYSIS_SESSION: "dialysis_session",
  TRANSFER_HANDOFF: "transfer_handoff",
  DISRUPTION: "disruption",
  TRANSPORT_ROUTE: "transport_route",
  TREATMENT_OCCURRENCE: "treatment_occurrence",
  SETTLEMENT: "settlement",
  PATIENT_NOTIFICATION: "patient_notification",
});

/**
 * 场次同时占用的六类资源。任一项容量不足即不得预留。
 */
export const RESOURCE_TYPES = Object.freeze({
  PERSONNEL: "personnel", // 受训合格护士/医生班次
  MACHINE: "machine", // 透析机
  WATER: "water", // 水处理能力
  CONSUMABLE: "consumable", // 耗材批次
  INFECTION_ZONE: "infection_zone", // 感染分区
  SAFETY_INTERVAL: "safety_interval", // 安全间隔（场次间/消杀/周转）
});

export const RESOURCE_TYPE_LIST = Object.freeze(Object.values(RESOURCE_TYPES));

/** 道路通行状态。 */
export const ROAD_STATUS = Object.freeze({
  OPEN: "open", // 通行可达
  RESTRICTED: "restricted", // 限制通行（需转运条件，如四驱/护送）
  CLOSED: "closed", // 封路，替代机构不可达
});

/** 场次生命周期状态。 */
export const SESSION_STATUS = Object.freeze({
  RESERVED: "reserved", // 已预留六类资源
  LOCKED: "locked", // 被紧急停机锁定（资源冻结待处置）
  REROUTED: "rerouted", // 已交接至替代机构
  CLOSED: "closed", // 当次已结案
});

/** 交接单状态。 */
export const HANDOFF_STATUS = Object.freeze({
  REQUESTED: "requested",
  ACCEPTED: "accepted", // 电话答应接收：尚不算交接完成
  RECORD_SENT: "record_sent", // 已收最小资料但未必已答应
  COMPLETED: "completed", // 接收 + 最小资料齐备
  DECLINED: "declined",
});

/**
 * 当次治疗结局，四类分别结案，互不混淆。
 * 只有 TREATED 计入“完成一次透析”。
 */
export const OCCURRENCE_OUTCOME = Object.freeze({
  TREATED: "treated", // 实际治疗（在原机构或替代机构）
  NO_SHOW: "no_show", // 患者未到
  EN_ROUTE_RISK: "en_route_risk", // 途中风险，未完成治疗
  TEMP_ADMISSION: "temp_admission", // 临时住院，本次透析并入住院处置
  MISSED: "missed", // 无替代方案导致漏治——须始终出现在开放缺口清单直到补救
});

/** 计入完成透析次数的结局集合。 */
export const TREATMENT_COUNTING_OUTCOMES = Object.freeze(new Set([OCCURRENCE_OUTCOME.TREATED]));

/** 跨院结算项目类型。 */
export const SETTLEMENT_ITEM_TYPES = Object.freeze({
  BORROWED_SLOT: "borrowed_slot", // 借用名额
  CONSUMABLE: "consumable", // 耗材
  FEE: "fee", // 费用
});

/** 通知渠道。 */
export const NOTIFICATION_CHANNELS = Object.freeze(["sms", "voice_call", "app", "messenger"]);
