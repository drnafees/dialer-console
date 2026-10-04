import { applyTemplate, handle, processImport, type Emitted } from "../../src/core/mock-api";
import type { WebhookDelivery } from "../../src/core/types";
import { json, KvStore, type Env } from "../_lib/kv-store";
import { receiveDelivery } from "../_lib/receiver";

// Upstream: 1000/hour, burst 60/minute, max 2 concurrent. KV gives us
// eventually-consistent counters, which is fine for a demo of the semantics.
const LIMIT_MINUTE = 60;
const LIMIT_HOUR = 1000;
const LIMIT_CONCURRENT = 2;

// Catch-all for the mock API: /v1/<anything> → pure router → JSON.
export const onRequest = async (ctx: EventContext<Env, "path", unknown>): Promise<Response> => {
  const { request, env } = ctx;
  const started = Date.now();
  const requestId = crypto.randomUUID();
  const store = new KvStore(env.CONSOLE_KV);
  await store.ensureSeeded();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/v1/, "");

  // Rate limiting
  const minute = Math.floor(started / 60_000);
  const hour = Math.floor(started / 3_600_000);
  const [m, h, c] = await Promise.all([env.CONSOLE_KV.get(`rate:m:${minute}`), env.CONSOLE_KV.get(`rate:h:${hour}`), env.CONSOLE_KV.get("rate:concurrent")]);
  const usedMinute = Number(m ?? "0") + 1;
  const usedHour = Number(h ?? "0") + 1;
  const concurrent = Number(c ?? "0") + 1;
  await Promise.all([
    env.CONSOLE_KV.put(`rate:m:${minute}`, String(usedMinute), { expirationTtl: 120 }),
    env.CONSOLE_KV.put(`rate:h:${hour}`, String(usedHour), { expirationTtl: 3700 }),
    env.CONSOLE_KV.put("rate:concurrent", String(concurrent), { expirationTtl: 60 }),
  ]);
  const release = async () => {
    const now = Number((await env.CONSOLE_KV.get("rate:concurrent")) ?? "1");
    await env.CONSOLE_KV.put("rate:concurrent", String(Math.max(now - 1, 0)), { expirationTtl: 60 });
  };
  const baseHeaders = {
    "X-Request-Id": requestId,
    "X-RateLimit-Limit": String(LIMIT_MINUTE),
    "X-RateLimit-Remaining": String(Math.max(LIMIT_MINUTE - usedMinute, 0)),
    "X-RateLimit-Limit-Hour": String(LIMIT_HOUR),
    "X-RateLimit-Remaining-Hour": String(Math.max(LIMIT_HOUR - usedHour, 0)),
  };
  const log = (status: number, emitted: string[] = []) =>
    store.requestLog.put({ id: requestId, at: new Date(started).toISOString(), method: request.method, path, query: url.search.slice(1), status, durationMs: Date.now() - started, rateLimitRemaining: Math.max(LIMIT_MINUTE - usedMinute, 0), emitted });

  // Concurrency is only enforced if the client really is parallel; the counter is
  // self-healing via TTL so a crashed request cannot wedge the API.
  const limited = usedMinute > LIMIT_MINUTE ? "burst limit of 60 requests per minute" : usedHour > LIMIT_HOUR ? "limit of 1000 requests per hour" : concurrent > LIMIT_CONCURRENT ? "maximum of 2 concurrent requests" : null;
  if (limited) {
    ctx.waitUntil(Promise.all([release(), log(429)]));
    return json({ code: 429, message: `Rate limit exceeded: ${limited}` }, 429, { ...baseHeaders, "Retry-After": usedHour > LIMIT_HOUR ? "3600" : "60" });
  }

  let body: unknown;
  if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        ctx.waitUntil(Promise.all([release(), log(400)]));
        return json({ code: 400, message: "Body is not valid JSON" }, 400, baseHeaders);
      }
    }
  }

  const result = await handle(
    { method: request.method, path, query: Object.fromEntries(url.searchParams), body, authorization: request.headers.get("Authorization"), baseUrl: `${url.origin}/v1${path}` },
    store,
  );

  const background: Promise<unknown>[] = [release(), log(result.status, result.emitted.map((e) => e.event))];
  if (result.emitted.length) background.push(dispatch(result.emitted, store, url.origin));
  for (const id of result.startedImports ?? []) background.push(runImport(id, store, url.origin));
  ctx.waitUntil(Promise.all(background));

  return json(result.body, result.status, baseHeaders);
};

async function runImport(id: number, store: KvStore, origin: string): Promise<void> {
  const { job, emitted } = await processImport(id, store);
  if (emitted.length) await dispatch(emitted, store, origin);
  if (job.callbackUrl) {
    const payload = { event: "import_completed", importId: job.id, status: job.status, result: job.result, completed: job.completed };
    await postTo(job.callbackUrl, payload, store, origin);
  }
}

// Deliver to a URL. Webhooks pointing at this deployment's own receiver are
// invoked directly (a Pages Function cannot reliably fetch its own origin in
// local dev); everything else goes over HTTP.
async function postTo(urlString: string, payload: unknown, store: KvStore, origin: string): Promise<void> {
  const target = new URL(urlString);
  if (target.origin === origin && target.pathname === "/hooks/receive") {
    await receiveDelivery(store, { authKey: target.searchParams.get("authKey"), contentType: "application/json", raw: JSON.stringify(payload), origin });
    return;
  }
  try {
    await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    // External delivery failures are not retried by the mock (nor documented upstream).
  }
}

// Deliver each emitted event to every registered webhook for that event type.
async function dispatch(emitted: Emitted[], store: KvStore, origin: string): Promise<void> {
  const webhooks = await store.listWebhooks();
  for (const { event, lead } of emitted) {
    for (const hook of webhooks.filter((w) => w.event === event)) {
      const payload: WebhookDelivery = {
        event,
        webhookId: hook.id,
        leadId: lead.id,
        campaignId: lead.campaignId,
        status: lead.status,
        timestamp: new Date().toISOString(),
        data: event === "lead_saved" ? applyTemplate(hook.template, lead) : undefined,
      };
      const target = new URL(hook.url);
      if (hook.authKey) target.searchParams.set("authKey", hook.authKey);
      await postTo(target.toString(), payload, store, origin);
    }
  }
}
