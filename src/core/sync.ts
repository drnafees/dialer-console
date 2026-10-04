// Incremental sync engine: pulls leads changed since a cursor, page by page,
// through a rate-limited client, and hands each lead to an upsert function.
// Pure: it knows nothing about Cloudflare, KV or the CRM shape.

import type { Lead, Meta } from "./types";

export interface SyncClient {
  // GET a list endpoint. Returns the parsed JSON body and the HTTP status.
  get(path: string, query: Record<string, string>): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }>;
}

export interface SyncOptions {
  cursor: string; // ISO datetime; fetch leads with lastModifiedTime > cursor - overlap
  overlapSeconds: number; // re-read a window to survive clock skew / late writes
  pageSize: number;
  campaignIds: number[]; // empty = all
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncProgress {
  pagesFetched: number;
  requestsMade: number;
  rowsFetched: number;
  rateLimitWaitsMs: number;
  cursorAfter: string;
}

// Token bucket: `perMinute` tokens refilled continuously, `concurrent` slots.
export class RateLimiter {
  private tokens: number;
  private last: number;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  waitedMs = 0;

  constructor(
    private readonly perMinute = 60,
    private readonly concurrent = 2,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60_000) * this.perMinute);
    this.last = t;
  }

  async acquire(): Promise<void> {
    while (this.active >= this.concurrent) await new Promise<void>((r) => this.waiters.push(r));
    this.refill();
    if (this.tokens < 1) {
      const wait = Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000);
      this.waitedMs += wait;
      await this.sleep(wait);
      this.refill();
    }
    this.tokens -= 1;
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

export function windowStart(cursor: string, overlapSeconds: number): string {
  return new Date(Date.parse(cursor) - overlapSeconds * 1000).toISOString();
}

export async function* fetchChangedLeads(client: SyncClient, limiter: RateLimiter, opts: SyncOptions, progress: SyncProgress): AsyncGenerator<Lead> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const filters: Record<string, unknown> = { lastModifiedTime: { $gt: windowStart(opts.cursor, opts.overlapSeconds) } };
  // The API has no $in on list endpoints; one campaign per pass, or all.
  const campaigns = opts.campaignIds.length ? opts.campaignIds : [null];
  const seen = new Set<number>(); // the overlap window re-reads rows: dedupe on id
  let maxModified = opts.cursor;

  for (const campaignId of campaigns) {
    const f = campaignId === null ? filters : { ...filters, campaignId: { $eq: campaignId } };
    let page = 1;
    for (;;) {
      await limiter.acquire();
      let res;
      try {
        res = await client.get("/leads", {
          filters: JSON.stringify(f),
          sortProperty: "lastModifiedTime",
          sortDirection: "ASC",
          page: String(page),
          pageSize: String(opts.pageSize),
          includeMeta: "true",
        });
      } finally {
        limiter.release();
      }
      progress.requestsMade++;
      if (res.status === 429) {
        const wait = (res.retryAfterSeconds ?? 60) * 1000;
        progress.rateLimitWaitsMs += wait;
        await sleep(wait);
        continue;
      }
      if (res.status !== 200) throw new Error(`GET /leads failed with ${res.status}: ${JSON.stringify(res.body)}`);
      const body = res.body as { meta: Meta; leads: Lead[] };
      progress.pagesFetched++;
      for (const lead of body.leads) {
        progress.rowsFetched++;
        if (lead.lastModifiedTime > maxModified) maxModified = lead.lastModifiedTime;
        if (seen.has(lead.id)) continue;
        seen.add(lead.id);
        yield lead;
      }
      if (!body.meta.pagination.nextUrl && page >= body.meta.pagination.pageCount) break;
      page++;
    }
  }
  progress.cursorAfter = maxModified;
}
