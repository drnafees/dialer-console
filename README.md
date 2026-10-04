# Dialer Console

A mock of an outbound dialer's REST API, plus one page that uses it.

Log in, change a lead's status, and watch the webhook arrive. No vendor account needed; the mock ships with the project. Demo login: `demo` / `demo`.

The mock follows the public OpenAPI spec of a commercial dialer: Basic auth, `[{ id, value }]` lead data keyed by field ID, JSON `filters` in the query string, `{ code, message }` errors, webhooks with an `authKey` query parameter and `[fieldId]` templates.

## The page

1. **Log in** — `GET /organization` with `Authorization: Basic …`
2. **Leads** — `GET /leads`; changing a status sends `PUT /leads/{id}`
3. **Webhooks** — `POST /webhooks { event, url, authKey }`
4. **Received webhooks** — what the API delivered to the page's own `/hooks/receive`

## Run

```bash
npm install
npm run preview      # http://localhost:8788
```

```bash
AUTH="Authorization: Basic $(printf 'demo:demo' | base64)"
curl -H "$AUTH" localhost:8788/v1/organization
curl -H "$AUTH" 'localhost:8788/v1/leads?filters={"status":{"$eq":"new"}}'
curl -H "$AUTH" -H 'Content-Type: application/json' -X PUT localhost:8788/v1/leads/204179334 -d '{"status":"success"}'
```

`npm test`, `npm run typecheck`, `npm run build`.

## Mock API routes

`GET /organization`, `GET /fields`, `GET /users`, `GET /campaigns`, `GET /campaigns/{id}`, `GET /sessions`,
`GET|POST /leads`, `GET|PUT|DELETE /leads/{id}`, `GET|POST /webhooks`, `GET|PUT|DELETE /webhooks/{id}`.

List routes accept `filters` (`$eq $neq $gt $lt $c $nc`), `sortProperty`, `sortDirection`, `page`, `pageSize`, `includeMeta`. Closing a lead (`success`, `notInterested`, `invalid`, `unqualified`) sets `active=false` and emits `lead_saved` plus `leadClosed*`. 60 requests/minute, then `429`.

## Files

```
src/core/mock-api.ts         the API as a pure function (auth, filters, routes, webhook events)
src/core/seed.ts             demo data
src/core/types.ts            types + validation
functions/v1/[[path]].ts     serves the API, delivers webhooks
functions/hooks/receive.ts   the page's webhook receiver
functions/console/events.ts  received-event log; DELETE resets demo data
src/web/main.ts              the page
test/mock-api.test.ts        15 tests
```

## Deploy

Cloudflare dashboard → Workers & Pages → Create → **Pages** → Connect to Git. Build command `npm run build`, output `dist`. After the first deploy, Settings → Bindings → add a KV namespace with variable name `CONSOLE_KV`, then retry the deployment.

MIT. Independent portfolio project; no vendor affiliation.
