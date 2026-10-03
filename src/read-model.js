/**
 * 读模型投影：按事件受理顺序重放，维护调度所需的全部事实视图。
 * 涉及治疗计数的口径以 occurrence 为单位（一个应治疗场次 = 一个 occurrence），
 * 替代场次复用同一 occurrence_id，因此原机构与替代机构不可能各记一次透析。
 */
import {
  AGGREGATE_TYPES,
  EVENT_TYPES,
  HANDOFF_STATUS,
  OCCURRENCE_OUTCOME,
  SESSION_STATUS,
  TREATMENT_COUNTING_OUTCOMES,
} from "./domain.js";

export class ReadModel {
  constructor() {
    /** @type {Map<string, PlanView>} */
    this.plans = new Map();
    /** @type {Map<string, CapacityPoolView>} 键见 poolKey() */
    this.capacityPools = new Map();
    /** @type {Map<string, SessionView>} */
    this.sessions = new Map();
    /** @type {Map<string, DisruptionView>} */
    this.disruptions = new Map();
    /** @type {Map<string, RouteView>} */
    this.routes = new Map();
    /** @type {Map<string, HandoffView>} */
    this.handoffs = new Map();
    /** @type {Map<string, OccurrenceView>} */
    this.occurrences = new Map();
    /** @type {Map<string, SettlementView>} */
    this.settlements = new Map();
    /** @type {Map<string, NotificationView>} */
    this.notifications = new Map();
    /** 患者 -> 处方/场次索引，便于倒推连续性 */
    this.patientPlans = new Map(); // patient_id -> plan_id[]
    this.patientSessions = new Map(); // patient_id -> session_id[]
  }

  apply(event) {
    switch (event.event_type) {
      case EVENT_TYPES.PLAN_CONFIRMED:
        this.#onPlanConfirmed(event);
        break;
      case EVENT_TYPES.CAPACITY_CHANGED:
        this.#onCapacityChanged(event);
        break;
      case EVENT_TYPES.SESSION_RESERVED:
        this.#onSessionReserved(event);
        break;
      case EVENT_TYPES.DISRUPTION_DECLARED:
        this.#onDisruptionDeclared(event);
        break;
      case EVENT_TYPES.ROAD_STATUS_UPDATED:
        this.#onRoadUpdated(event);
        break;
      case EVENT_TYPES.TRANSFER_REQUESTED:
        this.#onTransferRequested(event);
        break;
      case EVENT_TYPES.TRANSFER_ACCEPTED:
        this.#onTransferAccepted(event);
        break;
      case EVENT_TYPES.MINIMAL_RECORD_SENT:
        this.#onMinimalRecordSent(event);
        break;
      case EVENT_TYPES.HANDOFF_COMPLETED:
        this.#onHandoffCompleted(event);
        break;
      case EVENT_TYPES.OCCURRENCE_CLOSED:
        this.#onOccurrenceClosed(event);
        break;
      case EVENT_TYPES.TREATMENT_RECONCILED:
        this.#onReconciled(event);
        break;
      case EVENT_TYPES.SETTLEMENT_RECORDED:
        this.#onSettlement(event);
        break;
      case EVENT_TYPES.PATIENT_NOTIFIED:
        this.#onNotified(event);
        break;
      default:
        // 未知事件不影响已知投影
        break;
    }
  }

