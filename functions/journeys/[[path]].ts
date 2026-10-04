import { handle } from "../../src/core/mock-api";
import * as seed from "../../src/core/seed";
import { normalizePhone } from "../../src/core/normalize";
import { LEAD_STATUSES, type JourneyRunLog, type JourneyTrigger, type LeadStatus } from "../../src/core/types";
import { json, KvStore, type Env } from "../_lib/kv-store";

// Simulates the vendor's "trigger a journey from an external system" feature:
// an inbound webhook with Bearer auth whose body is matched to a lead and
// mapped onto fields.
//
//   GET    /journeys                      list triggers
//   POST   /journeys                      create {name, resource, matchOn, fieldMap}
//   DELETE /journeys/:id
//   POST   /journeys/:id/trigger          the endpoint an external system calls
//   GET    /journeys/runs                 run log

const DEMO_AUTH = `Basic ${btoa("demo:demo")}`;

export const onRequest = async ({ request, env }: EventContext<Env, "path", unknown>): Promise<Response> => {
  const store = new KvStore(env.CONSOLE_KV);
  await store.ensureSeeded();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/journeys/, "").replace(/\/+$/, "");
  let m: RegExpMatchArray | null;

  if (path === "" && request.method === "GET") return json({ triggers: await store.journeys.list() });
  if (path === "/runs" && request.method === "GET") return json({ runs: await store.journeyRuns.list() });
  if (path === "" && request.method === "POST") {
    const b = (await request.json()) as Partial<JourneyTrigger>;
    const trigger: JourneyTrigger = {
      id: crypto.randomUUID().slice(0, 8),
      name: b.name || "Untitled trigger",
      token: crypto.randomUUID().replace(/-/g, ""),
      resource: b.resource ?? "leads",
      matchOn: b.matchOn ?? "leadId",
      fieldMap: b.fieldMap ?? { updatedName: "1", updatedPhone: "3", status: "status" },
      created: new Date().toISOString(),
    };
    await store.journeys.put(trigger);
    return json({ trigger, triggerUrl: `${url.origin}/journeys/${trigger.id}/trigger` });
  }
  if ((m = path.match(/^\/([^/]+)$/)) && request.method === "DELETE") {
    await store.journeys.delete(m[1]!);
    return json({ ok: true });
  }

  if ((m = path.match(/^\/([^/]+)\/trigger$/)) && request.method === "POST") {
    const trigger = await store.journeys.get(m[1]!);
    if (!trigger) return json({ error: "Unknown trigger" }, 404);
    const auth = request.headers.get("Authorization") ?? "";
    const authorized = auth === `Bearer ${trigger.token}`;
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "Body is not valid JSON" }, 400);
    }
    const log: JourneyRunLog = {
      id: crypto.randomUUID(),
      triggerId: trigger.id,
      at: new Date().toISOString(),
      authorized,
      matched: null,
      applied: {},
      error: null,
      body,
    };
    if (!authorized) {
      log.error = "Unauthorized: expected Authorization: Bearer <token>";
      await store.journeyRuns.put(log);
      return json({ error: log.error }, 401);
    }

    // Match the request to a lead.
    // Match by primary key when we have one; otherwise scan (a real system
    // would use findByData or an indexed lookup here).
    let lead = null;
    if (trigger.matchOn === "leadId") lead = Number.isInteger(Number(body.leadId)) ? await store.getLead(Number(body.leadId)) : null;
    else {
      const leads = await store.listLeads();
      if (trigger.matchOn === "externalId") lead = leads.find((l) => l.externalId !== null && String(l.externalId) === String(body.externalId)) ?? null;
      else {
        const phone = normalizePhone(String(body.phone ?? body.updatedPhone ?? ""));
        lead = phone ? (leads.find((l) => normalizePhone(l.masterData.find((p) => p.id === 3)?.value ?? "") === phone) ?? null) : null;
      }
    }
    if (!lead) {
      log.error = `No lead matched on ${trigger.matchOn}`;
      await store.journeyRuns.put(log);
      return json({ error: log.error, matchOn: trigger.matchOn }, 404);
    }
    log.matched = lead.id;

    // Map inbound keys onto fields / status and apply through the normal API
    // so webhooks fire exactly as they would for a user edit.
    const masterData: { id: number; value: string }[] = [];
    let status: LeadStatus | undefined;
    for (const [inKey, target] of Object.entries(trigger.fieldMap)) {
      const v = body[inKey];
      if (v === undefined || v === null || v === "") continue;
      if (target === "status") {
        if ((LEAD_STATUSES as readonly string[]).includes(String(v))) status = String(v) as LeadStatus;
        else log.error = `Ignored status "${String(v)}": not one of ${LEAD_STATUSES.join(", ")}`;
        continue;
      }
      const id = Number(target);
      if (!seed.fields.some((f) => f.id === id)) continue;
      masterData.push({ id, value: String(v) });
      log.applied[seed.fields.find((f) => f.id === id)!.name] = String(v);
    }
    if (status) log.applied.status = status;
    const res = await handle(
      { method: "PUT", path: `/leads/${lead.id}`, query: {}, body: { masterData, ...(status ? { status } : {}) }, authorization: DEMO_AUTH },
      store,
    );
    await store.journeyRuns.put(log);
    return json({ matched: lead.id, applied: log.applied, result: res.body, note: "Webhooks for lead_saved fire as usual; see Deliveries." }, res.status);
  }

  return json({ error: `No route for ${request.method} ${url.pathname}` }, 404);
};
