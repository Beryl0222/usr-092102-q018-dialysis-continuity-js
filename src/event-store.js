/**
 * 幂等事件存储：event_id 全局去重，聚合版本严格递增，事件按受理顺序追加。
 *
 * 幂等约定（contracts/domain.schema.json）：
 * - 同一 event_id 只生效一次。重复 append 返回首次事件与 duplicate=true，不产生新版本。
 * - 同一聚合的 version 必须恰好为 当前版本+1，否则拒绝（并发/重放错位）。
 *
 * 可选用 JSONL 文件持久化；store.events 始终保持 append 顺序（受理顺序），
 * 而按 occurred_at 的排序在投影/对账层完成——离线补录因此可以按发生时间归位。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export class EventStore {
  #events = [];
  #byId = new Map();
  #versions = new Map(); // aggregate_key -> 当前版本
  #file = null;

  constructor({ file } = {}) {
    this.#file = file ?? null;
    if (this.#file && existsSync(this.#file)) {
      const text = readFileSync(this.#file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.#ingest(JSON.parse(line));
      }
    }
  }

  #ingest(event) {
    this.#byId.set(event.event_id, event);
    const key = aggregateKey(event.aggregate_type, event.aggregate_id);
    const expected = (this.#versions.get(key) ?? 0) + 1;
    this.#versions.set(key, Math.max(this.#versions.get(key) ?? 0, event.version));
    this.#events.push(event);
    if (event.version !== expected) {
      // 重放文件时容忍乱序到达（离线补录文件可能是按发生时间导出的）
    }
  }

  /**
   * 追加事件。
   * @returns {{event: Object, duplicate: boolean}}
   */
  append(event) {
    const existing = this.#byId.get(event.event_id);
    if (existing) return { event: existing, duplicate: true };

    const key = aggregateKey(event.aggregate_type, event.aggregate_id);
    const expected = (this.#versions.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new EventVersionConflictError(event, expected);
    }

    this.#events.push(event);
    this.#byId.set(event.event_id, event);
    this.#versions.set(key, event.version);
    if (this.#file) appendFileSync(this.#file, JSON.stringify(event) + "\n");
    return { event, duplicate: false };
  }

  /** 按 event_id 取事件（命令幂等重试时用）。 */
  get(eventId) {
    return this.#byId.get(eventId) ?? null;
  }

  has(eventId) {
    return this.#byId.has(eventId);
  }

  /** 聚合内事件，按 version 排序。 */
  stream(aggregateType, aggregateId) {
    const key = aggregateKey(aggregateType, aggregateId);
    return this.#events
      .filter((e) => aggregateKey(e.aggregate_type, e.aggregate_id) === key)
      .sort((a, b) => a.version - b.version);
  }

  /** 全部事件（受理顺序）。 */
  all() {
    return [...this.#events];
  }

  /** 某聚合当前版本。 */
  versionOf(aggregateType, aggregateId) {
    return this.#versions.get(aggregateKey(aggregateType, aggregateId)) ?? 0;
  }

  get size() {
    return this.#byId.size;
  }

  get file() {
    return this.#file;
  }
}

function aggregateKey(type, id) {
  return `${type}/${id}`;
}

export class EventVersionConflictError extends Error {
  constructor(event, expected) {
    super(
      `聚合 ${event.aggregate_type}/${event.aggregate_id} 版本冲突：事件版本 ${event.version}，期望 ${expected}（event_id=${event.event_id}）`,
    );
    this.name = "EventVersionConflictError";
    this.code = "EVENT_VERSION_CONFLICT";
    this.expectedVersion = expected;
    this.actualVersion = event.version;
  }
}