  #onPlanConfirmed(e) {
    const p = e.payload ?? {};
    /** @type {PlanView} */
    const view = {
      id: e.aggregate_id,
      patient_id: p.patient_id,
      version: e.version,
      prescription: p.prescription ?? {},
      cadence: p.cadence ?? {},
      confirmed_by: p.confirmed_by,
      source: p.source ?? "physician",
      occurred_at: e.occurred_at,
      supersedes: p.supersedes ?? null,
    };
    this.plans.set(e.aggregate_id, view);
    if (p.supersedes) {
      const old = this.plans.get(p.supersedes);
      if (old) old.superseded_by = e.aggregate_id;
    }
    if (!this.patientPlans.has(p.patient_id)) this.patientPlans.set(p.patient_id, []);
    const list = this.patientPlans.get(p.patient_id);
    if (!list.includes(e.aggregate_id)) list.push(e.aggregate_id);
  }

  #onCapacityChanged(e) {
    const p = e.payload ?? {};
    const key = poolKey(p);
    const existing = this.capacityPools.get(key);
    /** @type {CapacityPoolView} */
    const pool = existing ?? {
      key,
      facility_id: p.facility_id,
      resource_type: p.resource_type,
      resource_id: p.resource_id ?? null,
      scope: p.scope ? { ...p.scope } : {},
      window: p.window ? { ...p.window } : null,
      available: 0,
      total: null,
      changes: [],
    };
    // 允许绝对值通告（班次/盘点/告警）与增减量（出入库）
    pool.available = typeof p.available === "number" ? p.available : pool.available + (p.delta ?? 0);
    pool.total = typeof p.total === "number" ? p.total : pool.total;
    pool.updated_at = e.occurred_at;
    pool.notice = p.notice ?? pool.notice;
    pool.changes.push({ event_id: e.event_id, occurred_at: e.occurred_at, available: pool.available });
    this.capacityPools.set(key, pool);
  }

  #onSessionReserved(e) {
    const p = e.payload ?? {};
    /** @type {SessionView} */
    const session = {
      id: e.aggregate_id,
      facility_id: p.facility_id,
      patient_id: p.patient_id,
      plan_id: p.plan_id,
      plan_version: p.plan_version,
      occurrence_id: p.occurrence_id,
      start: p.scheduled_start,
      end: p.scheduled_end,
      needs: p.needs ?? {},
      assignments: p.assignments ?? {},
      status: SESSION_STATUS.RESERVED,
      disruption_id: null,
      handoff_id: null,
      remedial_for: p.remedial_for ?? null,
      reserved_event: e.event_id,
      reserved_at: e.occurred_at,
    };
    this.sessions.set(session.id, session);
    this.#touchOccurrence(session, { reserved: true });
    if (!this.patientSessions.has(p.patient_id)) this.patientSessions.set(p.patient_id, []);
    this.patientSessions.get(p.patient_id).push(session.id);
  }

  #onDisruptionDeclared(e) {
    const p = e.payload ?? {};
    const prev = this.disruptions.get(e.aggregate_id);
    if (prev && p.status === "resolved") {
      // 停机解除：保留锁定记录，仅更新状态
      prev.status = "resolved";
      prev.resolved_at = e.occurred_at;
      prev.resolve_event_id = e.event_id;
      return;
    }
    /** @type {DisruptionView} */
    this.disruptions.set(e.aggregate_id, {
      id: e.aggregate_id,
      facility_id: p.facility_id,
      reason: p.reason,
      scope: p.scope ?? {},
      declared_at: e.occurred_at,
      locked_session_ids: [...(p.locked_session_ids ?? [])],
      status: p.status ?? "active",
    });
    for (const sid of p.locked_session_ids ?? []) {
      const s = this.sessions.get(sid);
      if (s) {
        s.status = SESSION_STATUS.LOCKED;
        s.disruption_id = e.aggregate_id;
      }
    }
  }

  #onRoadUpdated(e) {
    const p = e.payload ?? {};
    const key = routeKey(p.facility_from_id, p.facility_to_id);
    const prev = this.routes.get(key);
    this.routes.set(key, {
      key,
      facility_from_id: p.facility_from_id,
      facility_to_id: p.facility_to_id,
      status: p.status,
      transport_requirements: p.transport_requirements ?? [],
      risk_level: p.risk_level ?? null,
      detail: p.detail ?? null,
      occurred_at: e.occurred_at,
      previous_status: prev?.status ?? null,
    });
  }

  #onTransferRequested(e) {
    const p = e.payload ?? {};
    this.handoffs.set(e.aggregate_id, {
      id: e.aggregate_id,
      disruption_id: p.disruption_id ?? null,
      patient_id: p.patient_id,
      occurrence_id: p.occurrence_id,
      from_facility_id: p.from_facility_id,
      to_facility_id: p.to_facility_id,
      preferred_slot: p.preferred_slot ?? null,
      status: HANDOFF_STATUS.REQUESTED,
      requested_at: e.occurred_at,
      accepted_at: null,
      record_sent_at: null,
      record_event_id: null,
      completed_at: null,
      replacement_session_id: null,
      decline_reason: null,
    });
  }

  #onTransferAccepted(e) {
    const h = this.#requireHandoff(e);
    const p = e.payload ?? {};
    if (p.declined) {
      h.status = HANDOFF_STATUS.DECLINED;
      h.decline_reason = p.reason ?? null;
    } else {
      h.status = h.status === HANDOFF_STATUS.COMPLETED ? h.status : HANDOFF_STATUS.ACCEPTED;
      h.accepted_at = e.occurred_at;
      h.agreed_slot = p.agreed_slot ?? h.agreed_slot ?? null;
      h.accepted_needs = p.needs ?? h.accepted_needs ?? null;
      h.contact = p.contact ?? h.contact ?? null;
    }
  }

  #onMinimalRecordSent(e) {
    const h = this.#requireHandoff(e);
    const p = e.payload ?? {};
    h.record_sent_at = e.occurred_at;
    h.record_event_id = e.event_id;
    h.sent_fields = p.fields ?? [];
    h.plan_version_shared = p.plan_version ?? h.plan_version_shared ?? null;
    if (h.status === HANDOFF_STATUS.ACCEPTED) h.status = HANDOFF_STATUS.RECORD_SENT;
  }

  #onHandoffCompleted(e) {
    const h = this.#requireHandoff(e);
    const p = e.payload ?? {};
    h.status = HANDOFF_STATUS.COMPLETED;
    h.completed_at = e.occurred_at;
    h.replacement_session_id = p.replacement_session_id ?? h.replacement_session_id;
    const replacement = h.replacement_session_id;
    // 原机构的受影响场次改道；替代场次保持 RESERVED 直至实际治疗结案
    for (const sid of this.#rootSessionIds(h)) {
      const rs = this.sessions.get(sid);
      if (rs && rs.id !== replacement) {
        rs.status = SESSION_STATUS.REROUTED;
        rs.handoff_id = h.id;
      }
    }
  }

  #rootSessionIds(h) {
    return [...this.sessions.values()]
      .filter((s) => s.occurrence_id === h.occurrence_id && s.facility_id === h.from_facility_id)
      .map((s) => s.id);
  }

  #onOccurrenceClosed(e) {
    const p = e.payload ?? {};
    const occ = this.occurrences.get(e.aggregate_id);
    if (!occ) return; // 保留来自没有预留路径的兜底（正常流程先有场次）
    // 终态结案只记一次；冲突证据进入 evidence，等待 TREATMENT_RECONCILED 裁决
    if (occ.outcome) {
      occ.evidence.push({
        event_id: e.event_id,
        occurred_at: e.occurred_at,
        recorded_at: e.recorded_at ?? e.occurred_at,
        outcome: p.outcome,
        session_id: p.session_id,
        facility_id: p.facility_id,
        late: true,
        detail: p.detail ?? null,
      });
      occ.pending_conflict = true;
      return;
    }
    occ.outcome = p.outcome;
    occ.closed_at = e.occurred_at;
    occ.close_recorded_at = e.recorded_at ?? e.occurred_at;
    occ.close_event_id = e.event_id;
    occ.closed_by_session = p.session_id;
    occ.closed_at_facility = p.facility_id;
    occ.close_detail = p.detail ?? null;
    for (const sid of occ.session_ids) {
      const s = this.sessions.get(sid);
      if (s && s.status !== SESSION_STATUS.CLOSED) s.status = SESSION_STATUS.CLOSED;
    }
  }

  #onReconciled(e) {
    const p = e.payload ?? {};
    const occ = this.occurrences.get(e.aggregate_id);
    if (!occ) return;
    occ.reconciled = {
      at: e.occurred_at,
      event_id: e.event_id,
      counted_treatment: p.counted_treatment,
      basis_event_id: p.basis_event_id ?? null,
      decision: p.decision ?? "confirm", // confirm | supersede
      effective_outcome: p.effective_outcome ?? occ.outcome,
      note: p.note ?? null,
    };
    occ.pending_conflict = false;
    if (p.decision === "supersede" && p.effective_outcome) {
      occ.outcome = p.effective_outcome;
      occ.closed_at_facility = p.facility_id ?? occ.closed_at_facility;
    }
    occ.reconciliations.push(occ.reconciled);
  }

  #onSettlement(e) {
    const p = e.payload ?? {};
    /** @type {SettlementView} */
    this.settlements.set(e.aggregate_id, {
      id: e.aggregate_id,
      disruption_id: p.disruption_id ?? null,
      from_facility_id: p.from_facility_id,
      to_facility_id: p.to_facility_id,
      patient_id: p.patient_id ?? null,
      occurrence_id: p.occurrence_id ?? null,
      items: p.items ?? [],
      currency: p.currency ?? "CNY",
      status: p.status ?? "recorded",
      occurred_at: e.occurred_at,
    });
  }

  #onNotified(e) {
    const p = e.payload ?? {};
    this.notifications.set(e.aggregate_id, {
      id: e.aggregate_id,
      patient_id: p.patient_id,
      channel: p.channel,
      current_location: p.current_location ?? null,
      transport_risk: p.transport_risk ?? null,
      next_appointment: p.next_appointment ?? null,
      message: p.message ?? "",
      occurred_at: e.occurred_at,
      delivered: p.delivered ?? false,
    });
  }

  #requireHandoff(e) {
    const h = this.handoffs.get(e.aggregate_id);
    if (!h) throw new Error(`交接单不存在：${e.aggregate_id}（事件 ${e.event_id}）`);
    return h;
  }

  /** 场次预留时登记/复用 occurrence 视图。 */
  #touchOccurrence(session) {
    let occ = this.occurrences.get(session.occurrence_id);
    if (!occ) {
      occ = {
        id: session.occurrence_id,
        patient_id: session.patient_id,
        plan_id: session.plan_id,
        plan_version: session.plan_version,
        scheduled_for: session.start,
        scheduled_end: session.end,
        root_session_id: session.id,
        remedial_for: session.remedial_for ?? null,
        session_ids: [],
        outcome: null,
        closed_at: null,
        close_event_id: null,
        closed_by_session: null,
        closed_at_facility: null,
        evidence: [],
        reconciled: null,
        reconciliations: [],
        pending_conflict: false,
      };
      this.occurrences.set(occ.id, occ);
      if (occ.remedial_for) {
        const root = this.occurrences.get(occ.remedial_for);
        if (root) root.remedial_ids = [...(root.remedial_ids ?? []), occ.id];
      }
    }
    if (!occ.session_ids.includes(session.id)) occ.session_ids.push(session.id);
    return occ;
  }

  sessionsByIds(ids) {
    return ids.map((id) => this.sessions.get(id)).filter(Boolean);
  }

  /** 同设施时间重叠且仍在占用资源的场次（LOCKED 已停机释放、REROUTED 已改道、CLOSED 已结案）。 */
  overlappingSessions(facilityId, start, end, excludeSessionId = null) {
    return [...this.sessions.values()].filter(
      (s) =>
        s.facility_id === facilityId &&
        s.id !== excludeSessionId &&
        s.status === SESSION_STATUS.RESERVED &&
        timeOverlaps(s.start, s.end, start, end),
    );
  }

  /** 患者当前有效处方（版本最高的医生确认件）。 */
  activePlanFor(patientId) {
    const ids = this.patientPlans.get(patientId) ?? [];
    const plans = ids.map((id) => this.plans.get(id)).filter((p) => p && !p.superseded_by);
    plans.sort((a, b) => b.version - a.version || Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
    return plans[0] ?? null;
  }

  /** 该 occurrence 是否应计入一次已完成透析（对账裁决优先）。 */
  countsTreatment(occId) {
    const occ = this.occurrences.get(occId);
    if (!occ) return false;
    if (occ.reconciled) return occ.reconciled.counted_treatment === true;
    return TREATMENT_COUNTING_OUTCOMES.has(occ.outcome);
  }
}

