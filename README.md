# Dialer Console

A mock of an outbound dialer's REST API, a page that uses it, and the integration toolkit a solution engineer would hand to a customer.

Log in, change a lead's status, and watch the webhook arrive. No vendor account needed; the mock ships with the project. Demo login: `demo` / `demo`.

The mock follows the public OpenAPI spec of a commercial dialer: Basic auth, `[{ id, value }]` lead data keyed by field ID, JSON `filters` in the query string, `{ code, message }` errors, webhooks with an `authKey` query parameter and `[fieldId]` templates, imports with duplicate matching, contacts in pools, field mappings, and the 60/min · 1000/h · 2-concurrent rate limit.

## The page

Built so that someone who has never heard the word "webhook" can use it. Every tab says what it is for in one line, every step is numbered, every action tells you what happened in plain words, and nothing is real so nothing can break. Developers flip on **Developer view** (top right) to see the API codes, paths, raw JSON and curl commands behind every label.

| Tab | In plain words | Vendor API used |
|---|---|---|
| **Try it** | Connect, turn on notifications, change a contact, watch the message arrive. Four numbered steps. | `GET /organization`, `POST /webhooks`, `PUT /leads/{id}`, `GET /leads` |
| **Add people** | Paste a spreadsheet. See exactly who is new, who is already there, who must not be called. Then add them. | `POST /imports` → `/insert` → `/start` → `GET /imports/{id}`, `callbackUrl` |
| **Match fields** | "The dialer says Firstname, my CRM says first_name." Pair them once. | `/field-mappings` |
| **Sync to CRM** | Preview what would change, then copy changed contacts to a (pretend) CRM. Edit the CRM to see conflict rules work. | `GET /leads?filters=…&includeMeta=true` with cursor, overlap window, `nextUrl` paging, token bucket 60/min · 2 concurrent |
| **Incoming** | Every message the dialer sent, told as a story: received → key checked → not a duplicate → saved. Fake a message in JSON, form or XML; fake a wrong key; fake a CRM outage and watch retries. | `/hooks/receive` (ours) |
| **Push to dialer** | The other direction: make an "inbox" with a token; any app that posts to it updates the matching person. | `PUT /leads/{id}` |
| **Activity** | Every API call in a sentence ("Updated contact 204179334"), with result, latency and remaining rate budget. | — |
| **Health check** | Finds problems and says how to fix them in the words you would use with a customer. | — |

## Run

```bash
npm install
npm run preview            # build + serve on http://localhost:8788
scripts/dev-server.sh      # same, but first kills stray wrangler/workerd holding the port (FRESH=1 wipes local KV)
```

```bash
AUTH="Authorization: Basic $(printf 'demo:demo' | base64)"
curl -H "$AUTH" localhost:8788/v1/organization
curl -H "$AUTH" 'localhost:8788/v1/leads?filters={"status":{"$eq":"new"}}&includeMeta=true'
curl -H "$AUTH" -H 'Content-Type: application/json' -X PUT localhost:8788/v1/leads/204179334 -d '{"status":"success"}'

# import flow
curl -H "$AUTH" -H 'Content-Type: application/json' -X POST localhost:8788/v1/imports -d '{"poolId":21,"match":{"fields":[3],"blacklist":[23]},"updateFields":[4],"onImportedAction":{"type":"addToCampaign","campaignId":412}}'
curl -H "$AUTH" -H 'Content-Type: application/json' -X POST localhost:8788/v1/imports/<id>/insert -d '[{"data":{"1":"Alice","3":"20 12 34 56"}}]'
curl -H "$AUTH" -X POST localhost:8788/v1/imports/<id>/start
```

`npm test`, `npm run typecheck`, `npm run build`. Import `postman/` into Postman for a 40-request collection covering every route.

## Mock API routes

