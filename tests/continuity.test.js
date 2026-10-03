import assert from "node:assert/strict";
import test from "node:test";

import { createContinuityService } from "../src/continuity-service.js";
import { EventStore } from "../src/event-store.js";

const PLAN_BASE = {
  prescription_version: 1,
  cycle: { weekdays: [1, 3, 5] }, // 周一/三/五透析
  duration_minutes: 240,
  infection_zone: "standard",
  home_facility_id: "county",
  start_date: "2026-10-05",
  confirmed_by: "DR-1",
  occurred_at: "2026-10-01T09:00:00+08:00",
};

function confirmPlan(svc, planId, patientId, overrides = {}) {
  return svc.confirmPlan({ plan_id: planId, patient_id: patientId, ...PLAN_BASE, ...overrides });
}

test("事件标识幂等与版本连续", () => {
  const store = new EventStore();
  const event = {
    event_id: "e-1",
    event_type: "PLAN_CONFIRMED",
    aggregate_type: "treatment_plan",
    aggregate_id: "PLAN-X",
    occurred_at: "2026-10-04T08:00:00+08:00",
    version: 1,
    summary: "确认处方",
  };
  assert.equal(store.append(event).applied, true);
  const dup = store.append({ ...event });
  assert.equal(dup.applied, false);
  assert.equal(dup.duplicate, true);
  assert.equal(store.size, 1);
  assert.throws(() => store.append({ ...event, event_id: "e-2", version: 3 }), /版本不连续/);
  assert.equal(store.size, 1);
});

test("处方版本与周期只能由医生确认，调度不得擅改", () => {
  const svc = createContinuityService();
  confirmPlan(svc, "PLAN-A", "PT-A");
  svc.changeCapacity({
    facility_id: "county",
    slot: { slot_id: "2026-10-05-AM", date: "2026-10-05", start: "08:00", end: "12:00" },
    stations: [{ station_id: "S1", zone: "standard" }],
    staff: 1,
    water_capacity: 1,
    consumables: { b1: 1 },
    turnover_minutes: 30,
    occurred_at: "2026-10-01T08:00:00+08:00",
  });
  svc.changeCapacity({
    facility_id: "county",
    slot: { slot_id: "2026-10-07-AM", date: "2026-10-07", start: "08:00", end: "12:00" },
    stations: [{ station_id: "S1", zone: "standard" }],
    staff: 1,
    water_capacity: 1,
    consumables: { b1: 1 },
    turnover_minutes: 30,
    occurred_at: "2026-10-01T08:00:00+08:00",
  });
  svc.reserveSession({ plan_id: "PLAN-A", facility_id: "county", slot_id: "2026-10-05-AM", start: "08:00" });

  // 医生更新处方版本（唯一合法入口）
  confirmPlan(svc, "PLAN-A", "PT-A", {
    prescription_version: 2,
    duration_minutes: 210,
    occurred_at: "2026-10-03T09:00:00+08:00",
  });

  // 调度沿用旧版本 → 拒绝
  assert.throws(
    () => svc.reserveSession({ plan_id: "PLAN-A", facility_id: "county", slot_id: "2026-10-07-AM", start: "08:00", prescription_version: 1 }),
    /处方版本不一致/,
  );
  // 不显式给版本 → 绑定医生确认的当前版本
  const ok = svc.reserveSession({ plan_id: "PLAN-A", facility_id: "county", slot_id: "2026-10-07-AM", start: "08:00" });
  assert.equal(ok.session.prescription_version, 2);

  // 调度类操作全程不改写处方
  const plan = svc.planView("PLAN-A");
  assert.equal(plan.prescription_version, 2);
  assert.deepEqual(plan.cycle.weekdays, [1, 3, 5]);
  assert.equal(plan.duration_minutes, 210);
});

