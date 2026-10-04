import * as seed from "../../src/core/seed";
import type { CrmRecord, FieldMapping, Lead, WebhookDelivery } from "../../src/core/types";
import type { KvStore } from "./kv-store";

// A deliberately generic CRM: records with free-form string properties, looked
// up by externalId or by the dialer lead id. Stands in for any common CRM
// shape without naming one in product code.

const fieldName = (id: number) => seed.fields.find((f) => f.id === id)?.name ?? String(id);

// Translate a lead into CRM properties using the active field mapping. Without
// a mapping, fall back to the dialer field names (so the demo works out of the box).
export function leadToProperties(lead: Lead, mapping: FieldMapping | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of [...lead.masterData, ...lead.resultData]) {
    const key = mapping ? mapping.mappings[String(p.id)] : fieldName(p.id).toLowerCase().replace(/\s+/g, "_");
    if (key) out[key] = p.value;
  }
  out.dialer_status = lead.status;
  out.dialer_campaign_id = String(lead.campaignId);
  out.dialer_last_modified = lead.lastModifiedTime;
  return out;
}

export async function activeMapping(store: KvStore): Promise<FieldMapping | null> {
  const cfg = await store.getConnector();
  if (cfg.fieldMappingId === null) return null;
  return (await store.listFieldMappings()).find((m) => m.id === cfg.fieldMappingId) ?? null;
}

export async function findCrmRecord(store: KvStore, leadId: number, externalId: string | null): Promise<CrmRecord | null> {
  const all = await store.crm.list();
  return all.find((r) => r.dialerLeadId === leadId) ?? (externalId ? all.find((r) => r.externalId === externalId) : undefined) ?? null;
}

export type UpsertAction = "create" | "update" | "skip";

export interface UpsertPlan {
  action: UpsertAction;
  reason?: string;
  record: CrmRecord;
}

// Decide (without writing) what a sync of this lead would do.
export async function planUpsert(store: KvStore, lead: Lead, mapping: FieldMapping | null, source: CrmRecord["source"]): Promise<UpsertPlan> {
  const cfg = await store.getConnector();
  const properties = leadToProperties(lead, mapping);
  const externalId = lead.externalId === null ? null : `ext-${lead.externalId}`;
  const existing = await findCrmRecord(store, lead.id, externalId);
  const now = new Date().toISOString();
  if (!existing)
    return { action: "create", record: { id: crypto.randomUUID(), externalId, dialerLeadId: lead.id, properties, createdAt: now, updatedAt: now, source } };

  const changed = Object.entries(properties).some(([k, v]) => existing.properties[k] !== v);
  if (!changed) return { action: "skip", reason: "no changes", record: existing };
  if (cfg.conflictPolicy === "crm_wins" && existing.source === "manual")
    return { action: "skip", reason: "conflict policy crm_wins: record was edited in CRM", record: existing };
  if (cfg.conflictPolicy === "last_write_wins" && existing.updatedAt > lead.lastModifiedTime && existing.source === "manual")
    return { action: "skip", reason: "conflict policy last_write_wins: CRM edit is newer", record: existing };
  return {
    action: "update",
    record: {
      ...existing,
      dialerLeadId: lead.id,
      externalId: externalId ?? existing.externalId,
      properties: { ...existing.properties, ...properties },
      updatedAt: now,
      source,
    },
  };
}

export async function upsertLead(store: KvStore, lead: Lead, mapping: FieldMapping | null, source: CrmRecord["source"]): Promise<UpsertPlan> {
  const plan = await planUpsert(store, lead, mapping, source);
  if (plan.action !== "skip") await store.crm.put(plan.record);
  return plan;
}

// A webhook delivery carries only a partial view (the template's data), so we
// fetch the lead from the store to get a complete, consistent record.
export async function upsertCrmFromDelivery(store: KvStore, payload: WebhookDelivery): Promise<UpsertPlan> {
  const lead = await store.getLead(payload.leadId);
  if (!lead) throw new Error(`Lead ${payload.leadId} not found in dialer; cannot sync`);
  return upsertLead(store, lead, await activeMapping(store), "webhook");
}
