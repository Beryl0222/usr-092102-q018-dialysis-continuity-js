/**
 * HTTP 后端（node:http，零依赖）。
 *
 * 写接口：POST /api/<command>，body 中携带 idempotency_key（也可用 X-Idempotency-Key 头）。
 * 同一键重试返回 200 + idempotent/replayed，不重复产生事件。
 * 读接口：GET /api/gaps、/api/roster、/api/patients/:id、/api/settlements、/api/events。
 *
 * 事件存储默认 data/eventlog.jsonl（可用 DIALYSIS_EVENTLOG 覆盖），重启后读模型自动重放。
 */
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EventStore } from "./event-store.js";
import { SchedulingService } from "./scheduling-service.js";
import { DomainError } from "./errors.js";
import { validateEvent } from "./validator.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EVENTLOG = resolve(REPO_ROOT, "data/eventlog.jsonl");

const COMMANDS = {
  "plans/confirm": "confirmPlan",
  "capacity/report": "reportCapacity",
  "sessions/reserve": "reserveSession",
  "disruptions/declare": "declareDisruption",
  "disruptions/resolve": "resolveDisruption",
  "roads/update": "updateRoadStatus",
  "transfers/request": "requestTransfer",
  "transfers/accept": "acceptTransfer",
  "transfers/send-record": "sendMinimalRecord",
  "transfers/complete": "completeHandoff",
  "occurrences/close": "closeOccurrence",
  "occurrences/reconcile": "reconcileOccurrence",
  "settlements/record": "recordSettlement",
  "patients/notify": "notifyPatient",
};

export function createApp({ store, clock } = {}) {
  const eventStore = store ?? new EventStore({ file: process.env.DIALYSIS_EVENTLOG ? resolve(process.env.DIALYSIS_EVENTLOG) : DEFAULT_EVENTLOG });
  if (!store) {
    mkdirSync(dirname(eventStore.file), { recursive: true });
  }
  const svc = new SchedulingService(eventStore, { clock });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname.replace(/^\/+|\/+$/g, "");

      if (req.method === "GET" && path === "api/health") return send(res, 200, { ok: true, events: eventStore.size });
      if (req.method === "GET" && path === "api/gaps") {
        return send(res, 200, { gaps: svc.openGaps(Object.fromEntries(url.searchParams)) });
      }
      if (req.method === "GET" && path === "api/roster") {
        return send(res, 200, { rows: svc.roster(Object.fromEntries(url.searchParams)) });
      }
      if (req.method === "GET" && path === "api/settlements") {
        return send(res, 200, { settlements: svc.settlements(Object.fromEntries(url.searchParams)) });
      }
      if (req.method === "GET" && path === "api/events") {
        return send(res, 200, { events: svc.events() });
      }
      const patientMatch = path.match(/^api\/patients\/([^/]+)(?:\/(status))?$/);
      if (req.method === "GET" && patientMatch) {
        const [, patientId, sub] = patientMatch;
        return send(res, 200, sub === "status" ? svc.patientStatus(patientId) : { ledger: svc.treatmentLedger(patientId), ...svc.patientStatus(patientId) });
      }

      // 直接提交已构造的领域事件（受信封校验 + event_id 幂等约束，供离线补录/联调）
      if (req.method === "POST" && path === "api/events") {
        const body = await readJson(req);
        const errors = validateEvent(body);
        if (errors.length) throw new DomainError("VALIDATION_ERROR", errors.join("；"), { httpStatus: 422 });
        const { duplicate } = svc.ingestEvent(body);
        return send(res, duplicate ? 200 : 201, { event_id: body.event_id, duplicate });
      }

      const commandName = COMMANDS[path.replace(/^api\//, "")];
      if (req.method === "POST" && commandName) {
        const body = await readJson(req);
        if (req.headers["x-idempotency-key"] && !body.idempotency_key) body.idempotency_key = req.headers["x-idempotency-key"];
        if (!body.idempotency_key) {
          throw new DomainError("VALIDATION_ERROR", "写命令必须带 idempotency_key（body 字段或 X-Idempotency-Key 头）", { httpStatus: 400 });
        }
        const result = svc[commandName](body);
        return send(res, result.replayed ? 200 : 201, result);
      }

      send(res, 404, { error: "not_found", path });
    } catch (err) {
      if (err instanceof DomainError) return send(res, err.httpStatus ?? 400, { error: err.code, message: err.message, details: err.details });
      send(res, 500, { error: "internal_error", message: err.message });
    }
  });

  server.service = svc;
  server.store = eventStore;
  return server;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("VALIDATION_ERROR", "请求体不是合法 JSON", { httpStatus: 400 });
  }
}

function send(res, status, body) {
  const data = JSON.stringify(body, null, 0);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data + "\n");
}

// 直接启动：node src/server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const app = createApp();
  app.listen(port, () => {
    console.log(`高原透析连续调度后端监听 :${port}（事件日志 ${app.store.file ?? "内存"}）`);
  });
}
