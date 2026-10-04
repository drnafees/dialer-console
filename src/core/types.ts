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
  cdr: { destination: string; startTime: string; answerTime: string | null; endTime: string; durationSeconds: number; disposition: "answered" | "noAnswer" | "busy" | "fail" };
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
  pagination: { page: number; pageCount: number; pageSize: number; total: number };
}
