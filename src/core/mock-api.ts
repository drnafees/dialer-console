import { mergePairs, pairsToRecord, recordToPairs, type IdKind } from "./data";
import { planImport } from "./import-pipeline";
import { matchKey } from "./normalize";
import * as seed from "./seed";
import {
  AddContactSchema,
  ContactPatchSchema,
  ContactWriteSchema,
  FieldMappingWriteSchema,
  ImportCreateSchema,
  ImportInsertSchema,
  LeadWriteSchema,
  WebhookWriteSchema,
  type Contact,
  type FieldMapping,
  type ImportJob,
  type Lead,
  type LeadStatus,
  type Meta,
  type Webhook,
  type WebhookEvent,
} from "./types";

export const DEMO_USERNAME = "demo";
export const DEMO_PASSWORD = "demo";

export interface Store {
  listLeads(): Promise<Lead[]>;
  getLead(id: number): Promise<Lead | null>;
  putLead(lead: Lead): Promise<void>;
  deleteLead(id: number): Promise<void>;
  listWebhooks(): Promise<Webhook[]>;
  putWebhook(webhook: Webhook): Promise<void>;
  deleteWebhook(id: number): Promise<void>;
  listContacts(): Promise<Contact[]>;
  getContact(id: number): Promise<Contact | null>;
  putContact(contact: Contact): Promise<void>;
  deleteContact(id: number): Promise<void>;
  listImports(): Promise<ImportJob[]>;
  getImport(id: number): Promise<ImportJob | null>;
  putImport(job: ImportJob): Promise<void>;
  listFieldMappings(): Promise<FieldMapping[]>;
  putFieldMapping(mapping: FieldMapping): Promise<void>;
  deleteFieldMapping(id: number): Promise<void>;
  // Monotonic id per entity kind; never reuses a value within a store.
  nextId(kind: IdKind): Promise<number>;
}

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  authorization?: string | null;
  // Absolute URL of the list endpoint, used to build firstUrl/nextUrl in meta.
  baseUrl?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface Emitted {
  event: WebhookEvent;
  lead: Lead;
}

export interface ApiResult extends ApiResponse {
  emitted: Emitted[];
  // Imports whose processing the adapter should kick off in the background.
  startedImports?: number[];
}

const err = (status: number, message: string): ApiResult => ({ status, body: { code: status, message }, emitted: [] });
const ok = (body: unknown, emitted: Emitted[] = [], status = 200): ApiResult => ({ status, body, emitted });
const zodMessage = (issues: { path: PropertyKey[]; message: string }[]) => issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
const fieldMap = () => new Map(seed.fields.map((f) => [f.id, f]));

export function checkBasicAuth(header: string | null | undefined): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const [user, pass] = atob(header.slice(6)).split(":");
    return user === DEMO_USERNAME && pass === DEMO_PASSWORD;
  } catch {
    return false;
  }
}

// Filters mirror the upstream API: filters={"status":{"$eq":"success"},"lastModifiedTime":{"$gt":"..."}}
type Op = "$eq" | "$neq" | "$gt" | "$lt" | "$c" | "$nc";
type Filters = Record<string, Partial<Record<Op, string | number | boolean>>>;

export function parseFilters(raw: string | undefined): Filters | Error {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Error("filters must be a JSON object");
    return parsed as Filters;
  } catch {
    return new Error("filters is not valid JSON");
  }
}

// Numbers compare numerically, everything else (incl. ISO datetimes) as strings.
function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b !== "boolean" && !Number.isNaN(Number(b))) return a - Number(b);
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function matchesFilters<T extends object>(row: T, filters: Filters): boolean {
  return Object.entries(filters).every(([prop, ops]) => {
    const value = (row as Record<string, unknown>)[prop];
    return Object.entries(ops).every(([op, expected]) => {
      switch (op as Op) {
        case "$eq":
          return String(value) === String(expected);
        case "$neq":
          return String(value) !== String(expected);
        case "$gt":
          return value !== null && value !== undefined && compare(value, expected) > 0;
        case "$lt":
          return value !== null && value !== undefined && compare(value, expected) < 0;
        case "$c":
          return String(value ?? "")
            .toLowerCase()
            .includes(String(expected).toLowerCase());
        case "$nc":
          return !String(value ?? "")
            .toLowerCase()
            .includes(String(expected).toLowerCase());
        default:
          return false;
      }
    });
  });
}

function parsePositiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

function list<T extends object>(rows: T[], key: string, query: Record<string, string>, baseUrl?: string): ApiResult {
  const filters = parseFilters(query.filters);
  if (filters instanceof Error) return err(400, filters.message);
  // $in is only accepted by POST /contacts/findByData upstream.
  for (const ops of Object.values(filters)) if ("$in" in ops) return err(400, "Operator $in is not supported on this endpoint");
  let out = rows.filter((r) => matchesFilters(r, filters));

  if (query.sortDirection && query.sortDirection !== "ASC" && query.sortDirection !== "DESC") return err(400, "sortDirection must be ASC or DESC");
  if (query.sortProperty) {
    const prop = query.sortProperty;
    const dir = query.sortDirection === "DESC" ? -1 : 1;
    // Nulls sort last regardless of direction, like most SQL engines' NULLS LAST.
    out = [...out].sort((a, b) => {
      const av = (a as Record<string, unknown>)[prop];
      const bv = (b as Record<string, unknown>)[prop];
      const an = av === null || av === undefined;
      const bn = bv === null || bv === undefined;
      if (an || bn) return an && bn ? 0 : an ? 1 : -1;
      return compare(av, bv) * dir;
    });
  }

  const pageSize = parsePositiveInt(query.pageSize, 1000);
  const page = parsePositiveInt(query.page, 1);
  if (pageSize === null) return err(400, "pageSize must be an integer between 1 and 1000");
  if (page === null) return err(400, "page must be a positive integer");
  if (pageSize > 1000) return err(400, "pageSize must be an integer between 1 and 1000");
  const total = out.length;
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const slice = out.slice((page - 1) * pageSize, page * pageSize);

  if (query.includeMeta === "true") {
    const pageUrl = (p: number) => {
      if (!baseUrl) return undefined;
      const u = new URL(baseUrl);
      for (const [k, v] of Object.entries(query)) if (k !== "page") u.searchParams.set(k, v);
      if (p > 1) u.searchParams.set("page", String(p));
      return u.toString();
    };
    const meta: Meta = { pagination: { page, pageCount, pageSize, total } };
    if (baseUrl) {
      meta.pagination.firstUrl = pageUrl(1);
      meta.pagination.previousUrl = page > 1 ? pageUrl(page - 1) : null;
      meta.pagination.nextUrl = page < pageCount ? pageUrl(page + 1) : null;
      meta.pagination.lastUrl = pageUrl(pageCount);
    }
    return ok({ meta, [key]: slice });
  }
  return ok(slice);
}

const contactData = (c: Contact) => pairsToRecord(c.data);
const toPairs = recordToPairs;
const mergeData = (current: Contact["data"], incoming: Record<string, string>) => mergePairs(current, recordToPairs(incoming));

// Place a contact on a campaign: creates a lead whose masterData is the
// contact's data restricted to the campaign's master fields.
async function addContactToCampaign(store: Store, contact: Contact, campaignId: number, status: LeadStatus): Promise<Lead> {
  const campaign = seed.campaigns.find((c) => c.id === campaignId)!;
  const allowed = new Set(campaign.masterFields.map((f) => f.id));
  const now = new Date().toISOString();
  const lead: Lead = {
    id: await store.nextId("lead"),
    contactId: contact.id,
    campaignId,
    contactAttempts: 0,
    lastModifiedTime: now,
    nextContactTime: null,
    importedTime: now,
    lastContactedBy: null,
    status,
    active: true,
    externalId: contact.externalId && /^\d+$/.test(contact.externalId) ? Number(contact.externalId) : null,
    masterData: contact.data.filter((p) => allowed.has(p.id)),
    resultData: [],
  };
  await store.putLead(lead);
  return lead;
}

