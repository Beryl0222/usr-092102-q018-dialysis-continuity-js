import assert from "node:assert/strict";
import test from "node:test";

import { newService, publishCapacity, standardNeeds, WIN_D3, WIN_D4 } from "./helpers.js";
import { ErrorCodes } from "../src/errors.js";
import { RESOURCE_TYPES } from "../src/domain.js";

const SLOT_A = { start: "2026-10-03T09:00:00+08:00", end: "2026-10-03T13:00:00+08:00" };

function setup({ capacity = {} } = {}) {
  const { svc } = newService();
  publishCapacity(svc, "cap", "COUNTY", capacity);
  const plan = svc.confirmPlan({
    idempotency_key: "plan-1", patient_id: "P1", confirmed_by: "DR",
    prescription: { modality: "hd" }, cadence: { per_week: 3 },
  });
  return { svc, plan };
}

function reserve(svc, plan, key, over = {}) {
  return svc.reserveSession({
    idempotency_key: key,
    facility_id: "COUNTY",
    patient_id: over.patient_id ?? "P1",
    plan_id: plan.plan_id,
    scheduled_start: over.scheduled_start ?? SLOT_A.start,
    scheduled_end: over.scheduled_end ?? SLOT_A.end,
    needs: over.needs ?? standardNeeds(over.station_id ? { station_id: over.station_id } : {}),
  });
}

test("六类资源齐全才允许预留，缺一不可", () => {
  const { svc, plan } = setup();
  const ok = reserve(svc, plan, "r1");
  assert.ok(ok.session_id);
});

for (const [label, capSpec] of [
  ["受训护士班次未同步", { personnel: 0 }],
  ["无可用透析机", { machine: 0 }],
  ["水处理告警能力为零", { water: 0 }],
  ["耗材批次余量不足", { dialyzer: 0 }],
  ["无感染分区", { zone: 0 }],
  ["安全间隔周转能力为零", { interval: 0 }],
]) {
  test(`资源缺口（${label}）整场拒绝且报告缺口类型`, () => {
    const { svc, plan } = setup({ capacity: capSpec });
    try {
      reserve(svc, plan, `r-${label}`);
      assert.fail("应当抛出资源缺口");
    } catch (e) {
      assert.equal(e.code, ErrorCodes.RESOURCE_SHORTFALL);
      assert.equal(e.details.deficits.length, 1);
      assert.ok(Object.values(RESOURCE_TYPES).includes(e.details.deficits[0].resource_type));
    }
  });
}

test("容量按时间窗隔离：10-04 的余量不能用于 10-03 的场次", () => {
  const { svc } = newService();
  publishCapacity(svc, "cap", "COUNTY", {}, WIN_D4); // 容量只覆盖 10-04
  const plan = svc.confirmPlan({
    idempotency_key: "plan-9", patient_id: "P9", confirmed_by: "DR",
    prescription: { modality: "hd" }, cadence: { per_week: 3 },
  });
  assert.throws(
    () => reserve(svc, plan, "r-out", { patient_id: "P9" }),
    (e) => e.code === ErrorCodes.RESOURCE_SHORTFALL,
  );
  assert.ok(svc.reserveSession({
    idempotency_key: "r-in", facility_id: "COUNTY", patient_id: "P9", plan_id: plan.plan_id,
    scheduled_start: "2026-10-04T09:00:00+08:00", scheduled_end: "2026-10-04T13:00:00+08:00",
    needs: standardNeeds(),
  }).session_id);
});

