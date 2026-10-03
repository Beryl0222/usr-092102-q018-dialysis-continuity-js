import { AGGREGATE_TYPES, EVENT_TYPES } from "./domain.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 校验一条领域事件信封。返回错误信息数组（空数组表示通过）。
 * 不做业务状态机判断，只保证交换格式与幂等约定可用。
 */
export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }
  for (const name of required) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if (errors.length > 0) return errors;

  if (typeof record.event_id !== "string" || record.event_id.trim() === "") {
    errors.push("event_id 必须是非空字符串（幂等键）");
  }
  if (!Object.values(EVENT_TYPES).includes(record.event_type)) {
    errors.push(`未知 event_type：${record.event_type}`);
  }
  if (!Object.values(AGGREGATE_TYPES).includes(record.aggregate_type)) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.trim() === "") {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if (typeof record.occurred_at !== "string" || !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是带时区的 ISO 8601 日期时间");
  } else if (Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 无法解析为有效时间");
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push("version 必须是正整数");
  }
  if (typeof record.summary !== "string" || record.summary.trim() === "") {
    errors.push("summary 必须是非空字符串");
  }
  if ("payload" in record && (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  if ("recorded_at" in record) {
    if (typeof record.recorded_at !== "string" || !ISO_DATE_TIME.test(record.recorded_at) || Number.isNaN(Date.parse(record.recorded_at))) {
      errors.push("recorded_at 必须是带时区的 ISO 8601 日期时间");
    }
  }
  return errors;
}

/**
 * 校验命令自带的幂等键（不与 event_id 冲突时由服务生成事件 id）。
 */
export function validateIdempotencyKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(key);
}
