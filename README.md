# 高原透析连续调度

事件溯源的透析治疗连续性调度后端。设计目标来自区域肾病质控中心对暴雪中断事故的整改要求：
**从患者连续性倒推资源**，而不是让资源台账决定谁能被治上。

## 核心不变量

1. **处方不可被调度擅改**：治疗处方与周期只能由医生确认事件（`PLAN_CONFIRMED`，`source=physician`）推进；调度命令只引用 `plan_id + plan_version`。旧版本被 supersede 后不能再排期。
2. **一场次同时占用六类资源**：合格人员、透析机、水处理能力、耗材批次、感染分区、安全间隔。任一类不足整场拒绝，不产生半占用。
3. **紧急停机只锁受影响场次**：按设施 + 时间窗（可附资源范围）选定，只锁 `reserved` 场次；其他机构、其他时段不动。锁定即释放原机构资源占用。
4. **道路可达是硬前置**：暴雪后的道路通行状态（open / restricted / closed）与转运条件决定替代机构是否真正可达；封路时转移申请与交接完成都会被拒绝。
5. **交接完成三条件齐备**：替代机构明确接收（`TRANSFER_ACCEPTED`，接收时做六类资源预检，电话口头答应但护士班次/耗材未同步会被挡下）＋最少必要临床资料送达（`MINIMAL_RECORD_SENT`）＋替代场次硬占用成功（`HANDOFF_COMPLETED`）。
6. **一个应治疗场次 = 一个 occurrence**：替代场次复用同一 `occurrence_id`，患者在原机构与替代机构的名单里是同一条治疗线，结构上不可能各记一次透析。
7. **四类结局分别结案**：`treated`（实际治疗，唯一计次）、`no_show`（未到）、`en_route_risk`（途中风险）、`temp_admission`（临时住院），另有 `missed`（漏治）。不良结局在补救 occurrence 完成治疗前始终是开放缺口。
8. **离线补录按发生时间对账**：结案证据以 `occurred_at`（发生时间）为准，`recorded_at` 只是受理时间；互相冲突的结案不覆盖，进入 `conflict_pending_reconciliation`，由 `TREATMENT_RECONCILED` 裁决计不计次。
9. **恢复后回归结算与通知**：借用名额、耗材、费用生成跨院结算（只有完成交接且实际在接收机构治疗才可结算）；患者收到当前地点、交通风险、下一次安排；值班视图随时列出未闭合缺口及其责任方。

## 事件目录（`contracts/domain.schema.json`）

| 事件 | 聚合 | 含义 |
| --- | --- | --- |
| `PLAN_CONFIRMED` | treatment_plan | 医生确认处方版本与周期（可 supersede 旧版） |
| `CAPACITY_CHANGED` | resource_capacity | 六类资源容量/班次/盘点/告警（支持绝对值与增减量、时间窗、批次有效期） |
| `SESSION_RESERVED` | dialysis_session | 场次预留，六类资源同时占用 |
| `DISRUPTION_DECLARED` | disruption | 紧急停机声明 / 解除（status=resolved） |
| `ROAD_STATUS_UPDATED` | transport_route | 道路通行与转运条件 |
| `TRANSFER_REQUESTED` / `TRANSFER_ACCEPTED` / `MINIMAL_RECORD_SENT` / `HANDOFF_COMPLETED` | transfer_handoff | 转移交接状态机 |
| `OCCURRENCE_CLOSED` | treatment_occurrence | 当次结局结案（四类） |
| `TREATMENT_RECONCILED` | treatment_occurrence | 按发生时间对账裁决 |
| `SETTLEMENT_RECORDED` | settlement | 跨院结算：borrowed_slot / consumable / fee |
| `PATIENT_NOTIFIED` | patient_notification | 当前地点、交通风险、下一次安排 |

### 幂等约定（不可破坏）

- `event_id` 是全局幂等键：同一 id 只受理一次，重复提交返回首次事件（`duplicate=true`）。
- `version` 是聚合内自 1 起严格递增的整数。
- 命令接口使用 `idempotency_key`；事件 id 由命令键确定性派生，事件 `causation_id` 回溯到命令。重试返回 `replayed=true`，不产生新事件；进程重启后从历史事件重建幂等索引。

## 目录