// Run a started import to completion. Called by the adapter in the background
// (waitUntil) so POST /imports/{id}/start can return immediately like upstream.
export async function processImport(id: number, store: Store): Promise<{ job: ImportJob; emitted: Emitted[] }> {
  const job = await store.getImport(id);
  if (!job) throw new Error(`Import ${id} not found`);
  await store.putImport({ ...job, status: "processing" });
  const emitted: Emitted[] = [];
  try {
    const plan = planImport(job, await store.listContacts(), fieldMap());
    const result = { inserted: 0, updated: 0, duplicates: 0, addedToCampaign: 0, errors: [] as string[] };
    const now = new Date().toISOString();
    for (const row of plan.rows) {
      if (row.action === "duplicate" || row.action === "blacklisted") {
        result.duplicates++;
        continue;
      }
      let contact: Contact;
      if (row.action === "update") {
        const existing = (await store.getContact(row.existingId!))!;
        const patch = Object.fromEntries(Object.entries(row.changes).map(([k, v]) => [k, v.to]));
        contact = { ...existing, data: mergeData(existing.data, patch), lastModifiedTime: now };
        result.updated++;
      } else {
        contact = { id: await store.nextId("contact"), poolId: job.poolId, externalId: null, created: now, lastModifiedTime: now, data: toPairs(row.data) };
        result.inserted++;
      }
      await store.putContact(contact);
      if (job.onImportedAction) {
        const lead = await addContactToCampaign(store, contact, job.onImportedAction.campaignId, "new");
        emitted.push({ event: "leads_inserted", lead });
        result.addedToCampaign++;
      }
    }
    const done: ImportJob = { ...job, status: "completed", started: job.started ?? now, completed: new Date().toISOString(), result };
    await store.putImport(done);
    return { job: done, emitted };
  } catch (e) {
    const failed: ImportJob = {
      ...job,
      status: "failed",
      completed: new Date().toISOString(),
      result: { inserted: 0, updated: 0, duplicates: 0, addedToCampaign: 0, errors: [String(e)] },
    };
    await store.putImport(failed);
    return { job: failed, emitted };
  }
}

// The public shape of an import: rows are not echoed back.
const publicImport = ({ rows, ...job }: ImportJob) => ({ ...job, rowCount: rows.length });

const CLOSED_STATUSES = new Set<LeadStatus>(["success", "notInterested", "invalid", "unqualified"]);

const CLOSE_EVENT: Partial<Record<LeadStatus, WebhookEvent>> = {
  success: "leadClosedSuccess",
  notInterested: "leadClosedNotInterested",
  invalid: "leadClosedInvalid",
  unqualified: "leadClosedUnqualified",
  automaticRedial: "leadClosedAutomaticRedial",
  privateRedial: "leadClosedPrivateRedial",
};

