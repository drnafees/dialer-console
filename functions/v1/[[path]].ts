import { applyTemplate, handle, type Emitted } from "../../src/core/mock-api";
import type { WebhookDelivery } from "../../src/core/types";
import { json, KvStore, type Env } from "../_lib/kv-store";
import { receive } from "../hooks/receive";

const RATE_LIMIT_PER_MINUTE = 60;

// Catch-all for the mock API: /v1/<anything> → pure router → JSON.
export const onRequest = async (ctx: EventContext<Env, "path", unknown>): Promise<Response> => {
  const { request, env } = ctx;
  const store = new KvStore(env.CONSOLE_KV);
  await store.ensureSeeded();

  const minute = Math.floor(Date.now() / 60_000);
  const used = Number((await env.CONSOLE_KV.get(`rate:${minute}`)) ?? "0") + 1;
  await env.CONSOLE_KV.put(`rate:${minute}`, String(used), { expirationTtl: 120 });
  const rateHeaders = { "X-RateLimit-Limit": String(RATE_LIMIT_PER_MINUTE), "X-RateLimit-Remaining": String(Math.max(RATE_LIMIT_PER_MINUTE - used, 0)) };
  if (used > RATE_LIMIT_PER_MINUTE) {
    return new Response(JSON.stringify({ code: 429, message: "Rate limit exceeded" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60", ...rateHeaders } });
  }

  const url = new URL(request.url);
  let body: unknown;
  if (request.method === "POST" || request.method === "PUT") {
    try {
      body = await request.json();
    } catch {
      return json({ code: 400, message: "Body is not valid JSON" }, 400);
    }
  }

  const result = await handle(
    { method: request.method, path: url.pathname.replace(/^\/v1/, ""), query: Object.fromEntries(url.searchParams), body, authorization: request.headers.get("Authorization") },
    store,
  );

  if (result.emitted.length) ctx.waitUntil(dispatch(result.emitted, store, url.origin));

  const res = json(result.body, result.status);
  for (const [k, v] of Object.entries(rateHeaders)) res.headers.set(k, v);
  return res;
};

// Deliver each emitted event to every registered webhook for that event type.
// Webhooks pointing at this deployment's own /hooks/receive are invoked directly
// (a Pages Function cannot reliably fetch its own origin in local dev).
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

      if (target.origin === origin && target.pathname === "/hooks/receive") {
        await receive(store, target.searchParams.get("authKey"), payload);
        continue;
      }
      try {
        await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } catch {
        // External delivery failures are not retried by the mock.
      }
    }
  }
}
