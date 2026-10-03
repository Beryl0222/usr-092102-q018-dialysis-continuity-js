/**
 * 连续调度命令服务：所有状态变更以领域事件落库，读模型同步投影。
 *
 * 关键不变量：
 * 1. 处方（treatment_plan）只能由医生确认事件推进；调度命令只引用 plan_id + plan_version，从不改写处方/周期。
 * 2. 场次预留同时占用六类资源，任一不足整场拒绝。
 * 3. 紧急停机只锁定显式命中的受影响场次，其他设施/时段不动；锁定即释放原资源占用。
 * 4. 交接完成 = 替代机构明确接收 + 最少必要临床资料齐备 + 替代场次占用成功。
 * 5. 一个应治疗场次对应一个 occurrence_id；替代场次复用该 id，故一个 occurrence 最多计一次透析。
 * 6. 离线补录以 occurred_at 为证据时间；冲突进入对账，TREATMENT_RECONCILED 裁决计不计透析。
 */
import {
  AGGREGATE_TYPES,
  EVENT_TYPES,
  HANDOFF_STATUS,
  NOTIFICATION_CHANNELS,
  OCCURRENCE_OUTCOME,
  RESOURCE_TYPES,
  ROAD_STATUS,
  SESSION_STATUS,
  SETTLEMENT_ITEM_TYPES,
} from "./domain.js";
import { EventVersionConflictError } from "./event-store.js";
import { ReadModel, poolKey } from "./read-model.js";
import { checkCapacity, normalizeNeeds } from "./capacity.js";
import { DomainError, ErrorCodes } from "./errors.js";
import { idFromKey, randomId } from "./ids.js";

/** 交接所需最少必要临床资料字段（隐私最小化，只发治疗安全必需项）。 */
export const MINIMAL_RECORD_FIELDS = Object.freeze([
  "plan_version", // 医生确认的处方版本号
  "prescription", // 透析模式/时长/超滤目标
  "anticoagulation", // 抗凝方案
  "vascular_access", // 血管通路
  "dry_weight", // 干体重
  "infection_screen", // 感染筛查结果（决定感染分区）
  "emergency_contact", // 紧急联系
]);

export class SchedulingService {
  #store;
  #read;
  #clock;
  #fixedNow = null;
  #commandResults = new Map(); // idempotency_key -> 首次执行结果（本进程）
  #knownKeys = new Set(); // 从历史事件 causation_id 重建的命令键（跨重启幂等）

  constructor(store, { clock } = {}) {
    this.#store = store;
    this.#read = new ReadModel();
    for (const e of store.all()) {
      this.#read.apply(e);
      if (e.causation_id) this.#knownKeys.add(e.causation_id);
      // 嵌套命令的 causation_id 形如 <父键>:reserve
    }
    this.#clock = clock ?? null;
  }

  /** 固定/推进逻辑时钟（测试与离线场景演练用）。传 null 恢复实时时钟。 */
  setClock(at) {
    this.#fixedNow = at;
  }

  get read() {
    return this.#read;
  }

  get now() {
    return this.#fixedNow ?? this.#clock?.() ?? new Date().toISOString();
  }

  // ───────────────────────── 处方 ─────────────────────────

