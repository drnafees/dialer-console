# AGENTS.md

Cloudflare Pages project: console (`src/web`) over a mock dialer REST API served by Pages Functions (`functions/v1/[[path]].ts`), plus an integration toolkit (`functions/integrations`, `functions/journeys`, `functions/_lib`), all sharing pure code in `src/core`.

## Commands
- `npm run preview` builds and serves page + API + local KV on :8788. KV binding comes from `wrangler.toml`; placeholder ids are fine locally, real ids are needed for deploy. `npm test`, `npm run typecheck`, `npm run build`.
- Only one project exists: this directory. Do not create sibling projects.
- Use `scripts/dev-server.sh` to (re)start the local server; it kills whatever holds :8788 first. `pkill -x workerd` alone is not enough: the parent wrangler respawns it.
- Two tsconfigs (browser vs workers-types); `src/core` must compile under both, so no DOM or Node APIs there.

## Conventions
- No third-party brand names or logos in `src/`, `functions/`, `public/` or the UI. The API is "a dialer API modelled on a public OpenAPI spec". `docs/` and `postman/` are analysis material and may name vendors.
- The API router (`src/core/mock-api.ts`) is pure: `(request, store) => result`. Keep Cloudflare specifics in `functions/`.
- Seed rows with dates are factories (`buildLeads()`, `buildContacts()`, `buildSessions()`) because Workers freeze `Date.now()` at module load.
- Side effects (webhook dispatch, import processing) are returned from the router as data (`emitted`, `startedImports`) and performed by the adapter in `waitUntil`.
- KV "tables" go through `Collection` in `functions/_lib/kv-store.ts` (index key + one key per row). Add a collection rather than ad-hoc keys.
- `.shots/` holds screenshots from Playwright checks; it is gitignored.
- Icons: Lucide only via `icon("name")`; register new names in the `ICONS` map in `src/web/ui.ts`. No emojis.
- UI copy is plain language first; API codes/paths go inside `dev(...)` or `.dev-block` so they only show in Developer view. Labels for statuses/events live in `src/web/labels.ts`.
- Demo credentials are `demo` / `demo`; the receiver authKey is `console-secret`.
- The terminal tool in this environment rejects heredocs; write files with the editor.
