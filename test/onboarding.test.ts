import { describe, expect, it } from "vitest";
import { guessField, parseCsv, planImport } from "../src/core/import-pipeline";
import { applyTemplate, handle, processImport, type ApiRequest } from "../src/core/mock-api";
import { matchKey, normalizeEmail, normalizePhone } from "../src/core/normalize";
import * as seed from "../src/core/seed";
import type { Contact, Lead, Meta } from "../src/core/types";
import { MemoryStore } from "./memory-store";

const AUTH = `Basic ${btoa("demo:demo")}`;
const req = (method: string, path: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({ method, path, query: {}, authorization: AUTH, ...extra });
const fields = new Map(seed.fields.map((f) => [f.id, f]));

describe("normalisation", () => {
  it("normalises Danish phone numbers to E.164", () => {
    expect(normalizePhone("20 12 34 56")).toBe("+4520123456");
    expect(normalizePhone("+45 20-12-34-56")).toBe("+4520123456");
    expect(normalizePhone("0045 20123456")).toBe("+4520123456");
    expect(normalizePhone("4520123456")).toBe("+4520123456");
    expect(normalizePhone("")).toBe("");
  });
  it("lowercases and trims email, builds composite match keys", () => {
    expect(normalizeEmail("  Mette@Example.DK ")).toBe("mette@example.dk");
    expect(matchKey({ "3": "20 12 34 56", "4": "A@B.dk" }, [3, 4], fields)).toBe("+4520123456|a@b.dk");
    expect(matchKey({ "3": "20 12 34 56" }, [3, 4], fields)).toBeNull();
  });
});

describe("csv", () => {
  it("parses quoted cells, semicolons and a BOM", () => {
    const { headers, rows } = parseCsv('\uFEFFFornavn;Efternavn;Telefon\n"Jens";"Hansen, Jr";"20 12 34 56"\nIda;Lund;"31 ""44"" 55 66"\n');
    expect(headers).toEqual(["Fornavn", "Efternavn", "Telefon"]);
    expect(rows).toEqual([["Jens", "Hansen, Jr", "20 12 34 56"], ["Ida", "Lund", '31 "44" 55 66']]);
  });
  it("guesses field ids from Danish and English headers", () => {
    expect(guessField("Fornavn", seed.fields)?.id).toBe(1);
    expect(guessField("E-mail address", seed.fields)?.id).toBe(4);
    expect(guessField("Mobile", seed.fields)?.id).toBe(3);
    expect(guessField("Postnr", seed.fields)?.id).toBe(6);
    expect(guessField("Favourite colour", seed.fields)).toBeUndefined();
  });
});

describe("import pipeline", () => {
  const contacts = seed.buildContacts();
  it("classifies rows as insert / update / duplicate / blacklisted", () => {
    const plan = planImport(
      {
        poolId: 21,
        match: { fields: [3], blacklist: [23] },
        updateFields: [4],
        rows: [
          { "1": "New", "2": "Person", "3": "+45 11 11 11 11" }, // insert
          { "1": "Mette", "3": "20 12 34 56", "4": "mette.new@example.dk" }, // existing in pool 21, email differs -> update
          { "1": "Mette", "3": "+45 20 12 34 56" }, // same key again in the file -> duplicate
          { "1": "Ole", "3": "99 88 77 66" }, // on the blacklist pool
          { "1": "Lars", "3": "+45 31 44 55 66", "4": "lars@fjordlogistik.dk" }, // exists, email same -> duplicate
        ],
      },
      contacts,
      fields,
    );
    expect(plan.rows.map((r) => r.action)).toEqual(["insert", "update", "duplicate", "blacklisted", "duplicate"]);
    expect(plan.rows[1]!.changes).toEqual({ "4": { from: "mette.sorensen@nordicbyg.dk", to: "mette.new@example.dk" } });
    expect(plan.summary).toEqual({ inserted: 1, updated: 1, duplicates: 2, blacklisted: 1 });
  });
  it("treats rows without match fields as inserts", () => {
    const plan = planImport({ poolId: 21, match: { fields: [3], blacklist: [] }, updateFields: [], rows: [{ "1": "No", "2": "Phone" }] }, contacts, fields);
    expect(plan.rows[0]!.action).toBe("insert");
  });
});

describe("imports API", () => {
  it("runs create -> insert -> start -> processed, adds to campaign and emits leads_inserted", async () => {
    const store = new MemoryStore();
    const created = await handle(req("POST", "/imports", { body: { poolId: 21, match: { fields: [3], blacklist: [23] }, updateFields: [4], onImportedAction: { type: "addToCampaign", campaignId: 412 }, callbackUrl: "https://example.com/cb" } }), store);
    expect(created.status).toBe(200);
    const { id } = created.body as { id: number };

    const inserted = await handle(req("POST", `/imports/${id}/insert`, { body: [{ data: { "1": "Alice", "2": "Andersen", "3": "+45 20 12 34 56", "4": "alice@example.dk" } }, { data: { "1": "Bob", "3": "+45 12 12 12 12" } }, { data: { "1": "Ole", "3": "+45 99 88 77 66" } }] }), store);
    expect(inserted.status).toBe(200);
    // Also accept the spec's typo'd path.
    expect((await handle(req("POST", `/imports${id}/insert`, { body: [{ data: { "1": "Carl", "3": "+45 13 13 13 13" } }] }), store)).status).toBe(200);
    expect((await handle(req("POST", `/imports/${id}/insert`, { body: [{ data: { "999": "x" } }] }), store)).status).toBe(400);

    const started = await handle(req("POST", `/imports/${id}/start`), store);
    expect(started.status).toBe(200);
    expect(started.startedImports).toEqual([id]);
    expect((await handle(req("GET", `/imports/${id}`), store)).body).toMatchObject({ status: "queued", rowCount: 4 });
    expect((await handle(req("POST", `/imports/${id}/start`), store)).status).toBe(409);

    const leadsBefore = (await store.listLeads()).length;
    const { job, emitted } = await processImport(id, store);
    expect(job.status).toBe("completed");
    // Alice matches Mette's phone -> update email; Bob and Carl are new; Ole is blacklisted.
    expect(job.result).toMatchObject({ inserted: 2, updated: 1, duplicates: 1, addedToCampaign: 3 });
    expect(emitted.filter((e) => e.event === "leads_inserted")).toHaveLength(3);
    expect((await store.listLeads()).length).toBe(leadsBefore + 3);
    const mette = (await store.listContacts()).find((c) => c.data.some((p) => p.id === 3 && p.value === "+45 20 12 34 56"))!;
    expect(mette.data.find((p) => p.id === 4)?.value).toBe("alice@example.dk");
  });

  it("validates poolId, campaignId and field ids on create", async () => {
    const store = new MemoryStore();
    expect((await handle(req("POST", "/imports", { body: { poolId: 999 } }), store)).body).toMatchObject({ code: 400, message: "Unknown poolId" });
    expect((await handle(req("POST", "/imports", { body: { poolId: 21, onImportedAction: { type: "addToCampaign", campaignId: 1 } } }), store)).status).toBe(400);
    expect((await handle(req("POST", "/imports", { body: { poolId: 21, match: { fields: [999] } } }), store)).status).toBe(400);
  });
});

describe("contacts API", () => {
  it("lists pools and contacts, finds by data with normalisation and $in", async () => {
    const store = new MemoryStore();
    expect(((await handle(req("GET", "/pools"), store)).body as unknown[]).length).toBe(3);
    const byPhone = await handle(req("POST", "/contacts/findByData", { body: { "3": "20123456" } }), store);
    expect((byPhone.body as Contact[]).map((c) => c.data.find((p) => p.id === 1)?.value)).toEqual(["Mette"]);
    const byIn = await handle(req("POST", "/contacts/findByData", { body: { "1": { $in: ["Mette", "lars"] } } }), store);
    expect((byIn.body as Contact[]).length).toBe(2);
    expect((await handle(req("POST", "/contacts/findByData", { body: { "1": { $gt: "A" } } }), store)).status).toBe(400);
    expect((await handle(req("GET", "/contacts", { query: { filters: '{"id":{"$in":[1]}}' } }), store)).status).toBe(400);
  });

  it("patches by externalId and keeps the derived lead in sync (emits lead_saved)", async () => {
    const store = new MemoryStore();
    const res = await handle(req("PATCH", "/contacts-external/ext-50015", { body: { poolId: 21, data: { "4": "peter@holm.dk" } } }), store);
    expect(res.status).toBe(200);
    expect(res.emitted.map((e) => e.event)).toEqual(["lead_saved"]);
    expect((await store.getLead(204179334))!.masterData.find((p) => p.id === 4)?.value).toBe("peter@holm.dk");
    expect((await handle(req("PATCH", "/contacts-external/nope", { body: { data: {} } }), store)).status).toBe(404);
  });

  it("adds a contact to a campaign restricted to the campaign's master fields", async () => {
    const store = new MemoryStore();
    const res = await handle(req("POST", "/campaigns/418/addContact", { body: { contactId: 390001 } }), store);
    expect(res.status).toBe(200);
    const lead = (await store.getLead((res.body as { id: number }).id))!;
    expect(lead.campaignId).toBe(418);
    expect(lead.masterData.some((p) => p.id === 5)).toBe(false); // Company is not on campaign 418
    expect(res.emitted[0]!.event).toBe("leads_inserted");
  });
});

describe("field mappings API", () => {
  it("CRUDs a mapping and rejects unknown field ids", async () => {
    const store = new MemoryStore();
    const created = await handle(req("POST", "/field-mappings", { body: { name: "CRM", mappings: { "1": "firstname", "3": "phone" } } }), store);
    const { id } = created.body as { id: number };
    expect(((await handle(req("GET", "/field-mappings"), store)).body as unknown[]).length).toBe(1);
    await handle(req("PUT", `/field-mappings/${id}`, { body: { mappings: { "1": "firstname", "3": "phone", "4": "email" } } }), store);
    expect(((await handle(req("GET", `/field-mappings/${id}`), store)).body as { mappings: Record<string, string> }).mappings["4"]).toBe("email");
    expect((await handle(req("POST", "/field-mappings", { body: { name: "x", mappings: { "999": "y" } } }), store)).status).toBe(400);
    await handle(req("DELETE", `/field-mappings/${id}`), store);
    expect(((await handle(req("GET", "/field-mappings"), store)).body as unknown[]).length).toBe(0);
  });
});

describe("spec fidelity", () => {
  it("builds firstUrl/nextUrl/lastUrl in meta when a base URL is known", async () => {
    const res = await handle(req("GET", "/leads", { query: { pageSize: "3", page: "2", includeMeta: "true" }, baseUrl: "https://api.example.test/v1/leads" }), new MemoryStore());
    const meta = (res.body as { meta: Meta }).meta.pagination;
    expect(meta.firstUrl).toBe("https://api.example.test/v1/leads?pageSize=3&includeMeta=true");
    expect(meta.previousUrl).toBe("https://api.example.test/v1/leads?pageSize=3&includeMeta=true");
    expect(meta.nextUrl).toBe("https://api.example.test/v1/leads?pageSize=3&includeMeta=true&page=3");
    expect(meta.lastUrl).toContain("page=3");
  });
  it("rejects templates on events other than lead_saved", async () => {
    const res = await handle(req("POST", "/webhooks", { body: { event: "call_ended", url: "https://example.com/h", template: { x: "[1]" } } }), new MemoryStore());
    expect(res.status).toBe(400);
  });
  it("resolves [status], [last_called_by] and [lead_id] special tags", () => {
    const lead: Lead = seed.buildLeads()[0]!;
    expect(applyTemplate({ s: "[status]", u: "[last_called_by]", l: "[lead_id]" }, lead)).toEqual({ s: "success", u: "1823", l: "204179331" });
  });
});