test("容量被重叠场次实际占用：同班次第二个患者超出净容量即拒绝", () => {
  const { svc } = newService();
  publishCapacity(svc, "cap", "COUNTY", { personnel: 1, machine: 6, water: 6, dialyzer: 30, bloodline: 30, zone: 6, interval: 6 });
  const p1 = svc.confirmPlan({ idempotency_key: "pl1", patient_id: "P1", confirmed_by: "DR", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
  const p2 = svc.confirmPlan({ idempotency_key: "pl2", patient_id: "P2", confirmed_by: "DR", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
  reserve(svc, p1, "r1", { patient_id: "P1" });
  assert.throws(() => reserve(svc, p2, "r2", { patient_id: "P2" }), (e) => e.code === ErrorCodes.RESOURCE_SHORTFALL
    && e.details.deficits[0].resource_type === RESOURCE_TYPES.PERSONNEL);
});

test("安全间隔：同一机位背靠背场次被拒，错开 30 分钟通过；不同机位平行场次不受限", () => {
  const { svc } = newService();
  publishCapacity(svc, "cap", "COUNTY", { personnel: 4, machine: 6, water: 6, dialyzer: 30, bloodline: 30, zone: 6, interval: 6 });
  const p1 = svc.confirmPlan({ idempotency_key: "pl1", patient_id: "P1", confirmed_by: "DR", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
  const p2 = svc.confirmPlan({ idempotency_key: "pl2", patient_id: "P2", confirmed_by: "DR", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
  const p3 = svc.confirmPlan({ idempotency_key: "pl3", patient_id: "P3", confirmed_by: "DR", prescription: { modality: "hd" }, cadence: { per_week: 3 } });

  // P1 占用 1 号机 09:00-13:00
  reserve(svc, p1, "r1", { station_id: "station-1" });
  // P2 13:10 接 1 号机 → 间隔不足
  assert.throws(
    () => svc.reserveSession({
      idempotency_key: "r2", facility_id: "COUNTY", patient_id: "P2", plan_id: p2.plan_id,
      scheduled_start: "2026-10-03T13:10:00+08:00", scheduled_end: "2026-10-03T17:10:00+08:00",
      needs: standardNeeds({ station_id: "station-1" }),
    }),
    (e) => e.code === ErrorCodes.RESOURCE_SHORTFALL && e.details.deficits.some((d) => d.resource_type === RESOURCE_TYPES.SAFETY_INTERVAL),
  );
  // 13:30 接机 → 通过
  assert.ok(svc.reserveSession({
    idempotency_key: "r3", facility_id: "COUNTY", patient_id: "P2", plan_id: p2.plan_id,
    scheduled_start: "2026-10-03T13:30:00+08:00", scheduled_end: "2026-10-03T17:30:00+08:00",
    needs: standardNeeds({ station_id: "station-1" }),
  }).session_id);
  // P3 同一时间在 2 号机平行治疗 → 通过
  assert.ok(svc.reserveSession({
    idempotency_key: "r4", facility_id: "COUNTY", patient_id: "P3", plan_id: p3.plan_id,
    scheduled_start: "2026-10-03T09:00:00+08:00", scheduled_end: "2026-10-03T13:00:00+08:00",
    needs: standardNeeds({ station_id: "station-2" }),
  }).session_id);
});

test("感染分区：乙肝隔离需求不能落到普通分区容量", () => {
  const { svc } = newService();
  publishCapacity(svc, "cap", "COUNTY", {}); // 只有 standard
  const plan = svc.confirmPlan({ idempotency_key: "plh", patient_id: "PH", confirmed_by: "DR", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
  assert.throws(
    () => reserve(svc, plan, "rh", { patient_id: "PH", needs: standardNeeds({ zone: "hepb_isolation" }) }),
    (e) => e.code === ErrorCodes.RESOURCE_SHORTFALL && e.details.deficits.some((d) => d.resource_type === RESOURCE_TYPES.INFECTION_ZONE),
  );
});

test("耗材批次过期不参与分配", () => {
  const { svc } = newService();
  publishCapacity(svc, "cap", "COUNTY", { dialyzer: 0 });
  svc.reportCapacity({
    idempotency_key: "expired-batch", facility_id: "COUNTY", resource_type: "consumable",
    scope: { code: "dialyzer", expires_at: "2026-09-01T00:00:00+08:00" }, window: WIN_D3, available: 50,
  });
  const plan = svc.confirmPlan({ idempotency_key: "plx", patient_id: "PX", confirmed_by: "DR", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
  assert.throws(() => reserve(svc, plan, "rx", { patient_id: "PX" }), (e) => e.code === ErrorCodes.RESOURCE_SHORTFALL);
});
