import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { EVENT_TYPES, AGGREGATE_TYPES } from "../src/domain.js";
import { EventStore, EventVersionConflictError } from "../src/event-store.js";

function baseEvent(over = {}) {
  return {
    event_id: "e1",
    event_type: EVENT_TYPES.PLAN_CONFIRMED,
    aggregate_type: AGGREGATE_TYPES.TREATMENT_PLAN,
    aggregate_id: "p1",
    occurred_at: "2026-10-02T08:00:00+08:00",
    version: 1,
    summary: "x",
    ...over,
  };
}

test("校验器：既有五类事件与样例结构仍然合法（向后兼容）", () => {
  for (const type of ["PLAN_CONFIRMED", "CAPACITY_CHANGED", "SESSION_RESERVED", "TRANSFER_ACCEPTED", "TREATMENT_RECONCILED"]) {
    assert.deepEqual(validateEvent(baseEvent({ event_id: `e-${type}`, event_type: type })), []);
  }
});

test("校验器：拒绝未知事件类型、坏时间、坏版本", () => {
  assert.ok(validateEvent(baseEvent({ event_type: "NOPE" })).some((m) => m.includes("event_type")));
  assert.ok(validateEvent(baseEvent({ occurred_at: "2026/10/02" })).some((m) => m.includes("occurred_at")));
  assert.ok(validateEvent(baseEvent({ version: 0 })).some((m) => m.includes("version")));
  assert.ok(validateEvent(baseEvent({ event_id: "  " })).some((m) => m.includes("event_id")));
  assert.deepEqual(validateEvent(null), ["事件必须是对象"]);
});

test("事件库：event_id 幂等——同一事件第二次 append 返回 duplicate 且不新增", () => {
  const store = new EventStore();
  const e = baseEvent();
  assert.equal(store.append(e).duplicate, false);
  const again = store.append({ ...e, summary: "篡改" });
  assert.equal(again.duplicate, true);
  assert.equal(again.event.summary, "x"); // 返回首次事件，篡改无效
  assert.equal(store.size, 1);
});

test("事件库：聚合版本必须严格 +1", () => {
  const store = new EventStore();
  store.append(baseEvent());
  assert.throws(
    () => store.append(baseEvent({ event_id: "e2", version: 3 })),
    EventVersionConflictError,
  );
  store.append(baseEvent({ event_id: "e2", version: 2 }));
  assert.deepEqual(store.stream(AGGREGATE_TYPES.TREATMENT_PLAN, "p1").map((x) => x.version), [1, 2]);
});

test("事件库：不同聚合各自计版本", () => {
  const store = new EventStore();
  store.append(baseEvent({ aggregate_id: "a" }));
  store.append(baseEvent({ event_id: "e2", aggregate_id: "b" }));
  assert.equal(store.versionOf(AGGREGATE_TYPES.TREATMENT_PLAN, "a"), 1);
  assert.equal(store.versionOf(AGGREGATE_TYPES.TREATMENT_PLAN, "b"), 1);
});
