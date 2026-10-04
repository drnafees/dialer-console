import * as seed from "../core/seed";
import type { ConnectorConfig, Field, FieldMapping } from "../core/types";
import { consoleApi, type DialerApi, type ImportPreview } from "./api";
import { $, $$, badge, card, esc, fail, fmtTime, icon, kpi, note, pre, statusBadge, table } from "./ui";

export interface ToolkitContext {
  api: DialerApi;
  fields: Map<number, Field>;
  origin: string;
}

type View = (root: HTMLElement, ctx: ToolkitContext) => Promise<void>;

// Resolved lazily so the map can sit above the view definitions.
const VIEWS: Record<string, () => View> = {
  import: () => importView,
  mapping: () => mappingView,
  connector: () => connectorView,
  deliveries: () => deliveriesView,
  journeys: () => journeysView,
  requests: () => requestsView,
  diagnose: () => diagnoseView,
};

export async function renderToolkit(name: string, root: HTMLElement, ctx: ToolkitContext): Promise<void> {
  const view = VIEWS[name]?.();
  if (!view) {
    root.innerHTML = `<p class="text-grey">Unknown page.</p>`;
    return;
  }
  root.innerHTML = `<p class="text-grey">Loading…</p>`;
  try {
    await view(root, ctx);
  } catch (e) {
    root.innerHTML = `<div class="card"><span id="err"></span></div>`;
    fail($("#err", root), e);
  }
}

const fieldOptions = (fields: Map<number, Field>, selected: number | string | null, allowNone = true) =>
  `${allowNone ? `<option value="">(ignore)</option>` : ""}${[...fields.values()].map((f) => `<option value="${f.id}" ${String(f.id) === String(selected) ? "selected" : ""}>${f.id} · ${esc(f.name)}</option>`).join("")}`;

const fname = (fields: Map<number, Field>, id: string | number) => fields.get(Number(id))?.name ?? String(id);

const SAMPLE_CSV = `Fornavn;Efternavn;Telefon;E-mail;Firma;Postnr;By
Alice;Andersen;20 12 34 56;alice.andersen@nordicbyg.dk;Nordic Byg A/S;8000;Aarhus
Bob;Bang;+45 12 12 12 12;bob@bangtransport.dk;Bang Transport;8200;Aarhus N
Ole;Blocked;99 88 77 66;;;;
Carl;Christensen;0045 13 13 13 13;carl@example.dk;Christensen Consulting;8700;Horsens
Alice;Andersen;+4520123456;alice.andersen@nordicbyg.dk;Nordic Byg A/S;8000;Aarhus`;

// ---- Import wizard ----------------------------------------------------------

