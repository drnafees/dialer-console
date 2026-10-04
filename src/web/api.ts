import type {
  ConnectorConfig,
  Contact,
  CrmRecord,
  Field,
  FieldMapping,
  ForwardAttempt,
  ImportJob,
  InboundDelivery,
  JourneyRunLog,
  JourneyTrigger,
  Lead,
  LeadWrite,
  Organization,
  Pool,
  ReceivedEvent,
  RequestLogEntry,
  SyncRun,
  Webhook,
  WebhookWrite,
} from "../core/types";
import type { ImportPlan } from "../core/import-pipeline";

// Thin client for the mock dialer API. Mirrors how a real integration would call
// the vendor: Basic auth header, JSON filters in the query string, JSON bodies.

export interface Credentials {
  username: string;
  password: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export type PublicImport = Omit<ImportJob, "rows"> & { rowCount: number };

export class DialerApi {
  constructor(private readonly creds: Credentials) {}

  private async call<T>(method: string, path: string, query: Record<string, string | number | boolean> = {}, body?: unknown): Promise<T> {
    const url = new URL(`/v1${path}`, window.location.origin);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Basic ${btoa(`${this.creds.username}:${this.creds.password}`)}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json()) as T & { message?: string };
    if (!res.ok) throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`);
    return data;
  }

  organization = () => this.call<Organization>("GET", "/organization");
  fields = () => this.call<Field[]>("GET", "/fields");
  pools = () => this.call<Pool[]>("GET", "/pools");
  allLeads = () => this.call<Lead[]>("GET", "/leads", { sortProperty: "lastModifiedTime", sortDirection: "DESC" });
  updateLead = (id: number, body: LeadWrite) => this.call<{ code: number; message: string }>("PUT", `/leads/${id}`, {}, body);
  contacts = (poolId?: number) => this.call<Contact[]>("GET", "/contacts", poolId ? { filters: JSON.stringify({ poolId: { $eq: poolId } }) } : {});
  webhooks = () => this.call<Webhook[]>("GET", "/webhooks");
  createWebhook = (body: WebhookWrite) => this.call<{ id: number }>("POST", "/webhooks", {}, body);
  deleteWebhook = (id: number) => this.call<{ code: number }>("DELETE", `/webhooks/${id}`);
  imports = () => this.call<PublicImport[]>("GET", "/imports");
  getImport = (id: number) => this.call<PublicImport>("GET", `/imports/${id}`);
  createImport = (body: unknown) => this.call<{ id: number }>("POST", "/imports", {}, body);
  insertImport = (id: number, rows: { data: Record<string, string> }[]) => this.call<{ rowCount: number }>("POST", `/imports/${id}/insert`, {}, rows);
  startImport = (id: number) => this.call<{ code: number }>("POST", `/imports/${id}/start`);
  fieldMappings = () => this.call<FieldMapping[]>("GET", "/field-mappings");
  createFieldMapping = (body: { name: string; mappings: Record<string, string> }) => this.call<{ id: number }>("POST", "/field-mappings", {}, body);
  updateFieldMapping = (id: number, body: { name?: string; mappings?: Record<string, string> }) => this.call<{ code: number }>("PUT", `/field-mappings/${id}`, {}, body);
  deleteFieldMapping = (id: number) => this.call<{ code: number }>("DELETE", `/field-mappings/${id}`);
}

// Console / toolkit endpoints: not part of the vendor API, no auth.
const j = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
};

export interface Overview {
  leads: number; contacts: number; imports: number; fieldMappings: number; webhooks: number;
  deliveries: { total: number; delivered: number; pending: number; dead: number; duplicates: number };
  crm: number; syncRuns: number; requests: number; cursor: string | null;
}
export interface Check { id: string; level: "ok" | "warn" | "error"; title: string; detail: string; fix?: string }
export interface ImportPreview { headers: string[]; rowCount: number; guesses: { header: string; fieldId: number | null }[]; columnMap: Record<string, string>; plan: ImportPlan; rows: Record<string, string>[] }

export const consoleApi = {
  events: async () => (await j<{ events: ReceivedEvent[] }>("/console/events")).events,
  reset: () => fetch("/console/events", { method: "DELETE" }),
  overview: () => j<Overview>("/integrations/overview"),
  requests: async () => (await j<{ requests: RequestLogEntry[] }>("/integrations/requests")).requests,
  deliveries: () => j<{ retried: number; deliveries: InboundDelivery[] }>("/integrations/deliveries"),
  delivery: (id: string) => j<{ delivery: InboundDelivery; attempts: ForwardAttempt[] }>(`/integrations/deliveries/${id}`),
  replay: (id: string) => j<{ delivery: InboundDelivery }>(`/integrations/deliveries/${id}/replay`, { method: "POST" }),
  crm: async () => (await j<{ records: CrmRecord[] }>("/integrations/crm")).records,
  editCrm: (id: string, properties: Record<string, string>) => j<{ record: CrmRecord }>(`/integrations/crm/${id}`, { method: "PUT", body: JSON.stringify({ properties }) }),
  clearCrm: () => j<{ ok: true }>("/integrations/crm", { method: "DELETE" }),
  connector: () => j<{ connector: ConnectorConfig; cursor: string | null; mappings: FieldMapping[] }>("/integrations/connector"),
  saveConnector: (patch: Partial<ConnectorConfig> & { cursor?: string | null }) => j<{ connector: ConnectorConfig; cursor: string | null }>("/integrations/connector", { method: "PUT", body: JSON.stringify(patch) }),
  sync: (dryRun: boolean) => j<{ run: SyncRun }>(`/integrations/sync?dryRun=${dryRun ? 1 : 0}`, { method: "POST" }),
  syncRuns: async () => (await j<{ runs: SyncRun[] }>("/integrations/sync")).runs,
  importPreview: (body: { csv: string; columnMap?: Record<string, string>; poolId?: number; matchFields?: number[]; blacklist?: number[]; updateFields?: number[] }) => j<ImportPreview>("/integrations/import/preview", { method: "POST", body: JSON.stringify(body) }),
  diagnose: async () => (await j<{ checks: Check[] }>("/integrations/diagnose")).checks,
  journeys: async () => (await j<{ triggers: JourneyTrigger[] }>("/journeys")).triggers,
  createJourney: (body: Partial<JourneyTrigger>) => j<{ trigger: JourneyTrigger; triggerUrl: string }>("/journeys", { method: "POST", body: JSON.stringify(body) }),
  deleteJourney: (id: string) => j<{ ok: true }>(`/journeys/${id}`, { method: "DELETE" }),
  journeyRuns: async () => (await j<{ runs: JourneyRunLog[] }>("/journeys/runs")).runs,
  // Fire a trigger exactly like an external system would (Bearer token, JSON body).
  fireJourney: async (id: string, token: string, body: unknown) => {
    const res = await fetch(`/journeys/${id}/trigger`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  },
  // Send a raw webhook to the receiver in a chosen wire format.
  sendRaw: async (contentType: string, raw: string, authKey: string, failTimes = 0) => {
    const res = await fetch(`/hooks/receive?authKey=${encodeURIComponent(authKey)}${failTimes ? `&failTimes=${failTimes}` : ""}`, { method: "POST", headers: { "Content-Type": contentType }, body: raw });
    return { status: res.status, body: await res.json() };
  },
};
