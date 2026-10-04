# Customer integration playbook

A step-by-step runbook for connecting your systems to the Adversus API. It is written for the IT person or developer on the customer side. All requests target the real API at `https://api.adversus.io/v1` and follow the public Swagger spec (https://api.adversus.io/swagger/apinew.json) and the help center (https://help.adversus.io). The toolkit in this repository (a mock of the same API plus a console) is used as the worked example; every step is also valid against the real API.

Where this playbook goes beyond what the public documentation states, it says so.

## 0. Before you start

| Item | How to get it |
| --- | --- |
| An API user in Adversus | Admin follows the help article "Create an API user". Use a dedicated user per integration so you can rotate credentials independently. |
| Basic auth credentials | Username and password of that API user. Store them in a secret manager, not in code. |
| Your pool ID | `GET /v1/pools`. A pool holds contacts. |
| Your campaign ID | `GET /v1/campaigns`. A campaign dials leads. |
| Your field IDs | `GET /v1/fields` for contact and lead fields; `GET /v1/campaign-fields` for the fields each campaign uses. |
| A public HTTPS endpoint for webhooks | Must accept POST and answer within a few seconds. For local testing use a tunnel; the receiver in this repo lives at `/hooks/receive`. |
| A sandbox | Adversus does not publish a public sandbox. Ask your account manager, or build and test the flow against the mock in this repo first (`npm run preview`, credentials `demo`/`demo`). |

## 1. Concepts

- **Contact**: a person or company record. Lives in a **pool**. Has data fields.
- **Lead**: a contact placed in a **campaign** for dialling. A lead has a status, a result, call history and its own data. The same contact can be a lead in several campaigns.
- **Campaign**: the dialling queue, script and result options. A campaign picks which fields it uses from the global field list.
- **Pool**: a container for contacts, also used as a duplicate-check boundary during imports (`match.blacklist`).
- **Fields and field IDs**: fields are global and numeric. A campaign chooses which of them to show. When you send data you address fields by ID, so `"13267"` is a phone field in one account and something else in another. Always resolve IDs with `GET /fields` rather than hard-coding them.
- **Data shape**: in most places data is a set of `{fieldId: value}` pairs (for imports: `{"data": {"13266": "Alice", "13267": "12345678"}}`). Some list responses present the same information as `[{id, value}]` arrays. Treat both as the same thing keyed by field ID.
- **External ID**: a field you designate to hold your own system's identifier. With `PATCH /contacts-external/{externalId}` you can update a contact without knowing the Adversus contact ID. See the help article "Working with contact identifiers".

## 2. Authentication and limits

Every request carries HTTP Basic auth:

```bash
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" https://api.adversus.io/v1/organization
```

A wrong credential returns `401` with body `{"status":"error","message":"Authentication failed"}`. Other errors return `{code, message}`.

Rate limits, quoted from the spec: "1000 requests pr. hour, with a burst rate limit of 60 requests pr. minute, and a maximum of 2 concurrent requests. If the rate limit is exceeded the API will respond with a 429 status code."

Recommended client behaviour:

1. Run a token bucket with capacity 60 refilled at 1 token per second, and a semaphore of 2 for in-flight requests. The connector in this repo does exactly this.
2. On `429`, honour `Retry-After` if present. The spec does not state whether the header is sent, so fall back to exponential backoff starting at 2 seconds with jitter, capped at 60 seconds. I would verify the presence of `Retry-After` with one deliberate burst against your account.
3. Budget the hourly limit. A full sync of 50,000 leads at `pageSize=100` is 500 requests, half the hour's budget. Prefer incremental sync (section 3.3).
4. Never retry non-idempotent calls (`POST /contacts`, `POST /imports/{id}/insert`) blindly after a timeout; check first whether the record exists.

## 3. Reading data

### 3.1 Filters and sorting

Filters are a JSON object passed in the `filters` query parameter, URL-encoded. Operators: `$eq`, `$neq`, `$gt`, `$lt`, `$c` (contains), `$nc` (does not contain). Several fields and several operators per field are allowed. Datetimes are ISO 8601, for example `2016-06-26T11:21:32Z`.

```bash
# Campaigns named exactly "Campaign A"
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" -G https://api.adversus.io/v1/campaigns \
  --data-urlencode 'filters={"name":{"$eq":"Campaign A"}}'

# Leads in campaign 1337 modified after a timestamp, oldest first
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" -G https://api.adversus.io/v1/leads \
  --data-urlencode 'filters={"campaignId":{"$eq":1337},"lastModifiedTime":{"$gt":"2026-10-01T00:00:00Z"}}' \
  --data-urlencode 'sortProperty=lastModifiedTime' \
  --data-urlencode 'sortDirection=ASC'
```

### 3.2 Pagination

List endpoints take `page` and `pageSize`. Add `includeMeta=true` to receive `meta.pagination` with `page`, `pageCount`, `pageSize`, `total`, `firstUrl`, `previousUrl`, `nextUrl` and `lastUrl`.

```bash
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" -G https://api.adversus.io/v1/leads \
  --data-urlencode 'page=1' --data-urlencode 'pageSize=100' --data-urlencode 'includeMeta=true'
```

Follow `meta.pagination.nextUrl` until it is empty rather than computing page numbers yourself. Note that the spec's description of `pageSize` is contradictory ("between 1 and 100. Default is 1000"); use `pageSize=100` explicitly and read back `meta.pagination.pageSize` to confirm what the server applied.

### 3.3 Incremental sync pattern

Full exports are expensive and hit the rate limit. Sync incrementally:

1. Store a cursor: the largest `lastModifiedTime` you have processed.
2. Each run, request `lastModifiedTime $gt (cursor - overlap)`, sorted ascending, with `overlap` of 5 to 10 minutes. The overlap covers clock skew and records committed slightly out of order.
3. Deduplicate on `id` within the run, and upsert by `id` downstream, so rows re-read in the overlap window are harmless.
4. Page through with `nextUrl`. After the last page, advance the cursor to the largest `lastModifiedTime` seen (not to "now").
5. Record each run: started, finished, rows read, rows written, errors. The connector in this repo writes such a run log and supports a dry-run mode that reads but does not write.

Whether a given list endpoint supports filtering on `lastModifiedTime` should be confirmed per endpoint in the spec; `/leads` is the one most integrations use.

## 4. Importing contacts

Imports are the bulk path. From the spec: "An import is used for bulk import of contacts, and has additional features for handling duplicate checking, and can also be used for updating existing leads. After creating the import, contacts can be added in a streaming fashion using the import/{id}/insert endpoint. The import is finally initiated by calling import/{id}/start, at which point the import is queued for processing."

### Step 1: create the import

```bash
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" -X POST https://api.adversus.io/v1/imports \
  -H 'Content-Type: application/json' \
  -d '{
    "poolId": 21,
    "match": {"fields": [12, 22], "blacklist": [123]},
    "onImportedAction": {"type": "addToCampaign", "campaignId": 1337},
    "updateFields": [55, 34],
    "callbackUrl": "https://your-domain.example/hooks/import-done"
  }'
```

- `poolId` is the only required property.
- `match.fields`: field IDs used for duplicate detection (typically phone and email).
- `match.blacklist`: pool IDs whose contacts must also be checked, for example a do-not-call pool.
- `updateFields`: fields to overwrite on existing contacts that match.
- `onImportedAction`: add the imported contacts to a campaign as leads.
- `processing.bloctel`: French do-not-call list check; the spec notes the feature must be enabled on the account.
- `callbackUrl`: Adversus calls this when processing finishes. The payload of the callback is not described in the spec; capture one with your receiver before depending on it.

The response contains the import `id`.

### Step 2: insert rows in batches

```bash
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" -X POST https://api.adversus.io/v1/imports/$IMPORT_ID/insert \
  -H 'Content-Type: application/json' \
  -d '[
    {"data": {"13266": "Alice", "13267": "+4512345678"}},
    {"data": {"13266": "Bob",   "13267": "+4587654321"}}
  ]'
```

The spec does not state a maximum batch size. Batches of 200 to 500 rows keep each request small and stay within the 60/min burst limit for files of tens of thousands of rows. Note the spec lists this path as `/imports{id}/insert` (missing slash); the working path is `/imports/{id}/insert`.

### Step 3: start, then wait

```bash
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" -X POST https://api.adversus.io/v1/imports/$IMPORT_ID/start
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" https://api.adversus.io/v1/imports/$IMPORT_ID
```

Either poll `GET /imports/{id}` with increasing intervals (5 s, 15 s, 60 s) or wait for the `callbackUrl`. Do both in production: the callback is faster, polling is the safety net.

### Dedupe advice

Duplicate detection compares field values as stored, so normalise before you insert:

- Phone numbers: convert to E.164 (`+4512345678`), strip spaces, dashes and leading zeros, apply the default country code. Decide once how to treat numbers that fail parsing (reject the row, or import without phone and flag it).
- Email: trim and lower-case. Do not strip plus-addressing unless your CRM does.
- Names: do not use as match fields; they are not stable.
- Run a dry-run first: parse the file, normalise, count duplicates within the file itself, and show the result before creating the import. The CSV wizard in this repo does this and reports in-file duplicates separately from duplicates against Adversus.

## 5. Updating existing records

| Need | Call | Notes |
| --- | --- | --- |
| Update a lead you already know the ID of | `PUT /leads/{id}` | Send the full lead representation as returned by `GET /leads/{id}` with your changes. |
| Update a contact by your own identifier | `PATCH /contacts-external/{externalId}` with `{"poolId":"2409","data":{"13267":"88668866"}}` | Requires an external ID field populated at import time. Best option for CRM-driven updates. |
| Find contacts by field values | `POST /contacts/findByData` | Filter keys are field IDs; only `$eq` and `$in` are allowed. Use it to resolve a phone or email to a contact ID. |
| Put an existing contact into a campaign | `POST /campaigns/{id}/addContact` (single) or `/addContacts` (batch) | Creates a lead for that contact in the campaign. |
| Partial update of contact data | `PATCH /contacts/{id}` | When you know the Adversus contact ID. |
| Remove | `DELETE /leads/{id}`, `DELETE /contacts/{id}` | Prefer closing or deactivating leads over deleting, so call history is preserved. |

Typical flow from a CRM change: `findByData` on the external ID or phone -> if found, `PATCH /contacts/{id}` or `PATCH /contacts-external/{externalId}` -> if the contact is not yet in the target campaign, `POST /campaigns/{id}/addContact` -> if not found at all, `POST /contacts` followed by `addContact`, or queue it for the next import.

## 6. Field mappings

Adversus field IDs are internal numbers; your system has its own names or IDs. A field mapping stores the translation on the Adversus side so that, in the words of the spec, "the mappings can be used to return an external ID of a field instead of Adversus internal ID".

```bash
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" -X POST https://api.adversus.io/v1/field-mappings \
  -H 'Content-Type: application/json' \
  -d '{"name": "crm-v1", "mappings": {"13266": "first_name", "13267": "phone", "13270": "crm_contact_id"}}'
```

Definition: `{id, name, mappings: {adversusFieldId: externalId}, lastUpdated}`. Manage with `GET/PUT/DELETE /field-mappings/{id}`.

Why bother: when an admin adds or renames a field, you update one mapping instead of redeploying your integration, and support staff can read the mapping to understand what `13267` means. The field-mapping editor in this repo lets you edit a mapping and preview a record translated through it. Exactly which read endpoints honour a mapping is not spelled out in the spec; test with your target endpoint before relying on it.

## 7. Webhooks (outbound from Adversus)

Webhook management is API-only; there is no UI.

```bash
curl -u "$ADVERSUS_USER:$ADVERSUS_PASS" -X POST https://api.adversus.io/v1/webhooks \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "lead_saved",
    "url": "https://your-domain.example/hooks/receive",
    "authKey": "console-secret",
    "template": {"leadId": "[lead_id]", "status": "[status]", "agent": "[last_called_by]", "phone": "[13267]"}
  }'
```

### Events

`lead_saved`, `call_ended`, `callAnswered`, `leadClosedSuccess`, `leadClosedAutomaticRedial`, `leadClosedPrivateRedial`, `leadClosedNotInterested`, `leadClosedInvalid`, `leadClosedUnqualified`, `leadClosedSystem`, `leads_deactivated`, `leads_inserted`, `mail_activity`, `sms_sent`, `sms_received`, `appointment_added`, `appointment_updated`, `note_added`.

### What arrives

- `authKey` is appended to your URL as a query parameter (`?authKey=console-secret`). Verify it on every request. Because it travels in the URL, make sure your web server does not log query strings for this path.
- `template` is a JSON object with merge tags: `[fieldId]` for any field, plus `[status]`, `[last_called_by]` and `[lead_id]` (per https://help.adversus.io/en/articles/5699-how-to-use-webhooks). The rendered result is delivered in the `data` property. Templating currently works only for `lead_saved`; for other events, expect identifiers and fetch details with a follow-up GET.
- The body shape for non-templated events is not documented in the spec. Register the webhook against a receiver you control and capture real payloads before writing parsing code.
- Retry behaviour is not documented. Assume no retries and design your receiver so it never loses a delivery it has acknowledged.

### Receiver requirements

1. Respond `2xx` within a couple of seconds. Do nothing slow inline.
2. Verify `authKey` before parsing the body. Reject with `401` otherwise.
3. Derive an idempotency key (for example a hash of event, lead ID and timestamp, or a provider ID if present) and drop duplicates.
4. Persist the raw delivery, then enqueue downstream work (CRM update, ticket creation).
5. Retry downstream work with exponential backoff and a dead-letter queue.
6. Log every delivery with headers, body, result and timing, and provide a replay action for support.

The receiver in this repo at `/hooks/receive` implements all six, accepts JSON, form-urlencoded and XML bodies, and forwards to a mock CRM at `/crm` with backoff and a delivery log.

## 8. Journeys (inbound to Adversus)

Journeys is the automation module. An external system can start a Journey by calling a webhook trigger URL (help article: https://help.adversus.io/en/articles/5695-trigger-journeys-by-using-webhooks).

1. In Adversus: Journeys > Available integrations > Webhook > "Connect Webhook with Adversus". Choose the auth type (the article's example uses Bearer) and a resource type such as Leads.
2. Copy the trigger URL and token.
3. Test from your side:

```bash
curl -X POST "$JOURNEY_TRIGGER_URL" \
  -H "Authorization: Bearer $JOURNEY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"leadId": 292784703, "updatedName": "John Doe", "updatedPhone": "+45 86 3000 86"}'
```

4. Back in Adversus, pick a property from the received request and match it to a reference: the lead ID, or a custom field such as phone or external ID. Then map the remaining "Webhook fields" to Adversus fields.
5. Add the actions the Journey should perform (update the lead, move it to a campaign, send an SMS, or call your API through a "Custom API Request").

The simulator in this repo at `/journeys/{id}/trigger` accepts the same call with Bearer auth and shows how the body is matched to a lead, so you can rehearse the mapping before touching production.

## 9. Go-live checklist and rollback

**Before go-live**

- [ ] Dedicated API user per integration; credentials in a secret manager.
- [ ] Field IDs resolved from `GET /fields`, stored in a field mapping, not hard-coded.
- [ ] Import tested end to end with a 50-row file, including deliberate duplicates in the file and against the pool.
- [ ] Rate limiter configured (60/min, 2 concurrent) and 429 handling tested with a deliberate burst.
- [ ] Incremental sync run twice in a row with no changes; second run writes zero rows.
- [ ] Webhook receiver verified with a wrong `authKey` (expect 401) and a duplicate delivery (expect no double processing).
- [ ] Real payloads captured for every event you subscribe to.
- [ ] Monitoring: alert on 4xx/5xx from Adversus, on webhook deliveries not seen for N hours during business hours, and on dead-letter queue growth.
- [ ] Owner on each side named, with an escalation path to Adversus support.

**Rollback**

- Webhooks: `DELETE /webhooks/{id}` (or `PUT` the URL to a holding endpoint that just stores deliveries) stops the outbound flow immediately. Keep the webhook IDs in your deployment notes.
- Imports: an import that has been started cannot be un-started via the API as far as the spec shows. Import into a staging campaign first, verify, then move leads; or keep the import IDs so support can identify the batch.
- Sync: disable the scheduler and reset the cursor to the last known-good run. Because the connector upserts by `id`, re-running from an older cursor is safe.
- Journeys: deactivate the Journey in the Adversus UI; the trigger URL will stop having effect.

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401` with `{"status":"error","message":"Authentication failed"}` | Wrong credentials, the user is not an API user, or the `Authorization` header was dropped by a proxy | Test with `curl -u` directly; confirm the user was created with the "Create an API user" procedure; check that your HTTP client sends Basic auth on the first request rather than waiting for a challenge. |
| `400` with a message like "Unknown campaignId" | Campaign ID from another account or environment, or the campaign was deleted | `GET /campaigns` and compare; stop hard-coding IDs and resolve by name at startup. |
| `429` | More than 60 requests in a minute, more than 2 concurrent, or more than 1000 in an hour | Add the token bucket and semaphore from section 2; honour `Retry-After` if present, otherwise back off exponentially; switch from full to incremental sync. |
| Webhook received but `authKey` does not match | Key rotated in Adversus but not in the receiver, URL re-encoded by a proxy, or two webhooks pointing at the same URL with different keys | `GET /webhooks` and compare `authKey` per webhook; accept a list of valid keys during rotation. |
| Template field renders empty | The field is not enabled on the campaign the lead belongs to, or the ID is a lead field where a contact field was expected (or vice versa) | Check `GET /campaign-fields` for the campaign; test with `[lead_id]` to confirm templating itself works; remember templating is only available on `lead_saved`. |
| Duplicates after import | `match.fields` not set, or values not normalised so "12 34 56 78" and "+4512345678" did not match | Set `match.fields` to the phone and email field IDs; normalise to E.164 and lower-case email before insert; add the relevant pools to `match.blacklist`. |
| Sync misses rows | Cursor advanced to "now" instead of the last seen `lastModifiedTime`, or no overlap window, or sort direction descending while paginating | Advance the cursor to the max value seen; subtract a 5 to 10 minute overlap; sort ascending; dedupe on `id`. |
| `404` on import insert or start | Path built from the spec typo `/imports{id}/insert` | Use `/imports/{id}/insert` and `/imports/{id}/start`. |
| Import stays queued | Processing is asynchronous and may take time under load; callback URL unreachable | Poll `GET /imports/{id}` with backoff; check that your `callbackUrl` is public and returns 2xx; contact support with the import ID if it does not progress. |

If you get stuck, collect the request (method, URL, redacted headers, body), the full response and the timestamp, and send them to Adversus support together with your API username. That is what they will ask for first.
