import { describe, expect, it } from "vitest";
import { detectFormat, idempotencyKeyOf, normalizeDelivery, parseBody } from "../src/core/inbound";

describe("receiver parsing", () => {
  it("detects the wire format from Content-Type or by sniffing", () => {
    expect(detectFormat("application/json; charset=utf-8", "")).toBe("json");
    expect(detectFormat("application/x-www-form-urlencoded", "")).toBe("form");
    expect(detectFormat("text/xml", "")).toBe("xml");
    expect(detectFormat(null, "  <delivery/>")).toBe("xml");
    expect(detectFormat(null, '{"a":1}')).toBe("json");
    expect(detectFormat(null, "a=1&b=2")).toBe("form");
  });

  it("normalises JSON, form (with bracket keys) and XML to the same envelope", () => {
    const json = normalizeDelivery(parseBody("json", '{"event":"lead_saved","leadId":204179334,"campaignId":412,"status":"success","timestamp":"2026-01-01T00:00:00Z","data":{"name":"Peter Holm"}}'));
    const form = normalizeDelivery(parseBody("form", "event=lead_saved&leadId=204179334&campaignId=412&status=success&timestamp=2026-01-01T00%3A00%3A00Z&data%5Bname%5D=Peter+Holm"));
    const xml = normalizeDelivery(parseBody("xml", "<delivery><event>lead_saved</event><leadId>204179334</leadId><campaignId>412</campaignId><status>success</status><timestamp>2026-01-01T00:00:00Z</timestamp><data><name>Peter Holm</name></data></delivery>"));
    expect(form).toEqual(json);
    expect(xml).toEqual(json);
    expect(json.data).toEqual({ name: "Peter Holm" });
    expect(idempotencyKeyOf(json)).toBe("lead_saved:204179334:2026-01-01T00:00:00Z");
  });

  it("accepts lead_id / lead aliases and rejects missing essentials", () => {
    expect(normalizeDelivery({ event: "call_ended", lead_id: "5" }).leadId).toBe(5);
    expect(() => normalizeDelivery({ leadId: 1 })).toThrow(/event/);
    expect(normalizeDelivery({ event: "import_completed", importId: 7 }).leadId).toBe(0);
    expect(() => normalizeDelivery({ event: "x", leadId: "abc" })).toThrow(/leadId/);
    expect(() => parseBody("json", "[1,2]")).toThrow(/object/);
  });
});
