import { beforeEach, describe, expect, it } from "vitest";
import { upsertLead } from "../functions/_lib/crm";
import { KvStore } from "../functions/_lib/kv-store";
import { BACKOFF_MS, MAX_ATTEMPTS, MAX_BODY_BYTES, receiveDelivery, retryDue } from "../functions/_lib/receiver";
import { handle } from "../src/core/mock-api";
import * as seed from "../src/core/seed";
import type { FieldMapping } from "../src/core/types";
import { asKv, MemoryKV } from "./memory-kv";

const AUTH = `Basic ${btoa("demo:demo")}`;
const ORIGIN = "https://console.test";
const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ event: "lead_saved", leadId: 204179334, campaignId: 412, status: "success", timestamp: "2026-01-01T00:00:00Z", ...over });
const inbound = (raw: string, over: Partial<Parameters<typeof receiveDelivery>[1]> = {}) => ({
  authKey: "console-secret",
  contentType: "application/json",
  raw,
  origin: ORIGIN,
  ...over,
});

let kv: MemoryKV;
let store: KvStore;

beforeEach(async () => {
  kv = new MemoryKV();
  store = new KvStore(asKv(kv));
  await store.ensureSeeded();
});

describe("KvStore", () => {
  it("seeds leads and contacts with one index write each and is idempotent", async () => {
    expect((await store.listLeads()).length).toBe(seed.buildLeads().length);
    expect((await store.listContacts()).length).toBe(seed.buildContacts().length);
    const writes = kv.writes;
    await store.ensureSeeded();
    expect(kv.writes).toBe(writes);
    expect(kv.keys().filter((k) => k.endsWith(":index")).length).toBe(2);
  });

  it("hands out monotonic ids per kind and never repeats one", async () => {
    const a = await store.nextId("lead");
    const b = await store.nextId("lead");
    const c = await store.nextId("contact");
    expect(b).toBe(a + 1);
    expect(c).not.toBe(a);
    expect(String(a).startsWith("2042")).toBe(true);
  });

  it("caps newest-first collections and drops evicted ids from the index", async () => {
    for (let i = 0; i < 105; i++)
      await store.pushEvent({
        id: `e${i}`,
        receivedAt: "",
        authKeyValid: true,
        payload: { event: "lead_saved", webhookId: 0, leadId: 1, campaignId: 0, status: "new", timestamp: "" },
      });
    const events = await store.listEvents();
    expect(events.length).toBe(100);
    expect(events[0]!.id).toBe("e104");
  });

  it("reset wipes everything and reseeds", async () => {
    await store.putCursor("2026-01-01T00:00:00Z");
    await store.reset();
    expect(await store.getCursor()).toBeNull();
    expect((await store.listLeads()).length).toBe(seed.buildLeads().length);
  });
});

describe("receiveDelivery", () => {
  it("accepts a valid delivery, returns 202 before forwarding, then upserts into the CRM", async () => {
    const r = await receiveDelivery(store, inbound(body()));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ received: true, duplicate: false, authKeyValid: true });
    expect((await store.crm.list()).length).toBe(0); // not yet: forward is in background
    await r.background;
    const [rec] = await store.crm.list();
    expect(rec).toMatchObject({ dialerLeadId: 204179334, source: "webhook" });
    expect(rec!.properties.firstname).toBe("Peter");
    const [d] = await store.deliveries.list();
    expect(d!.forward).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("logs but does not forward on a wrong authKey", async () => {
    const r = await receiveDelivery(store, inbound(body(), { authKey: "nope" }));
    expect(r.status).toBe(202);
    expect(r.background).toBeNull();
    const [d] = await store.deliveries.list();
    expect(d!.forward.status).toBe("dead");
    expect(d!.authKeyValid).toBe(false);
  });

  it("suppresses a duplicate (same event + lead + timestamp), even across wire formats", async () => {
    await (
      await receiveDelivery(store, inbound(body()))
    ).background;
    const dup = await receiveDelivery(
      store,
      inbound("event=lead_saved&leadId=204179334&timestamp=2026-01-01T00%3A00%3A00Z", { contentType: "application/x-www-form-urlencoded" }),
    );
    expect(dup.body).toMatchObject({ duplicate: true });
    expect(dup.background).toBeNull();
    expect((await store.crm.list()).length).toBe(1);
  });

  it("rejects oversized and unparseable bodies without logging a delivery", async () => {
    expect((await receiveDelivery(store, inbound("x".repeat(MAX_BODY_BYTES + 1)))).status).toBe(413);
    expect((await receiveDelivery(store, inbound("{nope"))).status).toBe(400);
    expect((await store.deliveries.list()).length).toBe(0);
  });

  it("records informational callbacks without a lead as skipped", async () => {
    const r = await receiveDelivery(store, inbound(JSON.stringify({ event: "import_completed", importId: 7, timestamp: "2026-01-01T00:00:00Z" })));
    expect(r.background).toBeNull();
    expect((await store.deliveries.list())[0]!.forward.status).toBe("skipped");
  });
});

