import type { Store } from "../src/core/mock-api";
import * as seed from "../src/core/seed";
import type { Contact, FieldMapping, ImportJob, Lead, Webhook } from "../src/core/types";

export class MemoryStore implements Store {
  leads = new Map(seed.buildLeads().map((l) => [l.id, l]));
  contacts = new Map(seed.buildContacts().map((c) => [c.id, c]));
  webhooks = new Map<number, Webhook>();
  imports = new Map<number, ImportJob>();
  mappings = new Map<number, FieldMapping>();
  async listLeads() { return [...this.leads.values()]; }
  async getLead(id: number) { return this.leads.get(id) ?? null; }
  async putLead(lead: Lead) { this.leads.set(lead.id, lead); }
  async deleteLead(id: number) { this.leads.delete(id); }
  async listWebhooks() { return [...this.webhooks.values()]; }
  async putWebhook(w: Webhook) { this.webhooks.set(w.id, w); }
  async deleteWebhook(id: number) { this.webhooks.delete(id); }
  async listContacts() { return [...this.contacts.values()]; }
  async getContact(id: number) { return this.contacts.get(id) ?? null; }
  async putContact(c: Contact) { this.contacts.set(c.id, c); }
  async deleteContact(id: number) { this.contacts.delete(id); }
  async listImports() { return [...this.imports.values()]; }
  async getImport(id: number) { return this.imports.get(id) ?? null; }
  async putImport(j: ImportJob) { this.imports.set(j.id, j); }
  async listFieldMappings() { return [...this.mappings.values()]; }
  async putFieldMapping(m: FieldMapping) { this.mappings.set(m.id, m); }
  async deleteFieldMapping(id: number) { this.mappings.delete(id); }
}