const importView: View = async (root, ctx) => {
  const pools = await ctx.api.pools();
  const state = {
    csv: SAMPLE_CSV,
    columnMap: null as Record<string, string> | null,
    poolId: 21,
    matchFields: [3],
    blacklist: [23],
    updateFields: [4],
    campaignId: 412 as number | null,
    preview: null as ImportPreview | null,
  };

  const render = async () => {
    const p = state.preview;
    const history = await importHistory(ctx);
    root.innerHTML = `
<h1 class="text-3xl">Import wizard</h1>
<p class="mt-2 text-grey-2">The onboarding path: a CSV becomes contacts in a pool, de-duplicated, optionally placed on a campaign. Preview is computed with the same rules the import uses, so what you see is what you get.</p>

${card(
  "1. Paste a CSV",
  "Comma or semicolon separated; the first row is headers. Danish and English header names are recognised.",
  `
  <textarea id="csv" class="input mt-4 h-40 font-mono text-xs">${esc(state.csv)}</textarea>
  <div class="mt-3 flex flex-wrap items-end gap-3">
    <div><label class="label">Pool</label><select id="pool" class="input">${pools.map((x) => `<option value="${x.id}" ${x.id === state.poolId ? "selected" : ""}>${x.id} · ${esc(x.name)}</option>`).join("")}</select></div>
    <div><label class="label">Dedupe on (match.fields)</label><select id="match" class="input" multiple size="3">${[...ctx.fields.values()]
      .slice(0, 7)
      .map((f) => `<option value="${f.id}" ${state.matchFields.includes(f.id) ? "selected" : ""}>${esc(f.name)}</option>`)
      .join("")}</select></div>
    <div><label class="label">Check against pools (match.blacklist)</label><select id="blacklist" class="input" multiple size="3">${pools.map((x) => `<option value="${x.id}" ${state.blacklist.includes(x.id) ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
    <div><label class="label">Update on existing (updateFields)</label><select id="update" class="input" multiple size="3">${[...ctx.fields.values()]
      .slice(0, 7)
      .map((f) => `<option value="${f.id}" ${state.updateFields.includes(f.id) ? "selected" : ""}>${esc(f.name)}</option>`)
      .join("")}</select></div>
    <div><label class="label">Then add to campaign</label><select id="campaign" class="input"><option value="">(no)</option>${seed.campaigns.map((c) => `<option value="${c.id}" ${c.id === state.campaignId ? "selected" : ""}>${c.id} · ${esc(c.settings.name)}</option>`).join("")}</select></div>
    <button id="preview" class="btn btn-indigo">${icon("eye")} Preview</button>
  </div>`,
)}

${
  p
    ? card(
        "2. Map columns to field IDs",
        "Guessed from headers. Field IDs are global in the dialer; campaigns pick which to use.",
        `
  <div class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">${p.headers.map((h) => `<div><label class="label">${esc(h)}</label><select class="input" data-col="${esc(h)}">${fieldOptions(ctx.fields, p.columnMap[h] ?? null)}</select></div>`).join("")}</div>
  <p class="mt-3 text-xs text-grey">Changing a mapping re-runs the preview.</p>`,
      )
    : ""
}

${
  p
    ? card(
        "3. Dry-run result",
        `${p.rowCount} rows. Phone numbers are normalised to E.164 and emails lower-cased before matching.`,
        `
  <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">${kpi("Insert", p.plan.summary.inserted, "text-accent")}${kpi("Update", p.plan.summary.updated, "text-indigo-brand")}${kpi("Duplicate", p.plan.summary.duplicates, "text-grey-2")}${kpi("Blacklisted", p.plan.summary.blacklisted, "text-coral-dark")}</div>
  ${table(
    ["#", "Action", "Match key", "Row", "Changes"],
    p.plan.rows.map((r) => [
      String(r.index + 1),
      statusBadge(r.action),
      `<code>${esc(r.key ?? "-")}</code>`,
      `<span class="text-xs">${esc(
        Object.entries(r.data)
          .map(([k, v]) => `${fname(ctx.fields, k)}=${v}`)
          .join(", "),
      )}</span>`,
      Object.keys(r.changes).length
        ? `<span class="text-xs">${esc(
            Object.entries(r.changes)
              .map(([k, c]) => `${fname(ctx.fields, k)}: "${c.from}" → "${c.to}"`)
              .join("; "),
          )}</span>`
        : r.existingId
          ? `<span class="text-xs text-grey">matches contact ${r.existingId}</span>`
          : "",
    ]),
  )}
  <div class="mt-5 flex flex-wrap items-center gap-3">
    <button id="run" class="btn btn-coral">${icon("upload")} Run import</button>
    <span class="text-sm text-grey-2">POST /imports → POST /imports/{id}/insert (batches of 100) → POST /imports/{id}/start → poll GET /imports/{id}</span>
    <span id="run-msg" class="text-sm"></span>
  </div>
  <div id="run-log" class="mt-3"></div>`,
      )
    : ""
}

${history}`;

    $("#csv", root).oninput = (e) => {
      state.csv = (e.target as HTMLTextAreaElement).value;
    };
    const multi = (sel: string) => $$<HTMLOptionElement>(`${sel} option:checked`, root).map((o) => Number(o.value));
    $("#preview", root).onclick = async () => {
      state.poolId = Number($<HTMLSelectElement>("#pool", root).value);
      state.matchFields = multi("#match");
      state.blacklist = multi("#blacklist");
      state.updateFields = multi("#update");
      state.campaignId = Number($<HTMLSelectElement>("#campaign", root).value) || null;
      state.preview = await consoleApi.importPreview({
        csv: state.csv,
        columnMap: state.columnMap ?? undefined,
        poolId: state.poolId,
        matchFields: state.matchFields,
        blacklist: state.blacklist,
        updateFields: state.updateFields,
      });
      state.columnMap = state.preview.columnMap;
      await render();
    };
    for (const sel of $$<HTMLSelectElement>("[data-col]", root)) {
      sel.onchange = async () => {
        state.columnMap = Object.fromEntries(
          $$<HTMLSelectElement>("[data-col]", root)
            .map((s) => [s.dataset.col!, s.value])
            .filter(([, v]) => v),
        );
        $("#preview", root).click();
      };
    }
    const run = root.querySelector<HTMLButtonElement>("#run");
    if (run) run.onclick = () => void runImport();
  };

  const runImport = async () => {
    const msg = $("#run-msg", root);
    const log = $("#run-log", root);
    const lines: string[] = [];
    const say = (s: string) => {
      lines.push(s);
      log.innerHTML = pre(lines.join("\n"));
    };
    try {
      const p = state.preview!;
      const body = {
        poolId: state.poolId,
        match: { fields: state.matchFields, blacklist: state.blacklist },
        updateFields: state.updateFields,
        ...(state.campaignId ? { onImportedAction: { type: "addToCampaign", campaignId: state.campaignId } } : {}),
        callbackUrl: `${ctx.origin}/hooks/receive?authKey=console-secret`,
      };
      say(`POST /imports ${JSON.stringify(body)}`);
      const { id } = await ctx.api.createImport(body);
      say(`→ { id: ${id} }`);
      for (let i = 0; i < p.rows.length; i += 100) {
        const batch = p.rows.slice(i, i + 100).map((data) => ({ data }));
        const r = await ctx.api.insertImport(id, batch);
        say(`POST /imports/${id}/insert (${batch.length} rows) → rowCount ${r.rowCount}`);
      }
      await ctx.api.startImport(id);
      say(`POST /imports/${id}/start → queued`);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const job = await ctx.api.getImport(id);
        say(`GET /imports/${id} → ${job.status}`);
        if (job.status === "completed" || job.status === "failed") {
          say(JSON.stringify(job.result, null, 2));
          note(msg, job.status === "completed" ? "Import completed" : "Import failed", job.status === "completed" ? "ok" : "warn");
          break;
        }
      }
      state.preview = null;
      setTimeout(() => void render(), 1500);
    } catch (e) {
      fail(msg, e);
    }
  };

  await render();
};

async function importHistory(ctx: ToolkitContext): Promise<string> {
  const imports = (await ctx.api.imports()).sort((a, b) => b.created.localeCompare(a.created));
  return card(
    "Import history",
    "GET /imports",
    table(
      ["Id", "Status", "Pool", "Rows", "Result", "Created"],
      imports.map((j) => [
        String(j.id),
        statusBadge(j.status),
        String(j.poolId),
        String(j.rowCount),
        j.result
          ? `<span class="text-xs">${j.result.inserted} inserted, ${j.result.updated} updated, ${j.result.duplicates} dup, ${j.result.addedToCampaign} on campaign</span>`
          : "-",
        fmtTime(j.created),
      ]),
      "No imports yet.",
    ),
  );
}

// ---- Field mappings ---------------------------------------------------------

const mappingView: View = async (root, ctx) => {
  const render = async () => {
    const mappings = await ctx.api.fieldMappings();
    root.innerHTML = `
<h1 class="text-3xl">Field mappings</h1>
<p class="mt-2 text-grey-2">Translate dialer field IDs into the names your CRM uses. The CRM connector applies the selected mapping on every create/update. Stored via <code>POST /field-mappings</code>.</p>
${card(
  "New mapping",
  "",
  `
  <form id="new" class="mt-4">
    <div class="flex flex-wrap items-end gap-3"><div class="flex-1"><label class="label">Name</label><input id="name" class="input" value="CRM contact properties"></div></div>
    <div class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">${[...ctx.fields.values()].map((f) => `<div class="flex items-center gap-2"><span class="w-40 shrink-0 text-sm"><code>${f.id}</code> ${esc(f.name)}</span>${icon("arrow-right", "icon text-grey")}<input class="input" data-fid="${f.id}" placeholder="external property" value="${esc(DEFAULT_MAP[f.name] ?? "")}"></div>`).join("")}</div>
    <div class="mt-4 flex items-center gap-3"><button class="btn btn-indigo">${icon("save")} Save mapping</button><span id="msg" class="text-sm"></span></div>
  </form>`,
)}
${card(
  "Existing mappings",
  "",
  mappings.length
    ? mappings
        .map(
          (m) => `
  <details class="mt-3 rounded-xl border border-line p-3"><summary class="flex cursor-pointer items-center gap-3"><strong>${esc(m.name)}</strong><span class="text-xs text-grey">id ${m.id} · ${Object.keys(m.mappings).length} fields · ${fmtTime(m.lastUpdated)}</span><button class="ml-auto text-xs text-coral-dark" data-del="${m.id}">Delete</button></summary>
  ${table(
    ["Dialer field", "", "External"],
    Object.entries(m.mappings).map(([k, v]) => [
      `<code>${k}</code> ${esc(fname(ctx.fields, k))}`,
      icon("arrow-right", "icon text-grey"),
      `<code>${esc(v)}</code>`,
    ]),
  )}
  </details>`,
        )
        .join("")
    : `<p class="mt-4 text-sm text-grey">None yet.</p>`,
)}`;

    $("#new", root).onsubmit = async (e) => {
      e.preventDefault();
      const mappingsObj = Object.fromEntries(
        $$<HTMLInputElement>("[data-fid]", root)
          .filter((i) => i.value.trim())
          .map((i) => [i.dataset.fid!, i.value.trim()]),
      );
      try {
        await ctx.api.createFieldMapping({ name: $<HTMLInputElement>("#name", root).value, mappings: mappingsObj });
        await render();
      } catch (err) {
        fail($("#msg", root), err);
      }
    };
    for (const b of $$<HTMLButtonElement>("[data-del]", root))
      b.onclick = async (e) => {
        e.preventDefault();
        await ctx.api.deleteFieldMapping(Number(b.dataset.del));
        await render();
      };
  };
  await render();
};

const DEFAULT_MAP: Record<string, string> = {
  Firstname: "firstname",
  Lastname: "lastname",
  Phone: "phone",
  Email: "email",
  Company: "company",
  Zip: "zip",
  City: "city",
  Interest: "product_interest",
  "Meeting time": "meeting_at",
  "Deal value": "amount",
  "Decision maker": "is_decision_maker",
  "Current provider": "current_provider",
};

// ---- CRM connector ----------------------------------------------------------

const connectorView: View = async (root, ctx) => {
  const render = async () => {
    const [{ connector, cursor, mappings }, runs, records] = await Promise.all([consoleApi.connector(), consoleApi.syncRuns(), consoleApi.crm()]);
    root.innerHTML = `
<h1 class="text-3xl">CRM connector</h1>
<p class="mt-2 text-grey-2">Two paths keep a CRM in step with the dialer: webhooks for real time (see Deliveries) and an incremental sync for catch-up. The sync reads <code>GET /leads</code> with <code>lastModifiedTime $gt cursor</code>, pages with <code>nextUrl</code>, and goes through a token bucket (60/min, 2 concurrent) so it never trips the vendor's limits.</p>

${card(
  "Settings",
  "",
  `
  <form id="cfg" class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <div><label class="label">Field mapping</label><select class="input" name="fieldMappingId"><option value="">(dialer field names)</option>${mappings.map((m: FieldMapping) => `<option value="${m.id}" ${m.id === connector.fieldMappingId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
    <div><label class="label">Direction</label><select class="input" name="direction"><option value="dialer_to_crm" ${connector.direction === "dialer_to_crm" ? "selected" : ""}>Dialer → CRM</option><option value="two_way" ${connector.direction === "two_way" ? "selected" : ""}>Two-way (CRM edits flow back via Journeys)</option></select></div>
    <div><label class="label">Conflict policy</label><select class="input" name="conflictPolicy">${["last_write_wins", "dialer_wins", "crm_wins"].map((p) => `<option value="${p}" ${connector.conflictPolicy === p ? "selected" : ""}>${p}</option>`).join("")}</select></div>
    <div><label class="label">Campaigns (empty = all)</label><select class="input" name="campaignIds" multiple size="2">${seed.campaigns.map((c) => `<option value="${c.id}" ${connector.campaignIds.includes(c.id) ? "selected" : ""}>${c.id} · ${esc(c.settings.name)}</option>`).join("")}</select></div>
    <div><label class="label">Overlap window (s)</label><input class="input" name="overlapSeconds" type="number" value="${connector.overlapSeconds}"></div>
    <div><label class="label">Page size</label><input class="input" name="pageSize" type="number" value="${connector.pageSize}"></div>
    <div class="sm:col-span-2 lg:col-span-3 flex flex-wrap items-center gap-3">
      <button class="btn btn-indigo">${icon("save")} Save</button>
      <span class="text-sm text-grey-2">Cursor: <code>${esc(cursor ?? "never run")}</code></span>
      <button type="button" id="reset-cursor" class="btn btn-ghost btn-sm">Reset cursor</button>
      <span id="cfg-msg" class="text-sm"></span>
    </div>
  </form>`,
)}

${card(
  "Run",
  "Dry-run shows exactly what would be written without touching the CRM.",
  `
  <div class="mt-4 flex flex-wrap items-center gap-3">
    <button id="dry" class="btn btn-outline">${icon("flask-conical")} Dry-run</button>
    <button id="sync" class="btn btn-coral">${icon("refresh-cw")} Sync now</button>
    <span id="run-msg" class="text-sm"></span>
  </div>
  <div id="run-out" class="mt-4"></div>`,
)}

${card(
  "Sync runs",
  "",
  table(
    ["Started", "Mode", "Status", "Cursor", "Requests", "Rows", "Created", "Updated", "Skipped", "Failed", "Waited"],
    runs.map((r) => [
      fmtTime(r.startedAt),
      r.dryRun ? badge("dry-run", "bg-paper-2 text-grey-2") : badge("live", "bg-indigo-soft text-indigo-brand"),
      statusBadge(r.status),
      `<span class="text-xs">${esc(r.cursorBefore.slice(0, 19))} → ${esc((r.cursorAfter ?? "").slice(0, 19))}</span>`,
      `${r.requestsMade} (${r.pagesFetched} pages)`,
      String(r.rowsFetched),
      String(r.created),
      String(r.updated),
      String(r.skipped),
      String(r.failed),
      `${r.rateLimitWaitsMs} ms`,
    ]),
    "No runs yet.",
  ),
)}

${card(
  "Mock CRM",
  `${records.length} records. Edit a value to simulate a change made in the CRM; conflict policies then apply on the next sync.`,
  `
  <div class="mt-2 flex justify-end"><button id="clear-crm" class="text-xs text-coral-dark">Wipe CRM</button></div>
  ${table(
    ["Lead", "External id", "Source", "Updated", "Properties"],
    records.map((r) => [
      String(r.dialerLeadId ?? "-"),
      esc(r.externalId ?? "-"),
      badge(r.source, r.source === "manual" ? "bg-amber-soft text-amber" : "bg-paper-2 text-grey-2"),
      fmtTime(r.updatedAt),
      `<div class="flex flex-wrap gap-1">${Object.entries(r.properties)
        .map(
          ([k, v]) =>
            `<span class="rounded-md bg-paper-2 px-1.5 py-0.5 text-xs" title="click to edit" data-edit="${r.id}" data-key="${esc(k)}"><b>${esc(k)}</b>=${esc(v)}</span>`,
        )
        .join("")}</div>`,
    ]),
    "Empty. Run a sync or trigger a webhook.",
  )}`,
)}`;

    $("#cfg", root).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target as HTMLFormElement);
      const patch: Partial<ConnectorConfig> = {
        fieldMappingId: f.get("fieldMappingId") ? Number(f.get("fieldMappingId")) : null,
        direction: f.get("direction") as ConnectorConfig["direction"],
        conflictPolicy: f.get("conflictPolicy") as ConnectorConfig["conflictPolicy"],
        campaignIds: f.getAll("campaignIds").map(Number),
        overlapSeconds: Number(f.get("overlapSeconds")),
        pageSize: Number(f.get("pageSize")),
      };
      await consoleApi.saveConnector(patch);
      note($("#cfg-msg", root), "Saved");
    };
    $("#reset-cursor", root).onclick = async () => {
      await consoleApi.saveConnector({ cursor: null });
      await render();
    };
    const run = async (dry: boolean) => {
      const msg = $("#run-msg", root);
      msg.textContent = "Running…";
      try {
        const { run } = await consoleApi.sync(dry);
        note(
          msg,
          `${dry ? "Dry-run" : "Sync"} ${run.status}: ${run.rowsFetched} rows in ${run.requestsMade} requests`,
          run.status === "completed" ? "ok" : "warn",
        );
        $("#run-out", root).innerHTML = table(
          ["Lead", "Action", "Reason", "Properties"],
          run.preview.map((p) => [
            String(p.leadId),
            statusBadge(p.action),
            esc(p.reason ?? ""),
            `<span class="text-xs">${esc(
              Object.entries(p.properties)
                .map(([k, v]) => `${k}=${v}`)
                .join(", "),
            )}</span>`,
          ]),
          "No changes since cursor.",
        );
        if (!dry) setTimeout(render, 1200);
      } catch (e) {
        fail(msg, e);
      }
    };
    $("#dry", root).onclick = () => void run(true);
    $("#sync", root).onclick = () => void run(false);
    $("#clear-crm", root).onclick = async () => {
      await consoleApi.clearCrm();
      await render();
    };
    for (const s of $$<HTMLElement>("[data-edit]", root)) {
      s.style.cursor = "pointer";
      s.onclick = async () => {
        const v = prompt(`New value for ${s.dataset.key}`);
        if (v === null) return;
        await consoleApi.editCrm(s.dataset.edit!, { [s.dataset.key!]: v });
        await render();
      };
    }
  };
  await render();
};

// ---- Deliveries -------------------------------------------------------------

const deliveriesView: View = async (root, ctx) => {
  const render = async () => {
    const retried = await consoleApi.retryDue();
    const deliveries = await consoleApi.deliveries();
    root.innerHTML = `
<h1 class="text-3xl">Webhook deliveries</h1>
<p class="mt-2 text-grey-2">Everything that reached <code>/hooks/receive</code>: parsed from JSON, form-encoded or XML, checked against the authKey, de-duplicated, then forwarded to the CRM with exponential backoff (0s, 2s, 10s, 60s, 5m). ${retried ? `<b>${retried} due retries were just processed.</b>` : ""}</p>

${card(
  "Send a test delivery",
  "Pretend to be the dialer. Try a wrong authKey, a duplicate (same timestamp twice), or make the CRM fail a few times to watch retries.",
  `
  <div class="mt-4 grid gap-3 lg:grid-cols-3">
    <div><label class="label">Format</label><select id="fmt" class="input"><option value="application/json">JSON</option><option value="application/x-www-form-urlencoded">Form (x-www-form-urlencoded)</option><option value="application/xml">XML</option></select></div>
    <div><label class="label">authKey</label><input id="key" class="input" value="console-secret"></div>
    <div><label class="label">Fail downstream N times</label><input id="fail" class="input" type="number" value="0" min="0" max="5"></div>
  </div>
  <textarea id="raw" class="input mt-3 h-32 font-mono text-xs"></textarea>
  <div class="mt-3 flex items-center gap-3"><button id="send" class="btn btn-indigo">${icon("send")} POST /hooks/receive</button><span id="send-msg" class="text-sm"></span></div>
  <div id="send-out" class="mt-3"></div>`,
)}

${card(
  "Log",
  "Newest first. Open a row for the raw body and every forward attempt.",
  deliveries.length
    ? deliveries
        .map(
          (d) => `
  <details class="mt-2 rounded-xl border border-line p-3" data-id="${d.id}">
    <summary class="flex cursor-pointer flex-wrap items-center gap-2">
      ${statusBadge(d.payload.event)} <span class="text-sm">lead ${d.payload.leadId}</span>
      ${badge(d.format, "bg-paper-2 text-grey-2")}
      ${d.authKeyValid ? badge("authKey ok", "bg-green-soft text-green") : badge("authKey wrong", "bg-coral-soft text-coral-dark")}
      ${d.duplicate ? badge("duplicate", "bg-amber-soft text-amber") : ""}
      <span class="ml-auto flex items-center gap-2 text-xs text-grey">forward: ${statusBadge(d.forward.status)} ${d.forward.attempts ? `${d.forward.attempts}× ` : ""}${d.forward.nextAttemptAt ? `next ${fmtTime(d.forward.nextAttemptAt)}` : ""} · ${fmtTime(d.receivedAt)}</span>
    </summary>
    <div class="mt-3 flex items-center gap-3 text-xs"><code>idempotency ${esc(d.idempotencyKey)}</code>${d.forward.lastError ? `<span class="text-coral-dark">${esc(d.forward.lastError)}</span>` : ""}<button class="btn btn-ghost btn-sm ml-auto" data-replay="${d.id}">${icon("rotate-ccw")} Replay</button></div>
    <div class="attempts mt-2 text-xs text-grey">Open to load attempts…</div>
    ${pre(d.raw)}
  </details>`,
        )
        .join("")
    : `<p class="mt-4 text-sm text-grey">Nothing yet.</p>`,
)}`;

    const sample = () => {
      const ts = new Date().toISOString();
      const fmt = $<HTMLSelectElement>("#fmt", root).value;
      const lead = 204179334;
      if (fmt.includes("json"))
        return JSON.stringify(
          {
            event: "lead_saved",
            webhookId: 1,
            leadId: lead,
            campaignId: 412,
            status: "success",
            timestamp: ts,
            data: { name: "Peter Holm", phone: "+45 22 33 44 55" },
          },
          null,
          2,
        );
      if (fmt.includes("form"))
        return `event=lead_saved&leadId=${lead}&campaignId=412&status=success&timestamp=${encodeURIComponent(ts)}&data[name]=Peter+Holm&data[phone]=%2B45+22+33+44+55`;
      return `<delivery>\n  <event>lead_saved</event>\n  <leadId>${lead}</leadId>\n  <campaignId>412</campaignId>\n  <status>success</status>\n  <timestamp>${ts}</timestamp>\n  <data><name>Peter Holm</name><phone>+45 22 33 44 55</phone></data>\n</delivery>`;
    };
    $<HTMLTextAreaElement>("#raw", root).value = sample();
    $("#fmt", root).onchange = () => {
      $<HTMLTextAreaElement>("#raw", root).value = sample();
    };
    $("#send", root).onclick = async () => {
      const r = await consoleApi.sendRaw(
        $<HTMLSelectElement>("#fmt", root).value,
        $<HTMLTextAreaElement>("#raw", root).value,
        $<HTMLInputElement>("#key", root).value,
        Number($<HTMLInputElement>("#fail", root).value),
      );
      note($("#send-msg", root), `HTTP ${r.status}`, r.status < 300 ? "ok" : "warn");
      $("#send-out", root).innerHTML = pre(r.body);
      setTimeout(render, 800);
    };
    for (const d of $$<HTMLDetailsElement>("details[data-id]", root)) {
      d.ontoggle = async () => {
        if (!d.open) return;
        const { attempts } = await consoleApi.delivery(d.dataset.id!);
        $(".attempts", d).innerHTML = table(
          ["Attempt", "At", "Result", "Duration", "Error"],
          attempts.map((a) => [
            String(a.attempt),
            fmtTime(a.at),
            a.ok ? badge("ok", "bg-green-soft text-green") : badge(`HTTP ${a.status}`, "bg-coral-soft text-coral-dark"),
            `${a.durationMs} ms`,
            esc(a.error ?? ""),
          ]),
          "No forward attempts (not forwarded).",
        );
      };
    }
    for (const b of $$<HTMLButtonElement>("[data-replay]", root))
      b.onclick = async (e) => {
        e.preventDefault();
        await consoleApi.replay(b.dataset.replay!);
        await render();
      };
  };
  void ctx;
  await render();
};

// ---- Journeys (inbound trigger simulator) ----------------------------------

const journeysView: View = async (root, ctx) => {
  const render = async () => {
    const [triggers, runs] = await Promise.all([consoleApi.journeys(), consoleApi.journeyRuns()]);
    root.innerHTML = `
<h1 class="text-3xl">Journey triggers (inbound)</h1>
<p class="mt-2 text-grey-2">The other direction: an external system (CRM, web form, automation platform) calls the dialer. Mirrors the vendor's "trigger a journey by webhook": Bearer token, JSON body, match on lead id / external id / phone, map body keys onto fields. Changes go through <code>PUT /leads/{id}</code>, so outbound webhooks fire as normal.</p>

${card(
  "Create a trigger",
  "",
  `
  <form id="new" class="mt-4 grid gap-3 sm:grid-cols-3">
    <div><label class="label">Name</label><input class="input" name="name" value="CRM contact updated"></div>
    <div><label class="label">Match on</label><select class="input" name="matchOn"><option value="leadId">leadId</option><option value="externalId">externalId</option><option value="phone">phone (normalised)</option></select></div>
    <div><label class="label">Field map (JSON: bodyKey → fieldId | "status")</label><input class="input font-mono text-xs" name="fieldMap" value='{"updatedName":"1","updatedPhone":"3","email":"4","status":"status"}'></div>
    <div class="sm:col-span-3 flex items-center gap-3"><button class="btn btn-indigo">${icon("plus")} Create</button><span id="msg" class="text-sm"></span></div>
  </form>`,
)}

${triggers
  .map((t) =>
    card(
      esc(t.name),
      `Trigger URL <code>${ctx.origin}/journeys/${t.id}/trigger</code> · match on <code>${t.matchOn}</code>`,
      `
  <div class="mt-3 flex flex-wrap items-center gap-2 text-xs"><span>Token</span><code>${t.token}</code><button class="ml-auto text-coral-dark" data-del="${t.id}">Delete</button></div>
  ${pre(`curl -X POST '${ctx.origin}/journeys/${t.id}/trigger' \\\n  -H 'Authorization: Bearer ${t.token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"leadId": 204179334, "updatedName": "Peter", "updatedPhone": "+45 22 33 44 55", "status": "privateRedial"}'`)}
  <div class="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]"><textarea class="input h-24 font-mono text-xs" data-body="${t.id}">${esc(JSON.stringify({ leadId: 204179334, externalId: 50015, updatedName: "Peter", updatedPhone: "+45 22 33 44 55", email: "peter@holm.dk", status: "privateRedial" }, null, 2))}</textarea>
  <div class="flex flex-col gap-2"><button class="btn btn-coral btn-sm" data-fire="${t.id}" data-token="${t.token}">${icon("zap")} Fire</button><button class="btn btn-ghost btn-sm" data-fire="${t.id}" data-token="wrong">Fire (bad token)</button></div></div>
  <div class="mt-2" data-out="${t.id}"></div>`,
    ),
  )
  .join("")}

${card(
  "Run log",
  "",
  table(
    ["At", "Trigger", "Auth", "Matched lead", "Applied", "Error"],
    runs.map((r) => [
      fmtTime(r.at),
      esc(triggers.find((t) => t.id === r.triggerId)?.name ?? r.triggerId),
      r.authorized ? badge("ok", "bg-green-soft text-green") : badge("401", "bg-coral-soft text-coral-dark"),
      String(r.matched ?? "-"),
      `<span class="text-xs">${esc(
        Object.entries(r.applied)
          .map(([k, v]) => `${k}=${v}`)
          .join(", "),
      )}</span>`,
      `<span class="text-xs text-coral-dark">${esc(r.error ?? "")}</span>`,
    ]),
    "No runs yet.",
  ),
)}`;

    $("#new", root).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target as HTMLFormElement);
      try {
        await consoleApi.createJourney({
          name: String(f.get("name")),
          matchOn: f.get("matchOn") as never,
          fieldMap: JSON.parse(String(f.get("fieldMap"))) as Record<string, string>,
        });
        await render();
      } catch (err) {
        fail($("#msg", root), err);
      }
    };
    for (const b of $$<HTMLButtonElement>("[data-del]", root))
      b.onclick = async () => {
        await consoleApi.deleteJourney(b.dataset.del!);
        await render();
      };
    for (const b of $$<HTMLButtonElement>("[data-fire]", root)) {
      b.onclick = async () => {
        const id = b.dataset.fire!;
        let body: unknown;
        try {
          body = JSON.parse($<HTMLTextAreaElement>(`[data-body="${id}"]`, root).value);
        } catch {
          body = {};
        }
        const r = await consoleApi.fireJourney(id, b.dataset.token!, body);
        $(`[data-out="${id}"]`, root).innerHTML =
          `<div class="text-xs ${r.status < 300 ? "text-green" : "text-coral-dark"}">HTTP ${r.status}</div>${pre(r.body)}`;
        setTimeout(render, 1500);
      };
    }
  };
  await render();
};

