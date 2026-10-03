import { createHash, randomUUID } from "node:crypto";

/** 由幂等键派生稳定短 id，保证同一命令重试产生同一 event_id。 */
export function idFromKey(key) {
  return createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
}

/** 无幂等键时的随机标识（实时操作、不保证重试语义）。 */
export function randomId(prefix = "id") {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
