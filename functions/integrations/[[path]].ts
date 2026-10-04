import { planImport, parseCsv, guessField } from "../../src/core/import-pipeline";
import * as seed from "../../src/core/seed";
import { fetchChangedLeads, RateLimiter, type SyncClient } from "../../src/core/sync";
import type { ConnectorConfig, CrmRecord, SyncRun } from "../../src/core/types";
import { activeMapping, planUpsert, upsertLead } from "../_lib/crm";
import { json, KvStore, type Env } from "../_lib/kv-store";
import { forward, retryDue } from "../_lib/receiver";

// Console-side integration toolkit. Not part of the vendor API; no Basic auth.
//
//   GET    /integrations/overview               counts for the dashboard
//   GET    /integrations/requests               request log of the mock API
//   GET    /integrations/deliveries             inbound webhook deliveries (+ retries due)
//   GET    /integrations/deliveries/:id         one delivery with its attempts
//   POST   /integrations/deliveries/:id/replay  force a new forward attempt
//   GET    /integrations/crm                    mock CRM records
//   PUT    /integrations/crm/:id                edit a CRM record (marks source=manual)
//   DELETE /integrations/crm                    wipe CRM records
//   GET    /integrations/connector              connector config + cursor
//   PUT    /integrations/connector              update config
//   POST   /integrations/sync?dryRun=1          run an incremental sync
//   GET    /integrations/sync                   sync runs
//   POST   /integrations/import/preview         CSV text -> column guesses + dedupe plan
//   GET    /integrations/diagnose               run checks and explain findings

const DEMO_AUTH = `Basic ${btoa("demo:demo")}`;

export const onRequest = async (ctx: EventContext<Env, "path", unknown>): Promise<Response> => {
  const { request, env } = ctx;
  const store = new KvStore(env.CONSOLE_KV);
  await store.ensureSeeded();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/integrations/, "").replace(/\/+$/, "");
  const method = request.method;
  const body = async () => (await request.text()) || null;
  let m: RegExpMatchArray | null;

  if (path === "/overview" && method === "GET") {
    const [deliveries, crm, runs, requests, leads, contacts, imports, mappings, webhooks] = await Promise.all([
      store.deliveries.list(), store.crm.list(), store.syncRuns.list(), store.requestLog.list(), store.listLeads(), store.listContacts(), store.listImports(), store.listFieldMappings(), store.listWebhooks(),
    ]);
    return json({
      leads: leads.length, contacts: contacts.length, imports: imports.length, fieldMappings: mappings.length, webhooks: webhooks.length,
      deliveries: { total: deliveries.length, delivered: deliveries.filter((d) => d.forward.status === "delivered").length, pending: deliveries.filter((d) => d.forward.status === "pending").length, dead: deliveries.filter((d) => d.forward.status === "dead").length, duplicates: deliveries.filter((d) => d.duplicate).length },
      crm: crm.length, syncRuns: runs.length, requests: requests.length, cursor: await store.getCursor(),
    });
  }

  if (path === "/requests" && method === "GET") return json({ requests: await store.requestLog.list() });

  if (path === "/deliveries" && method === "GET") {
    const retried = await retryDue(store);
    return json({ retried, deliveries: await store.deliveries.list() });
  }
  if ((m = path.match(/^\/deliveries\/([^/]+)$/)) && method === "GET") {
    const d = await store.deliveries.get(m[1]!);
    if (!d) return json({ error: "Not found" }, 404);
    const attempts = (await store.attempts.list()).filter((a) => a.deliveryId === d.id).sort((a, b) => a.attempt - b.attempt);
    return json({ delivery: d, attempts });
  }
  if ((m = path.match(/^\/deliveries\/([^/]+)\/replay$/)) && method === "POST") {
    const d = await store.deliveries.get(m[1]!);
    if (!d) return json({ error: "Not found" }, 404);
    const reset = { ...d, forward: { ...d.forward, status: "pending" as const, attempts: 0, nextAttemptAt: null } };
    const after = await forward(store, reset);
    return json({ delivery: after });
  }

  if (path === "/crm" && method === "GET") return json({ records: await store.crm.list() });
  if (path === "/crm" && method === "DELETE") {
    await store.crm.clear();
    return json({ ok: true });
  }
  if ((m = path.match(/^\/crm\/([^/]+)$/)) && method === "PUT") {
    const rec = await store.crm.get(m[1]!);
    if (!rec) return json({ error: "Not found" }, 404);
    const patch = JSON.parse((await body()) ?? "{}") as { properties?: Record<string, string> };
    const updated: CrmRecord = { ...rec, properties: { ...rec.properties, ...(patch.properties ?? {}) }, updatedAt: new Date().toISOString(), source: "manual" };
    await store.crm.put(updated);
    return json({ record: updated });
  }

  if (path === "/connector" && method === "GET") return json({ connector: await store.getConnector(), cursor: await store.getCursor(), mappings: await store.listFieldMappings() });
  if (path === "/connector" && method === "PUT") {
    const patch = JSON.parse((await body()) ?? "{}") as Partial<ConnectorConfig> & { cursor?: string | null };
    const { cursor, ...rest } = patch;
    const next = { ...(await store.getConnector()), ...rest };
    await store.putConnector(next);
    if (cursor !== undefined) await store.putCursor(cursor ?? new Date(0).toISOString());
    return json({ connector: next, cursor: await store.getCursor() });
  }

  if (path === "/sync" && method === "GET") return json({ runs: await store.syncRuns.list() });
  if (path === "/sync" && method === "POST") return json({ run: await runSync(store, url.origin, url.searchParams.get("dryRun") === "1") });

  if (path === "/import/preview" && method === "POST") {
    const req = JSON.parse((await body()) ?? "{}") as { csv: string; columnMap?: Record<string, string>; poolId?: number; matchFields?: number[]; blacklist?: number[]; updateFields?: number[] };
    const { headers, rows } = parseCsv(req.csv ?? "");
    const guesses = headers.map((h) => ({ header: h, fieldId: guessField(h, seed.fields)?.id ?? null }));
    const columnMap = req.columnMap ?? Object.fromEntries(guesses.filter((g) => g.fieldId).map((g) => [g.header, String(g.fieldId)]));
    const data = rows.map((r) => Object.fromEntries(headers.map((h, i) => [columnMap[h], r[i] ?? ""]).filter(([k, v]) => k && v !== "")) as Record<string, string>);
    const plan = planImport({ poolId: req.poolId ?? 21, match: { fields: req.matchFields ?? [3], blacklist: req.blacklist ?? [] }, updateFields: req.updateFields ?? [], rows: data }, await store.listContacts(), new Map(seed.fields.map((f) => [f.id, f])));
    return json({ headers, rowCount: rows.length, guesses, columnMap, plan, rows: data });
  }

  if (path === "/diagnose" && method === "GET") return json({ checks: await diagnose(store) });

  return json({ error: `No route for ${method} ${url.pathname}` }, 404);
};