// ---- Request log --------------------------------------------------------------

const requestsView: View = async (root) => {
  const rows = await consoleApi.requests();
  root.innerHTML = `
<h1 class="text-3xl">Request log</h1>
<p class="mt-2 text-grey-2">Every call to the mock <code>/v1</code> API with its <code>X-Request-Id</code>, status, latency and remaining rate-limit budget. When a customer says "the API is broken", this is where you look first.</p>
${card(
  "Last 200 requests",
  "",
  table(
    ["At", "Method", "Path", "Query", "Status", "ms", "Remaining/min", "Emitted", "Request id"],
    rows.map((r) => [
      fmtTime(r.at),
      `<code>${r.method}</code>`,
      `<code>${esc(r.path)}</code>`,
      `<span class="break-all font-mono text-xs">${esc(decodeURIComponent(r.query))}</span>`,
      badge(String(r.status), r.status < 300 ? "bg-green-soft text-green" : r.status === 429 ? "bg-amber-soft text-amber" : "bg-coral-soft text-coral-dark"),
      String(r.durationMs),
      String(r.rateLimitRemaining),
      `<span class="text-xs">${esc(r.emitted.join(", "))}</span>`,
      `<span class="font-mono text-xs text-grey">${r.id.slice(0, 8)}</span>`,
    ]),
    "No requests yet.",
  ),
)}`;
};

