import { AGGREGATE_TYPES, EVENT_TYPES } from "./domain.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("event_id" in record && !isNonEmptyString(record.event_id)) errors.push("event_id 必须是非空字符串");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`event_type 不在登记范围：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`aggregate_type 不在登记范围：${record.aggregate_type}`);
  if ("aggregate_id" in record && !isNonEmptyString(record.aggregate_id)) errors.push("aggregate_id 必须是非空字符串");
  if (
    "occurred_at" in record &&
    (!isNonEmptyString(record.occurred_at) || !OCCURRED_AT_PATTERN.test(record.occurred_at) || Number.isNaN(Date.parse(record.occurred_at)))
  ) {
    errors.push("occurred_at 必须是携带时区偏移的合法时间");
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("summary" in record && !isNonEmptyString(record.summary)) errors.push("summary 必须是非空字符串");
  return errors;
}