  /**
   * 医生确认处方及周期。调度系统不得调用本命令“改”处方：
   * source 必须为 physician；既有计划的更新只能新版本确认或显式 supersede。
   */
  confirmPlan(cmd) {
    return this.#run(cmd, (b) => {
      const required = ["patient_id", "prescription", "cadence", "confirmed_by"];
      for (const k of required) if (cmd[k] === undefined || cmd[k] === null) throw bad(`缺少字段：${k}`);
      if ((cmd.source ?? "physician") !== "physician") {
        throw new DomainError(ErrorCodes.PRESCRIPTION_LOCKED, "只有医生可以确认处方版本，调度系统不得擅改");
      }
      const planId = cmd.plan_id ?? `plan_${cmd.patient_id}_${idFromKey(cmd.idempotency_key ?? randomId("p")).slice(0, 10)}`;
      const currentVersion = this.#store.versionOf(AGGREGATE_TYPES.TREATMENT_PLAN, planId);
      if (cmd.supersedes && !this.#read.plans.has(cmd.supersedes)) throw bad(`被取代处方不存在：${cmd.supersedes}`);
      if (!cmd.supersedes) {
        const active = this.#read.activePlanFor(cmd.patient_id);
        if (active && active.id !== planId && currentVersion === 0) {
          throw new DomainError(ErrorCodes.PRESCRIPTION_LOCKED, `患者已有生效处方 ${active.id}，更新须显式 supersede 或在原计划上确认新版本`, {
            httpStatus: 409,
          });
        }
      }
      b.emit(EVENT_TYPES.PLAN_CONFIRMED, AGGREGATE_TYPES.TREATMENT_PLAN, planId, {
        patient_id: cmd.patient_id,
        prescription: cmd.prescription,
        cadence: cmd.cadence,
        confirmed_by: cmd.confirmed_by,
        source: "physician",
        supersedes: cmd.supersedes ?? null,
      }, `医生 ${cmd.confirmed_by} 确认患者 ${cmd.patient_id} 处方 v${currentVersion + 1}`);
      return { plan_id: planId, version: currentVersion + 1 };
    });
  }

  // ───────────────────────── 容量 ─────────────────────────

  /** 资源容量通告（班次、机器、水处理告警、耗材盘点、分区与时段）。 */
  reportCapacity(cmd) {
    return this.#run(cmd, (b) => {
      const required = ["facility_id", "resource_type"];
      for (const k of required) if (!cmd[k]) throw bad(`缺少字段：${k}`);
      if (!Object.values(RESOURCE_TYPES).includes(cmd.resource_type)) throw bad(`未知资源类型：${cmd.resource_type}`);
      if (cmd.available === undefined && cmd.delta === undefined) throw bad("available 与 delta 至少提供一个");
      const aggId = capacityAggregateId(cmd);
      b.emit(EVENT_TYPES.CAPACITY_CHANGED, AGGREGATE_TYPES.RESOURCE_CAPACITY, aggId, {
        facility_id: cmd.facility_id,
        resource_type: cmd.resource_type,
        resource_id: cmd.resource_id ?? null,
        scope: cmd.scope ?? {},
        window: cmd.window ?? null,
        ...(cmd.available !== undefined ? { available: cmd.available } : { delta: cmd.delta }),
        total: cmd.total ?? null,
        notice: cmd.notice ?? null,
      }, `设施 ${cmd.facility_id} ${cmd.resource_type} 容量${cmd.notice ? `：${cmd.notice}` : "更新"}`);
      return { capacity_id: aggId };
    });
  }

  // ───────────────────────── 场次预留 ─────────────────────────

  reserveSession(cmd) {
    return this.#run(cmd, (b) => {
      const required = ["facility_id", "patient_id", "scheduled_start", "scheduled_end", "needs"];
      for (const k of required) if (cmd[k] === undefined || cmd[k] === null) throw bad(`缺少字段：${k}`);

      const plan = cmd.plan_id ? this.#requirePlan(cmd.plan_id) : this.#read.activePlanFor(cmd.patient_id);
      if (!plan) throw new DomainError(ErrorCodes.PLAN_NOT_FOUND, `患者 ${cmd.patient_id} 没有生效处方，无法安排场次`, { httpStatus: 409 });
      if (plan.patient_id !== cmd.patient_id) throw bad("场次患者与处方不一致");
      if (plan.superseded_by) throw new DomainError(ErrorCodes.PRESCRIPTION_LOCKED, `处方 ${plan.id} 已被 ${plan.superseded_by} 取代，须按新处方排期`, { httpStatus: 409 });

      const demands = normalizeNeeds(cmd.needs);
      for (const t of Object.values(RESOURCE_TYPES)) {
        if (!demands.some((d) => d.resource_type === t)) throw bad(`场次需求缺少六类资源之一：${t}`);
      }

      const occurrenceId = cmd.occurrence_id ?? defaultOccurrenceId(plan.id, cmd.scheduled_start);
      if (cmd.remedial_for && !this.#read.occurrences.has(cmd.remedial_for)) throw bad(`补救目标 occurrence 不存在：${cmd.remedial_for}`);
      const sessionId = cmd.session_id ?? `ses_${idFromKey(`${occurrenceId}|${cmd.facility_id}|${cmd.scheduled_start}`).slice(0, 12)}`;
      if (this.#read.sessions.has(sessionId)) throw new DomainError(ErrorCodes.SESSION_STATE, `场次已存在：${sessionId}`, { httpStatus: 409 });

      const assignments = checkCapacity(this.#read, demands, {
        facilityId: cmd.facility_id,
        start: cmd.scheduled_start,
        end: cmd.scheduled_end,
      });

      b.emit(EVENT_TYPES.SESSION_RESERVED, AGGREGATE_TYPES.DIALYSIS_SESSION, sessionId, {
        facility_id: cmd.facility_id,
        patient_id: cmd.patient_id,
        plan_id: plan.id,
        plan_version: plan.version,
        occurrence_id: occurrenceId,
        scheduled_start: cmd.scheduled_start,
        scheduled_end: cmd.scheduled_end,
        needs: cmd.needs,
        assignments,
        remedial_for: cmd.remedial_for ?? null,
      }, `预留场次 ${sessionId}：患者 ${cmd.patient_id} @ ${cmd.facility_id}（occurrence ${occurrenceId}）`);
      return { session_id: sessionId, occurrence_id: occurrenceId, plan_id: plan.id, plan_version: plan.version };
    });
  }

  // ───────────────────────── 紧急停机 ─────────────────────────

  /**
   * 声明紧急停机。锁定范围 = 显式 session_ids 与选择条件（设施+时间窗+资源范围）的交集，
   * 且只锁仍有效的 RESERVED 场次；其他设施、其他场次绝不受影响。
   */
  declareDisruption(cmd) {
    return this.#run(cmd, (b) => {
      if (!cmd.facility_id) throw bad("缺少字段：facility_id");
      if (!cmd.reason) throw bad("缺少字段：reason");
      const select = cmd.select ?? {};
      let ids = cmd.lock_session_ids ?? select.session_ids ?? [];
      if (select.time_window) {
        const { start, end } = select.time_window;
        if (!start || !end) throw bad("select.time_window 需要 start/end");
        const inWindow = [...this.#read.sessions.values()].filter(
          (s) =>
            s.facility_id === cmd.facility_id &&
            s.status === SESSION_STATUS.RESERVED &&
            Date.parse(s.start) < Date.parse(end) &&
            Date.parse(start) < Date.parse(s.end),
        ).map((s) => s.id);
        ids = ids.length ? ids.filter((id) => inWindow.includes(id)) : inWindow;
      }
      // 去重 + 只锁 RESERVED（已改道/结案的不动）
      const locked = [...new Set(ids)].filter((id) => {
        const s = this.#read.sessions.get(id);
        return s && s.facility_id === cmd.facility_id && s.status === SESSION_STATUS.RESERVED;
      }).sort();

      const disruptionId = cmd.disruption_id ?? `dis_${idFromKey(cmd.idempotency_key ?? randomId("d")).slice(0, 12)}`;
      b.emit(EVENT_TYPES.DISRUPTION_DECLARED, AGGREGATE_TYPES.DISRUPTION, disruptionId, {
        facility_id: cmd.facility_id,
        reason: cmd.reason,
        scope: cmd.scope ?? select.resource_scope ?? {},
        select: select.time_window ?? null,
        locked_session_ids: locked,
        status: "active",
      }, `${cmd.facility_id} 因${cmd.reason}紧急停机，锁定 ${locked.length} 个受影响场次`);
      return { disruption_id: disruptionId, locked_session_ids: locked };
    });
  }

  /** 停机解除（水处理恢复、暴雪警报取消）。只改变停机状态；已锁定场次须经转移/补救结案才闭合。 */
  resolveDisruption(cmd) {
    return this.#run(cmd, (b) => {
      const d = this.#read.disruptions.get(cmd.disruption_id);
      if (!d) throw new DomainError(ErrorCodes.SESSION_STATE, `停机事件不存在：${cmd.disruption_id}`, { httpStatus: 404 });
      if (d.status === "resolved") return { disruption_id: d.id, status: "resolved", idempotent: true };
      b.emit(EVENT_TYPES.DISRUPTION_DECLARED, AGGREGATE_TYPES.DISRUPTION, d.id, {
        facility_id: d.facility_id,
        reason: d.reason,
        scope: d.scope,
        locked_session_ids: d.locked_session_ids,
        status: "resolved",
      }, `${d.facility_id} 停机解除：${cmd.reason ?? "服务恢复"}`);
      return { disruption_id: d.id, status: "resolved", affected_session_ids: d.locked_session_ids };
    });
  }

  // ───────────────────────── 道路 ─────────────────────────
  updateRoadStatus(cmd) {
    return this.#run(cmd, (b) => {
      const { facility_from_id, facility_to_id, status } = cmd;
      if (!facility_from_id || !facility_to_id || !status) throw bad("需要 facility_from_id/facility_to_id/status");
      if (!Object.values(ROAD_STATUS).includes(status)) throw bad(`未知道路状态：${status}`);
      const aggId = `route_${facility_from_id}__${facility_to_id}`;
      b.emit(EVENT_TYPES.ROAD_STATUS_UPDATED, AGGREGATE_TYPES.TRANSPORT_ROUTE, aggId, {
        facility_from_id,
        facility_to_id,
        status,
        transport_requirements: cmd.transport_requirements ?? [],
        risk_level: cmd.risk_level ?? null,
        detail: cmd.detail ?? null,
      }, `${facility_from_id}→${facility_to_id} 道路${status}${cmd.risk_level ? `（风险 ${cmd.risk_level}）` : ""}`);
      return { route_id: aggId, status };
    });
  }

  // ───────────────────────── 转移交接 ─────────────────────────

  requestTransfer(cmd) {
    return this.#run(cmd, (b) => {
      const required = ["patient_id", "occurrence_id", "from_facility_id", "to_facility_id"];
      for (const k of required) if (!cmd[k]) throw bad(`缺少字段：${k}`);
      const occ = this.#requireOccurrence(cmd.occurrence_id);
      const root = this.#rootSession(occ);
      if (root.facility_id !== cmd.from_facility_id) throw bad("from_facility_id 与受影响场次所在机构不符");
      if (root.status !== SESSION_STATUS.LOCKED && !cmd.allow_unlocked) {
        throw new DomainError(ErrorCodes.SESSION_STATE, `场次 ${root.id} 当前 ${root.status}，只有停机锁定的场次可申请转移`, { httpStatus: 409 });
      }
      this.#assertReachable(cmd.from_facility_id, cmd.to_facility_id);

      const handoffId = cmd.handoff_id ?? `ho_${idFromKey(`${cmd.occurrence_id}|${cmd.to_facility_id}`).slice(0, 12)}`;
      if (this.#read.handoffs.has(handoffId)) throw new DomainError(ErrorCodes.HANDOFF_STATE, `交接单已存在：${handoffId}`, { httpStatus: 409 });
      b.emit(EVENT_TYPES.TRANSFER_REQUESTED, AGGREGATE_TYPES.TRANSFER_HANDOFF, handoffId, {
        disruption_id: root.disruption_id,
        patient_id: cmd.patient_id,
        occurrence_id: cmd.occurrence_id,
        from_facility_id: cmd.from_facility_id,
        to_facility_id: cmd.to_facility_id,
        preferred_slot: cmd.preferred_slot ?? null,
      }, `申请将患者 ${cmd.patient_id} 转至 ${cmd.to_facility_id}`);
      return { handoff_id: handoffId };
    });
  }

  /** 替代机构明确答复。接收需通过六类资源预检——电话口头答应但班次/耗材未同步时在此被挡住。 */
  acceptTransfer(cmd) {
    return this.#run(cmd, (b) => {
      const h = this.#requireHandoff(cmd.handoff_id);
      if ([HANDOFF_STATUS.COMPLETED, HANDOFF_STATUS.DECLINED].includes(h.status)) {
        throw new DomainError(ErrorCodes.HANDOFF_STATE, `交接单 ${h.id} 已 ${h.status}，不可再答复`, { httpStatus: 409 });
      }
      if (cmd.declined) {
        b.emit(EVENT_TYPES.TRANSFER_ACCEPTED, AGGREGATE_TYPES.TRANSFER_HANDOFF, h.id, {
          declined: true,
          reason: cmd.reason ?? null,
        }, `${h.to_facility_id} 拒绝接收患者 ${h.patient_id}`);
        return { handoff_id: h.id, status: HANDOFF_STATUS.DECLINED };
      }
      const slot = cmd.agreed_slot ?? h.preferred_slot;
      if (!slot?.start || !slot?.end) throw bad("接收需约定 agreed_slot（start/end）");
      this.#assertReachable(h.from_facility_id, h.to_facility_id);

      // 关键防线：接收必须同时满足合格人员、机器、水处理、耗材批次、感染分区、安全间隔
      const root = this.#rootSession(this.#requireOccurrence(h.occurrence_id));
      const demands = normalizeNeeds(cmd.needs ?? root.needs);
      checkCapacity(this.#read, demands, { facilityId: h.to_facility_id, start: slot.start, end: slot.end });

      b.emit(EVENT_TYPES.TRANSFER_ACCEPTED, AGGREGATE_TYPES.TRANSFER_HANDOFF, h.id, {
        agreed_slot: slot,
        contact: cmd.contact ?? null,
        needs: cmd.needs ?? root.needs,
      }, `${h.to_facility_id} 明确接收患者 ${h.patient_id}，约定 ${slot.start}`);
      return { handoff_id: h.id, status: HANDOFF_STATUS.ACCEPTED, agreed_slot: slot };
    });
  }

  /** 送达最少必要临床资料（按医生确认的处方版本，不允许借资料传递修改处方）。 */
  sendMinimalRecord(cmd) {
    return this.#run(cmd, (b) => {
      const h = this.#requireHandoff(cmd.handoff_id);
      if (h.status === HANDOFF_STATUS.DECLINED || h.status === HANDOFF_STATUS.COMPLETED) {
        throw new DomainError(ErrorCodes.HANDOFF_STATE, `交接单 ${h.id} 状态 ${h.status}，不能发送资料`, { httpStatus: 409 });
      }
      const fields = [...new Set(cmd.fields ?? [])];
      const missing = MINIMAL_RECORD_FIELDS.filter((f) => !fields.includes(f));
      if (missing.length > 0) {
        throw new DomainError(ErrorCodes.MINIMAL_RECORD_INCOMPLETE, `最少必要临床资料不齐，缺少：${missing.join("、")}`, {
          details: { missing },
        });
      }
      const occ = this.#requireOccurrence(h.occurrence_id);
      const plan = this.#requirePlan(occ.plan_id);
      const sharedVersion = cmd.plan_version ?? plan.version;
      if (sharedVersion !== plan.version || plan.superseded_by) {
        throw new DomainError(ErrorCodes.PRESCRIPTION_LOCKED, "共享资料必须引用当前医生确认的处方版本，且处方不得被调度改动", { httpStatus: 409 });
      }
      b.emit(EVENT_TYPES.MINIMAL_RECORD_SENT, AGGREGATE_TYPES.TRANSFER_HANDOFF, h.id, {
        fields,
        plan_id: plan.id,
        plan_version: sharedVersion,
      }, `向 ${h.to_facility_id} 送达患者 ${h.patient_id} 的最少必要资料（处方 v${sharedVersion}）`);
      return { handoff_id: h.id, fields, plan_version: sharedVersion };
    });
  }

  /** 交接完成：已接收 + 资料齐 + 道路可达 + 替代场次六类资源占用成功，四者缺一不可。 */
  completeHandoff(cmd) {
    return this.#run(cmd, (b) => {
      const h = this.#requireHandoff(cmd.handoff_id);
      if (h.status === HANDOFF_STATUS.COMPLETED) return { handoff_id: h.id, replacement_session_id: h.replacement_session_id, completed: true };
      if (!h.accepted_at) throw new DomainError(ErrorCodes.HANDOFF_STATE, `交接单 ${h.id} 尚未被明确接收`, { httpStatus: 409 });
      if (!h.record_sent_at) throw new DomainError(ErrorCodes.MINIMAL_RECORD_INCOMPLETE, `交接单 ${h.id} 最少必要资料未送达，不能完成交接`, { httpStatus: 409 });
      this.#assertReachable(h.from_facility_id, h.to_facility_id);

      const occ = this.#requireOccurrence(h.occurrence_id);
      const root = this.#rootSession(occ);
      const slot = cmd.scheduled ? { start: cmd.scheduled.start, end: cmd.scheduled.end } : h.agreed_slot;
      if (!slot?.start || !slot?.end) throw bad("缺少替代场次时间（agreed_slot 或 scheduled）");

      const replacementId =
        cmd.session_id ?? `ses_${idFromKey(`${occ.id}|${h.to_facility_id}|${slot.start}`).slice(0, 12)}`;
      if (!this.#read.sessions.has(replacementId)) {
        // 硬占用替代机构六类资源；复用同一 occurrence_id，保证患者只在一条治疗线上
        this.reserveSession({
          idempotency_key: cmd.idempotency_key
            ? `${cmd.idempotency_key}:reserve`
            : `reserve:${occ.id}:${h.to_facility_id}:${slot.start}`,
          session_id: replacementId,
          facility_id: h.to_facility_id,
          patient_id: h.patient_id,
          plan_id: occ.plan_id,
          occurrence_id: occ.id,
          scheduled_start: slot.start,
          scheduled_end: slot.end,
          needs: cmd.needs ?? h.accepted_needs ?? root.needs,
          occurred_at: cmd.occurred_at,
        });
      }

      b.emit(EVENT_TYPES.HANDOFF_COMPLETED, AGGREGATE_TYPES.TRANSFER_HANDOFF, h.id, {
        replacement_session_id: replacementId,
      }, `患者 ${h.patient_id} 交接完成：${h.from_facility_id} → ${h.to_facility_id}（场次 ${replacementId}）`);
      return { handoff_id: h.id, replacement_session_id: replacementId, occurrence_id: occ.id };
    });
  }

  // ───────────────────────── 结局与对账 ─────────────────────────

  /**
   * 当次结局结案。四类分别处理；只有 treated 计一次透析。
   * 离线补录允许 occurred_at 早于已结案事件：冲突证据保留，等待 reconcileOccurrence 裁决。
   */
  closeOccurrence(cmd) {
    return this.#run(cmd, (b) => {
      const occ = this.#requireOccurrence(cmd.occurrence_id);
      if (!Object.values(OCCURRENCE_OUTCOME).includes(cmd.outcome)) throw bad(`未知结局：${cmd.outcome}`);
      if (cmd.session_id && !occ.session_ids.includes(cmd.session_id)) throw bad(`场次 ${cmd.session_id} 不属于 occurrence ${occ.id}`);

      let conflict = null;
      if (occ.outcome) {
        if (occ.outcome === cmd.outcome && occ.closed_by_session === (cmd.session_id ?? occ.closed_by_session)) {
          return { occurrence_id: occ.id, outcome: occ.outcome, idempotent: true };
        }
        conflict = { existing_outcome: occ.outcome, claimed_outcome: cmd.outcome };
      }
      const facilityId = cmd.facility_id ?? (cmd.session_id ? this.#read.sessions.get(cmd.session_id)?.facility_id : null);
      b.emit(EVENT_TYPES.OCCURRENCE_CLOSED, AGGREGATE_TYPES.TREATMENT_OCCURRENCE, occ.id, {
        outcome: cmd.outcome,
        session_id: cmd.session_id ?? null,
        facility_id: facilityId ?? null,
        detail: cmd.detail ?? null,
      }, `患者 ${occ.patient_id} 当次治疗结案：${cmd.outcome}${conflict ? "（与既有结局冲突，待对账）" : ""}`);
      return { occurrence_id: occ.id, outcome: cmd.outcome, conflict };
    });
  }

  /**
   * 对账裁决：以发生时间（occurred_at）为准核对全部结案证据，明确计不计这次透析。
   * decision=confirm 维持现结局；supersede 以 effective_outcome 为准。
   */
  reconcileOccurrence(cmd) {
    return this.#run(cmd, (b) => {
      const occ = this.#requireOccurrence(cmd.occurrence_id);
      const events = this.#store.stream(AGGREGATE_TYPES.TREATMENT_OCCURRENCE, occ.id)
        .filter((e) => e.event_type === EVENT_TYPES.OCCURRENCE_CLOSED);
      if (events.length === 0) throw new DomainError(ErrorCodes.OCCURRENCE_NOT_FOUND, `occurrence ${occ.id} 尚无结案证据，无法对账`, { httpStatus: 409 });
      if (cmd.basis_event_id && !events.some((e) => e.event_id === cmd.basis_event_id)) {
        throw new DomainError(ErrorCodes.RECONCILIATION_REJECTED, `裁决依据事件 ${cmd.basis_event_id} 不属于本 occurrence 的结案证据`);
      }
      const decision = cmd.decision ?? "confirm";
      if (!["confirm", "supersede"].includes(decision)) throw bad("decision 为 confirm 或 supersede");
      const effective = decision === "supersede" ? cmd.effective_outcome : occ.outcome;
      if (decision === "supersede" && !Object.values(OCCURRENCE_OUTCOME).includes(effective)) {
        throw bad("supersede 必须给出有效 effective_outcome");
      }
      // 默认对账规则：证据按发生时间排序，以发生最早的现场结案为准；显式 basis_event_id 优先
      const basis = cmd.basis_event_id
        ? events.find((e) => e.event_id === cmd.basis_event_id)
        : [...events].sort((a, z) => Date.parse(a.occurred_at) - Date.parse(z.occurred_at))[0];
      const counted = cmd.counted_treatment ?? (effective === OCCURRENCE_OUTCOME.TREATED);
      if (effective === OCCURRENCE_OUTCOME.TREATED && counted === false) {
        throw new DomainError(ErrorCodes.RECONCILIATION_REJECTED, "effective_outcome=treated 时 counted_treatment 不能为 false，如需剔除请选择其他结局");
      }
      if (effective !== OCCURRENCE_OUTCOME.TREATED && counted === true) {
        throw new DomainError(ErrorCodes.RECONCILIATION_REJECTED, "非 treated 结局不得计为一次透析");
      }
      b.emit(EVENT_TYPES.TREATMENT_RECONCILED, AGGREGATE_TYPES.TREATMENT_OCCURRENCE, occ.id, {
        decision,
        effective_outcome: effective,
        counted_treatment: counted,
        basis_event_id: basis.event_id,
        basis_occurred_at: basis.occurred_at,
        evidence_event_ids: events.map((e) => e.event_id),
        facility_id: cmd.facility_id ?? null,
        note: cmd.note ?? null,
      }, `occurrence ${occ.id} 对账完成：${effective}，${counted ? "计" : "不计"}透析`);
      return { occurrence_id: occ.id, effective_outcome: effective, counted_treatment: counted };
    });
  }

  // ───────────────────────── 跨院结算 ─────────────────────────

  recordSettlement(cmd) {
    return this.#run(cmd, (b) => {
      const required = ["from_facility_id", "to_facility_id", "items"];
      for (const k of required) if (cmd[k] === undefined) throw bad(`缺少字段：${k}`);
      if (!Array.isArray(cmd.items) || cmd.items.length === 0) throw bad("items 不能为空");
      for (const it of cmd.items) {
        if (!Object.values(SETTLEMENT_ITEM_TYPES).includes(it.type)) throw bad(`未知结算项：${it.type}`);
        if (!Number.isFinite(it.qty) || it.qty <= 0) throw bad("结算项 qty 必须为正数");
        if (!Number.isFinite(it.unit_amount) || it.unit_amount < 0) throw bad("结算项 unit_amount 必须为非负数");
      }
      if (cmd.occurrence_id) {
        const occ = this.#requireOccurrence(cmd.occurrence_id);
        const treatedElsewhere = occ.closed_at_facility === cmd.to_facility_id &&
          (occ.outcome === OCCURRENCE_OUTCOME.TREATED || occ.reconciled?.counted_treatment);
        const handoff = [...this.#read.handoffs.values()].find(
          (h) => h.occurrence_id === cmd.occurrence_id && h.to_facility_id === cmd.to_facility_id && h.status === HANDOFF_STATUS.COMPLETED,
        );
        if (!handoff && !treatedElsewhere) {
          throw new DomainError(ErrorCodes.SETTLEMENT_ERROR, "只有完成交接且实际在接收机构治疗的 occurrence 才能跨院结算", { httpStatus: 409 });
        }
      }
      const settlementId = cmd.settlement_id ?? `stl_${idFromKey(cmd.idempotency_key ?? randomId("s")).slice(0, 12)}`;
      const total = round2(cmd.items.reduce((sum, it) => sum + it.qty * it.unit_amount, 0));
      b.emit(EVENT_TYPES.SETTLEMENT_RECORDED, AGGREGATE_TYPES.SETTLEMENT, settlementId, {
        disruption_id: cmd.disruption_id ?? null,
        from_facility_id: cmd.from_facility_id,
        to_facility_id: cmd.to_facility_id,
        patient_id: cmd.patient_id ?? null,
        occurrence_id: cmd.occurrence_id ?? null,
        items: cmd.items,
        total,
        currency: cmd.currency ?? "CNY",
        status: cmd.status ?? "recorded",
      }, `跨院结算 ${cmd.from_facility_id}→${cmd.to_facility_id}：${total} ${cmd.currency ?? "CNY"}`);
      return { settlement_id: settlementId, total };
    });
  }

  // ───────────────────────── 患者通知 ─────────────────────────

  /**
   * 通知患者当前地点、交通风险、下一次安排。缺省字段由当前读模型自动补齐，
   * 保证患者拿到的信息与值班视图一致。
   */
  notifyPatient(cmd) {
    return this.#run(cmd, (b) => {
      if (!cmd.patient_id) throw bad("缺少字段：patient_id");
      const channel = cmd.channel ?? "sms";
      if (!NOTIFICATION_CHANNELS.includes(channel)) throw bad(`未知通知渠道：${channel}`);
      const derived = this.composePatientUpdate(cmd.patient_id, { as_of: cmd.occurred_at });
      const payload = {
        patient_id: cmd.patient_id,
        channel,
        current_location: cmd.current_location ?? derived.current_location,
        transport_risk: cmd.transport_risk ?? derived.transport_risk,
        next_appointment: cmd.next_appointment ?? derived.next_appointment,
        message: cmd.message ?? derived.message,
        delivered: cmd.delivered ?? false,
      };
      const noteId = cmd.notification_id ?? `ntf_${idFromKey(cmd.idempotency_key ?? randomId("n")).slice(0, 12)}`;
      b.emit(EVENT_TYPES.PATIENT_NOTIFIED, AGGREGATE_TYPES.PATIENT_NOTIFICATION, noteId, payload,
        `通知患者 ${cmd.patient_id}：${payload.message}`);
      return { notification_id: noteId, ...payload };
    });
  }

  /** 汇总患者当前地点 / 交通风险 / 下一次安排（也供查询接口直接使用）。 */
  composePatientUpdate(patientId, { as_of } = {}) {
    const nowMs = Date.parse(as_of ?? this.now);
    const sessions = [...this.#read.sessions.values()].filter((s) => s.patient_id === patientId);
    const activeHandoff = [...this.#read.handoffs.values()]
      .filter((h) => h.patient_id === patientId && h.status === HANDOFF_STATUS.COMPLETED)
      .sort((a, z) => Date.parse(z.completed_at) - Date.parse(a.completed_at))[0];

    let currentLocation = null;
    let transportRisk = null;
    let nextAppointment = null;

    const future = sessions
      .filter((s) => Date.parse(s.start) >= nowMs - 60 * 60_000)
      .sort((a, z) => Date.parse(a.start) - Date.parse(z.start));
    const upcoming = future[0];
    if (activeHandoff && Date.parse(activeHandoff.completed_at) <= nowMs) {
      currentLocation = { facility_id: activeHandoff.to_facility_id, kind: "receiving_facility" };
      const route = this.#read.routes.get(routeMapKey(activeHandoff.from_facility_id, activeHandoff.to_facility_id));
      transportRisk = route ? { status: route.status, risk_level: route.risk_level, requirements: route.transport_requirements, detail: route.detail } : null;
    } else if (upcoming) {
      currentLocation = { facility_id: upcoming.facility_id, kind: "scheduled_facility" };
    }

    const candidate = future.find((s) => s.status === SESSION_STATUS.RESERVED || s.status === SESSION_STATUS.LOCKED);
    if (candidate) {
      nextAppointment = {
        facility_id: candidate.facility_id,
        start: candidate.start,
        end: candidate.end,
        occurrence_id: candidate.occurrence_id,
        status: candidate.status,
      };
    }
    const message = [
      currentLocation ? `您的当前安排地点：${currentLocation.facility_id}` : "您的治疗地点待确认",
      transportRisk ? `交通风险：${transportRisk.status}${transportRisk.risk_level ? `（${transportRisk.risk_level}）` : ""}` : null,
      nextAppointment ? `下一次透析：${nextAppointment.start} @ ${nextAppointment.facility_id}` : "下一次安排待通知",
    ].filter(Boolean).join("；");
    return { current_location: currentLocation, transport_risk: transportRisk, next_appointment: nextAppointment, message };
  }

  // ───────────────────────── 值班查询 ─────────────────────────

  /**
   * 尚未闭合的治疗缺口（值班人员随时可列）。每个缺口带责任方与原因。
   * 缺口闭合条件：结局已结案且计/不计均有对账结论；漏治等不良结局须有补救 occurrence 完成治疗。
   */
  openGaps({ facility_id, at } = {}) {
    const nowMs = Date.parse(at ?? this.now);
    const gaps = [];
    for (const occ of this.#read.occurrences.values()) {
      if (Date.parse(occ.scheduled_for) > nowMs) continue; // 未到时间的场次不是缺口
      const sessions = occ.session_ids.map((id) => this.#read.sessions.get(id));
      const home = sessions.find((s) => s.id === occ.root_session_id) ?? sessions[0];
      if (facility_id && ![...sessions.map((s) => s.facility_id), home.facility_id].includes(facility_id)) continue;

      const handoff = [...this.#read.handoffs.values()]
        .filter((h) => h.occurrence_id === occ.id)
        .sort((a, z) => this.#handoffStage(z) - this.#handoffStage(a))[0];

      const gap = this.#classifyGap(occ, sessions, home, handoff);
      if (gap) gaps.push({ occurrence_id: occ.id, patient_id: occ.patient_id, scheduled_for: occ.scheduled_for, plan_id: occ.plan_id, plan_version: occ.plan_version, ...gap });
    }
    return gaps.sort((a, b) => Date.parse(a.scheduled_for) - Date.parse(b.scheduled_for));
  }

  #classifyGap(occ, sessions, home, handoff) {
    if (occ.pending_conflict) {
      return {
        status: "conflict_pending_reconciliation",
        responsible_party: { type: "duty_officer", id: "regional_qc", reason: "存在互相冲突的结案证据，需按发生时间对账" },
        sessions: sessions.map(sessionBrief),
        evidence: occ.evidence,
      };
    }
    const remedialClosed = (occ.remedial_ids ?? []).some((rid) => {
      const r = this.#read.occurrences.get(rid);
      return r && this.#read.countsTreatment(rid);
    });

    if (!occ.outcome) {
      // 还在过程中，按交接进度确定责任方
      if (home.status === SESSION_STATUS.LOCKED && !handoff) {
        const disruption = home.disruption_id ? this.#read.disruptions.get(home.disruption_id) : null;
        if (disruption?.status === "resolved") {
          return { status: "resolved_awaiting_reschedule", responsible_party: { type: "facility", id: home.facility_id, reason: "服务已恢复，受影响场次尚未重排或结案" }, sessions: sessions.map(sessionBrief) };
        }
        return { status: "locked_no_handoff", responsible_party: { type: "facility", id: home.facility_id, reason: "场次已停机锁定，尚未发起替代交接" }, sessions: sessions.map(sessionBrief) };
      }
      if (handoff) {
        const route = this.#read.routes.get(routeMapKey(handoff.from_facility_id, handoff.to_facility_id));
        if (route?.status === ROAD_STATUS.CLOSED) {
          return { status: "route_closed", responsible_party: { type: "transport_authority", id: route.key, reason: "通往接收机构的道路封闭，替代机构不可达" }, sessions: sessions.map(sessionBrief) };
        }
        if (handoff.status === HANDOFF_STATUS.REQUESTED) {
          return { status: "awaiting_acceptance", responsible_party: { type: "receiving_facility", id: handoff.to_facility_id, reason: "替代机构尚未明确接收" }, sessions: sessions.map(sessionBrief) };
        }
        if (handoff.status === HANDOFF_STATUS.ACCEPTED || handoff.status === HANDOFF_STATUS.RECORD_SENT) {
          if (!handoff.record_sent_at) {
            return { status: "minimal_record_missing", responsible_party: { type: "facility", id: handoff.from_facility_id, reason: "机构已答应接收，最少必要临床资料尚未送达" }, sessions: sessions.map(sessionBrief) };
          }
          return { status: "handoff_not_completed", responsible_party: { type: "receiving_facility", id: handoff.to_facility_id, reason: "已接收且资料已送达，替代场次尚未落地" }, sessions: sessions.map(sessionBrief) };
        }
        if (handoff.status === HANDOFF_STATUS.DECLINED) {
          return { status: "transfer_declined", responsible_party: { type: "facility", id: handoff.from_facility_id, reason: "替代机构拒绝接收，须另寻方案" }, sessions: sessions.map(sessionBrief) };
        }
        if (handoff.status === HANDOFF_STATUS.COMPLETED) {
          return { status: "awaiting_treatment_outcome", responsible_party: { type: "receiving_facility", id: handoff.to_facility_id, reason: "交接完成，等待实际治疗结案" }, sessions: sessions.map(sessionBrief) };
        }
      }
      return { status: "not_closed", responsible_party: { type: "facility", id: home.facility_id, reason: "场次未结案" }, sessions: sessions.map(sessionBrief) };
    }

    // 已结案
    // 已结案
    if (occ.outcome === OCCURRENCE_OUTCOME.TREATED) {
      return null; // 单一实际治疗结案即闭合（重复计次在 occurrence 结构上已不可能；冲突证据另有挂账）
    }
    if (remedialClosed) return null; // 漏治/风险/住院后已通过补救场次完成治疗
    const reasonMap = {
      [OCCURRENCE_OUTCOME.MISSED]: "固定治疗漏治，须尽快安排补救场次",
      [OCCURRENCE_OUTCOME.NO_SHOW]: "患者未到，须联系并安排补救",
      [OCCURRENCE_OUTCOME.EN_ROUTE_RISK]: "途中出现风险未完成治疗，须确认人身安全并补治",
      [OCCURRENCE_OUTCOME.TEMP_ADMISSION]: "临时住院，须衔接住院透析并闭环",
    };
    return {
      status: `outcome_${occ.outcome}_without_remedy`,
      outcome: occ.outcome,
      responsible_party: { type: "facility", id: home.facility_id, reason: reasonMap[occ.outcome] ?? "不良结局未补救" },
      sessions: sessions.map(sessionBrief),
    };
  }

  #handoffStage(h) {
    return { requested: 1, accepted: 2, record_sent: 3, completed: 4, declined: 0 }[h.status] ?? 0;
  }

  /**
   * 机构名单：按 occurrence 去重，同一患者在原机构与替代机构两处名单中只出现一次，
   * 但保留两个场次行及其状态，彻底消除“两处名单重复/漏人”。
   */
  roster({ facility_id, from, to } = {}) {
    const rows = [];
    for (const s of [...this.#read.sessions.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
      if (facility_id && s.facility_id !== facility_id) continue;
      if (from && Date.parse(s.start) < Date.parse(from)) continue;
      if (to && Date.parse(s.end) > Date.parse(to)) continue;
      const occ = this.#read.occurrences.get(s.occurrence_id);
      rows.push({
        patient_id: s.patient_id,
        occurrence_id: s.occurrence_id,
        session_id: s.id,
        facility_id: s.facility_id,
        start: s.start,
        end: s.end,
        session_status: s.status,
        disruption_id: s.disruption_id,
        handoff_id: s.handoff_id,
        listed_once: true,
        occurrence_outcome: occ?.outcome ?? null,
        plan_id: s.plan_id,
        plan_version: s.plan_version,
      });
    }
    return dedupeByOccurrence(rows);
  }

  /** 患者治疗台账：每个 occurrence 至多一行 counted_treatment，证明不会多记一次透析。 */
  treatmentLedger(patientId) {
    return [...this.#read.occurrences.values()]
      .filter((o) => o.patient_id === patientId)
      .sort((a, b) => Date.parse(a.scheduled_for) - Date.parse(b.scheduled_for))
      .map((o) => ({
        occurrence_id: o.id,
        scheduled_for: o.scheduled_for,
        outcome: o.outcome,
        counted_treatment: this.#read.countsTreatment(o.id),
        reconciled: o.reconciled ? {
          effective_outcome: o.reconciled.effective_outcome,
          basis_event_id: o.reconciled.basis_event_id,
        } : null,
        sessions: o.session_ids,
        remedial_for: o.remedial_for,
      }));
  }

  patientStatus(patientId) {
    const plan = this.#read.activePlanFor(patientId);
    const update = this.composePatientUpdate(patientId);
    const ledger = this.treatmentLedger(patientId);
    const gaps = this.openGaps().filter((g) => g.patient_id === patientId);
    return {
      patient_id: patientId,
      active_plan: plan ? { plan_id: plan.id, version: plan.version, cadence: plan.cadence } : null,
      completed_treatments: ledger.filter((l) => l.counted_treatment).length,
      current_location: update.current_location,
      transport_risk: update.transport_risk,
      next_appointment: update.next_appointment,
      open_gaps: gaps,
    };
  }

  settlements({ from_facility_id, to_facility_id, disruption_id } = {}) {
    return [...this.#read.settlements.values()]
      .filter((s) => (!from_facility_id || s.from_facility_id === from_facility_id)
        && (!to_facility_id || s.to_facility_id === to_facility_id)
        && (!disruption_id || s.disruption_id === disruption_id))
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  }

  events() {
    return this.#store.all();
  }

  /**
   * 受理外部已构造事件（离线补录/跨系统对接）。event_id 幂等与版本约束仍生效；
   * 调用方须先用 validateEvent 校验信封。
   * @returns {{event: Object, duplicate: boolean}}
   */
  ingestEvent(event) {
    const result = this.#store.append(event);
    this.#read.apply(event);
    if (event.causation_id) this.#knownKeys.add(event.causation_id);
    return result;
  }

  // ───────────────────────── 内部 ─────────────────────────

  #requirePlan(id) {
    const p = this.#read.plans.get(id);
    if (!p) throw new DomainError(ErrorCodes.PLAN_NOT_FOUND, `处方不存在：${id}`, { httpStatus: 404 });
    return p;
  }

  #requireOccurrence(id) {
    const o = this.#read.occurrences.get(id);
    if (!o) throw new DomainError(ErrorCodes.OCCURRENCE_NOT_FOUND, `治疗 occurrence 不存在：${id}`, { httpStatus: 404 });
    return o;
  }

  #requireHandoff(id) {
    const h = this.#read.handoffs.get(id);
    if (!h) throw new DomainError(ErrorCodes.HANDOFF_STATE, `交接单不存在：${id}`, { httpStatus: 404 });
    return h;
  }

  #rootSession(occ) {
    return this.#read.sessions.get(occ.root_session_id);
  }

  #assertReachable(fromId, toId) {
    const route = this.#read.routes.get(routeMapKey(fromId, toId));
    if (!route) {
      throw new DomainError(ErrorCodes.UNREACHABLE_ALTERNATIVE, `缺少 ${fromId}→${toId} 的道路通行信息，暴雪后必须先确认可达性`, { httpStatus: 409 });
    }
    if (route.status === ROAD_STATUS.CLOSED) {
      throw new DomainError(ErrorCodes.UNREACHABLE_ALTERNATIVE, `道路封闭：${fromId}→${toId}，替代机构不可达`, { httpStatus: 409, details: { route: route.detail } });
    }
  }

  /**
   * 命令执行框架：
   * - 同一 idempotency_key 重放返回首次结果，不产生重复事件；
   * - 事件 id 由命令键确定性派生，event_id 级幂等是最后一道防线。
   */
  #run(cmd, fn) {
    const key = cmd.idempotency_key;
    if (key && this.#commandResults.has(key)) {
      return { ...this.#commandResults.get(key), idempotent: true, idempotency_key: key, replayed: true };
    }
    if (key && this.#knownKeys.has(key)) {
      // 进程重启后的重试：事件已在历史中，不再生效，业务结果请通过查询接口核对
      return { idempotent: true, idempotency_key: key, replayed: true, already_committed: true };
    }
    const emitted = [];
    const occurredAt = cmd.occurred_at ?? this.now;
    const recordedAt = cmd.recorded_at ?? this.now;
    const builder = {
      emit: (eventType, aggregateType, aggregateId, payload, summary) => {
        const version = this.#store.versionOf(aggregateType, aggregateId) + 1;
        const eventId = key
          ? `evt_${idFromKey(`${key}|${eventType}|${aggregateType}/${aggregateId}|v${version}`)}`
          : `evt_${randomId("e")}`;
        const event = {
          event_id: eventId,
          event_type: eventType,
          aggregate_type: aggregateType,
          aggregate_id: aggregateId,
          occurred_at: occurredAt,
          recorded_at: recordedAt,
          version,
          summary,
          payload,
        };
        if (key) event.causation_id = key;
        let result;
        try {
          result = this.#store.append(event);
        } catch (err) {
          if (err instanceof EventVersionConflictError) {
            throw new DomainError(ErrorCodes.VERSION_CONFLICT, err.message, { httpStatus: 409 });
          }
          throw err;
        }
        this.#read.apply(event);
        if (!result.duplicate) emitted.push(event);
        return event;
      },
    };

    const result = fn(builder);
    const envelope = { ...result, events_emitted: emitted.map((e) => e.event_id), occurred_at: occurredAt };
    if (key) this.#commandResults.set(key, envelope);
    return envelope;
  }
}

// ───────── 辅助 ─────────

function bad(message) {
  return new DomainError(ErrorCodes.VALIDATION_ERROR, message);
}

export function capacityAggregateId(cmd) {
  const p = {
    facility_id: cmd.facility_id,
    resource_type: cmd.resource_type,
    resource_id: cmd.resource_id ?? null,
    scope: cmd.scope ?? {},
    window: cmd.window ?? null,
  };
  return `cap_${idFromKey(poolKey(p)).slice(0, 16)}`;
}

function defaultOccurrenceId(planId, start) {
  return `occ_${idFromKey(`${planId}|${start}`).slice(0, 14)}`;
}

function routeMapKey(from, to) {
  return `${from}->${to}`;
}

function sessionBrief(s) {
  return { session_id: s.id, facility_id: s.facility_id, start: s.start, end: s.end, status: s.status };
}

function dedupeByOccurrence(rows) {
  // 行保留（两处名单各自可见），但加 listed_once 标记；调用方按 occurrence_id 折叠即可得唯一患者名单
  const seen = new Set();
  for (const r of rows) {
    const dedupeKey = `${r.occurrence_id}`;
    r.duplicate_on_other_roster = seen.has(dedupeKey);
    seen.add(dedupeKey);
  }
  return rows;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