test("场次预约同时占用人员、机位、水处理、耗材批次、感染分区与安全间隔", () => {
  const svc = createContinuityService();
  const mkPlan = (id, zone = "standard") => confirmPlan(svc, id, `PT-${id}`, { infection_zone: zone });
  const addSlot = (slotId, cfg) =>
    svc.changeCapacity({
      facility_id: "county",
      slot: { slot_id: slotId, date: "2026-10-05", start: "08:00", end: "23:00" },
      occurred_at: "2026-10-01T08:00:00+08:00",
      ...cfg,
    });

  // 合格人员不足
  addSlot("S-STAFF", { stations: [{ station_id: "A1", zone: "standard" }, { station_id: "A2", zone: "standard" }], staff: 1, water_capacity: 5, consumables: { b1: 5 }, turnover_minutes: 30 });
  mkPlan("P1");
  mkPlan("P2");
  svc.reserveSession({ plan_id: "P1", facility_id: "county", slot_id: "S-STAFF", start: "08:00" });
  assert.throws(() => svc.reserveSession({ plan_id: "P2", facility_id: "county", slot_id: "S-STAFF", start: "08:00" }), /合格人员不足/);

  // 水处理能力不足
  addSlot("S-WATER", { stations: [{ station_id: "B1", zone: "standard" }, { station_id: "B2", zone: "standard" }], staff: 5, water_capacity: 1, consumables: { b1: 5 }, turnover_minutes: 30 });
  mkPlan("P3");
  mkPlan("P4");
  svc.reserveSession({ plan_id: "P3", facility_id: "county", slot_id: "S-WATER", start: "08:00" });
  assert.throws(() => svc.reserveSession({ plan_id: "P4", facility_id: "county", slot_id: "S-WATER", start: "08:00" }), /水处理能力不足/);

  // 感染分区不匹配
  addSlot("S-ZONE", { stations: [{ station_id: "C1", zone: "standard" }], staff: 5, water_capacity: 5, consumables: { b1: 5 }, turnover_minutes: 30 });
  mkPlan("P5", "hepB");
  assert.throws(() => svc.reserveSession({ plan_id: "P5", facility_id: "county", slot_id: "S-ZONE", start: "08:00" }), /感染分区/);

  // 机位与安全间隔：08:00 起 240 分钟 + 30 分钟间隔 = 12:30 后才可再用
  addSlot("S-STATION", { stations: [{ station_id: "D1", zone: "standard" }], staff: 5, water_capacity: 5, consumables: { b1: 5 }, turnover_minutes: 30 });
  mkPlan("P6");
  mkPlan("P7");
  mkPlan("P8");
  svc.reserveSession({ plan_id: "P6", facility_id: "county", slot_id: "S-STATION", start: "08:00" });
  assert.throws(() => svc.reserveSession({ plan_id: "P7", facility_id: "county", slot_id: "S-STATION", start: "10:00" }), /安全间隔/);
  const staggered = svc.reserveSession({ plan_id: "P8", facility_id: "county", slot_id: "S-STATION", start: "13:00" });
  assert.equal(staggered.session.station_id, "D1");

  // 耗材批次余量不足
  addSlot("S-MAT", { stations: [{ station_id: "E1", zone: "standard" }, { station_id: "E2", zone: "standard" }], staff: 5, water_capacity: 5, consumables: { b9: 1 }, turnover_minutes: 30 });
  mkPlan("P9");
  mkPlan("P10");
  svc.reserveSession({ plan_id: "P9", facility_id: "county", slot_id: "S-MAT", start: "08:00" });
  assert.throws(() => svc.reserveSession({ plan_id: "P10", facility_id: "county", slot_id: "S-MAT", start: "08:00" }), /耗材批次/);
});

