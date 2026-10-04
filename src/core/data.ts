// Helpers for the `[{ id, value }]` field-data shape the vendor API uses.

import type { DataPair } from "./types";

export type DataRecord = Record<string, string>;

export const pairsToRecord = (pairs: DataPair[]): DataRecord => Object.fromEntries(pairs.map((p) => [String(p.id), p.value]));

export const recordToPairs = (data: DataRecord): DataPair[] => Object.entries(data).map(([id, value]) => ({ id: Number(id), value }));

// Merge incoming pairs over current ones; later values win, order is preserved
// for existing ids and new ids are appended.
export function mergePairs(current: DataPair[], incoming: DataPair[] | undefined): DataPair[] {
  if (!incoming?.length) return current;
  const map = new Map(current.map((p) => [p.id, p.value]));
  for (const p of incoming) map.set(p.id, p.value);
  return [...map.entries()].map(([id, value]) => ({ id, value }));
}

// Sequence ranges per entity so ids are recognisable in logs and never collide.
export const ID_RANGES = {
  lead: 204200000,
  contact: 400000,
  import: 7000,
  mapping: 500,
  webhook: 9000,
} as const;
export type IdKind = keyof typeof ID_RANGES;
