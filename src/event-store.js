import { validateEvent } from "./validator.js";

/**
 * 追加式事件存储。
 *
 * 幂等约定（与 contracts/domain.schema.json 一致）：
 * - event_id 是幂等键：重复追加同一 event_id 不产生新事件、不改变状态，
 *   返回首次存储的事件并标记 duplicate；
 * - version 在同一聚合内从 1 开始严格递增，乱序或跳号拒绝写入。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #versions = new Map();

  /**
   * @returns {{applied: boolean, duplicate: boolean, event: object}}
   */
  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) {
      const error = new Error(`事件校验失败：${errors.join("；")}`);
      error.code = "EVENT_INVALID";
      error.errors = errors;
      throw error;
    }
    const existing = this.#byId.get(event.event_id);
    if (existing) {
      return { applied: false, duplicate: true, event: existing };
    }
    const key = `${event.aggregate_type}/${event.aggregate_id}`;
    const last = this.#versions.get(key) ?? 0;
    if (event.version !== last + 1) {
      const error = new Error(`版本不连续：${key} 期望 ${last + 1}，收到 ${event.version}`);
      error.code = "VERSION_CONFLICT";
      throw error;
    }
    this.#events.push(event);
    this.#byId.set(event.event_id, event);
    this.#versions.set(key, event.version);
    return { applied: true, duplicate: false, event };
  }

  has(eventId) {
    return this.#byId.has(eventId);
  }

  get(eventId) {
    return this.#byId.get(eventId);
  }

  ofAggregate(aggregateType, aggregateId) {
    return this.#events.filter((event) => event.aggregate_type === aggregateType && event.aggregate_id === aggregateId);
  }

  all() {
    return [...this.#events];
  }

  get size() {
    return this.#events.length;
  }
}
