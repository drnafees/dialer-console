// The import pipeline as a pure function: given an import job, the current
// contacts and the field catalogue, decide what to insert / update / skip.
// Used by the mock API when an import is started, and by the console's CSV
// wizard to preview an import before it is sent.

import { matchKey } from "./normalize";
import type { Contact, Field, ImportJob } from "./types";

export interface PlannedRow {
  index: number;
  action: "insert" | "update" | "duplicate" | "blacklisted";
  key: string | null;
  existingId: number | null;
  data: Record<string, string>;
  changes: Record<string, { from: string; to: string }>;
}

export interface ImportPlan {
  rows: PlannedRow[];
  summary: { inserted: number; updated: number; duplicates: number; blacklisted: number };
}

const contactData = (c: Contact): Record<string, string> => Object.fromEntries(c.data.map((p) => [String(p.id), p.value]));

export function planImport(job: Pick<ImportJob, "poolId" | "match" | "updateFields" | "rows">, contacts: Contact[], fields: Map<number, Field>): ImportPlan {
  const matchFields = job.match.fields;
  const blacklistPools = new Set(job.match.blacklist);

  const inPool = new Map<string, Contact>();
  const inBlacklist = new Set<string>();
  for (const c of contacts) {
    const key = matchKey(contactData(c), matchFields, fields);
    if (!key) continue;
    if (c.poolId === job.poolId) inPool.set(key, c);
    if (blacklistPools.has(c.poolId)) inBlacklist.add(key);
  }

  const seenInFile = new Set<string>();
  const rows: PlannedRow[] = job.rows.map((data, index) => {
    const key = matchKey(data, matchFields, fields);
    const base = { index, key, data, changes: {} as PlannedRow["changes"] };
    if (key && inBlacklist.has(key)) return { ...base, action: "blacklisted", existingId: null };
    if (key && seenInFile.has(key)) return { ...base, action: "duplicate", existingId: null };
    if (key) seenInFile.add(key);
    const existing = key ? inPool.get(key) : undefined;
    if (!existing) return { ...base, action: "insert", existingId: null };
    const current = contactData(existing);
    const changes: PlannedRow["changes"] = {};
    for (const id of job.updateFields) {
      const k = String(id);
      if (data[k] !== undefined && data[k] !== current[k]) changes[k] = { from: current[k] ?? "", to: data[k]! };
    }
    return { ...base, action: Object.keys(changes).length ? "update" : "duplicate", existingId: existing.id, changes };
  });

  const count = (a: PlannedRow["action"]) => rows.filter((r) => r.action === a).length;
  return { rows, summary: { inserted: count("insert"), updated: count("update"), duplicates: count("duplicate"), blacklisted: count("blacklisted") } };
}

// Minimal CSV parser: handles quoted fields, escaped quotes, CRLF, and
// auto-detects comma vs semicolon (Danish Excel exports use semicolons).
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) out.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) out.push(row);
  const [headers = [], ...rows] = out;
  return { headers: headers.map((h) => h.replace(/^\uFEFF/, "").trim()), rows };
}

// Guess which field a CSV column maps to from its header.
export function guessField(header: string, fields: Field[]): Field | undefined {
  const h = header.toLowerCase().replace(/[^a-z0-9æøå]/g, "");
  const aliases: Record<string, string[]> = {
    firstname: ["firstname", "fornavn", "first", "givenname"],
    lastname: ["lastname", "efternavn", "last", "surname", "familyname"],
    phone: ["phone", "telefon", "tlf", "mobile", "mobil", "msisdn", "number"],
    email: ["email", "mail", "epost"],
    company: ["company", "firma", "virksomhed", "organisation", "organization"],
    zip: ["zip", "postnr", "postcode", "postalcode", "zipcode"],
    city: ["city", "by", "town"],
  };
  for (const f of fields) {
    const name = f.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (h === name) return f;
    if (aliases[name]?.some((a) => h === a || h.includes(a))) return f;
  }
  return undefined;
}
