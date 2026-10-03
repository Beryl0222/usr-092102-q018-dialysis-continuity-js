/** 测试工厂：在内存事件库上搭建县/州两级机构与若干注册患者。 */
import { EventStore } from "../src/event-store.js";
import { SchedulingService } from "../src/scheduling-service.js";

export const WIN_D3 = { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" };
export const WIN_D4 = { start: "2026-10-04T00:00:00+08:00", end: "2026-10-04T23:59:59+08:00" };

export function standardNeeds(overrides = {}) {
  return {
    personnel: { qualification: "dialysis_nurse", shift: "morning", qty: 1 },
    machine: { modality: "hd", qty: 1 },
    water: { system: "ro-main", amount: 1 },
    consumable: { lines: [{ code: "dialyzer", qty: 1 }, { code: "bloodline", qty: 1 }] },
    infection_zone: { zone_level: overrides.zone ?? "standard", qty: 1 },
    safety_interval: { zone_level: overrides.zone ?? "standard", minutes: 30, ...(overrides.station_id ? { station_id: overrides.station_id } : {}), qty: 1 },
  };
}

export function newService(clockStart = "2026-10-02T08:00:00+08:00") {
  const store = new EventStore();
  const svc = new SchedulingService(store);
  svc.setClock(clockStart);
  return { svc, store };
}

/** 发布某设施一天的六类资源容量；spec 可覆盖每类可用量。 */
export function publishCapacity(svc, keyPrefix, facilityId, spec = {}, window = WIN_D3) {
  const set = (k, resource_type, scope, available, notice) => {
    svc.reportCapacity({ idempotency_key: `${keyPrefix}-${k}`, facility_id: facilityId, resource_type, scope, window, available, notice });
  };
  set("nurse", "personnel", { qualification: "dialysis_nurse", shift: "morning" }, spec.personnel ?? 4);
  set("machine", "machine", { modality: "hd" }, spec.machine ?? 6);
  set("water", "water", { system: "ro-main" }, spec.water ?? 6);
  set("cons-dial", "consumable", { code: "dialyzer" }, spec.dialyzer ?? 30);
  set("cons-line", "consumable", { code: "bloodline" }, spec.bloodline ?? 30);
  set("zone", "infection_zone", { zone_level: "standard" }, spec.zone ?? 6);
  set("interval", "safety_interval", { zone_level: "standard" }, spec.interval ?? 6);
  if (spec.hepb) {
    set("zone-hepb", "infection_zone", { zone_level: "hepb_isolation" }, spec.hepb);
    set("interval-hepb", "safety_interval", { zone_level: "hepb_isolation" }, spec.hepb);
  }
}

export function confirmPatient(svc, pid, { key, cadence, prescription } = {}) {
  return svc.confirmPlan({
    idempotency_key: key ?? `plan-${pid}`,
    patient_id: pid,
    confirmed_by: "DR-001",
    prescription: prescription ?? { modality: "hd", duration_min: 240, anticoagulation: "heparin", dry_weight_kg: 60 },
    cadence: cadence ?? { per_week: 3, days: ["Mon", "Wed", "Fri"], shift: "morning" },
  });
}

export function reserveMorning(svc, { key, facility, pid, planId, start, end, needs, occurrenceId, remedialFor }) {
  return svc.reserveSession({
    idempotency_key: key,
    facility_id: facility,
    patient_id: pid,
    plan_id: planId,
    occurrence_id: occurrenceId,
    remedial_for: remedialFor,
    scheduled_start: start,
    scheduled_end: end,
    needs: needs ?? standardNeeds(),
  });
}
