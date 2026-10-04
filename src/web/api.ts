import type { Field, Lead, LeadWrite, Organization, ReceivedEvent, Webhook, WebhookWrite } from "../core/types";

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
  allLeads = () => this.call<Lead[]>("GET", "/leads", { sortProperty: "lastModifiedTime", sortDirection: "DESC" });
  updateLead = (id: number, body: LeadWrite) => this.call<{ code: number; message: string }>("PUT", `/leads/${id}`, {}, body);
  webhooks = () => this.call<Webhook[]>("GET", "/webhooks");
  createWebhook = (body: WebhookWrite) => this.call<{ id: number }>("POST", "/webhooks", {}, body);
  deleteWebhook = (id: number) => this.call<{ code: number }>("DELETE", `/webhooks/${id}`);
}

export const consoleApi = {
  events: async () => ((await (await fetch("/console/events")).json()) as { events: ReceivedEvent[] }).events,
  reset: () => fetch("/console/events", { method: "DELETE" }),
};
