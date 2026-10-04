import { z } from "zod";

// Shapes follow the public OpenAPI (Swagger 2.0) spec of a commercial outbound
// dialer: lead data is an array of { id: fieldId, value } pairs, and field names
// are resolved through GET /fields and GET /campaigns/{id}.

export const LEAD_STATUSES = ["new", "success", "notInterested", "unqualified", "invalid", "automaticRedial", "privateRedial", "unknown"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const WEBHOOK_EVENTS = [
  "lead_saved",
  "call_ended",
  "callAnswered",
  "leadClosedSuccess",
  "leadClosedAutomaticRedial",
  "leadClosedPrivateRedial",
  "leadClosedNotInterested",
  "leadClosedInvalid",
  "leadClosedUnqualified",
  "leadClosedSystem",
  "leads_deactivated",
  "leads_inserted",
  "mail_activity",
  "sms_sent",
  "sms_received",
  "appointment_added",
  "appointment_updated",
  "note_added",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Organization {
  id: number;
  name: string;
}

export interface Field {
  id: number;
  name: string;
  type: "text" | "float" | "datetime";
}

export interface Campaign {
  id: number;
  settings: { name: string; visible: boolean; record: boolean; active: boolean; projectId: number | null };
  masterFields: { id: number; type: "text" | "textarea"; editable: boolean; active: boolean }[];
  resultFields: { id: number; type: "text" | "textarea" | "select"; active: boolean; options?: string[] }[];
}

export const DataPairSchema = z.object({ id: z.coerce.number().int(), value: z.string() });
export type DataPair = z.infer<typeof DataPairSchema>;

export interface Lead {
  id: number;
  campaignId: number;
  contactAttempts: number;
  lastModifiedTime: string;
  nextContactTime: string | null;
  importedTime: string;
  lastContactedBy: number | null;
  status: LeadStatus;
  active: boolean;
  externalId: number | null;
  // The contact this lead was created from, when known (addContact / import).
  contactId: number | null;
  masterData: DataPair[];
  resultData: DataPair[];
}

// Body of PUT /leads/{id} and POST /leads: every property optional, same shape as a lead.
export const LeadWriteSchema = z.object({
  campaignId: z.coerce.number().int().optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  active: z.boolean().optional(),
  externalId: z.coerce.number().int().nullable().optional(),
  nextContactTime: z.string().nullable().optional(),
  masterData: z.array(DataPairSchema).optional(),
  resultData: z.array(DataPairSchema).optional(),
});
export type LeadWrite = z.infer<typeof LeadWriteSchema>;

export interface Session {
  id: number;
  leadId: number;
  userId: number;
  campaignId: number;
  startTime: string;
  endTime: string;
  lastUpdatedTime: string;
  status: LeadStatus;
  sessionSeconds: number;
  cdr: {
    destination: string;
    startTime: string;
    answerTime: string | null;
    endTime: string;
    durationSeconds: number;
    disposition: "answered" | "noAnswer" | "busy" | "fail";
  };
}

export interface User {
  id: number;
  name: string;
  displayName: string;
  active: boolean;
  admin: boolean;
  email: string;
  locale: string;
  timezone: string;
}

export const WebhookWriteSchema = z.object({
  event: z.enum(WEBHOOK_EVENTS),
  url: z.string().url(),
  authKey: z.string().min(1).optional(),
  template: z.record(z.string(), z.unknown()).optional(),
});
export type WebhookWrite = z.infer<typeof WebhookWriteSchema>;

export interface Webhook extends WebhookWrite {
  id: number;
  created: string;
  updated: string;
}

// What the mock emits to a registered webhook URL. The upstream spec does not
// document the body; this is a plausible minimal envelope plus the lead_saved
// template merge described in the spec.
export interface WebhookDelivery {
  event: WebhookEvent;
  webhookId: number;
  leadId: number;
  campaignId: number;
  status: LeadStatus;
  timestamp: string;
  data?: Record<string, unknown>;
}

// One row in the console's own event log: a webhook that reached /hooks/receive.
export interface ReceivedEvent {
  id: string;
  receivedAt: string;
  authKeyValid: boolean;
  payload: WebhookDelivery;
}

export interface Meta {
  pagination: {
    page: number;
    pageCount: number;
    pageSize: number;
    total: number;
    firstUrl?: string;
    previousUrl?: string | null;
    nextUrl?: string | null;
    lastUrl?: string;
  };
}

// ---------------------------------------------------------------------------
// Contacts, pools, imports, field mappings (the onboarding half of the spec)
// ---------------------------------------------------------------------------

export interface Pool {
  id: number;
  name: string;
  active: boolean;
}

// A contact lives in a pool. A lead is a contact placed on a campaign.
export interface Contact {
  id: number;
  poolId: number;
  externalId: string | null;
  created: string;
  lastModifiedTime: string;
  data: DataPair[];
}

export const ImportCreateSchema = z.object({
  poolId: z.coerce.number().int(),
  match: z
    .object({ fields: z.array(z.coerce.number().int()).default([]), blacklist: z.array(z.coerce.number().int()).default([]) })
    .default({ fields: [], blacklist: [] }),
  updateFields: z.array(z.coerce.number().int()).default([]),
  onImportedAction: z.object({ type: z.literal("addToCampaign"), campaignId: z.coerce.number().int() }).optional(),
  callbackUrl: z.string().url().optional(),
  processing: z.object({ bloctel: z.boolean().optional() }).optional(),
});
export type ImportCreate = z.infer<typeof ImportCreateSchema>;

export const ImportInsertSchema = z.array(z.object({ data: z.record(z.string(), z.coerce.string()) })).min(1);

export type ImportStatus = "created" | "queued" | "processing" | "completed" | "failed";

export interface ImportJob extends ImportCreate {
  id: number;
  status: ImportStatus;
  created: string;
  started: string | null;
  completed: string | null;
  rows: Record<string, string>[];
  result: { inserted: number; updated: number; duplicates: number; addedToCampaign: number; errors: string[] } | null;
}

export const FieldMappingWriteSchema = z.object({
  name: z.string().min(1),
  mappings: z.record(z.string(), z.string()),
});
export type FieldMappingWrite = z.infer<typeof FieldMappingWriteSchema>;

export interface FieldMapping extends FieldMappingWrite {
  id: number;
  lastUpdated: string;
}

export const ContactWriteSchema = z.object({
  poolId: z.coerce.number().int(),
  externalId: z.string().nullable().optional(),
  data: z.record(z.string(), z.coerce.string()),
});

export const ContactPatchSchema = z.object({
  poolId: z.coerce.number().int().optional(),
  externalId: z.string().nullable().optional(),
  data: z.record(z.string(), z.coerce.string()).optional(),
});

export const AddContactSchema = z.object({
  contactId: z.coerce.number().int(),
  status: z.enum(LEAD_STATUSES).default("new"),
});

// ---------------------------------------------------------------------------
// Integration toolkit (the console's side, not the vendor API)
// ---------------------------------------------------------------------------

// Normalised view of any inbound webhook, whatever the wire format was.
export type WireFormat = "json" | "form" | "xml";

export interface InboundDelivery {
  id: string;
  idempotencyKey: string;
  receivedAt: string;
  format: WireFormat;
  authKeyValid: boolean;
  duplicate: boolean;
  payload: WebhookDelivery;
  raw: string;
  forward: {
    status: "pending" | "delivered" | "failed" | "dead" | "skipped";
    attempts: number;
    lastError: string | null;
    nextAttemptAt: string | null;
    deliveredAt: string | null;
  };
}

export interface ForwardAttempt {
  id: string;
  deliveryId: string;
  attempt: number;
  at: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

export interface CrmRecord {
  id: string;
  externalId: string | null;
  dialerLeadId: number | null;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  source: "sync" | "webhook" | "manual";
}

export interface ConnectorConfig {
  fieldMappingId: number | null;
  direction: "dialer_to_crm" | "two_way";
  conflictPolicy: "last_write_wins" | "dialer_wins" | "crm_wins";
  campaignIds: number[];
  overlapSeconds: number;
  pageSize: number;
}

export interface SyncRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  dryRun: boolean;
  cursorBefore: string;
  cursorAfter: string | null;
  pagesFetched: number;
  requestsMade: number;
  rowsFetched: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  rateLimitWaitsMs: number;
  status: "running" | "completed" | "failed";
  error: string | null;
  preview: { leadId: number; action: "create" | "update" | "skip"; properties: Record<string, string>; reason?: string }[];
}

export interface RequestLogEntry {
  id: string;
  at: string;
  method: string;
  path: string;
  query: string;
  status: number;
  durationMs: number;
  rateLimitRemaining: number;
  emitted: string[];
}

export interface JourneyTrigger {
  id: string;
  name: string;
  token: string;
  resource: "leads" | "contacts";
  matchOn: "leadId" | "externalId" | "phone";
  fieldMap: Record<string, string>; // inbound key -> dialer field id or "status"
  created: string;
}

export interface JourneyRunLog {
  id: string;
  triggerId: string;
  at: string;
  authorized: boolean;
  matched: number | null;
  applied: Record<string, string>;
  error: string | null;
  body: unknown;
}