test("暴雪中断：锁定、转运、结案、结算与缺口清单", () => {
  const svc = createContinuityService();
  const T = (hhmm) => `2026-10-04T${hhmm}:00+08:00`;

  // 容量登记：县医院 AM/PM，州医院 AM/PM
  svc.changeCapacity({
    facility_id: "county",
    slot: { slot_id: "2026-10-05-AM", date: "2026-10-05", start: "08:00", end: "12:00" },
    stations: [{ station_id: "S1", zone: "standard" }, { station_id: "S2", zone: "standard" }, { station_id: "S3", zone: "standard" }],
    staff: 3,
    water_capacity: 3,
    consumables: { "batch-77": 3 },
    turnover_minutes: 30,
    occurred_at: T("07:00"),
  });
  svc.changeCapacity({
    facility_id: "county",
    slot: { slot_id: "2026-10-05-PM", date: "2026-10-05", start: "13:00", end: "18:00" },
    stations: [{ station_id: "P1", zone: "standard" }],
    staff: 1,
    water_capacity: 1,
    consumables: { "batch-78": 1 },
    turnover_minutes: 30,
    occurred_at: T("07:00"),
  });
  svc.changeCapacity({
    facility_id: "state",
    slot: { slot_id: "2026-10-05-AM", date: "2026-10-05", start: "08:00", end: "12:00" },
    stations: [{ station_id: "T1", zone: "standard" }, { station_id: "T2", zone: "standard" }],
    staff: 2,
    water_capacity: 2,
    consumables: { "batch-81": 4 },
    turnover_minutes: 30,
    tariff: { slot_fee: 400, consumable_fee: 80 },
    occurred_at: T("07:00"),
  });
  svc.changeCapacity({
    facility_id: "state",
    slot: { slot_id: "2026-10-05-PM", date: "2026-10-05", start: "13:00", end: "18:00" },
    stations: [{ station_id: "T3", zone: "standard" }],
    staff: 1,
    water_capacity: 1,
    consumables: { "batch-82": 2 },
    turnover_minutes: 30,
    tariff: { slot_fee: 400, consumable_fee: 80 },
    occurred_at: T("07:00"),
  });

  // 医生确认五名患者的固定处方（周一/三/五）
  for (const [plan, patient] of [["PLAN-A", "PT-A"], ["PLAN-B", "PT-B"], ["PLAN-C", "PT-C"], ["PLAN-D", "PT-D"], ["PLAN-E", "PT-E"]]) {
    confirmPlan(svc, plan, patient);
  }

  // 预约次日（10-05 周一）场次
  svc.reserveSession({ plan_id: "PLAN-A", facility_id: "county", slot_id: "2026-10-05-AM", start: "08:00" });
  svc.reserveSession({ plan_id: "PLAN-B", facility_id: "county", slot_id: "2026-10-05-AM", start: "08:00" });
  svc.reserveSession({ plan_id: "PLAN-D", facility_id: "county", slot_id: "2026-10-05-AM", start: "08:00" });
  svc.reserveSession({ plan_id: "PLAN-C", facility_id: "county", slot_id: "2026-10-05-PM", start: "14:00" });

  // 暴雪：道路管制；水处理设备告警，次日 AM 场次停机
  svc.updateRoadStatus({ from_facility_id: "county", to_facility_id: "state", status: "RESTRICTED", note: "暴雪管制", occurred_at: T("08:00") });
  svc.changeCapacity({
    facility_id: "county",
    slot: { slot_id: "2026-10-05-AM", date: "2026-10-05", start: "08:00", end: "12:00" },
    water_capacity: 0,
    occurred_at: T("08:05"),
  });
  const lock = svc.lockSlot({ facility_id: "county", slot_id: "2026-10-05-AM", reason: "水处理设备告警", occurred_at: T("08:10") });
  assert.equal(lock.locked.length, 3);
  assert.equal(svc.events().filter((e) => e.event_type === "SESSION_LOCKED").length, 3);
  // 只锁定受影响场次：PM 场次不受影响，也不允许再约进已停机场次
  assert.equal(svc.session("SES-PLAN-C-2026-10-05-PM").status, "RESERVED");
  assert.throws(() => svc.reserveSession({ plan_id: "PLAN-E", facility_id: "county", slot_id: "2026-10-05-AM", start: "08:00" }), /已锁定/);

  // 缺口清单：A/B/D 的固定治疗缺口，责任在县医院
  let gaps = svc.openGaps("2026-10-04T09:00:00+08:00");
  assert.deepEqual(gaps.map((g) => g.patient_id).sort(), ["PT-A", "PT-B", "PT-D"]);
  assert.ok(gaps.every((g) => g.status === "场次锁定待转运" && g.responsible.id === "county"));

  // 管制路段无护送不可转运；安排救护车护送后可发起
  assert.throws(
    () => svc.proposeTransfer({ session_id: "SES-PLAN-A-2026-10-05-AM", to_facility_id: "state", slot_id: "2026-10-05-AM", start: "09:00", transport: { mode: "family", escort: false }, occurred_at: T("09:00") }),
    /护送/,
  );
  svc.proposeTransfer({ session_id: "SES-PLAN-A-2026-10-05-AM", to_facility_id: "state", slot_id: "2026-10-05-AM", start: "09:00", transport: { mode: "ambulance", escort: true }, occurred_at: T("09:05") });
  gaps = svc.openGaps("2026-10-04T09:10:00+08:00");
  assert.equal(gaps.find((g) => g.patient_id === "PT-A").status, "转运待接收确认");
  assert.equal(gaps.find((g) => g.patient_id === "PT-A").responsible.id, "state");

  // 交接完成 = 明确接收 + 取得最少必要临床资料（版本须与医生确认一致）
  assert.throws(() => svc.acceptTransfer({ handoff_id: "HO-SES-PLAN-A-2026-10-05-AM", occurred_at: T("09:20") }), /最少必要临床资料/);
  const packetA = { patient_id: "PT-A", plan_id: "PLAN-A", prescription_version: 1, infection_zone: "standard", duration_minutes: 240, last_treatment_at: "2026-10-02T09:00:00+08:00" };
  assert.throws(
    () => svc.acceptTransfer({ handoff_id: "HO-SES-PLAN-A-2026-10-05-AM", clinical_packet: { ...packetA, prescription_version: 7 }, occurred_at: T("09:21") }),
    /不一致/,
  );
  svc.acceptTransfer({ handoff_id: "HO-SES-PLAN-A-2026-10-05-AM", clinical_packet: packetA, received_by: "STATE-NURSE-1", occurred_at: T("09:30") });
  assert.equal(svc.session("SES-PLAN-A-2026-10-05-AM").status, "TRANSFERRED");
  const borrowedA = svc.session("SES-B-HO-SES-PLAN-A-2026-10-05-AM");
  assert.equal(borrowedA.status, "RESERVED");
  assert.equal(borrowedA.facility_id, "state");
  assert.equal(svc.slotView("county", "2026-10-05-AM").consumables["batch-77"], 1); // 原场次耗材回库
  assert.equal(svc.slotView("state", "2026-10-05-AM").consumables["batch-81"], 3); // 借用场次占用接收方耗材

  // 患者通知：当前地点、交通风险、下一次安排
  const notice = svc.patientNotice("PT-A", "2026-10-04T09:40:00+08:00");
  assert.equal(notice.current_location, "county");
  assert.equal(notice.traffic_risk.road_status, "RESTRICTED");
  assert.equal(notice.next_arrangement.facility_id, "state");
  assert.equal(notice.next_arrangement.date, "2026-10-05");

  // A 已排上替代场次，缺口清单只剩 B/D
  gaps = svc.openGaps("2026-10-04T09:45:00+08:00");
  assert.deepEqual(gaps.map((g) => g.patient_id).sort(), ["PT-B", "PT-D"]);

  // 道路封闭 → 替代机构不可达；恢复管制后须护送转运
  svc.updateRoadStatus({ from_facility_id: "county", to_facility_id: "state", status: "CLOSED", note: "暴雪封路", occurred_at: T("10:00") });
  assert.throws(
    () => svc.proposeTransfer({ session_id: "SES-PLAN-B-2026-10-05-AM", to_facility_id: "state", slot_id: "2026-10-05-PM", start: "14:00", transport: { mode: "ambulance", escort: true }, occurred_at: T("10:05") }),
    /不可达/,
  );
  svc.updateRoadStatus({ from_facility_id: "county", to_facility_id: "state", status: "RESTRICTED", note: "恢复管制通行", occurred_at: T("12:00") });
  svc.proposeTransfer({ session_id: "SES-PLAN-B-2026-10-05-AM", to_facility_id: "state", slot_id: "2026-10-05-PM", start: "14:00", transport: { mode: "ambulance", escort: true }, occurred_at: T("12:05") });
  const packetB = { patient_id: "PT-B", plan_id: "PLAN-B", prescription_version: 1, infection_zone: "standard", duration_minutes: 240, last_treatment_at: "2026-10-02T09:00:00+08:00" };
  svc.acceptTransfer({ handoff_id: "HO-SES-PLAN-B-2026-10-05-AM", clinical_packet: packetB, received_by: "STATE-NURSE-2", occurred_at: T("12:30") });

  // 次日：A 在州医院完成治疗（实际治疗结案）
  svc.recordTreatment({ session_id: "SES-B-HO-SES-PLAN-A-2026-10-05-AM", occurred_at: "2026-10-05T09:30:00+08:00", recorded_by: "STATE-NURSE-1" });
  assert.equal(svc.session("SES-B-HO-SES-PLAN-A-2026-10-05-AM").closure_reason, "TREATED");

  // 县医院离线补录 A 同日透析：按发生时间对账，绝不重记
  const dup = svc.recordTreatment({ plan_id: "PLAN-A", occurred_at: "2026-10-05T10:00:00+08:00", facility_id: "county", offline: true, recorded_by: "COUNTY-NURSE-1" });
  assert.equal(dup.duplicate, true);
  assert.equal(svc.events().filter((e) => e.event_type === "TREATMENT_RECONCILED").length, 1);

  // 分别结案：B 途中风险、D 临时住院、C 未到
  svc.closeSession({ session_id: "SES-B-HO-SES-PLAN-B-2026-10-05-AM", reason: "EN_ROUTE_RISK", detail: "转运途中车辆故障，返回县医院", occurred_at: "2026-10-05T15:00:00+08:00" });
  svc.closeSession({ session_id: "SES-PLAN-D-2026-10-05-AM", reason: "TEMP_ADMISSION", detail: "临时住院，转入住院透析", occurred_at: "2026-10-05T11:00:00+08:00" });
  svc.closeSession({ session_id: "SES-PLAN-C-2026-10-05-PM", reason: "NO_SHOW", detail: "患者未到", occurred_at: "2026-10-05T20:00:00+08:00" });
  const again = svc.closeSession({ session_id: "SES-PLAN-C-2026-10-05-PM", reason: "NO_SHOW", occurred_at: "2026-10-05T21:00:00+08:00" });
  assert.equal(again.duplicate, true); // 重复结案幂等

  // 缺口清单：只剩 E 从未排程，责任在调度
  gaps = svc.openGaps("2026-10-05T21:30:00+08:00");
  assert.deepEqual(gaps.map((g) => [g.patient_id, g.status]), [["PT-E", "未排程"]]);
  assert.equal(gaps[0].responsible.type, "scheduling");

  // 服务恢复后跨院结算：A 的借用名额与耗材费用，B 未治疗不计费
  svc.changeCapacity({
    facility_id: "county",
    slot: { slot_id: "2026-10-05-AM", date: "2026-10-05", start: "08:00", end: "12:00" },
    water_capacity: 3,
    occurred_at: "2026-10-06T08:00:00+08:00",
  });
  const st = svc.settleCrossFacility({ borrower_facility_id: "county", lender_facility_id: "state", since: "2026-10-05", until: "2026-10-05", occurred_at: "2026-10-06T09:00:00+08:00" });
  assert.equal(st.statement.totals.sessions, 1);
  assert.equal(st.statement.totals.grand_total, 480); // 名额 400 + 耗材 80
  assert.equal(st.statement.lines[0].consumable.batch_id, "batch-81");
  const stAgain = svc.settleCrossFacility({ borrower_facility_id: "county", lender_facility_id: "state", since: "2026-10-05", until: "2026-10-05", occurred_at: "2026-10-06T10:00:00+08:00" });
  assert.equal(stAgain.duplicate, true);
  assert.equal(svc.events().filter((e) => e.event_type === "SETTLEMENT_RECORDED").length, 1);

  // A 治疗后当前地点更新为州医院
  assert.equal(svc.patientNotice("PT-A", "2026-10-06T10:00:00+08:00").current_location, "state");
});