describe("forward + retry", () => {
  it("schedules a retry with backoff after a failure and completes on a later retryDue", async () => {
    const r = await receiveDelivery(store, inbound(body(), { failTimes: 2 }));
    await r.background;
    let [d] = await store.deliveries.list();
    expect(d!.forward).toMatchObject({ status: "pending", attempts: 1 });
    expect(Date.parse(d!.forward.nextAttemptAt!) - Date.now()).toBeGreaterThan(BACKOFF_MS[1]! - 500);

    // Not due yet
    expect(await retryDue(store)).toBe(0);

    // Make it due by rewinding nextAttemptAt
    await store.deliveries.put({ ...d!, forward: { ...d!.forward, nextAttemptAt: new Date(0).toISOString() } });
    expect(await retryDue(store)).toBe(1);
    [d] = await store.deliveries.list();
    // failTimes only applies to the inline call; retryDue uses the real downstream.
    expect(d!.forward).toMatchObject({ status: "delivered", attempts: 2 });
    const attempts = (await store.attempts.list()).filter((a) => a.deliveryId === d!.id);
    expect(attempts.map((a) => a.ok).sort()).toEqual([false, true]);
  });

  it("goes dead after MAX_ATTEMPTS and records every attempt", async () => {
    const payload = body({ leadId: 1 }); // lead 1 does not exist -> every forward fails
    await (
      await receiveDelivery(store, inbound(payload))
    ).background;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const [d] = await store.deliveries.list();
      await store.deliveries.put({ ...d!, forward: { ...d!.forward, nextAttemptAt: new Date(0).toISOString() } });
      await retryDue(store);
    }
    const [d] = await store.deliveries.list();
    expect(d!.forward.status).toBe("dead");
    expect(d!.forward.attempts).toBe(MAX_ATTEMPTS);
    expect(d!.forward.lastError).toMatch(/not found/);
    expect(await retryDue(store)).toBe(0);
  });

  it("caps failTimes so a test hook cannot force a dead letter", async () => {
    const r = await receiveDelivery(store, inbound(body(), { failTimes: 99 }));
    await r.background;
    const [d] = await store.deliveries.list();
    expect(d!.forward.status).toBe("pending");
  });
});

describe("CRM upsert", () => {
  const mapping: FieldMapping = { id: 1, name: "m", mappings: { "1": "first_name", "3": "phone_e164" }, lastUpdated: "" };

  it("applies the field mapping and skips unchanged leads", async () => {
    const lead = (await store.getLead(204179334))!;
    const first = await upsertLead(store, lead, mapping, "sync");
    expect(first.action).toBe("create");
    expect(first.record.properties).toMatchObject({ first_name: "Peter", phone_e164: "+45 22 33 44 55", dialer_status: "new" });
    expect(first.record.properties.lastname).toBeUndefined();
    const second = await upsertLead(store, lead, mapping, "sync");
    expect(second.action).toBe("skip");
  });

  it("honours conflict policies against manual CRM edits", async () => {
    const lead = (await store.getLead(204179334))!;
    const { record } = await upsertLead(store, lead, null, "sync");
    await store.crm.put({
      ...record,
      properties: { ...record.properties, firstname: "Edited in CRM" },
      source: "manual",
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await store.putConnector({ ...(await store.getConnector()), conflictPolicy: "crm_wins" });
    expect((await upsertLead(store, lead, null, "sync")).action).toBe("skip");

    await store.putConnector({ ...(await store.getConnector()), conflictPolicy: "last_write_wins" });
    expect((await upsertLead(store, lead, null, "sync")).action).toBe("skip"); // CRM edit is newer

    await store.putConnector({ ...(await store.getConnector()), conflictPolicy: "dialer_wins" });
    const r = await upsertLead(store, lead, null, "sync");
    expect(r.action).toBe("update");
    expect(r.record.properties.firstname).toBe("Peter");
  });
});

describe("router against KvStore", () => {
  it("creates leads with sequential ids and links addContact leads to their contact", async () => {
    const a = await handle({ method: "POST", path: "/leads", query: {}, authorization: AUTH, body: { campaignId: 418, masterData: [] } }, store);
    const b = await handle({ method: "POST", path: "/campaigns/418/addContact", query: {}, authorization: AUTH, body: { contactId: 390001 } }, store);
    const idA = (a.body as { id: number }).id;
    const idB = (b.body as { id: number }).id;
    expect(idB).toBe(idA + 1);
    expect((await store.getLead(idB))!.contactId).toBe(390001);
    expect((await store.getLead(idA))!.contactId).toBeNull();
  });

  it("validates pagination and sort inputs", async () => {
    const q = (query: Record<string, string>) => handle({ method: "GET", path: "/leads", query, authorization: AUTH }, store);
    expect((await q({ pageSize: "abc" })).status).toBe(400);
    expect((await q({ page: "0" })).status).toBe(400);
    expect((await q({ pageSize: "1001" })).status).toBe(400);
    expect((await q({ sortDirection: "down" })).status).toBe(400);
    const sorted = await q({ sortProperty: "nextContactTime", sortDirection: "DESC" });
    const rows = sorted.body as { nextContactTime: string | null }[];
    const nulls = rows.map((r) => r.nextContactTime === null);
    expect(nulls.slice(nulls.indexOf(true)).every(Boolean)).toBe(true); // nulls last
  });
});
