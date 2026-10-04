import { detectFormat, idempotencyKeyOf, normalizeDelivery, parseBody } from "../../src/core/inbound";
import type { InboundDelivery, WebhookDelivery } from "../../src/core/types";
import { upsertCrmFromDelivery } from "./crm";
import type { KvStore } from "./kv-store";

// The console's own webhook endpoint. Register it in the mock API as
// https://<host>/hooks/receive with an authKey; the mock appends ?authKey=... on delivery.
export const EXPECTED_AUTH_KEY = "console-secret";

export const BACKOFF_MS = [0, 2_000, 10_000, 60_000, 300_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length;
export const MAX_BODY_BYTES = 256 * 1024;
const MAX_FAIL_TIMES = MAX_ATTEMPTS - 1;

export interface InboundRequest {
  authKey: string | null;
  contentType: string | null;
  raw: string;
  origin: string;
  // Test hook: force the downstream to fail N times (demo of retries).
  failTimes?: number;
}

// ---- receive + forward -----------------------------------------------------

export interface ReceiveResult {
  status: number;
  body: unknown;
  // Work the caller should run after responding (ctx.waitUntil in a Function).
  background: Promise<unknown> | null;
}

// Parse, authenticate, dedupe and log an inbound webhook. Returns immediately
// with a 2xx; the forward to the CRM is handed back as `background` so the
// HTTP response is never held up by a slow downstream (which would make the
// sender time out and retry, creating the duplicates we are trying to avoid).
export async function receiveDelivery(store: KvStore, req: InboundRequest): Promise<ReceiveResult> {
  if (req.raw.length > MAX_BODY_BYTES) return { status: 413, body: { error: `Body exceeds ${MAX_BODY_BYTES} bytes` }, background: null };
  const format = detectFormat(req.contentType, req.raw);
  let payload: WebhookDelivery;
  try {
    payload = normalizeDelivery(parseBody(format, req.raw));
  } catch (e) {
    return { status: 400, body: { error: `Could not parse ${format} body: ${e instanceof Error ? e.message : String(e)}` }, background: null };
  }
  const authKeyValid = req.authKey === EXPECTED_AUTH_KEY;
  const key = idempotencyKeyOf(payload);
  const deliveryId = crypto.randomUUID();
  // Best-effort dedupe: KV is eventually consistent, so two copies arriving
  // within the same few milliseconds can both pass. Claim the key before any
  // other write to keep that window as small as KV allows.
  const duplicate = await store.hasIdempotencyKey(key);
  if (!duplicate) await store.putIdempotencyKey(key, deliveryId);
  const delivery: InboundDelivery = {
    id: deliveryId,
    idempotencyKey: key,
    receivedAt: new Date().toISOString(),
    format,
    authKeyValid,
    duplicate,
    payload,
    raw: req.raw.slice(0, 4000),
    forward: {
      status: !authKeyValid || duplicate ? "dead" : payload.leadId === 0 ? "skipped" : "pending",
      attempts: 0,
      lastError: !authKeyValid
        ? "authKey mismatch; not forwarded"
        : duplicate
          ? "duplicate delivery; not forwarded"
          : payload.leadId === 0
            ? "informational event without a lead; logged only"
            : null,
      nextAttemptAt: null,
      deliveredAt: null,
    },
  };
  await store.deliveries.put(delivery);
  // Keep the simple event log on the front page working.
  await store.pushEvent({ id: delivery.id, receivedAt: delivery.receivedAt, authKeyValid, payload });

  const failTimes = Math.min(Math.max(req.failTimes ?? 0, 0), MAX_FAIL_TIMES);
  const background = delivery.forward.status === "pending" ? forward(store, delivery, failTimes) : null;
  return { status: 202, body: { received: true, deliveryId: delivery.id, duplicate, authKeyValid }, background };
}

// Forward to the CRM with exponential backoff. Attempts whose backoff has not
// elapsed are left "pending" with nextAttemptAt; the /integrations/deliveries
// endpoint and the replay button pick them up.
export async function forward(store: KvStore, delivery: InboundDelivery, failTimes = 0): Promise<InboundDelivery> {
  let current = delivery;
  while (current.forward.status === "pending" && current.forward.attempts < MAX_ATTEMPTS) {
    const attemptNo = current.forward.attempts + 1;
    const t0 = Date.now();
    let ok = false;
    let error: string | null = null;
    try {
      if (attemptNo <= failTimes) throw new Error(`The CRM did not answer (pretend outage, ${attemptNo} of ${failTimes})`);
      await upsertCrmFromDelivery(store, current.payload);
      ok = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await store.attempts.put({
      id: crypto.randomUUID(),
      deliveryId: current.id,
      attempt: attemptNo,
      at: new Date().toISOString(),
      ok,
      status: ok ? 200 : 500,
      error,
      durationMs: Date.now() - t0,
    });
    const exhausted = attemptNo >= MAX_ATTEMPTS;
    current = {
      ...current,
      forward: {
        status: ok ? "delivered" : exhausted ? "dead" : "pending",
        attempts: attemptNo,
        lastError: error,
        nextAttemptAt: ok || exhausted ? null : new Date(Date.now() + BACKOFF_MS[attemptNo]!).toISOString(),
        deliveredAt: ok ? new Date().toISOString() : null,
      },
    };
    await store.deliveries.put(current);
    // Only the first attempt is inline; later ones wait for their backoff.
    if (!ok) break;
  }
  return current;
}

// Retry everything whose backoff has elapsed. Called opportunistically from the
// deliveries endpoint (a cron trigger would do this in a real deployment).
export async function retryDue(store: KvStore): Promise<number> {
  const now = Date.now();
  let retried = 0;
  for (const d of await store.deliveries.list()) {
    if (d.forward.status !== "pending" || !d.forward.nextAttemptAt || Date.parse(d.forward.nextAttemptAt) > now) continue;
    await forward(store, d);
    retried++;
  }
  return retried;
}
