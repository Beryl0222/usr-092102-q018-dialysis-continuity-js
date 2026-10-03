# 高原透析连续调度

本仓库保存高原透析连续调度的领域词汇、事件约定与连续调度后端，便于各参与方在后续开发中统一对象身份和版本语义。中断（暴雪、设备告警等）处置从患者连续性倒推资源：先保住固定治疗的闭环，再倒排人员、机位、水、耗材与转运。

## 目录

- `contracts/domain.schema.json`：领域事件信封及稳定枚举。
- `data/sample.json`：一条可用于联调的中文业务样例。
- `src/domain.js`：事件类型、聚合类型、结案原因、路况、最少必要临床资料等领域常量。
- `src/validator.js`：事件基础字段校验。
- `src/event-store.js`：追加式事件存储（幂等与版本约束的执行点）。
- `src/continuity-service.js`：连续调度后端（命令 + 事件投影 + 读模型）。
- `tests/`：契约一致性检查与暴雪中断场景测试。

## 事件目录与幂等约定

事件信封字段见 `contracts/domain.schema.json`。约定如下：

- **`event_id` 是幂等键**：同一 `event_id` 重复投递不得重复改变系统状态，接收方返回首次处理结果。`EventStore.append` 与所有命令（预约、交接、结案、补录、结算）都遵守该约定。
- **`version` 在同一聚合内从 1 开始严格递增**，乱序或跳号拒绝写入，用于乐观并发与顺序重放。
- **`occurred_at` 是业务发生时间**（须携带发生地时区偏移）。离线补录一律以发生时间对账，而不是以入库时间对账。

已登记事件：

| 事件 | 聚合 | 含义 |
| --- | --- | --- |
| `PLAN_CONFIRMED` | `treatment_plan` | 医生确认处方版本与周期（唯一合法变更入口） |
| `CAPACITY_CHANGED` | `resource_capacity` | 容量场次登记/调整（首次全量，之后补丁语义） |
| `SESSION_RESERVED` | `dialysis_session` | 预约场次（含借用场次 `borrowed=true`） |
| `SESSION_LOCKED` | `dialysis_session` | 紧急停机锁定受影响场次 |
| `SESSION_CLOSED` | `dialysis_session` | 场次结案（四类原因之一） |
| `TRANSFER_PROPOSED` | `transfer_handoff` | 发起转运（已过可达性评估） |
| `TRANSFER_ACCEPTED` | `transfer_handoff` | 接收方明确接收并取得最少必要临床资料，交接完成 |
| `TREATMENT_RECONCILED` | `dialysis_session` / `treatment_plan` | 实际治疗入账（含离线补录） |
| `ROUTE_STATUS_CHANGED` | `route_status` | 道路通行状态变化 |
| `SETTLEMENT_RECORDED` | `settlement` | 跨院结算单入账 |

## 连续调度后端（`src/continuity-service.js`）

### 命令

- `confirmPlan`：医生确认处方。**处方版本与周期只能经此变更**；调度类命令不改动处方，预约若沿用旧版本会被拒绝。
- `changeCapacity`：登记/调整容量场次。场次同时登记合格人员、透析机位（含感染分区）、水处理能力、耗材批次与安全间隔（`turnover_minutes`）。
- `updateRoadStatus`：路况更新（`OPEN` / `RESTRICTED` / `CLOSED`）。
- `reserveSession`：预约场次。**六类资源同时占用**，任一维度不满足即整体拒绝；天然幂等键 `SES-{plan_id}-{slot_id}`。
- `lockSlot`：紧急停机，**只锁定受影响场次**内的在约 session。
- `proposeTransfer`：发起转运。暴雪后的道路通行状态与转运条件决定替代机构是否真正可达：`CLOSED` 不可达，`RESTRICTED` 须护送转运。
- `acceptTransfer`：接收方**明确接收并取得最少必要临床资料后才算交接完成**；资料中的处方版本须与医生确认一致。接收成功即在接收方占用借用场次，原场次转为 `TRANSFERRED`，原耗材回库。
- `recordTreatment`：登记实际治疗（含离线补录）。**对账键为 `plan_id@发生日期`，同一发生日期绝不重记一次透析**。
- `closeSession`：非治疗结案。四类结案分别进行：`TREATED`（实际治疗，只能经 `recordTreatment`）、`NO_SHOW`（未到）、`EN_ROUTE_RISK`（途中风险）、`TEMP_ADMISSION`（临时住院）。结案即终态，重复结案幂等。
- `settleCrossFacility`：服务恢复后，借用名额、耗材与费用回到跨院结算。结算单号 `SETTLE-{借方}-{贷方}-{起}-{止}` 天然幂等；未治疗的借用场次不计费。

### 读模型

- `patientNotice(patient_id, at)`：患者收到**当前地点、交通风险与下一次安排**。
- `openGaps(at)`：值班人员在任何时刻列出**尚未闭合的治疗缺口及其责任方**：
  - `未排程` → 责任方：区域调度（`scheduling`）；
  - `待治疗` / `逾期未治疗` → 责任方：场次所在机构；
  - `场次锁定待转运` → 责任方：转出机构；
  - `转运待接收确认` → 责任方：接收机构。
  
  已结案（含四类）与已按发生时间对账的缺口自动出单；患者在转出、转入两处名单间反复出现时，按 `plan_id@日期` 只算一个缺口。

## 本地检查

```bash
npm test
```
