// Value normalisation used for duplicate detection. Both the mock import
// pipeline and the console's CSV wizard use the same rules so what the wizard
// previews is what the import does.

import type { Field } from "./types";

// Danish default; the real system would take this from the organisation.
const DEFAULT_COUNTRY_CODE = "45";

// Normalise a phone number to E.164 ("+4520123456"). Keeps a leading "+",
// strips spaces/dashes/parentheses, converts "00" prefix, and prepends the
// default country code to 8-digit national numbers.
export function normalizePhone(raw: string, defaultCountryCode = DEFAULT_COUNTRY_CODE): string {
  let s = raw.trim().replace(/[\s\-().]/g, "");
  if (!s) return "";
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (s.startsWith("+")) return `+${s.slice(1).replace(/\D/g, "")}`;
  s = s.replace(/\D/g, "");
  if (s.length === 8) return `+${defaultCountryCode}${s}`;
  if (s.startsWith(defaultCountryCode) && s.length === defaultCountryCode.length + 8) return `+${s}`;
  return s ? `+${s}` : "";
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

// Pick a normaliser based on the field's name (the mock has no "phone" type;
// the upstream spec has text/float/datetime only).
export function normalizerFor(field: Field | undefined): (raw: string) => string {
  const name = field?.name.toLowerCase() ?? "";
  if (/phone|mobile|tel/.test(name)) return normalizePhone;
  if (/mail/.test(name)) return normalizeEmail;
  return normalizeText;
}

// Build a dedupe key for a row over the given match fields. Rows missing any
// match field return null (cannot be matched, treated as unique).
export function matchKey(data: Record<string, string>, matchFields: number[], fields: Map<number, Field>): string | null {
  if (!matchFields.length) return null;
  const parts: string[] = [];
  for (const id of matchFields) {
    const v = data[String(id)];
    if (v === undefined || v === "") return null;
    parts.push(normalizerFor(fields.get(id))(v));
  }
  return parts.join("|");
}
