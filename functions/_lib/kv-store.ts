import type { Store } from "../../src/core/mock-api";
import * as seed from "../../src/core/seed";
import type {
  Contact,
  ConnectorConfig,
  CrmRecord,
  FieldMapping,
  ForwardAttempt,
  ImportJob,
  InboundDelivery,
  JourneyRunLog,
  JourneyTrigger,
  Lead,
  ReceivedEvent,
  RequestLogEntry,
  SyncRun,
  Webhook,
} from "../../src/core/types";

export interface Env {
  CONSOLE_KV: KVNamespace;
}

const MAX_LOG = 200;

// A "table" in KV: an index key holding an array of ids plus one key per row.
class Collection<T, K extends string | number> {
  constructor(private readonly kv: KVNamespace, private readonly prefix: string, private readonly idOf: (row: T) => K, private readonly newestFirst = false, private readonly cap?: number) {}
  private get indexKey() { return `${this.prefix}:index`; }
  async ids(): Promise<K[]> { return JSON.parse((await this.kv.get(this.indexKey)) ?? "[]") as K[]; }
  async get(id: K): Promise<T | null> {
    const raw = await this.kv.get(`${this.prefix}:${id}`);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  async list(): Promise<T[]> {
    const rows: (T | null)[] = await Promise.all((await this.ids()).map((id) => this.get(id)));
    return rows.filter((r): r is Awaited<T> => r !== null) as T[];
  }
  async put(row: T): Promise<void> {
    const id = this.idOf(row);
    await this.kv.put(`${this.prefix}:${id}`, JSON.stringify(row));
    const ids = await this.ids();
    if (ids.includes(id)) return;
    const next = this.newestFirst ? [id, ...ids] : [...ids, id];
    await this.kv.put(this.indexKey, JSON.stringify(this.cap ? next.slice(0, this.cap) : next));
  }
  async delete(id: K): Promise<void> {
    await this.kv.delete(`${this.prefix}:${id}`);
    await this.kv.put(this.indexKey, JSON.stringify((await this.ids()).filter((x) => x !== id)));
  }
  async clear(): Promise<void> {
    await Promise.all((await this.ids()).map((id) => this.kv.delete(`${this.prefix}:${id}`)));
    await this.kv.put(this.indexKey, "[]");
  }
}

const DEFAULT_CONNECTOR: ConnectorConfig = { fieldMappingId: null, direction: "dialer_to_crm", conflictPolicy: "last_write_wins", campaignIds: [], overlapSeconds: 300, pageSize: 100 };

// Leads, contacts, imports, webhooks and mappings are mutable, so they live in
// KV; organisation, fields, campaigns, users, pools and sessions come from seed.
export class KvStore implements Store {
  readonly leads: Collection<Lead, number>;
  readonly contacts: Collection<Contact, number>;
  readonly webhooks: Collection<Webhook, number>;
  readonly imports: Collection<ImportJob, number>;
  readonly fieldMappings: Collection<FieldMapping, number>;
  // Console / toolkit side
  readonly events: Collection<ReceivedEvent, string>;
  readonly deliveries: Collection<InboundDelivery, string>;
  readonly attempts: Collection<ForwardAttempt, string>;
  readonly crm: Collection<CrmRecord, string>;
  readonly syncRuns: Collection<SyncRun, string>;
  readonly requestLog: Collection<RequestLogEntry, string>;
  readonly journeys: Collection<JourneyTrigger, string>;
  readonly journeyRuns: Collection<JourneyRunLog, string>;

  constructor(private readonly kv: KVNamespace) {
    this.leads = new Collection(kv, "lead", (l) => l.id);
    this.contacts = new Collection(kv, "contact", (c) => c.id);
    this.webhooks = new Collection(kv, "webhook", (w) => w.id);
    this.imports = new Collection(kv, "import", (i) => i.id);
    this.fieldMappings = new Collection(kv, "mapping", (m) => m.id);
    this.events = new Collection(kv, "event", (e) => e.id, true, 100);
    this.deliveries = new Collection(kv, "delivery", (d) => d.id, true, MAX_LOG);
    this.attempts = new Collection(kv, "attempt", (a) => a.id, true, MAX_LOG * 3);
    this.crm = new Collection(kv, "crm", (r) => r.id);
    this.syncRuns = new Collection(kv, "syncrun", (r) => r.id, true, 50);
    this.requestLog = new Collection(kv, "reqlog", (r) => r.id, true, MAX_LOG);
    this.journeys = new Collection(kv, "journey", (j) => j.id);
    this.journeyRuns = new Collection(kv, "journeyrun", (r) => r.id, true, MAX_LOG);
  }

  async ensureSeeded(): Promise<void> {
    if (await this.kv.get("seeded")) return;
    for (const l of seed.buildLeads()) await this.leads.put(l);
    for (const c of seed.buildContacts()) await this.contacts.put(c);
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

  // ---- Store interface (used by the pure router) ----
  listLeads() { return this.leads.list(); }
  getLead(id: number) { return this.leads.get(id); }
  putLead(lead: Lead) { return this.leads.put(lead); }
  deleteLead(id: number) { return this.leads.delete(id); }
  listWebhooks() { return this.webhooks.list(); }
  putWebhook(w: Webhook) { return this.webhooks.put(w); }
  deleteWebhook(id: number) { return this.webhooks.delete(id); }
  listContacts() { return this.contacts.list(); }
  getContact(id: number) { return this.contacts.get(id); }
  putContact(c: Contact) { return this.contacts.put(c); }
  deleteContact(id: number) { return this.contacts.delete(id); }
  listImports() { return this.imports.list(); }
  getImport(id: number) { return this.imports.get(id); }
  putImport(j: ImportJob) { return this.imports.put(j); }
  listFieldMappings() { return this.fieldMappings.list(); }
  putFieldMapping(m: FieldMapping) { return this.fieldMappings.put(m); }
  deleteFieldMapping(id: number) { return this.fieldMappings.delete(id); }

  // ---- console event log (kept for the simple front page) ----
  pushEvent(e: ReceivedEvent) { return this.events.put(e); }
  listEvents() { return this.events.list(); }

  // ---- toolkit scalars ----
  async getConnector(): Promise<ConnectorConfig> {
    const raw = await this.kv.get("connector");
    return raw ? { ...DEFAULT_CONNECTOR, ...(JSON.parse(raw) as Partial<ConnectorConfig>) } : DEFAULT_CONNECTOR;
  }
  putConnector(c: ConnectorConfig) { return this.kv.put("connector", JSON.stringify(c)); }
  async getCursor(): Promise<string | null> { return this.kv.get("sync:cursor"); }
  putCursor(iso: string) { return this.kv.put("sync:cursor", iso); }
  async hasIdempotencyKey(key: string): Promise<boolean> { return (await this.kv.get(`idem:${key}`)) !== null; }
  putIdempotencyKey(key: string, deliveryId: string) { return this.kv.put(`idem:${key}`, deliveryId, { expirationTtl: 7 * 24 * 3600 }); }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
