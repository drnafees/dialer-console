import * as seed from "./seed";
import { LeadWriteSchema, WebhookWriteSchema, type Lead, type LeadStatus, type Meta, type Webhook, type WebhookEvent } from "./types";

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
}

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  authorization?: string | null;
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
}

const err = (status: number, message: string): ApiResult => ({ status, body: { code: status, message }, emitted: [] });
const ok = (body: unknown, emitted: Emitted[] = [], status = 200): ApiResult => ({ status, body, emitted });

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
        case "$eq": return String(value) === String(expected);
        case "$neq": return String(value) !== String(expected);
        case "$gt": return value !== null && value !== undefined && compare(value, expected) > 0;
        case "$lt": return value !== null && value !== undefined && compare(value, expected) < 0;
        case "$c": return String(value ?? "").toLowerCase().includes(String(expected).toLowerCase());
        case "$nc": return !String(value ?? "").toLowerCase().includes(String(expected).toLowerCase());
        default: return false;
      }
    });
  });
}

function list<T extends object>(rows: T[], key: string, query: Record<string, string>): ApiResult {
  const filters = parseFilters(query.filters);
  if (filters instanceof Error) return err(400, filters.message);
  let out = rows.filter((r) => matchesFilters(r, filters));

  if (query.sortProperty) {
    const prop = query.sortProperty;
    const dir = query.sortDirection === "DESC" ? -1 : 1;
    out = [...out].sort((a, b) => {
      const av = (a as Record<string, unknown>)[prop] as never;
      const bv = (b as Record<string, unknown>)[prop] as never;
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  const pageSize = Math.min(Math.max(Number(query.pageSize ?? 1000), 1), 1000);
  const page = Math.max(Number(query.page ?? 1), 1);
  const total = out.length;
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const slice = out.slice((page - 1) * pageSize, page * pageSize);

  if (query.includeMeta === "true") {
    const meta: Meta = { pagination: { page, pageCount, pageSize, total } };
    return ok({ meta, [key]: slice });
  }
  return ok(slice);
}

const CLOSED_STATUSES = new Set<LeadStatus>(["success", "notInterested", "invalid", "unqualified"]);

const CLOSE_EVENT: Partial<Record<LeadStatus, WebhookEvent>> = {
  success: "leadClosedSuccess",
  notInterested: "leadClosedNotInterested",
  invalid: "leadClosedInvalid",
  unqualified: "leadClosedUnqualified",
  automaticRedial: "leadClosedAutomaticRedial",
  privateRedial: "leadClosedPrivateRedial",
};

function mergePairs(current: { id: number; value: string }[], incoming: { id: number; value: string }[] | undefined) {
  if (!incoming) return current;
  const map = new Map(current.map((p) => [p.id, p.value]));
  for (const p of incoming) map.set(p.id, p.value);
  return [...map.entries()].map(([id, value]) => ({ id, value }));
}

export async function handle(req: ApiRequest, store: Store): Promise<ApiResult> {
  if (!checkBasicAuth(req.authorization)) return { status: 401, body: { status: "error", message: "Authentication failed" }, emitted: [] };

  const path = req.path.replace(/\/+$/, "");
  const m = (pattern: RegExp) => path.match(pattern);
  const idOf = (match: RegExpMatchArray) => Number(match[1]);
  let match: RegExpMatchArray | null;

  if (path === "/organization" && req.method === "GET") return ok(seed.organization);
  if (path === "/fields" && req.method === "GET") return list(seed.fields, "fields", req.query);
  if (path === "/users" && req.method === "GET") return list(seed.users, "users", req.query);
  if (path === "/campaigns" && req.method === "GET") return list(seed.campaigns.map(({ id, settings }) => ({ id, settings })), "campaigns", req.query);
  if ((match = m(/^\/campaigns\/(\d+)$/)) && req.method === "GET") {
    const campaign = seed.campaigns.find((c) => c.id === idOf(match!));
    return campaign ? ok(campaign) : err(404, "Campaign not found");
  }
  if (path === "/sessions" && req.method === "GET") return list(seed.buildSessions(), "sessions", req.query);

  if (path === "/leads" && req.method === "GET") return list(await store.listLeads(), "leads", req.query);
  if (path === "/leads" && req.method === "POST") {
    const parsed = LeadWriteSchema.safeParse(req.body);
    if (!parsed.success) return err(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    if (!parsed.data.campaignId) return err(400, "campaignId is required");
    if (!seed.campaigns.some((c) => c.id === parsed.data.campaignId)) return err(400, "Unknown campaignId");
    const now = new Date().toISOString();
    const lead: Lead = {
      id: 204200000 + Math.floor(Math.random() * 99999),
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
      if (!parsed.success) return err(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
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

  if (path === "/webhooks" && req.method === "GET") return list(await store.listWebhooks(), "webhooks", req.query);
  if (path === "/webhooks" && req.method === "POST") {
    const parsed = WebhookWriteSchema.safeParse(req.body);
    if (!parsed.success) return err(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const now = new Date().toISOString();
    const webhook: Webhook = { id: 9000 + Math.floor(Math.random() * 999), ...parsed.data, created: now, updated: now };
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
      if (!parsed.success) return err(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const updated: Webhook = { ...webhook, ...parsed.data, updated: new Date().toISOString() };
      await store.putWebhook(updated);
      return ok({ code: 200, message: "Webhook updated" });
    }
  }

  return err(404, `No route for ${req.method} ${path}`);
}

// Resolves [fieldId] merge tags in a lead_saved template, as described in the upstream spec.
export function applyTemplate(template: Record<string, unknown> | undefined, lead: Lead): Record<string, unknown> | undefined {
  if (!template) return undefined;
  const values = new Map([...lead.masterData, ...lead.resultData].map((p) => [p.id, p.value]));
  const resolve = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/\[(\d+)\]/g, (_, id: string) => values.get(Number(id)) ?? "");
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  return resolve(template) as Record<string, unknown>;
}
