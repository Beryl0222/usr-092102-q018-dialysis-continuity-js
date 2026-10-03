import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore } from "../src/event-store.js";
import { SchedulingService } from "../src/scheduling-service.js";
import { createApp } from "../src/server.js";
import { publishCapacity, standardNeeds } from "./helpers.js";

async function startServer(store) {
  const app = createApp({ store });
  await new Promise((resolve) => app.listen(0, resolve));
  const port = app.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { app, base };
}

async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function seedWorld(store) {
  const svc = new SchedulingService(store);
  svc.setClock("2026-10-02T08:00:00+08:00");
  publishCapacity(svc, "cap", "COUNTY", { personnel: 2 });
  svc.confirmPlan({ idempotency_key: "plan-P1", patient_id: "P1", confirmed_by: "DR1", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
  svc.reserveSession({
    idempotency_key: "res-1", facility_id: "COUNTY", patient_id: "P1", plan_id: svc.read.activePlanFor("P1").id,
    scheduled_start: "2026-10-03T09:00:00+08:00", scheduled_end: "2026-10-03T13:00:00+08:00", needs: standardNeeds(),
  });
  return svc;
}

test("HTTP：写命令必须带幂等键，重复提交返回 idempotent 且事件不增加", async () => {
  const { app, base } = await startServer(new EventStore());
  try {
    const noKey = await api(base, "POST", "/api/plans/confirm", { patient_id: "P9", confirmed_by: "DR", prescription: {}, cadence: {} });
    assert.equal(noKey.status, 400);

    const cmd = { idempotency_key: "http-1", patient_id: "P9", confirmed_by: "DR", prescription: { modality: "hd" }, cadence: { per_week: 3 } };
    const r1 = await api(base, "POST", "/api/plans/confirm", cmd);
    assert.equal(r1.status, 201);
    const r2 = await api(base, "POST", "/api/plans/confirm", cmd);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.replayed, true);
    assert.equal(r2.json.plan_id, r1.json.plan_id);
    const events = await api(base, "GET", "/api/events");
    assert.equal(events.json.events.length, 1);
  } finally {
    app.close();
  }
});

test("HTTP：值班缺口、机构名单、患者状态查询可用", async () => {
  const store = new EventStore();
  await seedWorld(store);
  const { app, base } = await startServer(store);
  try {
    // 停机制造缺口
    await api(base, "POST", "/api/disruptions/declare", {
      idempotency_key: "dis", facility_id: "COUNTY", reason: "水处理告警",
      select: { time_window: { start: "2026-10-03T00:00:00+08:00", end: "2026-10-03T23:59:59+08:00" } },
    });
    const gaps = await api(base, "GET", "/api/gaps?at=2026-10-03T10:00:00%2B08:00");
    assert.equal(gaps.status, 200);
    assert.equal(gaps.json.gaps.length, 1);
    assert.equal(gaps.json.gaps[0].status, "locked_no_handoff");
    assert.equal(gaps.json.gaps[0].responsible_party.id, "COUNTY");

    const roster = await api(base, "GET", "/api/roster?facility_id=COUNTY");
    assert.equal(roster.json.rows.length, 1);

    const patient = await api(base, "GET", "/api/patients/P1/status");
    assert.equal(patient.json.active_plan.version, 1);
    assert.equal(patient.json.open_gaps.length, 1);
  } finally {
    app.close();
  }
});

test("HTTP：直接提交领域事件受 event_id 幂等约束，重复提交 duplicate=true", async () => {
  const { app, base } = await startServer(new EventStore());
  try {
    const event = {
      event_id: "direct-001", event_type: "CAPACITY_CHANGED", aggregate_type: "resource_capacity", aggregate_id: "cap-x",
      occurred_at: "2026-10-02T08:00:00+08:00", version: 1, summary: "直连事件",
      payload: { facility_id: "F", resource_type: "machine", available: 1 },
    };
    const r1 = await api(base, "POST", "/api/events", event);
    assert.equal(r1.status, 201);
    const r2 = await api(base, "POST", "/api/events", event);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.duplicate, true);
  } finally {
    app.close();
  }
});

test("持久化：JSONL 事件日志重启后读模型与幂等键全部恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dialysis-"));
  const file = join(dir, "eventlog.jsonl");
  try {
    const store1 = new EventStore({ file });
    await seedWorld(store1);
    assert.ok((await readFile(file, "utf8")).trim().length > 0);

    // 新进程：同库文件重建
    const store2 = new EventStore({ file });
    const svc2 = new SchedulingService(store2);
    assert.equal(svc2.read.activePlanFor("P1").patient_id, "P1");
    assert.equal(svc2.read.sessions.size, 1);

    // 用历史幂等键重试：不再产生事件
    const before = store2.size;
    const replay = svc2.confirmPlan({ idempotency_key: "plan-P1", patient_id: "P1", confirmed_by: "DR1", prescription: { modality: "hd" }, cadence: { per_week: 3 } });
    assert.equal(replay.already_committed, true);
    assert.equal(store2.size, before);

    // 版本约束仍然连续：新事件使用下一版本
    svc2.confirmPlan({ idempotency_key: "plan-P1-v2", patient_id: "P1", confirmed_by: "DR1", plan_id: svc2.read.activePlanFor("P1").id, prescription: { modality: "hd", duration_min: 220 }, cadence: { per_week: 3 } });
    assert.equal(svc2.read.activePlanFor("P1").version, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