test("离线补录以发生时间对账，绝不重记", () => {
  const svc = createContinuityService();
  confirmPlan(svc, "PLAN-F", "PT-F");

  // 断网期间无法预约，10-05 的固定治疗先出现缺口
  assert.equal(svc.openGaps("2026-10-05T20:00:00+08:00")[0].status, "未排程");

  // 恢复后按发生时间补录（无场次记录的离线治疗）
  const rec = svc.recordTreatment({ plan_id: "PLAN-F", occurred_at: "2026-10-05T11:00:00+08:00", facility_id: "county", offline: true, recorded_by: "NURSE-9" });
  assert.equal(rec.applied, true);
  assert.equal(svc.openGaps("2026-10-06T08:00:00+08:00").length, 0);

  // 同一发生日期重复补录不再入账
  const dup = svc.recordTreatment({ plan_id: "PLAN-F", occurred_at: "2026-10-05T15:00:00+08:00", facility_id: "county", offline: true, recorded_by: "NURSE-10" });
  assert.equal(dup.duplicate, true);
  assert.equal(svc.events().filter((e) => e.event_type === "TREATMENT_RECONCILED").length, 1);
});

test("命令幂等：重复预约与重复交接接收不产生新事件", () => {
  const svc = createContinuityService();
  confirmPlan(svc, "PLAN-A", "PT-A");
  svc.changeCapacity({
    facility_id: "county",
    slot: { slot_id: "2026-10-05-AM", date: "2026-10-05", start: "08:00", end: "12:00" },
    stations: [{ station_id: "S1", zone: "standard" }],
    staff: 1,
    water_capacity: 1,
    consumables: { b1: 1 },
    turnover_minutes: 30,
    occurred_at: "2026-10-01T08:00:00+08:00",
  });
  const r1 = svc.reserveSession({ plan_id: "PLAN-A", facility_id: "county", slot_id: "2026-10-05-AM", start: "08:00" });
  const r2 = svc.reserveSession({ plan_id: "PLAN-A", facility_id: "county", slot_id: "2026-10-05-AM", start: "08:00" });
  assert.equal(r1.applied, true);
  assert.equal(r2.duplicate, true);
  assert.equal(svc.events().filter((e) => e.event_type === "SESSION_RESERVED").length, 1);
});
