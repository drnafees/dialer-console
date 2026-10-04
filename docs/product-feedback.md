# Integration feedback memo

**To:** Customer Experience lead, platform/dev team
**From:** Customer Solution Engineer candidate
**Date:** 2026-10-04
**Scope:** What I would raise in my first month, based on the public API spec, help center and integrations page. Everything here is from public material; I have not seen the internal roadmap, support ticket volume or customer data, so where I extrapolate I say so.

## 1. Summary

- The public Swagger spec (https://api.adversus.io/swagger/apinew.json) is good, but it contains a handful of errors that cost integrators real time: two malformed import paths, a contradictory pagination default, and a deprecated endpoint with no sunset date.
- The HubSpot how-to article still instructs customers to use HubSpot's v1 contacts API with a `hapikey`, which HubSpot retired in November 2022. New customers following it will fail.
- Webhooks authenticate with a static key in the query string, do not document retries or the payload body, and support templating only on `lead_saved`. Each of these creates a support load that a small amount of platform work would remove.
- The homepage names HubSpot and Pipedrive, but both are delivered through Journeys or a Zapier integration that is still labelled beta. A native two-way CRM sync is the integration I would expect the sales team to be asked for most.
- Three internal tooling ideas (an MCP server over the API, a spec-diff watcher, a webhook replay tool) would speed up CSE work and make customer debugging reproducible.

## 2. Documentation issues found

### 2.1 HubSpot article uses a retired HubSpot API

- **Observation:** https://help.adversus.io/en/articles/5696-send-leads-from-adversus-to-hubspot-technical (updated 30 July 2025) configures a Journey "Custom API Request" to `https://api.hubapi.com/contacts/v1/contact/createOrUpdate/email/{email}/?hapikey=...` with form-style `properties[0].property` / `properties[0].value` keys. HubSpot sunset API keys (`hapikey`) on 30 November 2022 in favour of private app tokens, and the v1 contacts API is legacy; the v3 CRM API is current.
- **Customer impact:** A new customer following the article will get an authentication error from HubSpot and open a ticket with us, even though the fault is on the HubSpot side of the request. It also makes the Journeys module look broken when it is not.
- **Suggested change:** Rewrite the article for v3: `POST https://api.hubapi.com/crm/v3/objects/contacts` (or upsert via `/crm/v3/objects/contacts/{email}?idProperty=email`) with an `Authorization: Bearer <private-app-token>` header and a JSON body `{"properties": {...}}`. Add a note on creating a private app with `crm.objects.contacts.write` scope.
- **Effort:** S (documentation only, assuming Custom API Request can send a JSON body and custom headers; the article suggests it can send headers because it uses an auth header pattern elsewhere).
- **How I'd verify:** Build the Journey against a HubSpot developer test account and record the exact screens; check with support how many HubSpot tickets came in since 2022.

### 2.2 Malformed import paths in the Swagger spec

- **Observation:** The spec lists `/imports{id}/insert` and `/imports{id}/start` without the slash before `{id}`, while `/imports/{id}` is correct. Source: https://api.adversus.io/swagger/apinew.json.
- **Customer impact:** Anyone generating a client from the spec (Postman import, openapi-generator, Zapier/Make connectors) gets a client that calls `/imports123/insert` and receives a 404. The import flow is the first thing a new customer touches, so this hits exactly the onboarding moment.
- **Suggested change:** Fix the two paths. Add a CI check that fails if any path contains `}{` or a letter directly followed by `{`.
- **Effort:** S.
- **How I'd verify:** Import the spec into Postman and run the generated import request; confirm the real endpoint is `/v1/imports/{id}/insert`.

### 2.3 Pagination doc contradicts itself

- **Observation:** The `pageSize` description reads "A limit on the number of objects to be returned, between 1 and 100. Default is 1000." Source: spec parameter descriptions.
- **Customer impact:** Integrators do not know whether to expect 100 or 1000 rows, so some will under-page and miss rows, others will over-request and hit the 60/min burst limit sooner. It also undermines trust in the rest of the document.
- **Suggested change:** State one maximum and one default, and state what happens when a caller exceeds the maximum (clamp vs 400).
- **Effort:** S.
- **How I'd verify:** Call `GET /v1/leads?pageSize=1000&includeMeta=true` and read `meta.pagination.pageSize`; then try `pageSize=101`.

### 2.4 `/cdr` is deprecated with no sunset date

- **Observation:** `/cdr` is marked "deprecated - use GET /calls" in the spec, but there is no removal date, no migration note on field differences, and no deprecation header mentioned.
- **Customer impact:** Customers with reporting pipelines on `/cdr` will not migrate until something breaks. When it is removed, they will all break on the same day.
- **Suggested change:** Publish a sunset date, add `Deprecation` and `Sunset` response headers (RFC 8594), add a field-by-field mapping from `/cdr` to `/calls` in the help center, and consider logging which API users still call `/cdr` so CSEs can contact them.
- **Effort:** S for docs and headers; M if we add per-user usage reporting.
- **How I'd verify:** Compare the response schemas for `/cdr` and `/calls` in the spec and ask the dev team whether `/cdr` usage is already tracked.

### 2.5 Webhook payload body is not documented

- **Observation:** The `/webhooks` definition documents `event`, `url`, `authKey` and `template`, and the help article https://help.adversus.io/en/articles/5699-how-to-use-webhooks describes merge tags, but neither documents the body that is actually delivered for events without a template (for example `call_ended` or `sms_received`).
- **Customer impact:** Developers have to create a webhook, point it at a request-bin service, trigger a real call and reverse-engineer the payload. That is slow and leaks production data into third-party tools.
- **Suggested change:** Add one example payload per event to the help article and a `WebhookDelivery` definition to the spec. Add a `POST /webhooks/{id}/test` endpoint that sends a sample payload.
- **Effort:** S for docs, M for the test endpoint.
- **How I'd verify:** Register one webhook per event against a receiver I control (this repo's `/hooks/receive`) and capture the bodies.

