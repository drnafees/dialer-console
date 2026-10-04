import type { Store } from "../../src/core/mock-api";
import * as seed from "../../src/core/seed";
import type { Lead, ReceivedEvent, Webhook } from "../../src/core/types";

export interface Env {
  CONSOLE_KV: KVNamespace;
}

const MAX_EVENTS = 100;

// Leads and webhooks are mutable, so they live in KV; everything else is read from seed.
export class KvStore implements Store {
  constructor(private readonly kv: KVNamespace) {}

  async ensureSeeded(): Promise<void> {
    if (await this.kv.get("seeded")) return;
    const leads = seed.buildLeads();
    await Promise.all(leads.map((l) => this.kv.put(`lead:${l.id}`, JSON.stringify(l))));
    await this.kv.put("lead:index", JSON.stringify(leads.map((l) => l.id)));
    await this.kv.put("webhook:index", "[]");
    await this.kv.put("event:index", "[]");
    await this.kv.put("seeded", new Date().toISOString());
  }

  async reset(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ cursor });
      await Promise.all(page.keys.map((k) => this.kv.delete(k.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    await this.ensureSeeded();
  }

  private async index(key: string): Promise<number[]> {
    return JSON.parse((await this.kv.get(key)) ?? "[]") as number[];
  }

  private async setIndex(key: string, ids: number[]): Promise<void> {
    await this.kv.put(key, JSON.stringify(ids));
  }

  async listLeads(): Promise<Lead[]> {
    const ids = await this.index("lead:index");
    const rows = await Promise.all(ids.map((id) => this.getLead(id)));
    return rows.filter((l): l is Lead => l !== null);
  }

  async getLead(id: number): Promise<Lead | null> {
    const raw = await this.kv.get(`lead:${id}`);
    return raw ? (JSON.parse(raw) as Lead) : null;
  }

  async putLead(lead: Lead): Promise<void> {
    await this.kv.put(`lead:${lead.id}`, JSON.stringify(lead));
    const ids = await this.index("lead:index");
    if (!ids.includes(lead.id)) await this.setIndex("lead:index", [...ids, lead.id]);
  }

  async deleteLead(id: number): Promise<void> {
    await this.kv.delete(`lead:${id}`);
    await this.setIndex("lead:index", (await this.index("lead:index")).filter((x) => x !== id));
  }

  async listWebhooks(): Promise<Webhook[]> {
    const ids = await this.index("webhook:index");
    const rows = await Promise.all(ids.map(async (id) => JSON.parse((await this.kv.get(`webhook:${id}`)) ?? "null") as Webhook | null));
    return rows.filter((w): w is Webhook => w !== null);
  }

  async putWebhook(webhook: Webhook): Promise<void> {
    await this.kv.put(`webhook:${webhook.id}`, JSON.stringify(webhook));
    const ids = await this.index("webhook:index");
    if (!ids.includes(webhook.id)) await this.setIndex("webhook:index", [...ids, webhook.id]);
  }

  async deleteWebhook(id: number): Promise<void> {
    await this.kv.delete(`webhook:${id}`);
    await this.setIndex("webhook:index", (await this.index("webhook:index")).filter((x) => x !== id));
  }

  async pushEvent(event: ReceivedEvent): Promise<void> {
    await this.kv.put(`event:${event.id}`, JSON.stringify(event));
    const ids = JSON.parse((await this.kv.get("event:index")) ?? "[]") as string[];
    await this.kv.put("event:index", JSON.stringify([event.id, ...ids].slice(0, MAX_EVENTS)));
  }

  async listEvents(): Promise<ReceivedEvent[]> {
    const ids = JSON.parse((await this.kv.get("event:index")) ?? "[]") as string[];
    const rows = await Promise.all(ids.map(async (id) => JSON.parse((await this.kv.get(`event:${id}`)) ?? "null") as ReceivedEvent | null));
    return rows.filter((e): e is ReceivedEvent => e !== null);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