// ---- sync ------------------------------------------------------------------

// The sync talks to the mock API over HTTP like a real integration would, so it
// hits the same rate limiter and request log. In local dev a Function cannot
// always reach its own origin, so fall back to calling the router in-process.
function makeClient(store: KvStore, origin: string): SyncClient {
  return {
    async get(path, query) {
      const u = new URL(`/v1${path}`, origin);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      try {
        const res = await fetch(u, { headers: { Authorization: DEMO_AUTH } });
        return { status: res.status, body: await res.json(), retryAfterSeconds: Number(res.headers.get("Retry-After") ?? "0") || undefined };
      } catch {
        const { handle } = await import("../../src/core/mock-api");
        const r = await handle({ method: "GET", path, query, authorization: DEMO_AUTH, baseUrl: u.origin + u.pathname }, store);
        return { status: r.status, body: r.body };
      }
    },
  };
}

async function runSync(store: KvStore, origin: string, dryRun: boolean): Promise<SyncRun> {
  const cfg = await store.getConnector();
  const cursor = (await store.getCursor()) ?? new Date(0).toISOString();
  const run: SyncRun = { id: crypto.randomUUID(), startedAt: new Date().toISOString(), finishedAt: null, dryRun, cursorBefore: cursor, cursorAfter: null, pagesFetched: 0, requestsMade: 0, rowsFetched: 0, created: 0, updated: 0, skipped: 0, failed: 0, rateLimitWaitsMs: 0, status: "running", error: null, preview: [] };
  await store.syncRuns.put(run);
  const limiter = new RateLimiter(60, 2);
  const progress = { pagesFetched: 0, requestsMade: 0, rowsFetched: 0, rateLimitWaitsMs: 0, cursorAfter: cursor };
  const mapping = await activeMapping(store);
  try {
    for await (const lead of fetchChangedLeads(makeClient(store, origin), limiter, { cursor, overlapSeconds: cfg.overlapSeconds, pageSize: cfg.pageSize, campaignIds: cfg.campaignIds }, progress)) {
      try {
        const plan = dryRun ? await planUpsert(store, lead, mapping, "sync") : await upsertLead(store, lead, mapping, "sync");
        run[plan.action === "create" ? "created" : plan.action === "update" ? "updated" : "skipped"]++;
        if (run.preview.length < 50) run.preview.push({ leadId: lead.id, action: plan.action, properties: plan.record.properties, reason: plan.reason });
      } catch (e) {
        run.failed++;
        if (run.preview.length < 50) run.preview.push({ leadId: lead.id, action: "skip", properties: {}, reason: String(e) });
      }
    }
    run.status = "completed";
    run.cursorAfter = progress.cursorAfter;
    if (!dryRun) await store.putCursor(progress.cursorAfter);
  } catch (e) {
    run.status = "failed";
    run.error = e instanceof Error ? e.message : String(e);
  }
  Object.assign(run, { pagesFetched: progress.pagesFetched, requestsMade: progress.requestsMade, rowsFetched: progress.rowsFetched, rateLimitWaitsMs: progress.rateLimitWaitsMs + limiter.waitedMs, finishedAt: new Date().toISOString() });
  await store.syncRuns.put(run);
  return run;
}