## 3. Webhook platform gaps

### 3.1 Static `authKey` in the query string

- **Observation:** The spec describes `authKey` as "AuthKey set as GET parameter in request", so the secret is delivered as `?authKey=...` on the webhook URL.
- **Customer impact:** Query strings end up in web server access logs, CDN logs, and proxy logs on the customer side; many security teams will reject this during review. A static key also gives no protection against replay.
- **Suggested change:** Keep `authKey` for backwards compatibility, and add an `X-Adversus-Signature` header containing `t=<unix timestamp>, v1=<HMAC-SHA256(secret, timestamp + "." + body)>`. Document a five-minute tolerance window. This is the pattern most SaaS webhook providers use, so customers' existing verification code will transfer.
- **Effort:** M.
- **How I'd verify:** Ask the dev team how webhooks are dispatched today and whether the body is available at signing time; prototype verification in the receiver in this repo.

### 3.2 No documented retry, backoff or delivery log

- **Observation:** Neither the spec nor the help article says what happens when a receiver returns 5xx or times out, or whether a customer can see failed deliveries.
- **Customer impact:** When a customer's endpoint is down for ten minutes, they do not know if events were lost. Support cannot tell them either without a dev. This is, I would guess, one of the more common "the integration is missing data" tickets; I would verify that with the support team.
- **Suggested change:** Document the current behaviour first (even "no retries" is useful to know). Then add retries with exponential backoff (for example 1 min, 5 min, 30 min, 2 h, 12 h), a `GET /webhooks/{id}/deliveries` endpoint with status, response code and attempt count, and a `POST /webhooks/{id}/deliveries/{deliveryId}/replay` action.
- **Effort:** M to L depending on the current dispatch architecture.
- **How I'd verify:** Point a webhook at a receiver that returns 503 for a period and observe whether and when redelivery happens.

### 3.3 Templates only on `lead_saved`

- **Observation:** The spec states "Currently only the webhook event lead_saved support the templating system".
- **Customer impact:** For `call_ended` or any `leadClosed*` event, the customer receives an event with IDs and must make a follow-up `GET /leads/{id}` (and often `GET /contacts/{id}`) to get the data they need. At scale that doubles or triples the API calls per event, pushes customers into the 60/min burst limit, and increases load on Adversus' own API.
- **Suggested change:** Extend templating to `call_ended` and the `leadClosed*` family, and add call-related tags such as `[disposition]`, `[duration]` and `[recording_url]`. This removes a round trip per event for the customer and reduces read load on the API.
- **Effort:** M.
- **How I'd verify:** Measure how many `GET /leads/{id}` calls follow within a few seconds of a `call_ended` delivery in API logs; that is the direct saving.

