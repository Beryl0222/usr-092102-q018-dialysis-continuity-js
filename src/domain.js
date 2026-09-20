/**
 * 领域事件信封字段约定。
 *
 * @typedef {Object} DomainEvent
 * @property {string} event_id
 * @property {string} event_type
 * @property {string} aggregate_type
 * @property {string} aggregate_id
 * @property {string} occurred_at
 * @property {number} version
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
