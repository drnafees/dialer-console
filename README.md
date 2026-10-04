# Dialer Console

A mock of an outbound dialer's REST API, a page that uses it, and the integration toolkit a solution engineer would hand to a customer.

Log in, change a lead's status, and watch the webhook arrive. No vendor account needed; the mock ships with the project. Demo login: `demo` / `demo`.

The mock follows the public OpenAPI spec of a commercial dialer: Basic auth, `[{ id, value }]` lead data keyed by field ID, JSON `filters` in the query string, `{ code, message }` errors, webhooks with an `authKey` query parameter and `[fieldId]` templates, imports with duplicate matching, contacts in pools, field mappings, and the 60/min · 1000/h · 2-concurrent rate limit.

## The page

**Demo** (front page)

1. **Log in** — `GET /organization` with `Authorization: Basic …`
2. **Leads** — `GET /leads`; changing a status sends `PUT /leads/{id}`
3. **Webhooks** — `POST /webhooks { event, url, authKey, template }`
4. **Received webhooks** — what the API delivered to the page's own `/hooks/receive`

**Toolkit** (tabs)

| Tab | What it does | Vendor API used |
|---|---|---|
| Import | CSV → column guesses → dedupe dry-run (E.164 phones, lower-cased email, blacklist pools) → run | `POST /imports`, `/imports/{id}/insert`, `/imports/{id}/start`, `GET /imports/{id}`, `callbackUrl` |
| Field mappings | Dialer field IDs ↔ CRM property names | `POST/GET/PUT/DELETE /field-mappings` |
| CRM connector | Incremental sync on `lastModifiedTime $gt cursor` with overlap window, `nextUrl` paging, token bucket (60/min, 2 concurrent), dry-run, conflict policies, run log, mock CRM | `GET /leads?filters=…&includeMeta=true` |
| Deliveries | Receiver accepting JSON, form-urlencoded and XML; authKey check; idempotency; forward to CRM with backoff 0s/2s/10s/60s/5m; per-attempt log; replay | `/hooks/receive` (ours) |
| Journeys | Inbound trigger simulator: Bearer token, match on lead id / external id / phone, map body keys to fields; applies via `PUT /leads/{id}` so outbound webhooks fire | `PUT /leads/{id}` |
| Request log | Every `/v1` call with `X-Request-Id`, latency, status, remaining rate budget | — |
| Diagnose | Checks the integration end to end and explains findings in customer language | — |

## Run

```bash
npm install
npm run preview      # http://localhost:8788
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

`npm test` (36 tests), `npm run typecheck`, `npm run build`. Import `postman/` into Postman for a 40-request collection covering every route.

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
test/                        36 tests
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