`GET /organization`, `GET /fields`, `GET /users`, `GET /campaigns`, `GET /campaigns/{id}`, `POST /campaigns/{id}/addContact`, `GET /sessions`, `GET /pools`, `GET /pools/{id}`,
`GET|POST /contacts`, `POST /contacts/findByData`, `GET|PATCH|DELETE /contacts/{id}`, `PATCH /contacts-external/{externalId}`,
`GET|POST /imports`, `GET /imports/{id}`, `POST /imports/{id}/insert`, `POST /imports/{id}/start`,
`GET|POST /leads`, `GET|PUT|DELETE /leads/{id}`,
`GET|POST /field-mappings`, `GET|PUT|DELETE /field-mappings/{id}`,
`GET|POST /webhooks`, `GET|PUT|DELETE /webhooks/{id}`.

List routes accept `filters` (`$eq $neq $gt $lt $c $nc`; `$in` only on `findByData`), `sortProperty`, `sortDirection`, `page`, `pageSize`, `includeMeta` (adds `firstUrl/previousUrl/nextUrl/lastUrl`). Closing a lead (`success`, `notInterested`, `invalid`, `unqualified`) sets `active=false` and emits `lead_saved` plus `leadClosed*`. Templates resolve `[fieldId]`, `[status]`, `[last_called_by]`, `[lead_id]` and are only accepted on `lead_saved`. Limits: 60/min, 1000/h, 2 concurrent → `429` with `Retry-After`. Every response carries `X-Request-Id` and `X-RateLimit-*`.

## Docs

- `docs/playbook.md` — customer integration runbook (auth, limits, filters, imports, webhooks, journeys, go-live, troubleshooting)
- `docs/errors.md` — error catalogue: symptom → cause → what to tell the customer
- `docs/product-feedback.md` — what I would raise with the vendor's dev team in my first month
- `postman/` — collection + local environment

## Files

```
src/core/mock-api.ts         the API as a pure function (auth, filters, routes, imports, webhook events)
src/core/import-pipeline.ts  dedupe plan + CSV parsing + header guessing (shared by API and wizard)
src/core/normalize.ts        E.164 / email / text normalisation for match keys
src/core/sync.ts             incremental sync engine + token-bucket rate limiter
src/core/inbound.ts          JSON / form / XML → one webhook envelope
src/core/seed.ts             demo data
src/core/types.ts            types + validation
functions/v1/[[path]].ts     serves the API, rate limits, request log, delivers webhooks, runs imports
functions/_lib/kv-store.ts   KV "tables"
functions/_lib/receiver.ts   receive → dedupe → forward with backoff → attempts log
functions/_lib/crm.ts        mock CRM + mapping-aware upsert + conflict policies
functions/integrations/      connector, sync, deliveries, CRM, request log, import preview, diagnose
functions/journeys/          inbound trigger simulator
functions/hooks/receive.ts   the page's webhook receiver
functions/console/events.ts  received-event log; DELETE resets demo data
src/web/main.ts              demo page + routing
src/web/toolkit.ts           the toolkit tabs
test/                        unit tests: router, import pipeline, sync engine, receiver, KV store
```

## Deploy

Bindings are declared in `wrangler.toml` (it sets `pages_build_output_dir`, so Cloudflare treats the file as the source of truth and the dashboard's Settings → Bindings is read-only).

1. Create the two KV namespaces once:

   ```bash
   npx wrangler login
   npx wrangler kv namespace create CONSOLE_KV            # production
   npx wrangler kv namespace create CONSOLE_KV --preview  # preview branches
   ```

2. Paste the printed ids into `wrangler.toml` as `id` and `preview_id` under `[[kv_namespaces]]` and commit.
3. Cloudflare dashboard → Workers & Pages → Create → **Pages** → Connect to Git. Build command `npm run build`, output `dist`. Or from the CLI: `npm run deploy`.

Local dev needs no account: `wrangler pages dev` reads the binding from `wrangler.toml` and backs it with a local emulator in `.wrangler/`.

MIT. Independent portfolio project; no vendor affiliation.
