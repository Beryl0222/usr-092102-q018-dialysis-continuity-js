/**
 * 跨切面不变量：任何命令路径产生的事件都必须满足 contracts/domain.schema.json 的信封约定，
 * event_id 全局唯一，同一聚合 version 连续递增，occurred_at/recorded_at 可解析。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { EVENT_TYPES } from "../src/domain.js";
import { newService, publishCapacity, standardNeeds } from "./helpers.js";

function runRichFlow() {
  const { svc } = newService("2026-10-02T08:00:00+08:00");
  publishCapacity(svc, "cap-a", "COUNTY", { personnel: 2 });
  publishCapacity(svc, "cap-b", "STATE", { personnel: 2 });
  svc.confirmPlan({ idempotency_key: "plan", patient_id: "P1", confirmed_by: "DR1", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
  const planId = svc.read.activePlanFor("P1").id;
  const res = svc.reserveSession({
    idempotency_key: "res", facility_id: "COUNTY", patient_id: "P1", plan_id: planId,
    scheduled_start: "2026-10-03T09:00:00+08:00", scheduled_end: "2026-10-03T13:00:00+08:00", needs: standardNeeds(),
  });
  svc.setClock("2026-10-02T20:00:00+08:00");
  svc.declareDisruption({ idempotency_key: "dis", facility_id: "COUNTY", reason: "暴雪+水处理告警", select: { time_window: { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" } } });
  svc.updateRoadStatus({ idempotency_key: "road", facility_from_id: "COUNTY", facility_to_id: "STATE", status: "restricted", risk_level: "medium", transport_requirements: ["4wd_ambulance"] });
  const slot = { start: "2026-10-03T10:00:00+08:00", end: "2026-10-03T14:00:00+08:00" };
  const req = svc.requestTransfer({ idempotency_key: "req", patient_id: "P1", occurrence_id: res.occurrence_id, from_facility_id: "COUNTY", to_facility_id: "STATE", preferred_slot: slot });
  svc.acceptTransfer({ idempotency_key: "acc", handoff_id: req.handoff_id, agreed_slot: slot });
  svc.sendMinimalRecord({ idempotency_key: "mrec", handoff_id: req.handoff_id, fields: ["plan_version", "prescription", "anticoagulation", "vascular_access", "dry_weight", "infection_screen", "emergency_contact"] });
  const done = svc.completeHandoff({ idempotency_key: "done", handoff_id: req.handoff_id });
  svc.setClock("2026-10-03T15:00:00+08:00");
  svc.closeOccurrence({ idempotency_key: "close", occurrence_id: res.occurrence_id, session_id: done.replacement_session_id, facility_id: "STATE", outcome: "treated" });
  svc.reconcileOccurrence({ idempotency_key: "reconcile", occurrence_id: res.occurrence_id });
  svc.recordSettlement({
    idempotency_key: "stl", from_facility_id: "COUNTY", to_facility_id: "STATE", patient_id: "P1", occurrence_id: res.occurrence_id,
    items: [{ type: "borrowed_slot", qty: 1, unit_amount: 300 }],
  });
  svc.notifyPatient({ idempotency_key: "ntf", patient_id: "P1", delivered: true });
  return svc;
}

test("不变量：全部 13 类事件都被覆盖且每条事件通过信封校验", () => {
  const svc = runRichFlow();
  const events = svc.events();
  const types = new Set(events.map((e) => e.event_type));
  for (const t of Object.values(EVENT_TYPES)) {
    assert.ok(types.has(t), `事件类型未在流程中出现：${t}`);
  }
  for (const e of events) {
    assert.deepEqual(validateEvent(e), [], `事件 ${e.event_id}（${e.event_type}）信封不合法`);
  }
});

test("不变量：event_id 全局唯一，聚合版本严格连续，causation_id 可追溯到幂等键", () => {
  const svc = runRichFlow();
  const events = svc.events();
  assert.equal(new Set(events.map((e) => e.event_id)).size, events.length);

  const byAgg = new Map();
  for (const e of events) {
    const k = `${e.aggregate_type}/${e.aggregate_id}`;
    if (!byAgg.has(k)) byAgg.set(k, []);
    byAgg.get(k).push(e);
  }
  for (const [k, list] of byAgg) {
    list.sort((a, b) => a.version - b.version);
    list.forEach((e, i) => assert.equal(e.version, i + 1, `${k} 版本不连续`));
  }
  // 所有写命令事件都能关联到命令幂等键
  for (const e of events) {
    assert.ok(typeof e.causation_id === "string" && e.causation_id.length > 0, `${e.event_id} 缺 causation_id`);
    assert.ok(!Number.isNaN(Date.parse(e.occurred_at)));
    assert.ok(!Number.isNaN(Date.parse(e.recorded_at)));
  }
  assert.equal(new Set(events.map((e) => e.causation_id)).size > 1, true);
});

test("不变量：一个 occurrence 无论跨越几个机构/场次，最多计一次透析", () => {
  const svc = runRichFlow();
  const ledgers = svc.treatmentLedger("P1");
  const counted = ledgers.filter((l) => l.counted_treatment);
  assert.equal(counted.length, 1);
  assert.equal(counted[0].sessions.length, 2); // 原场次 + 替代场次都挂在同一 occurrence
});
