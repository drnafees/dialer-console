# Error catalogue

What each failure looks like, what it usually means, and what to tell the customer. The mock reproduces every one of these; the **Diagnose** tab in the console detects most of them automatically.

| Symptom | Where you see it | Likely cause | What to say / do |
|---|---|---|---|
| `401 {"status":"error","message":"Authentication failed"}` | Any `/v1` call | Missing or wrong `Authorization: Basic …`; API user not verified; password reset pending | "Every request needs Basic auth with the API user. Base64 of `username:password`, no spaces." Check the user is active in the dialer admin. |
| `400 {"code":400,"message":"filters is not valid JSON"}` | List endpoints | `filters` not URL-encoded, single quotes, or trailing comma | Send `filters` as a JSON object string: `filters={"status":{"$eq":"new"}}`. In Postman, put the JSON in the Params tab and let it encode. |
| `400 Operator $in is not supported on this endpoint` | List endpoints | `$in` is only accepted by `POST /contacts/findByData` | Use one request per value, or `findByData` if you are looking up contacts. |
| `400 Unknown campaignId` / `Unknown poolId` | `POST /leads`, `POST /imports`, `addContact` | Wrong environment, campaign deleted, or id copied from a different account | Verify with `GET /campaigns` / `GET /pools` using the same credentials. |
| `400 Row 3: unknown field id "email"` | `POST /imports/{id}/insert` | Row keys must be numeric field ids, not names | Resolve names via `GET /fields` first. The import wizard does this mapping for you. |
| `400 template is only supported for the lead_saved event` | `POST /webhooks` | Template on `call_ended`, `leadClosed*` etc. | Register the webhook without a template and fetch the lead with `GET /leads/{id}` when it fires. |
| `404 No route for POST /imports123/insert` | Import flow | Client generated from the spec, which has the path typo `/imports{id}/insert` | Use `/imports/{id}/insert`. (The mock accepts both.) |
| `409 Import is already queued` | `POST /imports/{id}/start` | Start called twice; or insert after start | One import object per upload. Create a new one. |
| `429 Rate limit exceeded: burst limit of 60 requests per minute` | Any `/v1` call; `Retry-After: 60` | Parallel workers, tight polling loops, or a backfill without a token bucket | Respect `Retry-After`, serialise to 2 concurrent, keep under 60/min and 1000/h. The sync engine in this repo shows the pattern. |
| Webhook arrives, `authKey wrong` in Deliveries | `/hooks/receive` | Key registered on the webhook differs from the one the receiver expects; key stripped by a proxy | The key travels as `?authKey=` in the query string. Compare `GET /webhooks` with the receiver config. Check reverse proxies that rewrite query strings. |
| Webhook arrives, template field is empty | `data.<key>` is `""` | `[fieldId]` refers to a field that is not on the lead's campaign, or the lead has no value | Check `GET /campaigns/{id}` `masterFields`/`resultFields`. Diagnose flags tags that are on no campaign. |
| Same event received twice | Deliveries shows `duplicate` | Sender retried after a slow 2xx, or two webhooks registered for the same event | Idempotency key `event + leadId + timestamp` suppresses the second copy. Delete the extra webhook. |
| Forward to CRM `dead` after 5 attempts | Deliveries | Downstream down, or record cannot be built (lead deleted) | Fix the downstream, then **Replay**. For deleted leads, mark as resolved. |
| Import produced duplicates | Contacts list | `match.fields` empty, or phone formats differ (`20 12 34 56` vs `+4520123456`) | Set `match.fields` to the phone field; normalise to E.164 before upload. The wizard's dry-run shows the computed match key. |
| Import skipped rows you expected to update | Import result `duplicates` high | `updateFields` empty, so matches are counted as duplicates with nothing to change | Add the fields you want refreshed to `updateFields`. |
| Sync misses rows | CRM behind | Cursor advanced past rows written with an earlier `lastModifiedTime` (clock skew, slow writes) | Keep an overlap window (default 300 s) and dedupe on id; both are built into the connector. |
| Sync re-creates records | CRM has duplicates | Lookup key changed (lead re-imported with a new id) | Match on `externalId` first, lead id second. Set `externalId` on import. |
| Journey trigger `401` | Journeys run log | Token mismatch or `Bearer` prefix missing | Header must be exactly `Authorization: Bearer <token>`. |
| Journey trigger `404 No lead matched on phone` | Journeys run log | Phone format differs, or lead is on a different campaign | The simulator normalises both sides to E.164; check the lead actually exists with `GET /leads?filters=…`. |
