import { CLOSURE_REASONS, MIN_CLINICAL_PACKET_FIELDS, ROAD_STATUSES } from "./domain.js";
import { EventStore } from "./event-store.js";

/** 领域规则拒绝：调用方可按 code 区分处理。 */
export class DomainError extends Error {
  constructor(message, code = "DOMAIN_REJECTED") {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

// ---- 时间工具：occurred_at 一律携带发生地时区偏移，对账按其本地日期 ----

const dateOf = (iso) => iso.slice(0, 10);

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const weekdayOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const slotKeyOf = (facilityId, slotId) => `${facilityId}|${slotId}`;
const routeKeyOf = (from, to) => `${from}->${to}`;
const reconKeyOf = (planId, date) => `${planId}@${date}`;

const RISK_ADVICE = Object.freeze({
  OPEN: "道路畅通，可按常规出行",
  RESTRICTED: "道路管制，须按护送转运安排出行，勿自行前往",
  CLOSED: "道路封闭，等待转运窗口，勿自行前往",
});

/**
 * 高原透析连续调度后端。
 *
 * 设计要点：
 * - 一切状态变更以领域事件入账（事件溯源），event_id 幂等、版本连续；
 * - 处方版本与周期只能经 confirmPlan（医生动作）确认，调度类命令不改动处方；
 * - 预约场次同时占用合格人员、透析机位、水处理能力、耗材批次、感染分区与安全间隔；
 * - 中断时按患者连续性倒推：锁定受影响场次 → 评估道路可达性 → 转运交接 →
 *   分别结案 → 以发生时间对账 → 恢复后跨院结算；
 * - 读模型：patientNotice（患者通知）、openGaps（值班缺口清单）。
 */
export function createContinuityService({ clock } = {}) {
  const store = new EventStore();
  const now = () => (clock ? clock() : new Date().toISOString());

  // ---- 投影状态（全部由事件重放得到） ----
  const plans = new Map(); // plan_id -> 处方计划
  const slots = new Map(); // facility|slot -> 容量场次
  const sessions = new Map(); // session_id -> 透析场次
  const handoffs = new Map(); // handoff_id -> 转运交接
  const roads = new Map(); // from->to -> 路况
  const treatments = new Map(); // plan_id@date -> 透析入账记录（对账键）
  const settlements = new Map(); // statement_id -> 结算单

  // ---- 事件投影 ----

  function restoreConsumable(session) {
    const slot = slots.get(session.slotKey);
    if (slot && session.batch_id) {
      slot.consumables.set(session.batch_id, (slot.consumables.get(session.batch_id) ?? 0) + 1);
    }
  }

  function project(event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "PLAN_CONFIRMED":
        plans.set(event.aggregate_id, {
          plan_id: event.aggregate_id,
          patient_id: p.patient_id,
          prescription_version: p.prescription_version,
          cycle: p.cycle,
          duration_minutes: p.duration_minutes,
          infection_zone: p.infection_zone,
          home_facility_id: p.home_facility_id,
          start_date: p.start_date,
          confirmed_by: p.confirmed_by,
          confirmed_at: event.occurred_at,
        });
        break;
      case "CAPACITY_CHANGED": {
        const key = slotKeyOf(p.facility_id, p.slot.slot_id);
        const prev = slots.get(key);
        slots.set(key, {
          key,
          facility_id: p.facility_id,
          slot_id: p.slot.slot_id,
          date: p.slot.date,
          start: p.slot.start,
          end: p.slot.end,
          stations: p.stations.map((s) => ({ ...s })),
          staff: p.staff,
          water_capacity: p.water_capacity,
          consumables: new Map(Object.entries(p.consumables ?? {})),
          turnover_minutes: p.turnover_minutes,
          ambulances: p.ambulances ?? 0,
          tariff: p.tariff ?? { slot_fee: 0, consumable_fee: 0 },
          disrupted: prev?.disrupted ?? false,
        });
        break;
      }
      case "ROUTE_STATUS_CHANGED":
        roads.set(routeKeyOf(p.from_facility_id, p.to_facility_id), {
          status: p.status,
          note: p.note ?? null,
          updated_at: event.occurred_at,
        });
        break;
      case "SESSION_RESERVED": {
        const key = slotKeyOf(p.facility_id, p.slot_id);
        sessions.set(p.session_id, {
          session_id: p.session_id,
          plan_id: p.plan_id,
          patient_id: p.patient_id,
          facility_id: p.facility_id,
          slot_id: p.slot_id,
          slotKey: key,
          slot_date: p.slot_date,
          station_id: p.station_id,
          batch_id: p.batch_id,
          start: p.start,
          duration_minutes: p.duration_minutes,
          prescription_version: p.prescription_version,
          borrowed: p.borrowed,
          origin_facility_id: p.origin_facility_id,
          continues_session_id: p.continues_session_id,
          handoff_id: p.handoff_id,
          status: "RESERVED",
          closure_reason: null,
          closure_detail: null,
          treated_at: null,
        });
        const slot = slots.get(key);
        if (slot && p.batch_id) {
          slot.consumables.set(p.batch_id, (slot.consumables.get(p.batch_id) ?? 0) - 1);
        }
        break;
      }
      case "SESSION_LOCKED": {
        const session = sessions.get(event.aggregate_id);
        if (session) {
          session.status = "LOCKED";
          const slot = slots.get(session.slotKey);
          if (slot) slot.disrupted = true;
        }
        break;
      }
      case "TRANSFER_PROPOSED":
        handoffs.set(event.aggregate_id, {
          handoff_id: event.aggregate_id,
          session_id: p.session_id,
          plan_id: p.plan_id,
          patient_id: p.patient_id,
          from_facility_id: p.from_facility_id,
          to_facility_id: p.to_facility_id,
          slot_id: p.slot_id,
          start: p.start,
          transport: p.transport ?? {},
          road_status: p.road_status,
          status: "PROPOSED",
          clinical_packet: null,
          borrowed_session_id: null,
          proposed_at: event.occurred_at,
          accepted_at: null,
        });
        break;
      case "TRANSFER_ACCEPTED": {
        const handoff = handoffs.get(event.aggregate_id);
        if (handoff) {
          handoff.status = "ACCEPTED";
          handoff.clinical_packet = p.clinical_packet;
          handoff.borrowed_session_id = p.borrowed_session_id;
          handoff.accepted_at = event.occurred_at;
          const original = sessions.get(handoff.session_id);
          if (original) {
            original.status = "TRANSFERRED";
            restoreConsumable(original); // 原场次未使用耗材回库
          }
        }
        break;
      }
      case "SESSION_CLOSED": {
        const session = sessions.get(event.aggregate_id);
        if (session) {
          session.status = "CLOSED";
          session.closure_reason = p.closure_reason;
          session.closure_detail = p.detail ?? null;
          session.closed_at = event.occurred_at;
          if (p.closure_reason !== "TREATED") restoreConsumable(session); // 未治疗结案，耗材回库
        }
        break;
      }
      case "TREATMENT_RECONCILED": {
        const key = reconKeyOf(p.plan_id, p.occurred_date);
        treatments.set(key, {
          key,
          plan_id: p.plan_id,
          patient_id: p.patient_id,
          facility_id: p.facility_id,
          occurred_at: event.occurred_at,
          occurred_date: p.occurred_date,
          session_id: p.session_id ?? null,
          offline: Boolean(p.offline),
          event_id: event.event_id,
        });
        if (p.session_id) {
          const session = sessions.get(p.session_id);
          if (session) session.treated_at = event.occurred_at;
        }
        break;
      }
      case "SETTLEMENT_RECORDED":
        settlements.set(event.aggregate_id, {
          statement_id: event.aggregate_id,
          ...p,
          recorded_at: event.occurred_at,
        });
        break;
      default:
        break;
    }
  }

  // ---- 入账 ----

  function emit({ event_id, event_type, aggregate_type, aggregate_id, occurred_at, summary, payload }) {
    const version = store.ofAggregate(aggregate_type, aggregate_id).length + 1;
    const event = {
      event_id: event_id ?? `EVT-${aggregate_type}-${aggregate_id}-v${version}`,
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at,
      version,
      summary,
      ...(payload ? { payload } : {}),
    };
    const result = store.append(event);
    if (result.applied) project(event);
    return result;
  }

  /** 外部事件 ingest / 重放入口：同样的幂等与版本约束。 */
  function publish(event) {
    const result = store.append(event);
    if (result.applied) project(result.event);
    return result;
  }

  // ---- 查有对象 ----

  const mustPlan = (planId) => {
    const plan = plans.get(planId);
    if (!plan) throw new DomainError(`未登记治疗计划：${planId}`, "PLAN_NOT_FOUND");
    return plan;
  };

  const mustSlot = (facilityId, slotId) => {
    const slot = slots.get(slotKeyOf(facilityId, slotId));
    if (!slot) throw new DomainError(`未登记容量场次：${facilityId}|${slotId}`, "SLOT_NOT_FOUND");
    return slot;
  };

  const mustSession = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) throw new DomainError(`未登记透析场次：${sessionId}`, "SESSION_NOT_FOUND");
    return session;
  };

  const mustHandoff = (handoffId) => {
    const handoff = handoffs.get(handoffId);
    if (!handoff) throw new DomainError(`未登记转运交接：${handoffId}`, "HANDOFF_NOT_FOUND");
    return handoff;
  };

  // ---- 资源检查：人员、机位（含安全间隔）、水处理、耗材批次、感染分区同时满足 ----

  const overlaps = (session, startMin, durationMin, turnoverMin) => {
    const sStart = minutesOf(session.start);
    return sStart < startMin + durationMin + turnoverMin && startMin < sStart + session.duration_minutes + turnoverMin;
  };

  function checkAvailability(slot, plan, startMin, { station_id, batch_id } = {}) {
    const active = [...sessions.values()].filter((s) => s.slotKey === slot.key && s.status === "RESERVED");
    if (active.length >= slot.staff) {
      throw new DomainError(`合格人员不足：${slot.slot_id} ${slot.staff} 名已全部占用`);
    }
    if (active.length >= slot.water_capacity) {
      throw new DomainError(`水处理能力不足：${slot.slot_id} 同时透析上限 ${slot.water_capacity}`);
    }
    const candidates = slot.stations.filter(
      (st) => st.zone === plan.infection_zone && (!station_id || st.station_id === station_id),
    );
    const station = candidates.find(
      (st) => !active.some((s) => s.station_id === st.station_id && overlaps(s, startMin, plan.duration_minutes, slot.turnover_minutes)),
    );
    if (!station) {
      throw new DomainError(`感染分区 ${plan.infection_zone} 无可用机位或安全间隔不足`);
    }
    const chosenBatch = batch_id ?? [...slot.consumables.entries()].find(([, qty]) => qty > 0)?.[0];
    if (!chosenBatch || (slot.consumables.get(chosenBatch) ?? 0) <= 0) {
      throw new DomainError("耗材批次余量不足");
    }
    return { station_id: station.station_id, batch_id: chosenBatch };
  }

  // ---- 命令 ----

  /** 医生确认处方（版本与周期只能经此变更，调度命令不得擅改）。再次确认须更换版本号。 */
  function confirmPlan(cmd) {
    const requiredFields = ["plan_id", "patient_id", "prescription_version", "cycle", "duration_minutes", "infection_zone", "home_facility_id", "start_date", "confirmed_by"];
    const missing = requiredFields.filter((f) => cmd[f] == null);
    if (missing.length > 0) throw new DomainError(`确认处方缺少字段：${missing.join("、")}`, "COMMAND_INVALID");
    if (!Array.isArray(cmd.cycle.weekdays) || cmd.cycle.weekdays.length === 0) {
      throw new DomainError("处方周期 cycle.weekdays 必须是非空数组", "COMMAND_INVALID");
    }
    const existing = plans.get(cmd.plan_id);
    if (existing && existing.prescription_version === cmd.prescription_version) {
      throw new DomainError(`处方版本未变化：v${cmd.prescription_version} 已确认`, "COMMAND_INVALID");
    }
    const res = emit({
      event_id: cmd.event_id,
      event_type: "PLAN_CONFIRMED",
      aggregate_type: "treatment_plan",
      aggregate_id: cmd.plan_id,
      occurred_at: cmd.occurred_at ?? now(),
      summary: `医生确认处方 ${cmd.plan_id} v${cmd.prescription_version}`,
      payload: {
        patient_id: cmd.patient_id,
        prescription_version: cmd.prescription_version,
        cycle: cmd.cycle,
        duration_minutes: cmd.duration_minutes,
        infection_zone: cmd.infection_zone,
        home_facility_id: cmd.home_facility_id,
        start_date: cmd.start_date,
        confirmed_by: cmd.confirmed_by,
      },
    });
    return { ...res, plan: plans.get(cmd.plan_id) };
  }

  /**
   * 登记/调整容量场次。首次登记须给出完整快照；之后按补丁语义，
   * 未提供的维度保持原值（如水处理告警只改 water_capacity）。
   */
  function changeCapacity(cmd) {
    const key = slotKeyOf(cmd.facility_id, cmd.slot.slot_id);
    const prev = slots.get(key);
    if (!prev) {
      const missingFields = ["stations", "staff", "water_capacity", "consumables", "turnover_minutes"].filter((f) => cmd[f] == null);
      if (missingFields.length > 0) {
        throw new DomainError(`首次登记容量缺少字段：${missingFields.join("、")}`, "COMMAND_INVALID");
      }
    }
    const merged = {
      facility_id: cmd.facility_id,
      slot: cmd.slot,
      stations: cmd.stations ?? [...(prev?.stations ?? [])],
      staff: cmd.staff ?? prev?.staff,
      water_capacity: cmd.water_capacity ?? prev?.water_capacity,
      consumables: cmd.consumables ?? Object.fromEntries(prev?.consumables ?? []),
      turnover_minutes: cmd.turnover_minutes ?? prev?.turnover_minutes,
      ambulances: cmd.ambulances ?? prev?.ambulances ?? 0,
      tariff: cmd.tariff ?? prev?.tariff,
    };
    const res = emit({
      event_id: cmd.event_id,
      event_type: "CAPACITY_CHANGED",
      aggregate_type: "resource_capacity",
      aggregate_id: key,
      occurred_at: cmd.occurred_at ?? now(),
      summary: `容量调整 ${key}`,
      payload: merged,
    });
    return { ...res, slot: slotView(cmd.facility_id, cmd.slot.slot_id) };
  }

  /** 路况更新：暴雪等导致的通行状态变化。 */
  function updateRoadStatus(cmd) {
    if (!ROAD_STATUSES.includes(cmd.status)) throw new DomainError(`未知道路状态：${cmd.status}`, "COMMAND_INVALID");
    const res = emit({
      event_id: cmd.event_id,
      event_type: "ROUTE_STATUS_CHANGED",
      aggregate_type: "route_status",
      aggregate_id: routeKeyOf(cmd.from_facility_id, cmd.to_facility_id),
      occurred_at: cmd.occurred_at ?? now(),
      summary: `路况 ${cmd.from_facility_id}->${cmd.to_facility_id}：${cmd.status}`,
      payload: { from_facility_id: cmd.from_facility_id, to_facility_id: cmd.to_facility_id, status: cmd.status, note: cmd.note },
    });
    return { ...res, road: roads.get(routeKeyOf(cmd.from_facility_id, cmd.to_facility_id)) };
  }

  /**
   * 预约透析场次：同时占用合格人员、透析机位、水处理能力、耗材批次、
   * 感染分区与安全间隔，任一维度不满足则整体拒绝。天然幂等键为
   * session_id（默认 SES-{plan_id}-{slot_id}），重复预约返回首次结果。
   */
  function reserveSession(cmd) {
    const plan = mustPlan(cmd.plan_id);
    const session_id = cmd.session_id ?? `SES-${cmd.plan_id}-${cmd.slot_id}`;
    const existing = sessions.get(session_id);
    if (existing) return { applied: false, duplicate: true, session: { ...existing }, events: [] };
    if (cmd.prescription_version != null && cmd.prescription_version !== plan.prescription_version) {
      throw new DomainError(
        `处方版本不一致：医生已确认 v${plan.prescription_version}，调度不得沿用 v${cmd.prescription_version}`,
        "PRESCRIPTION_STALE",
      );
    }
    const slot = mustSlot(cmd.facility_id, cmd.slot_id);
    if (slot.disrupted) throw new DomainError(`场次 ${cmd.slot_id} 已锁定，禁止新预约`, "SLOT_DISRUPTED");
    const { station_id, batch_id } = checkAvailability(slot, plan, minutesOf(cmd.start), cmd);
    const res = emit({
      event_id: cmd.event_id,
      event_type: "SESSION_RESERVED",
      aggregate_type: "dialysis_session",
      aggregate_id: session_id,
      occurred_at: cmd.occurred_at ?? now(),
      summary: `预约透析 ${session_id}（${cmd.facility_id}/${cmd.slot_id}）`,
      payload: {
        session_id,
        plan_id: plan.plan_id,
        patient_id: plan.patient_id,
        facility_id: cmd.facility_id,
        slot_id: cmd.slot_id,
        slot_date: slot.date,
        station_id,
        batch_id,
        start: cmd.start,
        duration_minutes: plan.duration_minutes,
        prescription_version: plan.prescription_version,
        borrowed: false,
        origin_facility_id: null,
        continues_session_id: null,
        handoff_id: null,
      },
    });
    return { applied: res.applied, duplicate: res.duplicate, session: { ...sessions.get(session_id) }, events: [res.event] };
  }

  /** 紧急停机：只锁定受影响场次内的在约 session，其他场次不受影响。 */
  function lockSlot(cmd) {
    const slot = mustSlot(cmd.facility_id, cmd.slot_id);
    const targets = [...sessions.values()].filter((s) => s.slotKey === slot.key && s.status === "RESERVED");
    const events = targets.map(
      (s) =>
        emit({
          event_id: cmd.event_ids?.[s.session_id],
          event_type: "SESSION_LOCKED",
          aggregate_type: "dialysis_session",
          aggregate_id: s.session_id,
          occurred_at: cmd.occurred_at ?? now(),
          summary: `紧急停机锁定 ${s.session_id}（${cmd.reason}）`,
          payload: { slot_id: slot.slot_id, facility_id: slot.facility_id, reason: cmd.reason },
        }).event,
    );
    if (targets.length === 0) slot.disrupted = true; // 空场次直接标记停机
    return { locked: targets.map((s) => ({ ...sessions.get(s.session_id) })), events };
  }

  /**
   * 发起转运：仅针对已锁定场次；暴雪后的道路通行状态与转运条件决定
   * 替代机构是否真正可达（CLOSED 不可达；RESTRICTED 须护送转运）。
   */
  function proposeTransfer(cmd) {
    const session = mustSession(cmd.session_id);
    if (session.status !== "LOCKED") throw new DomainError(`仅已锁定场次可发起转运，当前状态 ${session.status}`, "SESSION_NOT_LOCKED");
    const handoff_id = cmd.handoff_id ?? `HO-${cmd.session_id}`;
    const existing = handoffs.get(handoff_id);
    if (existing) return { applied: false, duplicate: true, handoff: { ...existing }, events: [] };
    const road = roads.get(routeKeyOf(session.facility_id, cmd.to_facility_id));
    if (!road || road.status === "CLOSED") {
      throw new DomainError(`道路封闭或路况未知，${cmd.to_facility_id} 当前不可达`, "ROUTE_UNREACHABLE");
    }
    if (road.status === "RESTRICTED" && cmd.transport?.escort !== true) {
      throw new DomainError("管制路段须安排护送转运方可通行", "ESCORT_REQUIRED");
    }
    const plan = mustPlan(session.plan_id);
    const slot = mustSlot(cmd.to_facility_id, cmd.slot_id);
    if (slot.disrupted) throw new DomainError(`接收方场次 ${cmd.slot_id} 已停机`, "SLOT_DISRUPTED");
    checkAvailability(slot, plan, minutesOf(cmd.start), cmd); // 接收能力预检，不占用
    const res = emit({
      event_id: cmd.event_id,
      event_type: "TRANSFER_PROPOSED",
      aggregate_type: "transfer_handoff",
      aggregate_id: handoff_id,
      occurred_at: cmd.occurred_at ?? now(),
      summary: `发起转运 ${handoff_id}：${session.facility_id} → ${cmd.to_facility_id}`,
      payload: {
        session_id: session.session_id,
        plan_id: plan.plan_id,
        patient_id: plan.patient_id,
        from_facility_id: session.facility_id,
        to_facility_id: cmd.to_facility_id,
        slot_id: cmd.slot_id,
        start: cmd.start,
        transport: cmd.transport ?? {},
        road_status: road.status,
      },
    });
    return { applied: res.applied, duplicate: res.duplicate, handoff: { ...handoffs.get(handoff_id) }, events: [res.event] };
  }

  /**
   * 接收方明确接收并取得最少必要临床资料后，交接才算完成：
   * 临床资料须与医生确认的处方版本一致；接收成功即在接收方占用一个
   * 借用场次（SESSION_RESERVED，borrowed=true），原场次转为 TRANSFERRED。
   */
  function acceptTransfer(cmd) {
    const handoff = mustHandoff(cmd.handoff_id);
    if (handoff.status === "ACCEPTED") {
      return { applied: false, duplicate: true, handoff: { ...handoff }, borrowed: { ...sessions.get(handoff.borrowed_session_id) }, events: [] };
    }
    const plan = mustPlan(handoff.plan_id);
    const packet = cmd.clinical_packet ?? {};
    const missing = MIN_CLINICAL_PACKET_FIELDS.filter((f) => !(f in packet));
    if (missing.length > 0) throw new DomainError(`缺少最少必要临床资料：${missing.join("、")}`, "CLINICAL_PACKET_INCOMPLETE");
    if (packet.plan_id !== plan.plan_id || packet.patient_id !== plan.patient_id) {
      throw new DomainError("临床资料与登记患者不符", "CLINICAL_PACKET_MISMATCH");
    }
    if (packet.prescription_version !== plan.prescription_version) {
      throw new DomainError(
        `临床资料处方版本 v${packet.prescription_version} 与医生确认 v${plan.prescription_version} 不一致`,
        "CLINICAL_PACKET_MISMATCH",
      );
    }
    if (packet.infection_zone !== plan.infection_zone) {
      throw new DomainError("临床资料感染分区与处方不一致", "CLINICAL_PACKET_MISMATCH");
    }
    const original = mustSession(handoff.session_id);
    const slot = mustSlot(handoff.to_facility_id, handoff.slot_id);
    if (slot.disrupted) throw new DomainError(`接收方场次 ${handoff.slot_id} 已停机`, "SLOT_DISRUPTED");
    const { station_id, batch_id } = checkAvailability(slot, plan, minutesOf(handoff.start), cmd);
    const borrowed_id = `SES-B-${handoff.handoff_id}`;
    const occurred_at = cmd.occurred_at ?? now();
    const e1 = emit({
      event_id: cmd.event_id,
      event_type: "TRANSFER_ACCEPTED",
      aggregate_type: "transfer_handoff",
      aggregate_id: handoff.handoff_id,
      occurred_at,
      summary: `交接完成 ${handoff.handoff_id}：${handoff.to_facility_id} 明确接收并取得临床资料`,
      payload: { clinical_packet: packet, received_by: cmd.received_by ?? null, borrowed_session_id: borrowed_id },
    });
    const e2 = emit({
      event_type: "SESSION_RESERVED",
      aggregate_type: "dialysis_session",
      aggregate_id: borrowed_id,
      occurred_at,
      summary: `借用场次 ${borrowed_id}（${handoff.to_facility_id}/${handoff.slot_id}）`,
      payload: {
        session_id: borrowed_id,
        plan_id: plan.plan_id,
        patient_id: plan.patient_id,
        facility_id: handoff.to_facility_id,
        slot_id: handoff.slot_id,
        slot_date: slot.date,
        station_id,
        batch_id,
        start: handoff.start,
        duration_minutes: plan.duration_minutes,
        prescription_version: plan.prescription_version,
        borrowed: true,
        origin_facility_id: original.facility_id,
        continues_session_id: original.session_id,
        handoff_id: handoff.handoff_id,
      },
    });
    return {
      applied: true,
      duplicate: false,
      handoff: { ...handoffs.get(handoff.handoff_id) },
      borrowed: { ...sessions.get(borrowed_id) },
      events: [e1.event, e2.event],
    };
  }

  /**
   * 登记实际治疗（含离线补录）。对账键为 plan_id@发生日期：
   * 同一计划同一发生日期只允许入账一次，重复补录绝不重记。
   */
  function recordTreatment(cmd) {
    if (!cmd.occurred_at) throw new DomainError("必须提供治疗发生时间 occurred_at", "COMMAND_INVALID");
    const session = cmd.session_id ? mustSession(cmd.session_id) : null;
    const plan_id = cmd.plan_id ?? session?.plan_id;
    if (!plan_id) throw new DomainError("缺少 plan_id", "COMMAND_INVALID");
    const plan = mustPlan(plan_id);
    const occurred_date = dateOf(cmd.occurred_at);
    const key = reconKeyOf(plan_id, occurred_date);
    const existing = treatments.get(key);
    if (existing) {
      return { applied: false, duplicate: true, treatment: existing, events: [], note: "同一发生日期已有透析记录，拒绝重复入账" };
    }
    if (session && session.status !== "RESERVED") {
      throw new DomainError(`场次状态 ${session.status} 不允许登记治疗`, "SESSION_NOT_TREATABLE");
    }
    const events = [];
    if (session) {
      events.push(
        emit({
          event_id: cmd.event_id,
          event_type: "TREATMENT_RECONCILED",
          aggregate_type: "dialysis_session",
          aggregate_id: session.session_id,
          occurred_at: cmd.occurred_at,
          summary: `登记透析治疗 ${session.session_id}`,
          payload: {
            session_id: session.session_id,
            plan_id,
            patient_id: plan.patient_id,
            facility_id: session.facility_id,
            occurred_date,
            offline: Boolean(cmd.offline),
            recorded_by: cmd.recorded_by ?? null,
          },
        }).event,
      );
      events.push(
        emit({
          event_type: "SESSION_CLOSED",
          aggregate_type: "dialysis_session",
          aggregate_id: session.session_id,
          occurred_at: cmd.occurred_at,
          summary: `场次结案：实际治疗 ${session.session_id}`,
          payload: { closure_reason: "TREATED", detail: cmd.detail ?? null },
        }).event,
      );
    } else {
      events.push(
        emit({
          event_id: cmd.event_id,
          event_type: "TREATMENT_RECONCILED",
          aggregate_type: "treatment_plan",
          aggregate_id: plan_id,
          occurred_at: cmd.occurred_at,
          summary: `离线补录透析治疗 ${plan_id} ${occurred_date}`,
          payload: {
            session_id: null,
            plan_id,
            patient_id: plan.patient_id,
            facility_id: cmd.facility_id ?? null,
            occurred_date,
            offline: cmd.offline ?? true,
            recorded_by: cmd.recorded_by ?? null,
          },
        }).event,
      );
    }
    return { applied: true, duplicate: false, treatment: treatments.get(key), events };
  }

  /** 非治疗结案：未到 / 途中风险 / 临时住院，分别结案。实际治疗须走 recordTreatment。 */
  function closeSession(cmd) {
    if (!CLOSURE_REASONS.includes(cmd.reason)) throw new DomainError(`未知结案原因：${cmd.reason}`, "COMMAND_INVALID");
    if (cmd.reason === "TREATED") throw new DomainError("实际治疗须通过 recordTreatment 结案", "COMMAND_INVALID");
    const session = mustSession(cmd.session_id);
    if (session.status === "CLOSED") return { applied: false, duplicate: true, session: { ...session }, events: [] };
    if (session.status !== "RESERVED" && session.status !== "LOCKED") {
      throw new DomainError(`场次状态 ${session.status} 不允许结案`, "SESSION_NOT_CLOSABLE");
    }
    const res = emit({
      event_id: cmd.event_id,
      event_type: "SESSION_CLOSED",
      aggregate_type: "dialysis_session",
      aggregate_id: session.session_id,
      occurred_at: cmd.occurred_at ?? now(),
      summary: `场次结案 ${session.session_id}：${cmd.reason}`,
      payload: { closure_reason: cmd.reason, detail: cmd.detail ?? null },
    });
    return { applied: res.applied, duplicate: res.duplicate, session: { ...sessions.get(session.session_id) }, events: [res.event] };
  }

  /**
   * 跨院结算：服务恢复后，借用名额、耗材与费用按对账窗口汇总。
   * 结算单号默认 SETTLE-{借方}-{贷方}-{起}-{止}，天然幂等，重复结算返回原单。
   */
  function settleCrossFacility(cmd) {
    const statement_id =
      cmd.statement_id ?? `SETTLE-${cmd.borrower_facility_id}-${cmd.lender_facility_id}-${cmd.since}-${cmd.until}`;
    const existing = settlements.get(statement_id);
    if (existing) return { applied: false, duplicate: true, statement: existing, events: [] };
    const lines = [...sessions.values()]
      .filter(
        (s) =>
          s.borrowed &&
          s.origin_facility_id === cmd.borrower_facility_id &&
          s.facility_id === cmd.lender_facility_id &&
          s.status === "CLOSED" &&
          s.closure_reason === "TREATED" &&
          s.treated_at &&
          dateOf(s.treated_at) >= cmd.since &&
          dateOf(s.treated_at) <= cmd.until,
      )
      .map((s) => {
        const slot = slots.get(s.slotKey);
        const slot_fee = slot?.tariff.slot_fee ?? 0;
        const consumable_fee = slot?.tariff.consumable_fee ?? 0;
        return {
          session_id: s.session_id,
          handoff_id: s.handoff_id,
          patient_id: s.patient_id,
          treated_at: s.treated_at,
          slot_fee,
          consumable: { batch_id: s.batch_id, fee: consumable_fee },
          line_total: slot_fee + consumable_fee,
        };
      });
    const totals = {
      sessions: lines.length,
      slot_fees: lines.reduce((sum, l) => sum + l.slot_fee, 0),
      consumable_fees: lines.reduce((sum, l) => sum + l.consumable.fee, 0),
      grand_total: lines.reduce((sum, l) => sum + l.line_total, 0),
    };
    const res = emit({
      event_id: cmd.event_id,
      event_type: "SETTLEMENT_RECORDED",
      aggregate_type: "settlement",
      aggregate_id: statement_id,
      occurred_at: cmd.occurred_at ?? now(),
      summary: `跨院结算 ${statement_id}：${totals.sessions} 场次，合计 ${totals.grand_total}`,
      payload: {
        borrower_facility_id: cmd.borrower_facility_id,
        lender_facility_id: cmd.lender_facility_id,
        window: { since: cmd.since, until: cmd.until },
        lines,
        totals,
      },
    });
    return { applied: res.applied, duplicate: res.duplicate, statement: settlements.get(statement_id), events: [res.event] };
  }

  // ---- 读模型 ----

  /** 患者通知：当前地点、交通风险与下一次安排。 */
  function patientNotice(patient_id, at) {
    const plan = [...plans.values()]
      .filter((p) => p.patient_id === patient_id)
      .sort((a, b) => (a.confirmed_at < b.confirmed_at ? 1 : -1))[0];
    if (!plan) throw new DomainError(`未登记患者 ${patient_id} 的治疗计划`, "PLAN_NOT_FOUND");
    const upcoming = [...sessions.values()]
      .filter((s) => s.plan_id === plan.plan_id && s.status === "RESERVED")
      .sort((a, b) => (a.slot_date + a.start < b.slot_date + b.start ? -1 : 1))[0];
    const lastTreatment = [...treatments.values()]
      .filter((t) => t.plan_id === plan.plan_id)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))
      .at(-1);
    const current_location = lastTreatment?.facility_id ?? plan.home_facility_id;
    let traffic_risk;
    if (upcoming && upcoming.facility_id !== current_location) {
      const road = roads.get(routeKeyOf(current_location, upcoming.facility_id));
      traffic_risk = {
        route: routeKeyOf(current_location, upcoming.facility_id),
        road_status: road?.status ?? "未知",
        advice: RISK_ADVICE[road?.status] ?? "路况未知，出发前联系值班调度",
      };
    } else {
      traffic_risk = { route: null, road_status: "院内", advice: "无需跨院转运" };
    }
    const next_arrangement = upcoming
      ? {
          status: "已预约",
          date: upcoming.slot_date,
          slot_id: upcoming.slot_id,
          start: upcoming.start,
          facility_id: upcoming.facility_id,
          station_id: upcoming.station_id,
        }
      : { status: "待安排", advice: "暂无已预约场次，请联系值班调度确认下一次治疗" };
    return { patient_id, generated_at: at ?? now(), current_location, traffic_risk, next_arrangement };
  }

  /** 值班缺口清单：任何时刻可列出尚未闭合的治疗缺口及其责任方。 */
  function openGaps(at) {
    const today = dateOf(at ?? now());
    const gaps = [];
    for (const plan of plans.values()) {
      for (const date of expectedDates(plan, today)) {
        if (treatments.has(reconKeyOf(plan.plan_id, date))) continue; // 已按发生时间对账
        const root = [...sessions.values()].find(
          (s) => s.plan_id === plan.plan_id && s.continues_session_id == null && s.slot_date === date,
        );
        if (!root) {
          gaps.push({
            plan_id: plan.plan_id,
            patient_id: plan.patient_id,
            date,
            status: "未排程",
            responsible: { type: "scheduling", id: "region-dispatch" },
            detail: "固定治疗未排程",
          });
          continue;
        }
        const head = chainHead(root);
        if (head.status === "CLOSED") continue; // 四类结案均已闭合
        if (head.status === "RESERVED" && head.slot_date > today) continue; // 未来已排程，无需动作
        gaps.push(gapOf(plan, date, head, today));
      }
      // 未来场次被锁定同样需要立即处置
      for (const s of sessions.values()) {
        if (s.plan_id === plan.plan_id && s.continues_session_id == null && s.status === "LOCKED" && s.slot_date > today) {
          gaps.push(gapOf(plan, s.slot_date, s, today));
        }
      }
    }
    return gaps.sort((a, b) => (a.date === b.date ? a.patient_id.localeCompare(b.patient_id) : a.date < b.date ? -1 : 1));
  }

  function expectedDates(plan, today) {
    const dates = [];
    let d = plan.start_date;
    for (let i = 0; i < 370 && d <= today; i += 1, d = addDays(d, 1)) {
      if (plan.cycle.weekdays.includes(weekdayOf(d))) dates.push(d);
    }
    return dates;
  }

  function chainHead(root) {
    let head = root;
    for (;;) {
      const next = [...sessions.values()].find((s) => s.continues_session_id === head.session_id);
      if (!next) return head;
      head = next;
    }
  }

  function gapOf(plan, date, head, today) {
    const base = { plan_id: plan.plan_id, patient_id: plan.patient_id, date };
    if (head.status === "RESERVED") {
      return {
        ...base,
        status: head.slot_date < today ? "逾期未治疗" : "待治疗",
        responsible: { type: "facility", id: head.facility_id },
        detail: `场次 ${head.slot_id}@${head.facility_id}`,
      };
    }
    if (head.status === "LOCKED") {
      const pending = [...handoffs.values()].find((h) => h.session_id === head.session_id && h.status === "PROPOSED");
      return pending
        ? {
            ...base,
            status: "转运待接收确认",
            responsible: { type: "facility", id: pending.to_facility_id },
            detail: `交接 ${pending.handoff_id} 待 ${pending.to_facility_id} 明确接收`,
          }
        : {
            ...base,
            status: "场次锁定待转运",
            responsible: { type: "facility", id: head.facility_id },
            detail: `场次 ${head.slot_id} 已锁定，尚未安排替代机构`,
          };
    }
    return { ...base, status: "转运中", responsible: { type: "facility", id: head.facility_id }, detail: `场次 ${head.session_id}` };
  }

  // ---- 只读访问器 ----

  const copy = (obj) => (obj ? { ...obj } : undefined);
  const planView = (planId) => copy(plans.get(planId));
  const session = (sessionId) => copy(sessions.get(sessionId));
  const handoff = (handoffId) => copy(handoffs.get(handoffId));
  const slotView = (facilityId, slotId) => {
    const slot = slots.get(slotKeyOf(facilityId, slotId));
    if (!slot) return undefined;
    return { ...slot, consumables: Object.fromEntries(slot.consumables) };
  };

  return {
    publish,
    confirmPlan,
    changeCapacity,
    updateRoadStatus,
    reserveSession,
    lockSlot,
    proposeTransfer,
    acceptTransfer,
    recordTreatment,
    closeSession,
    settleCrossFacility,
    patientNotice,
    openGaps,
    planView,
    session,
    handoff,
    slotView,
    treatments: () => [...treatments.values()].map((t) => ({ ...t })),
    events: () => store.all(),
  };
}
