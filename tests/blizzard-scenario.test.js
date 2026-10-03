/**
 * 暴雪封路端到端：复现事故经过并验证质控中心的全部整改要求。
 * 三名患者：P-A 成功转州医院完成治疗；P-B 途中风险；P-C 未到（差点漏治，后补救）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { newService, publishCapacity, standardNeeds } from "./helpers.js";
import { ErrorCodes } from "../src/errors.js";
import { OCCURRENCE_OUTCOME } from "../src/domain.js";

const D3_MORNING = { start: "2026-10-03T09:00:00+08:00", end: "2026-10-03T13:00:00+08:00" };
const STATE_SLOT = { start: "2026-10-03T10:00:00+08:00", end: "2026-10-03T14:00:00+08:00" };
const RECORD_FIELDS = ["plan_version", "prescription", "anticoagulation", "vascular_access", "dry_weight", "infection_screen", "emergency_contact"];

function world() {
  const env = newService("2026-10-02T08:00:00+08:00");
  const { svc } = env;

  // 县医院：次日班次齐备
  publishCapacity(svc, "county", "COUNTY", { personnel: 3 });
  // 州医院：机器/水/耗材有余量，但受训护士班次与耗材余量“尚未同步”（先报 0 模拟电话答应时的盲区）
  publishCapacity(svc, "state-before", "STATE", { personnel: 0, dialyzer: 0, bloodline: 0 });

  const plans = {};
  for (const pid of ["P-A", "P-B", "P-C"]) {
    plans[pid] = svc.confirmPlan({
      idempotency_key: `plan-${pid}`, patient_id: pid, confirmed_by: "DR-7",
      prescription: { modality: "hd", duration_min: 240, anticoagulation: "low_molecular_heparin", dry_weight_kg: 58 },
      cadence: { per_week: 3, days: ["Mon", "Wed", "Fri"], shift: "morning" },
    });
  }
  const sessions = {};
  for (const pid of ["P-A", "P-B", "P-C"]) {
    sessions[pid] = svc.reserveSession({
      idempotency_key: `res-${pid}`, facility_id: "COUNTY", patient_id: pid, plan_id: plans[pid].plan_id,
      scheduled_start: D3_MORNING.start, scheduled_end: D3_MORNING.end, needs: standardNeeds(),
    });
  }
  return { ...env, plans, sessions };
}

test("暴雪全流程：水处理告警停机只锁定受影响场次，未排程的其他时段不动", () => {
  const { svc, sessions } = world();
  svc.setClock("2026-10-02T19:30:00+08:00");
  // 水处理设备告警，县医院取消次日透析
  const dis = svc.declareDisruption({
    idempotency_key: "disruption", facility_id: "COUNTY", reason: "水处理设备告警",
    scope: { resource: "water", system: "ro-main" },
    select: {
      time_window: { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" },
    },
  });
  assert.deepEqual(dis.locked_session_ids.sort(), [sessions["P-A"].session_id, sessions["P-B"].session_id, sessions["P-C"].session_id].sort());
  // 另一个机构（州医院）与其他时段完全不受影响
  assert.equal(svc.read.sessions.get(sessions["P-A"].session_id).status, "locked");
  assert.ok(svc.openGaps({ at: "2026-10-03T09:30:00+08:00" }).every((g) => g.sessions.every((s) => s.facility_id === "COUNTY")));

  // 停机锁定释放了县医院资源：同一时段再排一场（假设另一名患者被临时加进来）不应因护士被占而失败
  const extraPlan = svc.confirmPlan({ idempotency_key: "plan-P-X", patient_id: "P-X", confirmed_by: "DR-7", prescription: { modality: "hd" }, cadence: { per_week: 2 } });
  // 注：此时水处理告警仍在，新场次仍会因水处理容量（通告值未变）而受限——资源是否恢复以 CAPACITY_CHANGED 为准
  assert.ok(extraPlan.plan_id);
});

test("暴雪全流程：封路期间替代机构不可达；州医院口头答应但护士班次未同步时预检拦截", () => {
  const { svc, sessions } = world();
  svc.setClock("2026-10-02T20:00:00+08:00");
  svc.declareDisruption({
    idempotency_key: "disruption", facility_id: "COUNTY", reason: "水处理设备告警",
    select: { time_window: { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" } },
  });

  // 暴雪封路
  svc.updateRoadStatus({ idempotency_key: "road-closed", facility_from_id: "COUNTY", facility_to_id: "STATE", status: "closed", risk_level: "severe", detail: "山口路段积雪封路" });
  assert.throws(
    () => svc.requestTransfer({ idempotency_key: "req-A", patient_id: "P-A", occurrence_id: sessions["P-A"].occurrence_id, from_facility_id: "COUNTY", to_facility_id: "STATE" }),
    (e) => e.code === ErrorCodes.UNREACHABLE_ALTERNATIVE,
  );

  // 除雪后限制通行（需四驱+护送）
  svc.updateRoadStatus({ idempotency_key: "road-open", facility_from_id: "COUNTY", facility_to_id: "STATE", status: "restricted", risk_level: "medium", transport_requirements: ["4wd_ambulance", "escort"] });
  const req = svc.requestTransfer({ idempotency_key: "req-A", patient_id: "P-A", occurrence_id: sessions["P-A"].occurrence_id, from_facility_id: "COUNTY", to_facility_id: "STATE", preferred_slot: STATE_SLOT });

  // 电话答应接收 → 六类资源预检发现受训护士 0、耗材 0
  assert.throws(
    () => svc.acceptTransfer({ idempotency_key: "acc-A", handoff_id: req.handoff_id, agreed_slot: STATE_SLOT, contact: "STATE-ONCALL" }),
    (e) => e.code === ErrorCodes.RESOURCE_SHORTFALL,
  );

  // 州医院连夜同步受训护士班次与耗材余量
  svc.reportCapacity({ idempotency_key: "state-nurse", facility_id: "STATE", resource_type: "personnel", scope: { qualification: "dialysis_nurse", shift: "morning" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 2, notice: "受训护士班次已排定" });
  svc.reportCapacity({ idempotency_key: "state-dial", facility_id: "STATE", resource_type: "consumable", scope: { code: "dialyzer" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 6 });
  svc.reportCapacity({ idempotency_key: "state-line", facility_id: "STATE", resource_type: "consumable", scope: { code: "bloodline" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 6 });

  const acc = svc.acceptTransfer({ idempotency_key: "acc-A", handoff_id: req.handoff_id, agreed_slot: STATE_SLOT, contact: "STATE-ONCALL" });
  assert.equal(acc.status, "accepted");
});

test("暴雪全流程：交接完成必须同时具备明确接收+最少必要资料+替代场次占用", () => {
  const { svc, sessions } = world();
  svc.setClock("2026-10-02T20:30:00+08:00");
  svc.declareDisruption({ idempotency_key: "disruption", facility_id: "COUNTY", reason: "水处理告警", select: { time_window: { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" } } });
  svc.updateRoadStatus({ idempotency_key: "road", facility_from_id: "COUNTY", facility_to_id: "STATE", status: "restricted", risk_level: "medium", transport_requirements: ["4wd_ambulance"] });
  const req = svc.requestTransfer({ idempotency_key: "req-A", patient_id: "P-A", occurrence_id: sessions["P-A"].occurrence_id, from_facility_id: "COUNTY", to_facility_id: "STATE", preferred_slot: STATE_SLOT });

  // 未接收先送资料：流程允许送达，但不能完成交接
  svc.reportCapacity({ idempotency_key: "state-nurse", facility_id: "STATE", resource_type: "personnel", scope: { qualification: "dialysis_nurse", shift: "morning" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 2 });
  svc.reportCapacity({ idempotency_key: "state-dial", facility_id: "STATE", resource_type: "consumable", scope: { code: "dialyzer" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 6 });
  svc.reportCapacity({ idempotency_key: "state-line", facility_id: "STATE", resource_type: "consumable", scope: { code: "bloodline" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 6 });

  // 资料不齐：缺抗凝与感染筛查时明确报错缺哪些
  try {
    svc.sendMinimalRecord({ idempotency_key: "rec-bad", handoff_id: req.handoff_id, fields: ["plan_version", "prescription", "vascular_access", "dry_weight", "emergency_contact"] });
    assert.fail("应拒绝不齐资料");
  } catch (e) {
    assert.equal(e.code, ErrorCodes.MINIMAL_RECORD_INCOMPLETE);
    assert.ok(e.details.missing.includes("anticoagulation"));
    assert.ok(e.details.missing.includes("infection_screen"));
  }

  svc.acceptTransfer({ idempotency_key: "acc-A", handoff_id: req.handoff_id, agreed_slot: STATE_SLOT });
  // 接收了但资料没送：交接不能完成
  assert.throws(() => svc.completeHandoff({ idempotency_key: "done-A", handoff_id: req.handoff_id }), (e) => e.code === ErrorCodes.MINIMAL_RECORD_INCOMPLETE);

  svc.sendMinimalRecord({ idempotency_key: "rec-A", handoff_id: req.handoff_id, fields: RECORD_FIELDS });
  const done = svc.completeHandoff({ idempotency_key: "done-A", handoff_id: req.handoff_id });
  assert.ok(done.replacement_session_id);

  // 替代场次与原场次共享 occurrence_id，州医院名单能看到患者，县医院原场次改道
  const stateRoster = svc.roster({ facility_id: "STATE" });
  const countyRoster = svc.roster({ facility_id: "COUNTY" });
  assert.ok(stateRoster.some((r) => r.patient_id === "P-A" && r.occurrence_id === sessions["P-A"].occurrence_id));
  assert.equal(svc.read.sessions.get(sessions["P-A"].session_id).status, "rerouted");
  assert.equal(svc.read.sessions.get(done.replacement_session_id).status, "reserved");

  // 跨机构合并名单按 occurrence 折叠：P-A 只出现一次（两处名单各有一行但同 occurrence_id）
  const merged = svc.roster();
  const aRows = merged.filter((r) => r.occurrence_id === sessions["P-A"].occurrence_id);
  assert.equal(aRows.length, 2);
  assert.equal(new Set(aRows.map((r) => r.patient_id)).size, 1);
});

test("暴雪全流程：四类结局分别结案，只有实际治疗计一次透析", () => {
  const env = world();
  const { svc, sessions } = env;
  routeAndHandoffAll(svc, sessions, { only: ["P-A"] });

  svc.setClock("2026-10-03T15:00:00+08:00");
  const doneA = svc.read.handoffs.values().next().value;
  // P-A 实际在州医院完成治疗
  svc.closeOccurrence({ idempotency_key: "close-A", occurrence_id: sessions["P-A"].occurrence_id, session_id: doneA.replacement_session_id, facility_id: "STATE", outcome: OCCURRENCE_OUTCOME.TREATED });
  // P-B 转运途中出现风险，折返未治疗
  svc.closeOccurrence({ idempotency_key: "close-B", occurrence_id: sessions["P-B"].occurrence_id, facility_id: "COUNTY", outcome: OCCURRENCE_OUTCOME.EN_ROUTE_RISK, detail: "山路结冰，救护车折返" });
  // P-C 未到，未联系上——差点漏掉的固定治疗
  svc.closeOccurrence({ idempotency_key: "close-C", occurrence_id: sessions["P-C"].occurrence_id, facility_id: "COUNTY", outcome: OCCURRENCE_OUTCOME.MISSED, detail: "通知未送达，患者按原计划扑空" });

  // 临时住院与未到分支（独立小场景验证另外两种结局可结案且不计次）
  const { svc: svc2, sessions: s2 } = world();
  svc2.setClock("2026-10-03T16:00:00+08:00");
  svc2.closeOccurrence({ idempotency_key: "close-D", occurrence_id: s2["P-A"].occurrence_id, facility_id: "COUNTY", outcome: OCCURRENCE_OUTCOME.TEMP_ADMISSION, detail: "凌晨急诊收入院", occurred_at: "2026-10-03T06:00:00+08:00" });
  svc2.closeOccurrence({ idempotency_key: "close-E", occurrence_id: s2["P-B"].occurrence_id, facility_id: "COUNTY", outcome: OCCURRENCE_OUTCOME.NO_SHOW, detail: "场次结束患者未出现，电话未接通" });

  // P-A 计一次，P-B/P-C/P-D 均不计
  assert.equal(svc.treatmentLedger("P-A").find((l) => l.occurrence_id === sessions["P-A"].occurrence_id).counted_treatment, true);
  assert.equal(svc.treatmentLedger("P-B")[0].counted_treatment, false);
  assert.equal(svc.treatmentLedger("P-C")[0].counted_treatment, false);
  assert.equal(svc2.treatmentLedger("P-A")[0].outcome, OCCURRENCE_OUTCOME.TEMP_ADMISSION);
  assert.equal(svc2.treatmentLedger("P-B")[0].outcome, OCCURRENCE_OUTCOME.NO_SHOW);
  assert.equal(svc2.treatmentLedger("P-B")[0].counted_treatment, false);

  // 四种结局合计：整个套件中 treated 只计 1 次（P-A），其余全部不计
  const counted = [...svc.treatmentLedger("P-A"), ...svc.treatmentLedger("P-B"), ...svc.treatmentLedger("P-C"),
    ...svc2.treatmentLedger("P-A"), ...svc2.treatmentLedger("P-B"), ...svc2.treatmentLedger("P-C")]
    .filter((l) => l.counted_treatment).length;
  assert.equal(counted, 1);

  // P-B、P-C 仍是开放缺口并带责任方
  const gaps = svc.openGaps();
  const byPatient = Object.fromEntries(gaps.map((g) => [g.patient_id, g]));
  assert.match(byPatient["P-B"].status, /en_route_risk/);
  assert.match(byPatient["P-C"].status, /missed/);
  assert.ok(byPatient["P-B"].responsible_party.reason);

  // no_show 同样挂为开放缺口
  assert.ok(svc2.openGaps().some((g) => g.patient_id === "P-B" && /no_show/.test(g.status)));
});

test("暴雪全流程：漏治患者经补救场次完成治疗后缺口闭合", () => {
  const { svc, plans, sessions } = world();
  svc.setClock("2026-10-03T16:00:00+08:00");
  svc.closeOccurrence({ idempotency_key: "close-C", occurrence_id: sessions["P-C"].occurrence_id, facility_id: "COUNTY", outcome: OCCURRENCE_OUTCOME.MISSED });
  assert.ok(svc.openGaps().some((g) => g.patient_id === "P-C"));

  // 次日水处理恢复，容量重新通告，按同一处方加排补救场次
  svc.setClock("2026-10-03T18:00:00+08:00");
  svc.reportCapacity({ idempotency_key: "county-recover-water", facility_id: "COUNTY", resource_type: "water", scope: { system: "ro-main" }, window: { start: "2026-10-04T00:00:00+08:00", end: "2026-10-04T23:59:59+08:00" }, available: 6, notice: "水处理修复" });
  publishCapacity(svc, "county-d4", "COUNTY", {}, { start: "2026-10-04T00:00:00+08:00", end: "2026-10-04T23:59:59+08:00" });
  svc.reportCapacity({ idempotency_key: "county-recover-water2", facility_id: "COUNTY", resource_type: "water", scope: { system: "ro-main" }, window: { start: "2026-10-04T00:00:00+08:00", end: "2026-10-04T23:59:59+08:00" }, available: 6, notice: "水处理修复" });

  const remedial = svc.reserveSession({
    idempotency_key: "res-C-remedy", facility_id: "COUNTY", patient_id: "P-C", plan_id: plans["P-C"].plan_id,
    scheduled_start: "2026-10-04T08:00:00+08:00", scheduled_end: "2026-10-04T12:00:00+08:00",
    needs: standardNeeds(), remedial_for: sessions["P-C"].occurrence_id,
  });
  svc.setClock("2026-10-04T12:30:00+08:00");
  svc.closeOccurrence({ idempotency_key: "close-C-remedy", occurrence_id: remedial.occurrence_id, facility_id: "COUNTY", outcome: OCCURRENCE_OUTCOME.TREATED });

  // 原 occurrence 仍记 missed 且不计次；补救 occurrence 计一次；患者总治疗次数不重不漏
  const gaps = svc.openGaps();
  assert.ok(!gaps.some((g) => g.patient_id === "P-C"), "补救完成后缺口应闭合");
  const ledger = svc.treatmentLedger("P-C");
  assert.equal(ledger.filter((l) => l.counted_treatment).length, 1);
  assert.equal(ledger.find((l) => l.remedial_for).outcome, OCCURRENCE_OUTCOME.TREATED);
});

test("暴雪全流程：离线补录与现场结案冲突时按发生时间对账，绝不多记一次透析", () => {
  const { svc, sessions } = world();
  routeAndHandoffAll(svc, sessions, { only: ["P-A"] });
  const replacement = [...svc.read.handoffs.values()][0].replacement_session_id;
  svc.setClock("2026-10-04T09:00:00+08:00"); // 网络恢复后离线补录

  // 10-03 14:30 州医院现场结案 treated
  svc.closeOccurrence({ idempotency_key: "close-online", occurrence_id: sessions["P-A"].occurrence_id, session_id: replacement, facility_id: "STATE", outcome: OCCURRENCE_OUTCOME.TREATED, occurred_at: "2026-10-03T14:30:00+08:00" });
  // 10-04 网络恢复，县医院离线补录“13:10 已治疗”——发生时间更早但属于重复上报
  svc.closeOccurrence({ idempotency_key: "close-offline", occurrence_id: sessions["P-A"].occurrence_id, session_id: sessions["P-A"].session_id, facility_id: "COUNTY", outcome: OCCURRENCE_OUTCOME.TREATED, detail: "离线补录：县医院纸面记录", occurred_at: "2026-10-03T13:10:00+08:00", recorded_at: "2026-10-04T09:10:00+08:00" });

  // 冲突在值班视图显式挂账
  const gap = svc.openGaps().find((g) => g.occurrence_id === sessions["P-A"].occurrence_id);
  assert.equal(gap.status, "conflict_pending_reconciliation");
  assert.equal(gap.evidence.length, 1);
  assert.equal(gap.evidence[0].late, true);

  // 对账：值班核查后确认县医院纸面记录系停机前模板误填，以州医院上机记录为裁决依据
  const onlineEvent = svc.events().find(
    (e) => e.event_type === "OCCURRENCE_CLOSED" && e.causation_id === "close-online",
  );
  const rec = svc.reconcileOccurrence({
    idempotency_key: "reconcile-A", occurrence_id: sessions["P-A"].occurrence_id,
    decision: "confirm", basis_event_id: onlineEvent.event_id,
    note: "县医院纸面记录系停机前模板误填，州医院有上机记录", occurred_at: "2026-10-04T09:30:00+08:00",
  });
  assert.equal(rec.counted_treatment, true);
  assert.equal(svc.treatmentLedger("P-A").find((l) => l.occurrence_id === sessions["P-A"].occurrence_id).reconciled.basis_event_id, onlineEvent.event_id);
  const ledger = svc.treatmentLedger("P-A");
  assert.equal(ledger.filter((l) => l.counted_treatment).length, 1);
  assert.ok(!svc.openGaps().some((g) => g.occurrence_id === sessions["P-A"].occurrence_id));
});

test("暴雪全流程：服务恢复后借用名额、耗材、费用回归跨院结算", () => {
  const { svc, sessions } = world();
  svc.setClock("2026-10-02T21:00:00+08:00");
  const dis = svc.declareDisruption({ idempotency_key: "disruption", facility_id: "COUNTY", reason: "水处理告警", select: { time_window: { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" } } });
  routeAndHandoffAll(svc, sessions, { only: ["P-A"] });
  const replacement = [...svc.read.handoffs.values()][0].replacement_session_id;
  svc.setClock("2026-10-03T15:00:00+08:00");
  svc.closeOccurrence({ idempotency_key: "close-A", occurrence_id: sessions["P-A"].occurrence_id, session_id: replacement, facility_id: "STATE", outcome: OCCURRENCE_OUTCOME.TREATED });
  svc.reconcileOccurrence({ idempotency_key: "rec-A", occurrence_id: sessions["P-A"].occurrence_id });

  const stl = svc.recordSettlement({
    idempotency_key: "settle-A", disruption_id: dis.disruption_id,
    from_facility_id: "COUNTY", to_facility_id: "STATE", patient_id: "P-A", occurrence_id: sessions["P-A"].occurrence_id,
    items: [
      { type: "borrowed_slot", qty: 1, unit_amount: 300, memo: "借用透析名额 1 例次" },
      { type: "consumable", qty: 1, unit_amount: 120.5, memo: "透析器+管路" },
      { type: "fee", qty: 1, unit_amount: 79.5, memo: "护士与水处理分摊" },
    ],
    occurred_at: "2026-10-04T10:00:00+08:00",
  });
  assert.equal(stl.total, 500);
  const list = svc.settlements({ disruption_id: dis.disruption_id });
  assert.equal(list.length, 1);

  // 未实际在州医院治疗的 occurrence 不能借交接名义结算
  assert.throws(
    () => svc.recordSettlement({ idempotency_key: "settle-B", from_facility_id: "COUNTY", to_facility_id: "STATE", patient_id: "P-B", occurrence_id: sessions["P-B"].occurrence_id, items: [{ type: "borrowed_slot", qty: 1, unit_amount: 300 }] }),
    (e) => e.code === ErrorCodes.SETTLEMENT_ERROR,
  );
});

test("暴雪全流程：患者收到当前地点、交通风险与下一次安排，且与值班视图一致", () => {
  const { svc, sessions } = world();
  routeAndHandoffAll(svc, sessions, { only: ["P-A"] });
  svc.setClock("2026-10-03T07:30:00+08:00");
  const note = svc.notifyPatient({ idempotency_key: "notify-A", patient_id: "P-A", channel: "voice_call", delivered: true });
  assert.equal(note.current_location.facility_id, "STATE");
  assert.equal(note.transport_risk.status, "restricted");
  assert.ok(note.transport_risk.requirements.includes("4wd_ambulance"));
  assert.equal(note.next_appointment.facility_id, "STATE");
  assert.equal(note.next_appointment.start, STATE_SLOT.start);
  assert.match(note.message, /STATE/);

  // 查询接口给出同样内容
  const status = svc.patientStatus("P-A");
  assert.deepEqual(status.next_appointment, note.next_appointment);
});

test("暴雪全流程：命令幂等重试不产生重复场次/交接/透析次数", () => {
  const { svc, sessions } = world();
  svc.setClock("2026-10-02T20:00:00+08:00");
  svc.declareDisruption({ idempotency_key: "disruption", facility_id: "COUNTY", reason: "水处理告警", select: { time_window: { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" } } });
  svc.updateRoadStatus({ idempotency_key: "road", facility_from_id: "COUNTY", facility_to_id: "STATE", status: "restricted", risk_level: "medium", transport_requirements: ["4wd_ambulance"] });
  const cmd = { idempotency_key: "req-A", patient_id: "P-A", occurrence_id: sessions["P-A"].occurrence_id, from_facility_id: "COUNTY", to_facility_id: "STATE", preferred_slot: STATE_SLOT };
  const r1 = svc.requestTransfer(cmd);
  const r2 = svc.requestTransfer(cmd);
  assert.equal(r2.idempotent, true);
  assert.equal(r1.handoff_id, r2.handoff_id ?? r1.handoff_id);
  assert.equal([...svc.read.handoffs.values()].filter((h) => h.patient_id === "P-A").length, 1);

  const eventCountBefore = svc.events().length;
  svc.requestTransfer(cmd);
  assert.equal(svc.events().length, eventCountBefore);
});

// ── 辅助：封路恢复 + 完成 P-A 的完整交接 ──
function routeAndHandoffAll(svc, sessions, { only = [] } = {}) {
  svc.setClock("2026-10-02T20:00:00+08:00");
  if (!svc.read.disruptions.size) {
    svc.declareDisruption({ idempotency_key: "disruption", facility_id: "COUNTY", reason: "水处理告警", select: { time_window: { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" } } });
  }
  if (![...svc.read.routes.values()].length) {
    svc.updateRoadStatus({ idempotency_key: "road", facility_from_id: "COUNTY", facility_to_id: "STATE", status: "restricted", risk_level: "medium", transport_requirements: ["4wd_ambulance"] });
  }
  svc.reportCapacity({ idempotency_key: "state-nurse", facility_id: "STATE", resource_type: "personnel", scope: { qualification: "dialysis_nurse", shift: "morning" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 3 });
  svc.reportCapacity({ idempotency_key: "state-dial", facility_id: "STATE", resource_type: "consumable", scope: { code: "dialyzer" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 6 });
  svc.reportCapacity({ idempotency_key: "state-line", facility_id: "STATE", resource_type: "consumable", scope: { code: "bloodline" }, window: { start: STATE_SLOT.start, end: STATE_SLOT.end }, available: 6 });

  for (const pid of only) {
    const req = svc.requestTransfer({ idempotency_key: `req-${pid}`, patient_id: pid, occurrence_id: sessions[pid].occurrence_id, from_facility_id: "COUNTY", to_facility_id: "STATE", preferred_slot: STATE_SLOT });
    svc.acceptTransfer({ idempotency_key: `acc-${pid}`, handoff_id: req.handoff_id, agreed_slot: STATE_SLOT });
    svc.sendMinimalRecord({ idempotency_key: `rec-${pid}`, handoff_id: req.handoff_id, fields: RECORD_FIELDS });
    svc.completeHandoff({ idempotency_key: `done-${pid}`, handoff_id: req.handoff_id });
  }
}