export async function handle(req: ApiRequest, store: Store): Promise<ApiResult> {
  if (!checkBasicAuth(req.authorization)) return { status: 401, body: { status: "error", message: "Authentication failed" }, emitted: [] };

  const path = req.path.replace(/\/+$/, "");
  const m = (pattern: RegExp) => path.match(pattern);
  const idOf = (match: RegExpMatchArray) => Number(match[1]);
  let match: RegExpMatchArray | null;

  if (path === "/organization" && req.method === "GET") return ok(seed.organization);
  if (path === "/fields" && req.method === "GET") return list(seed.fields, "fields", req.query, req.baseUrl);
  if (path === "/users" && req.method === "GET") return list(seed.users, "users", req.query, req.baseUrl);
  if (path === "/campaigns" && req.method === "GET")
    return list(
      seed.campaigns.map(({ id, settings }) => ({ id, settings })),
      "campaigns",
      req.query,
      req.baseUrl,
    );
  if ((match = m(/^\/campaigns\/(\d+)$/)) && req.method === "GET") {
    const campaign = seed.campaigns.find((c) => c.id === idOf(match!));
    return campaign ? ok(campaign) : err(404, "Campaign not found");
  }
  if (path === "/sessions" && req.method === "GET") return list(seed.buildSessions(), "sessions", req.query, req.baseUrl);

  if (path === "/leads" && req.method === "GET") return list(await store.listLeads(), "leads", req.query, req.baseUrl);
  if (path === "/leads" && req.method === "POST") {
    const parsed = LeadWriteSchema.safeParse(req.body);
    if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
    if (!parsed.data.campaignId) return err(400, "campaignId is required");
    if (!seed.campaigns.some((c) => c.id === parsed.data.campaignId)) return err(400, "Unknown campaignId");
    const now = new Date().toISOString();
    const lead: Lead = {
      id: await store.nextId("lead"),
      contactId: null,
      campaignId: parsed.data.campaignId,
      contactAttempts: 0,
      lastModifiedTime: now,
      nextContactTime: parsed.data.nextContactTime ?? null,
      importedTime: now,
      lastContactedBy: null,
      status: parsed.data.status ?? "new",
      active: parsed.data.active ?? true,
      externalId: parsed.data.externalId ?? null,
      masterData: parsed.data.masterData ?? [],
      resultData: parsed.data.resultData ?? [],
    };
    await store.putLead(lead);
    return ok({ id: lead.id }, [{ event: "leads_inserted", lead }]);
  }
  if ((match = m(/^\/leads\/(\d+)$/))) {
    const lead = await store.getLead(idOf(match));
    if (!lead) return err(404, "Lead not found");
    if (req.method === "GET") return ok(lead);
    if (req.method === "DELETE") {
      await store.deleteLead(lead.id);
      return ok({ code: 200, message: "Lead deleted" });
    }
    if (req.method === "PUT") {
      const parsed = LeadWriteSchema.safeParse(req.body);
      if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
      const before = lead.status;
      const status = parsed.data.status ?? lead.status;
      const updated: Lead = {
        ...lead,
        status,
        active: parsed.data.active ?? (parsed.data.status ? !CLOSED_STATUSES.has(status) : lead.active),
        externalId: parsed.data.externalId === undefined ? lead.externalId : parsed.data.externalId,
        nextContactTime: parsed.data.nextContactTime === undefined ? lead.nextContactTime : parsed.data.nextContactTime,
        masterData: mergePairs(lead.masterData, parsed.data.masterData),
        resultData: mergePairs(lead.resultData, parsed.data.resultData),
        lastModifiedTime: new Date().toISOString(),
        contactAttempts: parsed.data.status && parsed.data.status !== lead.status ? lead.contactAttempts + 1 : lead.contactAttempts,
      };
      await store.putLead(updated);
      const emitted: Emitted[] = [{ event: "lead_saved", lead: updated }];
      const closeEvent = CLOSE_EVENT[updated.status];
      if (closeEvent && updated.status !== before) emitted.push({ event: closeEvent, lead: updated });
      return ok({ code: 200, message: "Lead updated" }, emitted);
    }
  }

  // ---- pools & contacts ----------------------------------------------------
  if (path === "/pools" && req.method === "GET") return list(seed.pools, "pools", req.query, req.baseUrl);
  if ((match = m(/^\/pools\/(\d+)$/)) && req.method === "GET") {
    const pool = seed.pools.find((p) => p.id === idOf(match!));
    return pool ? ok(pool) : err(404, "Pool not found");
  }
  if (path === "/contacts" && req.method === "GET") return list(await store.listContacts(), "contacts", req.query, req.baseUrl);
  if (path === "/contacts" && req.method === "POST") {
    const parsed = ContactWriteSchema.safeParse(req.body);
    if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
    if (!seed.pools.some((p) => p.id === parsed.data.poolId)) return err(400, "Unknown poolId");
    const now = new Date().toISOString();
    const contact: Contact = {
      id: await store.nextId("contact"),
      poolId: parsed.data.poolId,
      externalId: parsed.data.externalId ?? null,
      created: now,
      lastModifiedTime: now,
      data: toPairs(parsed.data.data),
    };
    await store.putContact(contact);
    return ok({ id: contact.id });
  }
  if (path === "/contacts/findByData" && req.method === "POST") {
    // Body keys are field ids; values are a scalar ($eq) or {$in: [...]}.
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return err(400, "Body must be an object keyed by field id");
    const fields = fieldMap();
    const criteria = Object.entries(req.body as Record<string, unknown>);
    for (const [k, v] of criteria) {
      if (!/^\d+$/.test(k)) return err(400, `Key "${k}" is not a field id`);
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((op) => op !== "$eq" && op !== "$in"))
        return err(400, "Only $eq and $in are allowed");
    }
    const contacts = (await store.listContacts()).filter((c) => {
      const data = contactData(c);
      return criteria.every(([k, v]) => {
        const field = fields.get(Number(k));
        const norm = (x: unknown) => matchKey({ [k]: String(x) }, [Number(k)], fields) ?? "";
        const actual = norm(data[k] ?? "");
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const ops = v as { $eq?: unknown; $in?: unknown[] };
          if (ops.$in) return ops.$in.some((x) => norm(x) === actual);
          return norm(ops.$eq) === actual;
        }
        void field;
        return norm(v) === actual;
      });
    });
    return list(contacts, "contacts", { ...req.query, filters: "" }, req.baseUrl);
  }
  if ((match = m(/^\/contacts\/(\d+)$/))) {
    const contact = await store.getContact(idOf(match));
    if (!contact) return err(404, "Contact not found");
    if (req.method === "GET") return ok(contact);
    if (req.method === "DELETE") {
      await store.deleteContact(contact.id);
      return ok({ code: 200, message: "Contact deleted" });
    }
    if (req.method === "PATCH") {
      const parsed = ContactPatchSchema.safeParse(req.body);
      if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
      const updated: Contact = {
        ...contact,
        poolId: parsed.data.poolId ?? contact.poolId,
        externalId: parsed.data.externalId === undefined ? contact.externalId : parsed.data.externalId,
        data: parsed.data.data ? mergeData(contact.data, parsed.data.data) : contact.data,
        lastModifiedTime: new Date().toISOString(),
      };
      await store.putContact(updated);
      return ok({ code: 200, message: "Contact updated" });
    }
  }
  if ((match = m(/^\/contacts-external\/([^/]+)$/)) && req.method === "PATCH") {
    const externalId = decodeURIComponent(match[1]!);
    const parsed = ContactPatchSchema.safeParse(req.body);
    if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
    const contact = (await store.listContacts()).find((c) => c.externalId === externalId && (!parsed.data.poolId || c.poolId === parsed.data.poolId));
    if (!contact) return err(404, "Contact not found");
    const updated: Contact = {
      ...contact,
      data: parsed.data.data ? mergeData(contact.data, parsed.data.data) : contact.data,
      lastModifiedTime: new Date().toISOString(),
    };
    await store.putContact(updated);
    // Keep any leads created from this contact in sync, as the upstream does.
    const emitted: Emitted[] = [];
    if (parsed.data.data) {
      for (const lead of await store.listLeads()) {
        if (lead.contactId !== contact.id) continue;
        const synced: Lead = { ...lead, masterData: mergePairs(lead.masterData, toPairs(parsed.data.data)), lastModifiedTime: updated.lastModifiedTime };
        await store.putLead(synced);
        emitted.push({ event: "lead_saved", lead: synced });
      }
    }
    return ok({ code: 200, message: "Contact updated", contactId: contact.id }, emitted);
  }
  if ((match = m(/^\/campaigns\/(\d+)\/addContact$/)) && req.method === "POST") {
    const campaign = seed.campaigns.find((c) => c.id === idOf(match!));
    if (!campaign) return err(404, "Campaign not found");
    const parsed = AddContactSchema.safeParse(req.body);
    if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
    const contact = await store.getContact(parsed.data.contactId);
    if (!contact) return err(400, "Unknown contactId");
    const lead = await addContactToCampaign(store, contact, campaign.id, parsed.data.status);
    return ok({ id: lead.id }, [{ event: "leads_inserted", lead }]);
  }

  // ---- imports -------------------------------------------------------------
  if (path === "/imports" && req.method === "POST") {
    const parsed = ImportCreateSchema.safeParse(req.body);
    if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
    if (!seed.pools.some((p) => p.id === parsed.data.poolId)) return err(400, "Unknown poolId");
    if (parsed.data.onImportedAction && !seed.campaigns.some((c) => c.id === parsed.data.onImportedAction!.campaignId))
      return err(400, "Unknown campaignId in onImportedAction");
    const fields = fieldMap();
    const unknown = [...parsed.data.match.fields, ...parsed.data.updateFields].find((id) => !fields.has(id));
    if (unknown !== undefined) return err(400, `Unknown field id ${unknown}`);
    const job: ImportJob = {
      id: await store.nextId("import"),
      ...parsed.data,
      status: "created",
      created: new Date().toISOString(),
      started: null,
      completed: null,
      rows: [],
      result: null,
    };
    await store.putImport(job);
    return ok({ id: job.id });
  }
  if (path === "/imports" && req.method === "GET") return list((await store.listImports()).map(publicImport), "imports", req.query, req.baseUrl);
  // The upstream spec spells these "/imports{id}/insert" (missing slash); accept both.
  if ((match = m(/^\/imports\/?(\d+)(?:\/(insert|start))?$/))) {
    const job = await store.getImport(idOf(match));
    if (!job) return err(404, "Import not found");
    const action = match[2];
    if (!action && req.method === "GET") return ok(publicImport(job));
    if (action === "insert" && req.method === "POST") {
      if (job.status !== "created") return err(409, `Import is ${job.status}; rows can only be added before start`);
      const parsed = ImportInsertSchema.safeParse(req.body);
      if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
      const fields = fieldMap();
      for (const [i, row] of parsed.data.entries()) {
        const bad = Object.keys(row.data).find((k) => !/^\d+$/.test(k) || !fields.has(Number(k)));
        if (bad) return err(400, `Row ${i}: unknown field id "${bad}"`);
      }
      await store.putImport({ ...job, rows: [...job.rows, ...parsed.data.map((r) => r.data)] });
      return ok({ code: 200, message: `${parsed.data.length} rows inserted`, rowCount: job.rows.length + parsed.data.length });
    }
    if (action === "start" && req.method === "POST") {
      if (job.status !== "created") return err(409, `Import is already ${job.status}`);
      if (!job.rows.length) return err(400, "Import has no rows");
      await store.putImport({ ...job, status: "queued", started: new Date().toISOString() });
      return { ...ok({ code: 200, message: "Import queued" }), startedImports: [job.id] };
    }
  }

  // ---- field mappings ------------------------------------------------------
  if (path === "/field-mappings" && req.method === "GET") return list(await store.listFieldMappings(), "fieldMappings", req.query, req.baseUrl);
  if (path === "/field-mappings" && req.method === "POST") {
    const parsed = FieldMappingWriteSchema.safeParse(req.body);
    if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
    const fields = fieldMap();
    const bad = Object.keys(parsed.data.mappings).find((k) => !fields.has(Number(k)));
    if (bad) return err(400, `Unknown field id ${bad}`);
    const mapping: FieldMapping = { id: await store.nextId("mapping"), ...parsed.data, lastUpdated: new Date().toISOString() };
    await store.putFieldMapping(mapping);
    return ok({ id: mapping.id });
  }
  if ((match = m(/^\/field-mappings\/(\d+)$/))) {
    const mapping = (await store.listFieldMappings()).find((f) => f.id === idOf(match!));
    if (!mapping) return err(404, "Field mapping not found");
    if (req.method === "GET") return ok(mapping);
    if (req.method === "DELETE") {
      await store.deleteFieldMapping(mapping.id);
      return ok({ code: 200, message: "Field mapping deleted" });
    }
    if (req.method === "PUT") {
      const parsed = FieldMappingWriteSchema.partial().safeParse(req.body);
      if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
      const fields = fieldMap();
      const bad = Object.keys(parsed.data.mappings ?? {}).find((k) => !fields.has(Number(k)));
      if (bad) return err(400, `Unknown field id ${bad}`);
      await store.putFieldMapping({ ...mapping, ...parsed.data, lastUpdated: new Date().toISOString() });
      return ok({ code: 200, message: "Field mapping updated" });
    }
  }

  // ---- webhooks ------------------------------------------------------------
  if (path === "/webhooks" && req.method === "GET") return list(await store.listWebhooks(), "webhooks", req.query, req.baseUrl);
  if (path === "/webhooks" && req.method === "POST") {
    const parsed = WebhookWriteSchema.safeParse(req.body);
    if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
    if (parsed.data.template && parsed.data.event !== "lead_saved") return err(400, "template is only supported for the lead_saved event");
    const now = new Date().toISOString();
    const webhook: Webhook = { id: await store.nextId("webhook"), ...parsed.data, created: now, updated: now };
    await store.putWebhook(webhook);
    return ok({ id: webhook.id });
  }
  if ((match = m(/^\/webhooks\/(\d+)$/))) {
    const webhook = (await store.listWebhooks()).find((w) => w.id === idOf(match!));
    if (!webhook) return err(404, "Webhook not found");
    if (req.method === "GET") return ok(webhook);
    if (req.method === "DELETE") {
      await store.deleteWebhook(webhook.id);
      return ok({ code: 200, message: "Webhook deleted" });
    }
    if (req.method === "PUT") {
      const parsed = WebhookWriteSchema.partial().safeParse(req.body);
      if (!parsed.success) return err(400, zodMessage(parsed.error.issues));
      const updated: Webhook = { ...webhook, ...parsed.data, updated: new Date().toISOString() };
      if (updated.template && updated.event !== "lead_saved") return err(400, "template is only supported for the lead_saved event");
      await store.putWebhook(updated);
      return ok({ code: 200, message: "Webhook updated" });
    }
  }

  return err(404, `No route for ${req.method} ${path}`);
}

// Resolves [fieldId] merge tags in a lead_saved template, as described in the upstream spec.
// Besides [fieldId], the vendor's help centre documents [status], [last_called_by] and [lead_id].
export function applyTemplate(template: Record<string, unknown> | undefined, lead: Lead): Record<string, unknown> | undefined {
  if (!template) return undefined;
  const values = new Map([...lead.masterData, ...lead.resultData].map((p) => [p.id, p.value]));
  const special: Record<string, string> = {
    status: lead.status,
    last_called_by: lead.lastContactedBy === null ? "" : String(lead.lastContactedBy),
    lead_id: String(lead.id),
  };
  const resolve = (v: unknown): unknown => {
    if (typeof v === "string")
      return v.replace(/\[(\d+|status|last_called_by|lead_id)\]/g, (_, tag: string) => (/^\d+$/.test(tag) ? (values.get(Number(tag)) ?? "") : special[tag]!));
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  return resolve(template) as Record<string, unknown>;
}