## 4. Native integration shortlist

Ranked by the combination of visible demand (what the website promises) and how many API primitives already exist.

| Rank | Integration | Who asks | MVP | Primitives that already exist |
| --- | --- | --- | --- | --- |
| 1 | HubSpot and Pipedrive two-way sync | Sales teams running outbound from a CRM; named on the homepage ("Including HubSpot, Pipedrive, Zapier, ZohoCRM etc.") but delivered via Journeys or Zapier, and https://www.adversus.io/integrations labels Zapier "beta" | CRM contact or deal -> Adversus lead via `/imports` with dedupe on phone/email; Adversus `leadClosed*` and `call_ended` -> CRM activity and stage update; field mapping UI backed by `/field-mappings` | `/imports` with `match.fields`, `/contacts-external/{externalId}`, `/field-mappings`, `/webhooks`, `/leads` with `lastModifiedTime` filters |
| 2 | Danish accounting push beyond e-conomic (Dinero, Billy) | Customers using the sales module to close orders and invoice; e-conomic is listed on the integrations page, the other two common Danish SMB systems are not | On `leadClosedSuccess` with a sale, create a customer and draft invoice in Dinero or Billy; one mapping of `/products` to accounting product lines | `/sales`, `/products`, `/webhooks` (`leadClosedSuccess`), Journeys Custom API Request for a no-code first version |
| 3 | Intercom or Zendesk ticket on `sms_received` | Support-led teams that also dial; the help center already has "How to get notified when an Inbound SMS has been received", which suggests customers ask | Create a conversation or ticket with the SMS text, link back to the lead; thread subsequent inbound SMS on the same ticket | `sms_received` webhook, `/sms`, `/leads/{id}`, `/notes` to write the ticket link back |
| 4 | Danish do-not-call check (Robinsonlisten) | Every Danish outbound customer; the import endpoint already has a French `processing.bloctel` flag, so the pattern exists | A `processing.robinson` flag on `/imports` that excludes or tags matched contacts; later a nightly re-check | `/imports` processing flags, `/pools` blacklist concept via `match.blacklist` |

Notes on the ranking: items 1 and 4 are the ones I would expect sales to hear about most, because one is on the homepage and the other is a legal requirement for the home market. I do not have access to the CRM or support data to confirm this; I would verify with the sales team and by searching closed tickets for "HubSpot", "Pipedrive", "Robinson" and "Dinero".

## 5. Internal workflow and AI ideas

- **MCP server over the Adversus API for CSEs.** A thin Model Context Protocol server exposing read-only tools (`list_campaigns`, `get_lead`, `search_contacts_by_phone`, `list_webhooks`, `recent_calls`) against a customer's API user lets a CSE ask an assistant "why did lead 292784703 not get the webhook?" and get an answer grounded in live data, with every call logged. Effort: S to M; the mock API in this repo is a safe place to build it.
- **Spec-diff job.** A scheduled job that fetches https://api.adversus.io/swagger/apinew.json, diffs it against the last version and posts a summary to a channel. It would have caught the issues in section 2 and gives CSEs a changelog to send to customers. Effort: S.
- **Webhook replay tool for support cases.** Given a delivery log (section 3.2), a tool that replays a chosen delivery to a customer's endpoint or to a staging URL, with the signature recomputed, turns "it did not arrive" tickets into a reproducible test. Effort: S once the delivery log exists; the receiver in this repo has a replay action as a reference.

## 6. What this repo demonstrates

This repository is an independent portfolio project: a mock of the Adversus API (Cloudflare Pages Functions over KV, demo credentials `demo`/`demo`) with a console on top. The toolkit shows the integration patterns discussed above working end to end: a CSV import wizard that drives the `POST /imports` -> `insert` -> `start` flow with duplicate checking; a field-mapping editor over `/field-mappings`; a CRM connector with dry-run and incremental sync (cursor on `lastModifiedTime`, token bucket at 60/min with a maximum of 2 concurrent requests, run log) against a mock CRM at `/crm`; a webhook receiver at `/hooks/receive` that accepts JSON, form-urlencoded and XML, enforces idempotency keys, retries toward the CRM with backoff, and keeps a delivery log with replay; a journey-trigger simulator at `/journeys/{id}/trigger` with Bearer auth; and a Postman collection in `postman/`.
