// Plain-language labels for everything the vendor API expresses as codes.
// The developer toggle shows the raw value next to these.

import type { LeadStatus, WebhookEvent } from "../core/types";

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "Not called yet",
  success: "Sale",
  notInterested: "Not interested",
  unqualified: "Not a fit",
  invalid: "Wrong number",
  automaticRedial: "Call again later",
  privateRedial: "Agent will call back",
  unknown: "Unknown",
};

export const STATUS_TONE: Record<LeadStatus, string> = {
  new: "bg-accent-soft text-accent",
  success: "bg-green-soft text-green",
  notInterested: "bg-paper-2 text-grey-2",
  unqualified: "bg-paper-2 text-grey-2",
  invalid: "bg-coral-soft text-coral-dark",
  automaticRedial: "bg-amber-soft text-amber",
  privateRedial: "bg-amber-soft text-amber",
  unknown: "bg-paper-2 text-grey-2",
};

export const EVENT_LABEL: Partial<Record<WebhookEvent | string, string>> = {
  lead_saved: "A contact was saved",
  leads_inserted: "A contact was added",
  leads_deactivated: "A contact was switched off",
  call_ended: "A call ended",
  callAnswered: "A call was answered",
  leadClosedSuccess: "A sale was made",
  leadClosedNotInterested: "Someone said no",
  leadClosedInvalid: "A number was wrong",
  leadClosedUnqualified: "Someone was not a fit",
  leadClosedAutomaticRedial: "Scheduled to call again",
  leadClosedPrivateRedial: "An agent will call back",
  leadClosedSystem: "Closed by the system",
  sms_sent: "A text was sent",
  sms_received: "A text was received",
  mail_activity: "An email was opened or clicked",
  appointment_added: "A meeting was booked",
  appointment_updated: "A meeting was changed",
  note_added: "A note was written",
  import_completed: "An import finished",
};

export const eventLabel = (e: string) => EVENT_LABEL[e] ?? e;
export const statusLabel = (s: string) => STATUS_LABEL[s as LeadStatus] ?? s;

export const FORWARD_LABEL: Record<string, string> = {
  delivered: "Saved to your CRM",
  pending: "Will retry",
  dead: "Gave up",
  skipped: "Just logged",
  failed: "Failed",
};

export const ACTION_LABEL: Record<string, string> = {
  insert: "New person",
  update: "Update",
  duplicate: "Already here",
  blacklisted: "Do not call",
  create: "Will create",
  skip: "No change",
};

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString("en-GB");
}

// "in 2 s", "in 5 min" for future timestamps.
export function untilTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return "any moment now";
  if (s < 60) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  return `in ${Math.round(m / 60)} h`;
}
