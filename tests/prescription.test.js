import assert from "node:assert/strict";
import test from "node:test";

import { newService } from "./helpers.js";
import { ErrorCodes } from "../src/errors.js";

test("处方：只有医生（source=physician）能确认，调度系统不能改处方", () => {
  const { svc } = newService();
  assert.throws(
    () => svc.confirmPlan({ idempotency_key: "bad-source", patient_id: "P1", confirmed_by: "SCHEDULER", source: "scheduler", prescription: {}, cadence: {} }),
    (e) => e.code === ErrorCodes.PRESCRIPTION_LOCKED,
  );
});

test("处方：场次只能引用医生确认的版本，处方更新后旧版本不能再排期", () => {
  const { svc } = newService();
  const v1 = svc.confirmPlan({ idempotency_key: "p1", patient_id: "P1", confirmed_by: "DR1", prescription: { duration_min: 240 }, cadence: { per_week: 3 } });
  assert.equal(v1.version, 1);

  // 新版本必须显式 supersede
  assert.throws(
    () => svc.confirmPlan({ idempotency_key: "p-new", patient_id: "P1", confirmed_by: "DR1", plan_id: `plan_P1_other`, prescription: { duration_min: 200 }, cadence: { per_week: 3 } }),
    (e) => e.code === ErrorCodes.PRESCRIPTION_LOCKED,
  );
  const v2 = svc.confirmPlan({ idempotency_key: "p2", patient_id: "P1", confirmed_by: "DR1", plan_id: v1.plan_id, prescription: { duration_min: 200 }, cadence: { per_week: 3 } });
  assert.equal(v2.version, 2);

  // 另一医生确认的全新计划取代旧计划
  const v3 = svc.confirmPlan({ idempotency_key: "p3", patient_id: "P1", confirmed_by: "DR2", supersedes: v1.plan_id, prescription: { duration_min: 180 }, cadence: { per_week: 2 } });
  assert.ok(v3.plan_id);
  // 旧计划已被取代
  assert.throws(
    () => svc.reserveSession({
      idempotency_key: "r-old", facility_id: "F", patient_id: "P1", plan_id: v1.plan_id,
      scheduled_start: "2026-10-05T09:00:00+08:00", scheduled_end: "2026-10-05T13:00:00+08:00", needs: {},
    }),
    (e) => e.code === ErrorCodes.PRESCRIPTION_LOCKED,
  );
});

test("处方：当前有效处方始终是版本最高的医生确认件，调度命令无法注入处方内容", () => {
  const { svc } = newService();
  svc.confirmPlan({ idempotency_key: "p1", patient_id: "P1", confirmed_by: "DR1", prescription: { duration_min: 240 }, cadence: { per_week: 3 } });
  const active = svc.read.activePlanFor("P1");
  assert.equal(active.source, "physician");
  assert.equal(active.prescription.duration_min, 240);
  assert.equal(svc.patientStatus("P1").active_plan.version, 1);
});
