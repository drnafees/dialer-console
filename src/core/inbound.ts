// Inbound webhook parsing: JSON, application/x-www-form-urlencoded and XML all
// become one WebhookDelivery envelope. Pure; shared by the receiver and tests.

import { XMLParser } from "fast-xml-parser";
import type { WebhookDelivery, WireFormat } from "./types";

export function detectFormat(contentType: string | null, raw: string): WireFormat {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("x-www-form-urlencoded")) return "form";
  if (ct.includes("xml")) return "xml";
  const t = raw.trimStart();
  if (t.startsWith("<")) return "xml";
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  return "form";
}

// "data[name]=x&data[phone]=y" -> { data: { name: "x", phone: "y" } }
function unflatten(entries: Iterable<[string, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const parts = key.replace(/\]/g, "").split("[");
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
  }
  return out;
}

export function parseBody(format: WireFormat, raw: string): Record<string, unknown> {
  if (format === "json") {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JSON body must be an object");
    return v as Record<string, unknown>;
  }
  if (format === "form") return unflatten(new URLSearchParams(raw).entries());
  const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true }).parse(raw) as Record<string, unknown>;
  // Unwrap a single root element (<delivery>...</delivery>).
  const keys = Object.keys(parsed);
  const root = keys.length === 1 && parsed[keys[0]!] && typeof parsed[keys[0]!] === "object" ? (parsed[keys[0]!] as Record<string, unknown>) : parsed;
  return root;
}

// Coerce the loosely typed inbound object into our WebhookDelivery envelope.
export function normalizeDelivery(o: Record<string, unknown>): WebhookDelivery {
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? NaN : Number(v));
  const event = String(o.event ?? "");
  if (!event) throw new Error("Missing 'event'");
  // Lead events carry a leadId; informational callbacks (e.g. import completed) do not.
  const rawLead = o.leadId ?? o.lead_id ?? o.lead;
  const leadId = rawLead === undefined ? 0 : num(rawLead);
  if (Number.isNaN(leadId)) throw new Error("Non-numeric 'leadId'");
  const data = o.data && typeof o.data === "object" && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : undefined;
  return {
    event: event as WebhookDelivery["event"],
    webhookId: Number.isNaN(num(o.webhookId)) ? 0 : num(o.webhookId),
    leadId,
    campaignId: Number.isNaN(num(o.campaignId)) ? 0 : num(o.campaignId),
    status: String(o.status ?? "unknown") as WebhookDelivery["status"],
    timestamp: String(o.timestamp ?? new Date().toISOString()),
    data,
  };
}

// Vendor deliveries carry no delivery id, so derive one. Same event for the same
// lead at the same vendor timestamp is the same delivery.
export const idempotencyKeyOf = (p: WebhookDelivery) => `${p.event}:${p.leadId}:${p.timestamp}`;