- `contracts/domain.schema.json` — 事件信封、事件与聚合枚举、幂等语义。
- `src/domain.js` — 枚举：资源六类、道路状态、场次/交接状态、四类结局、结算项、最少资料字段。
- `src/event-store.js` — 幂等事件存储（内存 + 可选 JSONL 持久化，版本约束）。
- `src/read-model.js` — 投影：处方、容量池、场次、occurrence、交接、道路、结算、通知。
- `src/capacity.js` — 六类资源归一化与容量预检（时间窗、资质匹配、批次有效期、同机位安全间隔）。
- `src/scheduling-service.js` — 命令服务（全部业务规则）与值班查询。
- `src/server.js` — 零依赖 HTTP 后端。
- `tests/` — 37 个测试：事件库/契约、容量六类、处方锁定、暴雪端到端、HTTP、重启持久化、跨切面不变量。

## 运行

```bash
npm test          # 37 个测试
npm start         # HTTP 服务，默认 :8080，事件日志 data/eventlog.jsonl
PORT=9000 npm start
```

## HTTP 接口

写接口为 `POST /api/<command>`，body 必带 `idempotency_key`（或 `X-Idempotency-Key` 头）；命令可带 `occurred_at`（离线补录按发生时间）。

| 命令路径 | 服务方法 |
| --- | --- |
| `/api/plans/confirm` | 医生确认处方 |
| `/api/capacity/report` | 容量通告 |
| `/api/sessions/reserve` | 场次预留 |
| `/api/disruptions/declare`、`/api/disruptions/resolve` | 停机 / 解除 |
| `/api/roads/update` | 道路状态 |
| `/api/transfers/request`、`/accept`、`/send-record`、`/complete` | 交接四步 |
| `/api/occurrences/close`、`/reconcile` | 结局结案 / 对账 |
| `/api/settlements/record` | 跨院结算 |
| `/api/patients/notify` | 患者通知 |

读接口：`GET /api/gaps?at=...&facility_id=...`（未闭合缺口+责任方）、`/api/roster?facility_id=...`（机构名单，按 occurrence 可折叠）、
`/api/patients/:id/status`（当前地点/交通风险/下一次安排/台账）、`/api/settlements`、`/api/events`、`/api/health`。
`POST /api/events` 接受已构造的领域事件（先过信封校验，event_id 幂等仍生效），供离线补录与跨系统对接。

### 最小流程示例

```bash
# 医生确认处方
curl -sX POST localhost:8080/api/plans/confirm -H 'content-type: application/json' -d '{
  "idempotency_key":"plan-1","patient_id":"P1","confirmed_by":"DR7",
  "prescription":{"modality":"hd","duration_min":240},
  "cadence":{"per_week":3,"days":["Mon","Wed","Fri"]}}'

# 六类容量（人员/机器/水/耗材×N/感染分区/安全间隔）
curl -sX POST localhost:8080/api/capacity/report -H 'content-type: application/json' -d '{
  "idempotency_key":"cap-nurse","facility_id":"COUNTY","resource_type":"personnel",
  "scope":{"qualification":"dialysis_nurse","shift":"morning"},
  "window":{"start":"2026-10-03T00:00:00+08:00","end":"2026-10-03T23:59:59+08:00"},
  "available":3}'

# 值班视图：任何时刻列出未闭合治疗缺口与责任方
curl -s 'localhost:8080/api/gaps?at=2026-10-03T10:00:00%2B08:00'
```

场次 `needs` 结构（六类缺一即拒绝）：

```json
{
  "personnel": { "qualification": "dialysis_nurse", "shift": "morning", "qty": 1 },
  "machine": { "modality": "hd", "qty": 1 },
  "water": { "system": "ro-main", "amount": 1 },
  "consumable": { "lines": [ { "code": "dialyzer", "qty": 1 } ] },
  "infection_zone": { "zone_level": "standard", "qty": 1 },
  "safety_interval": { "zone_level": "standard", "minutes": 30, "station_id": "station-1", "qty": 1 }
}
```

## 暴雪场景的系统行为（见 `tests/blizzard-scenario.test.js`）

水处理告警 → 只锁定次日县医院场次；暴雪封路 → 转移被拒；除雪后 restricted 通行 → 可申请；
州医院电话答应但受训护士班次/耗材余量未同步 → 接收预检失败（缺口精确到资源类型）；
班次与盘点同步后接收成功 → 最少资料不齐不能交接 → 资料齐且替代场次占用成功才完成；
实际治疗 / 途中风险 / 未到 / 临时住院分别结案；县医院次日离线重复补录不覆盖现场结案，挂冲突账并按发生时间对账，全周期只计一次透析；
恢复后借用名额、耗材、费用进入跨院结算；患者收到地点、风险与下一次安排；值班缺口清单全程指向责任方，补救完成后才闭合。
