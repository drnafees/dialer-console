import { describe, expect, it } from "vitest";
import { applyTemplate, handle, matchesFilters, type ApiRequest, type Store } from "../src/core/mock-api";
import * as seed from "../src/core/seed";
import type { Lead, Webhook } from "../src/core/types";

class MemoryStore implements Store {
  leads = new Map(seed.buildLeads().map((l) => [l.id, l]));
  webhooks = new Map<number, Webhook>();
  async listLeads() { return [...this.leads.values()]; }
  async getLead(id: number) { return this.leads.get(id) ?? null; }
  async putLead(lead: Lead) { this.leads.set(lead.id, lead); }
  async deleteLead(id: number) { this.leads.delete(id); }
  async listWebhooks() { return [...this.webhooks.values()]; }
  async putWebhook(w: Webhook) { this.webhooks.set(w.id, w); }
  async deleteWebhook(id: number) { this.webhooks.delete(id); }
}

const AUTH = `Basic ${btoa("demo:demo")}`;
const req = (method: string, path: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({ method, path, query: {}, authorization: AUTH, ...extra });

describe("authentication", () => {
  it("rejects missing or wrong Basic credentials with the upstream error shape", async () => {
    const store = new MemoryStore();
    const none = await handle(req("GET", "/organization", { authorization: null }), store);
    const wrong = await handle(req("GET", "/organization", { authorization: `Basic ${btoa("demo:nope")}` }), store);
    expect(none.status).toBe(401);
    expect(wrong.body).toEqual({ status: "error", message: "Authentication failed" });
  });

  it("returns the organization for valid credentials", async () => {
    const res = await handle(req("GET", "/organization"), new MemoryStore());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(seed.organization);
  });
});

describe("list endpoints", () => {
  it("applies JSON filters with $eq and $gt", async () => {
    const res = await handle(req("GET", "/leads", { query: { filters: JSON.stringify({ campaignId: { $eq: 412 }, contactAttempts: { $gt: 1 } }) } }), new MemoryStore());
    const leads = res.body as Lead[];
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((l) => l.campaignId === 412 && l.contactAttempts > 1)).toBe(true);
  });

  it("supports $c (contains) on text and rejects malformed filters", async () => {
    const ok = await handle(req("GET", "/campaigns", { query: { filters: '{"id":{"$c":"41"}}' } }), new MemoryStore());
    expect((ok.body as unknown[]).length).toBe(2);
    const bad = await handle(req("GET", "/leads", { query: { filters: "{not json" } }), new MemoryStore());
    expect(bad.status).toBe(400);
  });

  it("paginates and returns meta when includeMeta=true", async () => {
    const res = await handle(req("GET", "/leads", { query: { pageSize: "3", page: "2", includeMeta: "true", sortProperty: "id" } }), new MemoryStore());
    const body = res.body as { meta: { pagination: { page: number; pageCount: number; total: number } }; leads: Lead[] };
    expect(body.meta.pagination).toMatchObject({ page: 2, pageCount: 3, total: 8 });
    expect(body.leads).toHaveLength(3);
    expect(body.leads[0]!.id).toBe(seed.buildLeads().map((l) => l.id).sort((a, b) => a - b)[3]);
  });

  it("matchesFilters compares datetimes as ISO strings", () => {
    expect(matchesFilters({ t: "2026-09-29T10:00:00Z" }, { t: { $gt: "2026-09-28T00:00:00Z" } })).toBe(true);
    expect(matchesFilters({ t: "2026-09-27T10:00:00Z" }, { t: { $gt: "2026-09-28T00:00:00Z" } })).toBe(false);
  });
});

describe("leads", () => {
  it("merges masterData/resultData pairs on PUT and bumps lastModifiedTime", async () => {
    const store = new MemoryStore();
    const before = (await store.getLead(204179334))!;
    const res = await handle(req("PUT", "/leads/204179334", { body: { masterData: [{ id: 4, value: "peter@holm.dk" }], resultData: [{ id: 20, value: "Solar" }] } }), store);
    expect(res.status).toBe(200);
    const after = (await store.getLead(204179334))!;
    expect(after.masterData.find((p) => p.id === 4)?.value).toBe("peter@holm.dk");
    expect(after.masterData.find((p) => p.id === 1)?.value).toBe("Peter");
    expect(after.resultData).toEqual([{ id: 20, value: "Solar" }]);
    expect(after.lastModifiedTime > before.lastModifiedTime).toBe(true);
  });

  it("emits lead_saved plus a leadClosed* event when status changes to a closed state", async () => {
    const res = await handle(req("PUT", "/leads/204179334", { body: { status: "success" } }), new MemoryStore());
    expect(res.emitted.map((e) => e.event)).toEqual(["lead_saved", "leadClosedSuccess"]);
    expect(res.emitted[0]!.lead.active).toBe(false);
    expect(res.emitted[0]!.lead.contactAttempts).toBe(1);
  });

  it("emits only lead_saved when status is unchanged", async () => {
    const res = await handle(req("PUT", "/leads/204179331", { body: { status: "success" } }), new MemoryStore());
    expect(res.emitted.map((e) => e.event)).toEqual(["lead_saved"]);
  });

  it("validates bodies with a 400 and the {code,message} error shape", async () => {
    const res = await handle(req("PUT", "/leads/204179331", { body: { status: "won" } }), new MemoryStore());
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 400 });
    expect(String((res.body as { message: string }).message)).toContain("status");
  });

  it("creates a lead with POST, returns {id} and emits leads_inserted", async () => {
    const store = new MemoryStore();
    const res = await handle(req("POST", "/leads", { body: { campaignId: 418, masterData: [{ id: 1, value: "Test" }, { id: 3, value: "+45 11 11 11 11" }] } }), store);
    expect(res.status).toBe(200);
    const { id } = res.body as { id: number };
    expect((await store.getLead(id))?.status).toBe("new");
    expect(res.emitted[0]!.event).toBe("leads_inserted");
  });

  it("404s on unknown lead and unknown route", async () => {
    expect((await handle(req("GET", "/leads/1"), new MemoryStore())).status).toBe(404);
    expect((await handle(req("GET", "/nope"), new MemoryStore())).status).toBe(404);
  });
});

describe("webhooks", () => {
  it("creates, lists, updates and deletes a webhook", async () => {
    const store = new MemoryStore();
    const created = await handle(req("POST", "/webhooks", { body: { event: "lead_saved", url: "https://example.com/hook", authKey: "k" } }), store);
    const { id } = created.body as { id: number };
    expect((await handle(req("GET", "/webhooks"), store)).body).toHaveLength(1);
    await handle(req("PUT", `/webhooks/${id}`, { body: { event: "leadClosedSuccess" } }), store);
    expect(((await handle(req("GET", `/webhooks/${id}`), store)).body as Webhook).event).toBe("leadClosedSuccess");
    await handle(req("DELETE", `/webhooks/${id}`), store);
    expect((await handle(req("GET", "/webhooks"), store)).body).toHaveLength(0);
  });

  it("rejects unknown events and invalid URLs", async () => {
    const res = await handle(req("POST", "/webhooks", { body: { event: "lead_exploded", url: "not-a-url" } }), new MemoryStore());
    expect(res.status).toBe(400);
  });

  it("resolves [fieldId] merge tags in templates", () => {
    const lead = seed.buildLeads()[0]!;
    const data = applyTemplate({ event: "saved", name: "[1] [2]", nested: { phone: "[3]", missing: "[999]" } }, lead);
    expect(data).toEqual({ event: "saved", name: "Mette Sørensen", nested: { phone: "+45 20 12 34 56", missing: "" } });
  });
});