// ---- Diagnose -----------------------------------------------------------------

const diagnoseView: View = async (root) => {
  const [checks, overview] = await Promise.all([consoleApi.diagnose(), consoleApi.overview()]);
  const tone = { ok: "border-green/40", warn: "border-amber/60", error: "border-coral/60" };
  root.innerHTML = `
<h1 class="text-3xl">Diagnose</h1>
<p class="mt-2 text-grey-2">Checks the integration end to end and explains each finding in the words you would use with a customer.</p>
<div class="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">${kpi("Leads", overview.leads)}${kpi("Contacts", overview.contacts)}${kpi("Webhooks", overview.webhooks)}${kpi("Deliveries", overview.deliveries.total)}${kpi("Dead letters", overview.deliveries.dead, overview.deliveries.dead ? "text-coral-dark" : "")}${kpi("CRM records", overview.crm)}</div>
<div class="mt-6 grid gap-3">${checks.map((c) => `<div class="card border-2 ${tone[c.level]}"><div class="flex items-center gap-3">${statusBadge(c.level)}<strong>${esc(c.title)}</strong></div>${c.detail ? `<p class="mt-2 text-sm text-grey-2">${esc(c.detail)}</p>` : ""}${c.fix ? `<p class="mt-2 text-sm">${icon("wrench", "icon text-indigo-brand")} ${esc(c.fix)}</p>` : ""}</div>`).join("")}</div>
<p class="mt-8 text-sm text-grey-2">Full runbook: <code>docs/playbook.md</code>. Product feedback for the vendor: <code>docs/product-feedback.md</code>. Postman collection: <code>postman/</code>.</p>`;
};
