/**
 * 六类资源容量分配：合格人员、透析机、水处理、耗材批次、感染分区、安全间隔。
 * 场次预留时六类必须同时满足；任一类不足则整场拒绝（不能只占一部分）。
 *
 * 容量口径：CAPACITY_CHANGED 通告的是净可用容量（已扣在院患者），
 * 因此预留新场次时需要再扣除时间重叠场次的需求。
 */
import { RESOURCE_TYPES } from "./domain.js";
import { DomainError, ErrorCodes } from "./errors.js";

/**
 * 把场次需求归一为资源条目。
 * @returns {Array<{resource_type:string, scope:Object, qty:number}>}
 */
export function normalizeNeeds(needs = {}) {
  const out = [];
  const push = (resource_type, scope, qty = 1) => {
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) throw new DomainError(ErrorCodes.VALIDATION_ERROR, `${resource_type} 数量必须为正数`);
    out.push({ resource_type, scope: scope ?? {}, qty: q });
  };

  if (needs.personnel) {
    const n = needs.personnel;
    const entries = Array.isArray(n) ? n : [n];
    for (const e of entries) push(RESOURCE_TYPES.PERSONNEL, { qualification: e.qualification, shift: e.shift }, e.qty ?? 1);
  }
  if (needs.machine) {
    const n = needs.machine;
    const entries = Array.isArray(n) ? n : [n];
    for (const e of entries) push(RESOURCE_TYPES.MACHINE, { modality: e.modality }, e.qty ?? 1);
  }
  if (needs.water) {
    const n = typeof needs.water === "object" ? needs.water : {};
    push(RESOURCE_TYPES.WATER, { system: n.system }, n.amount ?? n.qty ?? 1);
  }
  if (needs.consumable) {
    const lines = needs.consumable.lines ?? (Array.isArray(needs.consumable) ? needs.consumable : [needs.consumable]);
    for (const line of lines) {
      push(
        RESOURCE_TYPES.CONSUMABLE,
        { code: line.code, ...(line.batch ? { batch: line.batch } : {}) },
        line.qty ?? 1,
      );
    }
  }
  if (needs.infection_zone) {
    const n = needs.infection_zone;
    push(RESOURCE_TYPES.INFECTION_ZONE, { zone_level: n.zone_level ?? "standard" }, n.qty ?? 1);
  }
  if (needs.safety_interval) {
    const n = needs.safety_interval;
    const minutes = Number(n.minutes ?? 30);
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new DomainError(ErrorCodes.VALIDATION_ERROR, "safety_interval.minutes 必须是非负数");
    }
    const scope = { zone_level: n.zone_level ?? needs.infection_zone?.zone_level ?? "standard", minutes };
    if (n.station_id) scope.station_id = n.station_id; // 指定机位时施加同机位硬间隔
    push(RESOURCE_TYPES.SAFETY_INTERVAL, scope, n.qty ?? 1);
  }
  return out;
}

function scopeSatisfies(poolScope, needScope) {
  return Object.entries(needScope).every(([k, v]) => v === undefined || poolScope[k] === v);
}

function poolCoversWindow(pool, start, end) {
  if (!pool.window) return true;
  return Date.parse(pool.window.start) <= Date.parse(start) && Date.parse(end) <= Date.parse(pool.window.end);
}

function poolUsableAt(pool, at) {
  const expiry = pool.scope?.expires_at;
  if (expiry && Date.parse(at) > Date.parse(expiry)) return false;
  return true;
}

/**
 * 校验一场次的六类需求在给定时间窗内是否可满足。
 * @param {import("./read-model.js").ReadModel} read
 * @param {Array} demands normalizeNeeds() 结果
 * @param {Object} ctx
 */
export function checkCapacity(read, demands, ctx) {
  const { facilityId, start, end, excludeSessionId = null } = ctx;
  const deficits = [];
  const assignments = {};

  for (const d of demands) {
    // minutes/station_id 是约束参数，不参与容量池匹配
    const matchScope = { ...d.scope };
    delete matchScope.minutes;
    delete matchScope.station_id;
    // 同设施、同类型、时间窗覆盖、范围匹配、未过期
    const candidates = [...read.capacityPools.values()].filter(
      (pool) =>
        pool.facility_id === facilityId &&
        pool.resource_type === d.resource_type &&
        poolCoversWindow(pool, start, end) &&
        poolUsableAt(pool, start) &&
        scopeSatisfies(pool.scope ?? {}, matchScope),
    );
    candidates.sort((a, b) => Date.parse(b.updated_at ?? 0) - Date.parse(a.updated_at ?? 0));

    // 时间重叠场次对同一容量池的已承诺占用
    const overlapping = read.overlappingSessions(facilityId, start, end, excludeSessionId);
    let remaining = d.qty;
    const chosen = [];
    for (const pool of candidates) {
      if (remaining <= 0) break;
      const committed = overlapping.reduce((sum, s) => {
        for (const dd of normalizeNeeds(s.needs)) {
          const ddMatch = { ...dd.scope };
          delete ddMatch.minutes;
          delete ddMatch.station_id;
          if (
            dd.resource_type === d.resource_type &&
            scopeSatisfies(pool.scope ?? {}, ddMatch) &&
            poolCoversWindow(pool, s.start, s.end)
          ) {
            return sum + dd.qty;
          }
        }
        return sum;
      }, 0);
      const free = pool.available - committed;
      if (free <= 0) continue;
      const take = Math.min(free, remaining);
      chosen.push({ pool: pool.key, qty: take, resource_id: pool.resource_id });
      remaining -= take;
    }

    if (remaining > 0.0001) {
      deficits.push({ resource_type: d.resource_type, scope: d.scope, shortfall: round4(remaining) });
    } else {
      assignments[d.resource_type] = assignments[d.resource_type] ?? [];
      assignments[d.resource_type].push(...chosen);
    }
  }

  // 安全间隔的硬时间约束仅在指定机位时生效：同一机位连续两场必须间隔足够（消杀/周转）；
  // 不同机位的平行场次互不冲突，其周转能力由 safety_interval 容量池约束。
  const interval = demands.find((d) => d.resource_type === RESOURCE_TYPES.SAFETY_INTERVAL);
  if (interval && interval.scope.station_id) {
    const requiredMinutes = Number(interval.scope.minutes ?? 30);
    const zone = interval.scope.zone_level;
    const stationId = interval.scope.station_id;
    const neighbors = read.overlappingSessions(
      facilityId,
      addMinutes(start, -requiredMinutes),
      addMinutes(end, requiredMinutes),
      excludeSessionId,
    );
    for (const s of neighbors) {
      const sInterval = s.needs?.safety_interval;
      if (sInterval?.station_id !== stationId) continue;
      if ((s.needs?.infection_zone?.zone_level ?? "standard") !== zone) continue;
      const gap = Math.min(Date.parse(start) - Date.parse(s.end), Date.parse(s.start) - Date.parse(end));
      if (gap < requiredMinutes * 60_000) {
        deficits.push({
          resource_type: RESOURCE_TYPES.SAFETY_INTERVAL,
          scope: { zone_level: zone, station_id: stationId },
          shortfall: 1,
          reason: `机位 ${stationId} 与场次 ${s.id} 间隔不足 ${requiredMinutes} 分钟`,
        });
      }
    }
  }

  if (deficits.length > 0) {
    throw new DomainError(
      ErrorCodes.RESOURCE_SHORTFALL,
      `设施 ${facilityId} 在 ${start} ~ ${end} 存在资源缺口`,
      { details: { deficits } },
    );
  }
  return assignments;
}

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