/** 容量池稳定键：设施 + 资源类型 + 单元 + 适用范围 + 时段。 */
export function poolKey(p) {
  const scope = p.scope ? JSON.stringify(normalizeObject(p.scope)) : "";
  const w = p.window ? `${p.window.start}|${p.window.end}` : "anytime";
  return [p.facility_id, p.resource_type, p.resource_id ?? "_pool_", scope, w].join("|");
}

function routeKey(from, to) {
  return `${from}->${to}`;
}

function normalizeObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function timeOverlaps(aStart, aEnd, bStart, bEnd) {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

/**
 * @typedef {Object} PlanView
 * @property {string} id
 * @property {string} patient_id
 * @property {number} version
 * @property {Object} prescription 医生确认的处方内容（透析模式、时长、抗凝、干体重等）
 * @property {Object} cadence 周期（每周次数、星期/班次）
 * @property {string} confirmed_by
 * @property {string} source
 * @property {string} occurred_at
 * @property {string|null} supersedes
 * @property {string} [superseded_by]
 *
 * @typedef {Object} CapacityPoolView
 * @property {string} key
 * @property {string} facility_id
 * @property {string} resource_type
 * @property {string|null} resource_id
 * @property {Object} scope qualification / zone_level / consumable_code / expires_at 等
 * @property {{start:string,end:string}|null} window
 * @property {number} available
 * @property {number|null} total
 * @property {Array} changes
 *
 * @typedef {Object} SessionView
 * @property {string} id
 * @property {string} facility_id
 * @property {string} patient_id
 * @property {string} plan_id
 * @property {number} plan_version
 * @property {string} occurrence_id
 * @property {string} start
 * @property {string} end
 * @property {Object} needs
 * @property {Object} assignments
 * @property {string} status
 * @property {string|null} disruption_id
 * @property {string|null} handoff_id
 *
 * @typedef {Object} OccurrenceView
 * @property {string} id
 * @property {string} patient_id
 * @property {string} plan_id
 * @property {number} plan_version
 * @property {string} scheduled_for
 * @property {string} root_session_id
 * @property {string[]} session_ids
 * @property {string|null} outcome
 * @property {Array} evidence
 * @property {Object|null} reconciled
 * @property {Array} reconciliations
 * @property {boolean} pending_conflict
 *
 * @typedef {Object} HandoffView
 * @property {string} id
 * @property {string} patient_id
 * @property {string} occurrence_id
 * @property {string} from_facility_id
 * @property {string} to_facility_id
 * @property {string} status
 * @property {string|null} accepted_at
 * @property {string|null} record_sent_at
 * @property {string|null} completed_at
 * @property {string|null} replacement_session_id
 */