// ---- diagnose --------------------------------------------------------------

interface Check { id: string; level: "ok" | "warn" | "error"; title: string; detail: string; fix?: string }

async function diagnose(store: KvStore): Promise<Check[]> {
  const checks: Check[] = [];
  const [webhooks, deliveries, requests, mappings, cfg, cursor] = await Promise.all([store.listWebhooks(), store.deliveries.list(), store.requestLog.list(), store.listFieldMappings(), store.getConnector(), store.getCursor()]);

  if (!webhooks.length) checks.push({ id: "no-webhooks", level: "warn", title: "No webhooks registered", detail: "The dialer will not notify this integration of changes.", fix: "POST /v1/webhooks with event lead_saved and url <origin>/hooks/receive." });
  for (const w of webhooks) {
    if (!w.authKey) checks.push({ id: `hook-${w.id}-noauth`, level: "warn", title: `Webhook ${w.id} has no authKey`, detail: "Anyone who guesses the URL can inject events.", fix: "PUT /v1/webhooks/{id} with an authKey and verify it in the receiver." });
    if (w.template && w.event !== "lead_saved") checks.push({ id: `hook-${w.id}-template`, level: "error", title: `Webhook ${w.id} has a template on ${w.event}`, detail: "Templates are only applied to lead_saved.", fix: "Fetch the lead with GET /v1/leads/{id} on this event instead." });
    const campaignFields = new Set(seed.campaigns.flatMap((c) => [...c.masterFields, ...c.resultFields].map((f) => f.id)));
    const tags = [...JSON.stringify(w.template ?? {}).matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
    for (const t of tags) if (!campaignFields.has(t)) checks.push({ id: `hook-${w.id}-tag-${t}`, level: "warn", title: `Template tag [${t}] is not on any campaign`, detail: "It will always resolve to an empty string.", fix: "Check GET /v1/campaigns/{id} masterFields/resultFields." });
  }
  const badKey = deliveries.filter((d) => !d.authKeyValid);
  if (badKey.length) checks.push({ id: "authkey-mismatch", level: "error", title: `${badKey.length} deliveries arrived with a wrong or missing authKey`, detail: "They were logged but not forwarded to the CRM.", fix: "The key is sent as ?authKey= in the query string. Compare it with the value registered on the webhook." });
  const dead = deliveries.filter((d) => d.forward.status === "dead" && d.authKeyValid && !d.duplicate);
  if (dead.length) checks.push({ id: "dead-letters", level: "error", title: `${dead.length} deliveries exhausted all retries`, detail: dead.map((d) => `${d.payload.event} lead ${d.payload.leadId}: ${d.forward.lastError}`).slice(0, 3).join(" | "), fix: "Fix the downstream and use Replay on the delivery." });
  const dup = deliveries.filter((d) => d.duplicate).length;
  if (dup) checks.push({ id: "duplicates", level: "ok", title: `${dup} duplicate deliveries were suppressed`, detail: "Idempotency key = event + leadId + timestamp." });
  const r429 = requests.filter((r) => r.status === 429).length;
  if (r429) checks.push({ id: "rate-limit", level: "warn", title: `${r429} requests were rate limited (429)`, detail: "Burst limit is 60/min, 1000/h, 2 concurrent.", fix: "Use the sync engine's token bucket; honour Retry-After." });
  const r401 = requests.filter((r) => r.status === 401).length;
  if (r401) checks.push({ id: "auth-failed", level: "warn", title: `${r401} requests failed authentication`, detail: "Basic auth is required on every /v1 request.", fix: "Header: Authorization: Basic base64(username:password)." });
  if (!mappings.length) checks.push({ id: "no-mapping", level: "warn", title: "No field mapping defined", detail: "CRM records use the dialer's field names.", fix: "Create one under Field mappings and select it on the connector." });
  else if (cfg.fieldMappingId === null) checks.push({ id: "mapping-unselected", level: "warn", title: "A field mapping exists but the connector does not use it", detail: "", fix: "Select it in Connector settings." });
  if (!cursor) checks.push({ id: "no-cursor", level: "ok", title: "Sync has never run", detail: "The first run will read all leads." });
  else if (Date.now() - Date.parse(cursor) > 24 * 3600_000) checks.push({ id: "stale-cursor", level: "warn", title: "Sync cursor is older than 24h", detail: `Cursor: ${cursor}`, fix: "Run a sync or schedule one." });
  if (!checks.some((c) => c.level !== "ok")) checks.push({ id: "all-good", level: "ok", title: "No problems found", detail: "" });
  return checks;
}
