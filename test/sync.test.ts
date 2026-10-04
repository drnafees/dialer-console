import { describe, expect, it } from "vitest";
import { handle } from "../src/core/mock-api";
import * as seed from "../src/core/seed";
import { fetchChangedLeads, RateLimiter, windowStart, type SyncClient } from "../src/core/sync";
import type { Lead } from "../src/core/types";
import { MemoryStore } from "./memory-store";

const AUTH = `Basic ${btoa("demo:demo")}`;

// A client that routes through the pure router in-process and records calls.
function clientFor(store: MemoryStore, opts: { fail429Times?: number } = {}) {
  const calls: Record<string, string>[] = [];
  let fails = opts.fail429Times ?? 0;
  const client: SyncClient = {
    async get(path, query) {
      calls.push(query);
      if (fails > 0) {
        fails--;
        return { status: 429, body: { code: 429 }, retryAfterSeconds: 1 };
      }
      const r = await handle({ method: "GET", path, query, authorization: AUTH, baseUrl: `https://x.test/v1${path}` }, store);
      return { status: r.status, body: r.body };
    },
  };
  return { client, calls };
}

const fresh = () => ({ pagesFetched: 0, requestsMade: 0, rowsFetched: 0, rateLimitWaitsMs: 0, cursorAfter: "" });
const noSleep = async () => {};

describe("RateLimiter", () => {
  it("waits when the per-minute bucket is empty and caps concurrency", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(
      60,
      2,
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    );
    for (let i = 0; i < 60; i++) {
      await limiter.acquire();
      limiter.release();
    }
    expect(sleeps).toEqual([]);
    await limiter.acquire();
    limiter.release();
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBe(1000); // one token = 1s at 60/min
    expect(limiter.waitedMs).toBe(1000);

    await limiter.acquire();
    await limiter.acquire();
    let third = false;
    const p = limiter.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    limiter.release();
    await p;
    expect(third).toBe(true);
  });
});

describe("fetchChangedLeads", () => {
  it("pages through results, dedupes the overlap window, and advances the cursor", async () => {
    const store = new MemoryStore();
    const { client, calls } = clientFor(store);
    const progress = fresh();
    const cursor = new Date(Date.now() - 3 * 86400_000).toISOString();
    const out: Lead[] = [];
    for await (const l of fetchChangedLeads(
      client,
      new RateLimiter(60, 2),
      { cursor, overlapSeconds: 300, pageSize: 2, campaignIds: [], sleep: noSleep },
      progress,
    ))
      out.push(l);
    const expected = seed.buildLeads().filter((l) => l.lastModifiedTime > windowStart(cursor, 300));
    expect(out.map((l) => l.id).sort()).toEqual(expected.map((l) => l.id).sort());
    expect(new Set(out.map((l) => l.id)).size).toBe(out.length);
    expect(progress.pagesFetched).toBe(Math.ceil(expected.length / 2));
    expect(progress.cursorAfter).toBe(
      expected
        .map((l) => l.lastModifiedTime)
        .sort()
        .at(-1),
    );
    expect(calls[0]).toMatchObject({ sortProperty: "lastModifiedTime", sortDirection: "ASC", includeMeta: "true", pageSize: "2" });
    expect(JSON.parse(calls[0]!.filters!)).toEqual({ lastModifiedTime: { $gt: windowStart(cursor, 300) } });
  });

  it("filters by campaign and retries on 429 honouring Retry-After", async () => {
    const store = new MemoryStore();
    const { client, calls } = clientFor(store, { fail429Times: 2 });
    const progress = fresh();
    const out: Lead[] = [];
    for await (const l of fetchChangedLeads(
      client,
      new RateLimiter(60, 2),
      { cursor: new Date(0).toISOString(), overlapSeconds: 0, pageSize: 100, campaignIds: [418], sleep: noSleep },
      progress,
    ))
      out.push(l);
    expect(out.every((l) => l.campaignId === 418)).toBe(true);
    expect(out.length).toBe(3);
    expect(progress.requestsMade).toBe(3);
    expect(progress.rateLimitWaitsMs).toBe(2000);
    expect(calls.length).toBe(3);
  });
});
