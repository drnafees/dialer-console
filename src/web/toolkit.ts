import * as seed from "../core/seed";
import type { ConnectorConfig, Field, FieldMapping } from "../core/types";
import { consoleApi, type DialerApi, type ImportPreview } from "./api";
import { eventLabel, relativeTime, STATUS_LABEL, untilTime } from "./labels";
import {
  $,
  $$,
  actionBadge,
  badge,
  busy,
  dev,
  devMode,
  emptyState,
  esc,
  eventBadge,
  explain,
  fail,
  fmtTime,
  forwardBadge,
  help,
  icon,
  kpi,
  labelled,
  pre,
  statusBadge,
  stepHeader,
  table,
  toast,
} from "./ui";

export interface ToolkitContext {
  api: DialerApi;
  fields: Map<number, Field>;
  origin: string;
}

type View = (root: HTMLElement, ctx: ToolkitContext) => Promise<void>;

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
    root.innerHTML = emptyState("help-circle", "That page does not exist", "Pick one from the menu above.");
    return;
  }
  root.innerHTML = `<p class="text-grey"><span class="spinner"></span> Loading…</p>`;
  try {
    await view(root, ctx);
  } catch (e) {
    root.innerHTML = `<div class="card"><p class="font-semibold">Something went wrong loading this page.</p><p id="err" class="mt-2"></p><button class="btn btn-ghost btn-sm mt-4" onclick="location.reload()">Reload</button></div>`;
    fail($("#err", root), e);
  }
}

const pageTitle = (title: string, what: string, why: string) =>
  `<h1 class="text-3xl">${title}</h1><p class="lead mt-3">${what}</p><p class="mt-2 text-sm text-grey-2">${why}</p>`;

const fieldOptions = (fields: Map<number, Field>, selected: number | string | null, allowNone = true) =>
  `${allowNone ? `<option value="">— skip this column —</option>` : ""}${[...fields.values()].map((f) => `<option value="${f.id}" ${String(f.id) === String(selected) ? "selected" : ""}>${esc(f.name)}${devMode() ? ` (${f.id})` : ""}</option>`).join("")}`;

const fname = (fields: Map<number, Field>, id: string | number) => fields.get(Number(id))?.name ?? String(id);

const SAMPLE_CSV = `Fornavn;Efternavn;Telefon;E-mail;Firma;Postnr;By
Alice;Andersen;20 12 34 56;alice.andersen@nordicbyg.dk;Nordic Byg A/S;8000;Aarhus
Bob;Bang;+45 12 12 12 12;bob@bangtransport.dk;Bang Transport;8200;Aarhus N
Ole;Blocked;99 88 77 66;;;;
Carl;Christensen;0045 13 13 13 13;carl@example.dk;Christensen Consulting;8700;Horsens
Alice;Andersen;+4520123456;alice.andersen@nordicbyg.dk;Nordic Byg A/S;8000;Aarhus`;

// ---- Add people (import wizard) --------------------------------------------

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
    done: false,
  };

  const render = async () => {
    const p = state.preview;
    const history = await importHistory(ctx);
    root.innerHTML = `
${pageTitle("Add people from a spreadsheet", "Paste a list of people. We check it for duplicates and people who must not be called, show you exactly what will happen, and only then add them to the dialer.", "A sample list is already pasted so you can just press Check.")}

<section class="card mt-8">
  ${stepHeader(1, "Paste your list", "Comma or semicolon separated, first row is the column names. Danish and English names are recognised.", !!p)}
  <textarea id="csv" class="input mt-4 h-40 font-mono text-xs" aria-label="CSV data">${esc(state.csv)}</textarea>
  <div class="mt-4 grid gap-4 md:grid-cols-2">
    <div><label class="label">Put them in which list? ${help("A pool is a list of people. Campaigns pull from pools.")}</label><select id="pool" class="input">${pools.map((x) => `<option value="${x.id}" ${x.id === state.poolId ? "selected" : ""}>${esc(x.name)}${devMode() ? ` (${x.id})` : ""}</option>`).join("")}</select></div>
    <div><label class="label">Start calling them right away? ${help("If yes, each new person becomes a lead on this campaign.")}</label><select id="campaign" class="input"><option value="">No, just store them</option>${seed.campaigns.map((c) => `<option value="${c.id}" ${c.id === state.campaignId ? "selected" : ""}>Yes, on "${esc(c.settings.name)}"</option>`).join("")}</select></div>
    <div><label class="label">Same person if these match ${help("Phone numbers are compared after normalising (+45 20 12 34 56 = 20123456). Emails ignore case.")}</label><select id="match" class="input" multiple size="3">${[
      ...ctx.fields.values(),
    ]
      .slice(0, 7)
      .map((f) => `<option value="${f.id}" ${state.matchFields.includes(f.id) ? "selected" : ""}>${esc(f.name)}</option>`)
      .join("")}</select><p class="mt-1 text-xs text-grey">Hold Ctrl / Cmd to pick several.</p></div>
    <div><label class="label">Never add anyone who is on ${help("People found in these lists are skipped. Use it for a do-not-call list.")}</label><select id="blacklist" class="input" multiple size="3">${pools.map((x) => `<option value="${x.id}" ${state.blacklist.includes(x.id) ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
    <div class="md:col-span-2"><label class="label">If the person already exists, update their ${help("Only these fields are overwritten on existing people. Everything else is left alone.")}</label><select id="update" class="input" multiple size="3">${[
      ...ctx.fields.values(),
    ]
      .slice(0, 7)
      .map((f) => `<option value="${f.id}" ${state.updateFields.includes(f.id) ? "selected" : ""}>${esc(f.name)}</option>`)
      .join("")}</select></div>
  </div>
  <div class="mt-5 flex items-center gap-3"><button id="preview" class="btn btn-indigo">${icon("eye")} Check my list</button><span class="text-sm text-grey-2">Nothing is added yet. You will see a preview first.</span></div>
  ${dev(explain("API calls this will make", `<code>POST /imports</code> with <code>poolId</code>, <code>match.fields</code>, <code>match.blacklist</code>, <code>updateFields</code>, <code>onImportedAction</code>; then <code>POST /imports/{id}/insert</code> in batches of 100; then <code>POST /imports/{id}/start</code>; then poll <code>GET /imports/{id}</code>.`))}
</section>

${
  p
    ? `<section class="card mt-6">
  ${stepHeader(2, "Check the columns", "We guessed which column is which. Fix any that are wrong.", true)}
  <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${p.headers.map((h) => `<div><label class="label">Column "${esc(h)}"</label><select class="input" data-col="${esc(h)}">${fieldOptions(ctx.fields, p.columnMap[h] ?? null)}</select></div>`).join("")}</div>
</section>

<section class="card mt-6">
  ${stepHeader(3, "This is what will happen", `${p.rowCount} rows in your list.`)}
  <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">${kpi("New people", p.plan.summary.inserted, "text-accent")}${kpi("Updates", p.plan.summary.updated, "text-indigo-brand")}${kpi("Already here", p.plan.summary.duplicates, "text-grey-2")}${kpi("Do not call", p.plan.summary.blacklisted, "text-coral-dark")}</div>
  ${table(
    ["", "What we'll do", "Person", "Why / what changes"],
    p.plan.rows.map((r) => [
      String(r.index + 1),
      actionBadge(r.action),
      `<span class="text-xs">${esc([r.data["1"], r.data["2"]].filter(Boolean).join(" ") || "(no name)")}${r.data["3"] ? ` · ${esc(r.data["3"])}` : ""}</span>${dev(`<div class="text-xs text-grey">key <code>${esc(r.key ?? "-")}</code></div>`)}`,
      reason(r, ctx),
    ]),
  )}
  <div class="mt-5 flex flex-wrap items-center gap-3">
    <button id="run" class="btn btn-coral" ${state.done ? "disabled" : ""}>${icon("upload")} Add them now</button>
    <span class="text-sm text-grey-2">${p.plan.summary.inserted + p.plan.summary.updated} people will be added or updated. The rest are skipped.</span>
    <span id="run-msg" class="text-sm"></span>
  </div>
  <div id="run-log" class="mt-3 dev-block"></div>
</section>`
    : ""
}

${history}`;

    $("#csv", root).oninput = (e) => {
      state.csv = (e.target as HTMLTextAreaElement).value;
    };
    const multi = (sel: string) => $$<HTMLOptionElement>(`${sel} option:checked`, root).map((o) => Number(o.value));
    $("#preview", root).onclick = async () => {
      const btn = $<HTMLButtonElement>("#preview", root);
      busy(btn, true, "Checking…");
      state.poolId = Number($<HTMLSelectElement>("#pool", root).value);
      state.matchFields = multi("#match");
      state.blacklist = multi("#blacklist");
      state.updateFields = multi("#update");
      state.campaignId = Number($<HTMLSelectElement>("#campaign", root).value) || null;
      state.done = false;
      try {
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
        document.getElementById("run")?.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (e) {
        busy(btn, false);
        toast(e instanceof Error ? e.message : String(e), "error");
      }
    };
    for (const sel of $$<HTMLSelectElement>("[data-col]", root)) {
      sel.onchange = () => {
        state.columnMap = Object.fromEntries(
          $$<HTMLSelectElement>("[data-col]", root)
            .map((s) => [s.dataset.col!, s.value])
            .filter(([, v]) => v),
        );
        $("#preview", root).click();
      };
    }
    const run = root.querySelector<HTMLButtonElement>("#run");
    if (run) run.onclick = () => void runImport(run);
  };

  const runImport = async (btn: HTMLButtonElement) => {
    const msg = $("#run-msg", root);
    const log = $("#run-log", root);
    const lines: string[] = [];
    const say = (s: string) => {
      lines.push(s);
      log.innerHTML = pre(lines.join("\n"));
    };
    busy(btn, true, "Adding…");
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
          if (job.status === "completed") toast(`Done. ${job.result!.inserted} new, ${job.result!.updated} updated, ${job.result!.duplicates} skipped.`);
          else toast("The import failed. See details below.", "error");
          break;
        }
      }
      state.done = true;
      state.preview = null;
      await render();
      document.getElementById("history")?.scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      busy(btn, false);
      fail(msg, e);
    }
  };

  await render();
};

function reason(r: ImportPreview["plan"]["rows"][number], ctx: ToolkitContext): string {
  if (r.action === "insert") return `<span class="text-xs text-grey-2">Not in the list yet</span>`;
  if (r.action === "blacklisted") return `<span class="text-xs text-coral-dark">On a do-not-call list</span>`;
  if (r.action === "duplicate")
    return `<span class="text-xs text-grey-2">${r.existingId ? "Already in the list, nothing new to save" : "Appears twice in your file"}</span>`;
  return `<span class="text-xs">${esc(
    Object.entries(r.changes)
      .map(([k, c]) => `${fname(ctx.fields, k)}: "${c.from || "(empty)"}" → "${c.to}"`)
      .join("; "),
  )}</span>`;
}

async function importHistory(ctx: ToolkitContext): Promise<string> {
  const imports = (await ctx.api.imports()).sort((a, b) => b.created.localeCompare(a.created));
  return `<section class="card mt-6" id="history"><h2 class="text-lg">Previous imports</h2>${
    imports.length
      ? table(
          ["When", "Result", "Status"],
          imports.map((j) => [
            `${relativeTime(j.created)}${dev(` <code>import ${j.id}</code>`)}`,
            j.result
              ? `<span class="text-xs">${j.result.inserted} new, ${j.result.updated} updated, ${j.result.duplicates} skipped${j.result.addedToCampaign ? `, ${j.result.addedToCampaign} now being called` : ""}</span>`
              : `<span class="text-xs text-grey">${j.rowCount} rows</span>`,
            statusBadge(j.status),
          ]),
        )
      : emptyState("upload", "No imports yet", "Your first one will appear here.")
  }</section>`;
}

// ---- Match fields (mappings) ------------------------------------------------

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

const mappingView: View = async (root, ctx) => {
  const render = async () => {
    const mappings = await ctx.api.fieldMappings();
    root.innerHTML = `
${pageTitle("Match field names", 'The dialer calls it "Firstname"; your CRM might call it "first_name". Tell us which is which once, and every sync uses it.', "Suggested names are already filled in. Leave a box empty to not send that field.")}

<section class="card mt-8">
  ${stepHeader(1, "Pair them up", "Left: the dialer's field. Right: what your CRM calls it.")}
  <form id="new" class="mt-4">
    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">${[...ctx.fields.values()].map((f) => `<div class="flex items-center gap-2"><span class="w-36 shrink-0 text-sm">${esc(f.name)}${dev(` <code>${f.id}</code>`)}</span>${icon("arrow-right", "icon text-grey")}<input class="input" data-fid="${f.id}" placeholder="(don't send)" value="${esc(DEFAULT_MAP[f.name] ?? "")}" aria-label="CRM name for ${esc(f.name)}"></div>`).join("")}</div>
    <div class="mt-5 flex flex-wrap items-end gap-3"><div class="flex-1"><label class="label">Give this set a name</label><input id="name" class="input" value="My CRM fields"></div><button class="btn btn-indigo">${icon("save")} Save</button><span id="msg" class="text-sm"></span></div>
  </form>
  ${dev(explain("API", `<code>POST /field-mappings</code> with <code>{ name, mappings: { "<dialerFieldId>": "<externalName>" } }</code>. The CRM connector applies the selected mapping on every create and update.`))}
</section>

<section class="card mt-6"><h2 class="text-lg">Saved sets</h2>${
      mappings.length
        ? mappings
            .map(
              (m) => `
  <details class="mt-3 rounded-xl border border-line p-3"><summary class="flex cursor-pointer items-center gap-3"><strong>${esc(m.name)}</strong><span class="text-xs text-grey">${Object.keys(m.mappings).length} fields · ${relativeTime(m.lastUpdated)}</span>${dev(`<code>id ${m.id}</code>`)}<button class="ml-auto text-xs text-coral-dark" data-del="${m.id}">Delete</button></summary>
  ${table(
    ["Dialer", "", "Your CRM"],
    Object.entries(m.mappings).map(([k, v]) => [labelled(fname(ctx.fields, k), k), icon("arrow-right", "icon text-grey"), `<code>${esc(v)}</code>`]),
  )}
  </details>`,
            )
            .join("")
        : emptyState("git-compare-arrows", "Nothing saved yet", "Fill in the pairs above and press Save.")
    }</section>`;

    $("#new", root).onsubmit = async (e) => {
      e.preventDefault();
      const mappingsObj = Object.fromEntries(
        $$<HTMLInputElement>("[data-fid]", root)
          .filter((i) => i.value.trim())
          .map((i) => [i.dataset.fid!, i.value.trim()]),
      );
      try {
        await ctx.api.createFieldMapping({ name: $<HTMLInputElement>("#name", root).value, mappings: mappingsObj });
        toast("Saved. Pick it on the Sync to CRM page to use it.");
        await render();
      } catch (err) {
        fail($("#msg", root), err);
      }
    };
    for (const b of $$<HTMLButtonElement>("[data-del]", root))
      b.onclick = async (e) => {
        e.preventDefault();
        if (!confirm("Delete this set?")) return;
        await ctx.api.deleteFieldMapping(Number(b.dataset.del));
        await render();
      };
  };
  await render();
};

// ---- Sync to CRM (connector) ----------------------------------------------

const connectorView: View = async (root, ctx) => {
  const render = async () => {
    const [{ connector, cursor, mappings }, runs, records] = await Promise.all([consoleApi.connector(), consoleApi.syncRuns(), consoleApi.crm()]);
    root.innerHTML = `
${pageTitle("Keep your CRM in sync", "Copies every contact that changed in the dialer since last time into your CRM. Run it by hand here; in real life it runs on a schedule.", 'Try "Preview" first: it shows what would change without touching anything.')}

<section class="card mt-8">
  ${stepHeader(1, "Run a sync", cursor ? `Last synced ${relativeTime(cursor)}. Only changes since then are copied.` : "Never synced. The first run copies everyone.")}
  <div class="mt-5 flex flex-wrap items-center gap-3">
    <button id="dry" class="btn btn-outline">${icon("flask-conical")} Preview changes</button>
    <button id="sync" class="btn btn-coral">${icon("refresh-cw")} Sync now</button>
    <button type="button" id="reset-cursor" class="btn btn-ghost btn-sm" title="Forget when we last synced, so the next run copies everyone again">Start from scratch</button>
    <span id="run-msg" class="text-sm"></span>
  </div>
  <div id="run-out" class="mt-4"></div>
  ${explain("How it stays safe and fast", `It asks the dialer only for contacts changed after the last sync (<code>lastModifiedTime</code> greater than a saved timestamp), re-reads a small window before that to survive clock drift, and never sends more than 60 requests a minute or 2 at once, which are the dialer's limits.`)}
</section>

<section class="card mt-6">
  ${stepHeader(2, "Settings", "The defaults are sensible. Change them only if you know why.")}
  <form id="cfg" class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <div><label class="label">Field names to use ${help("Made on the Match fields page.")}</label><select class="input" name="fieldMappingId"><option value="">The dialer's own names</option>${mappings.map((m: FieldMapping) => `<option value="${m.id}" ${m.id === connector.fieldMappingId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
    <div><label class="label">If both sides changed ${help("What to do when someone edited the record in the CRM and the dialer also changed it.")}</label><select class="input" name="conflictPolicy"><option value="last_write_wins" ${connector.conflictPolicy === "last_write_wins" ? "selected" : ""}>Newest change wins</option><option value="dialer_wins" ${connector.conflictPolicy === "dialer_wins" ? "selected" : ""}>Dialer always wins</option><option value="crm_wins" ${connector.conflictPolicy === "crm_wins" ? "selected" : ""}>CRM always wins</option></select></div>
    <div><label class="label">Only these campaigns ${help("Leave empty for all.")}</label><select class="input" name="campaignIds" multiple size="2">${seed.campaigns.map((c) => `<option value="${c.id}" ${connector.campaignIds.includes(c.id) ? "selected" : ""}>${esc(c.settings.name)}</option>`).join("")}</select></div>
    <div class="dev-block"><label class="label">Overlap window (seconds)</label><input class="input" name="overlapSeconds" type="number" value="${connector.overlapSeconds}"></div>
    <div class="dev-block"><label class="label">Page size</label><input class="input" name="pageSize" type="number" value="${connector.pageSize}"></div>
    <input type="hidden" name="direction" value="${connector.direction}">
    <div class="sm:col-span-2 lg:col-span-3 flex items-center gap-3"><button class="btn btn-indigo">${icon("save")} Save settings</button><span id="cfg-msg" class="text-sm"></span>${dev(`<span class="text-xs text-grey">cursor <code>${esc(cursor ?? "none")}</code></span>`)}</div>
  </form>
</section>

<section class="card mt-6"><h2 class="text-lg">Past syncs</h2>${
      runs.length
        ? table(
            ["When", "Kind", "Result", "Copied", "Requests", "Waited for limits"],
            runs.map((r) => [
              relativeTime(r.startedAt),
              r.dryRun ? badge("preview", "bg-paper-2 text-grey-2") : badge("real", "bg-indigo-soft text-indigo-brand"),
              statusBadge(r.status),
              `<span class="text-xs">${r.created} new, ${r.updated} updated, ${r.skipped} unchanged${r.failed ? `, <b class="text-coral-dark">${r.failed} failed</b>` : ""}</span>`,
              `<span class="text-xs">${r.requestsMade}${dev(` (${r.pagesFetched} pages, ${r.rowsFetched} rows)`)}</span>`,
              r.rateLimitWaitsMs ? `${(r.rateLimitWaitsMs / 1000).toFixed(1)} s` : "none",
            ]),
          )
        : emptyState("refresh-cw", "No syncs yet", "Press Preview changes to see what the first one would do.")
    }</section>

<section class="card mt-6">
  <div class="flex items-center justify-between"><h2 class="text-lg">Your CRM (pretend)</h2><button id="clear-crm" class="text-xs text-coral-dark">Empty it</button></div>
  <p class="mt-1 text-sm text-grey-2">${records.length} people. Click any value to edit it as if you were in the CRM, then run a sync to see the conflict rule in action.</p>
  ${
    records.length
      ? table(
          ["Person", "Last change", "Details"],
          records.map((r) => [
            `${esc(r.properties.firstname ?? r.properties.first_name ?? "")} ${esc(r.properties.lastname ?? r.properties.last_name ?? "")}${dev(`<div class="text-xs text-grey">lead ${r.dialerLeadId ?? "-"} · ${esc(r.externalId ?? "-")}</div>`)}`,
            `<span class="text-xs">${relativeTime(r.updatedAt)} by ${badge(r.source === "manual" ? "you (in CRM)" : r.source === "webhook" ? "a webhook" : "a sync", r.source === "manual" ? "bg-amber-soft text-amber" : "bg-paper-2 text-grey-2")}</span>`,
            `<div class="flex flex-wrap gap-1">${Object.entries(r.properties)
              .filter(([k]) => !k.startsWith("dialer_") || devMode())
              .map(
                ([k, v]) =>
                  `<button class="rounded-md bg-paper-2 px-1.5 py-0.5 text-left text-xs hover:bg-indigo-soft" title="Click to edit" data-edit="${r.id}" data-key="${esc(k)}"><b>${esc(k)}</b> ${esc(v)}</button>`,
              )
              .join("")}</div>`,
          ]),
        )
      : emptyState("inbox", "Empty", "Run a sync, or trigger a webhook from the Try it page.")
  }
</section>`;

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
      toast("Settings saved");
    };
    $("#reset-cursor", root).onclick = async () => {
      await consoleApi.saveConnector({ cursor: null });
      toast("Next sync will copy everyone", "warn");
      await render();
    };
    const run = async (dry: boolean, btn: HTMLButtonElement) => {
      busy(btn, true, dry ? "Previewing…" : "Syncing…");
      try {
        const { run } = await consoleApi.sync(dry);
        const changes = run.created + run.updated;
        toast(
          dry ? (changes ? `${changes} people would change` : "Nothing would change") : `${changes} people copied to your CRM`,
          run.status === "completed" ? "ok" : "warn",
        );
        $("#run-out", root).innerHTML = run.preview.length
          ? table(
              ["Person", dry ? "Would" : "Did", "Why"],
              run.preview.map((p) => [
                `${esc(p.properties.firstname ?? p.properties.first_name ?? `contact ${p.leadId}`)} ${esc(p.properties.lastname ?? p.properties.last_name ?? "")}${dev(` <code>lead ${p.leadId}</code>`)}`,
                actionBadge(p.action),
                `<span class="text-xs text-grey-2">${esc(p.reason ?? (p.action === "create" ? "not in the CRM yet" : p.action === "update" ? "changed in the dialer" : ""))}</span>`,
              ]),
            )
          : emptyState("check-circle", "Nothing to do", "Everyone is already up to date.");
        if (!dry) setTimeout(() => void render(), 1200);
        else busy(btn, false);
      } catch (e) {
        busy(btn, false);
        toast(e instanceof Error ? e.message : String(e), "error");
      }
    };
    $("#dry", root).onclick = (e) => void run(true, e.currentTarget as HTMLButtonElement);
    $("#sync", root).onclick = (e) => void run(false, e.currentTarget as HTMLButtonElement);
    $("#clear-crm", root).onclick = async () => {
      if (!confirm("Remove every record from the pretend CRM?")) return;
      await consoleApi.clearCrm();
      await render();
    };
    for (const s of $$<HTMLButtonElement>("[data-edit]", root)) {
      s.onclick = async () => {
        const v = prompt(`New value for "${s.dataset.key}"`);
        if (v === null) return;
        await consoleApi.editCrm(s.dataset.edit!, { [s.dataset.key!]: v });
        toast("Edited in the CRM. Now run a sync to see what happens.");
        await render();
      };
    }
  };
  await render();
};

// ---- Incoming (deliveries) --------------------------------------------------

const deliveriesView: View = async (root) => {
  const render = async () => {
    const retried = await consoleApi.retryDue();
    const deliveries = await consoleApi.deliveries();
    if (retried) toast(`${retried} waiting message${retried > 1 ? "s were" : " was"} retried`);
    const counts = { delivered: 0, pending: 0, dead: 0, badKey: 0, dup: 0 };
    for (const d of deliveries) {
      if (!d.authKeyValid) counts.badKey++;
      else if (d.duplicate) counts.dup++;
      else if (d.forward.status in counts) counts[d.forward.status as keyof typeof counts]++;
    }
    root.innerHTML = `
${pageTitle("Messages from the dialer", "Every message the dialer sent us, what we did with it, and whether it reached your CRM. If anything goes wrong, this is where you look.", "Use the sender below to fake a message, a wrong key, a duplicate, or a CRM that is down.")}

<div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">${kpi("Saved to CRM", counts.delivered, "text-green")}${kpi("Will retry", counts.pending, counts.pending ? "text-amber" : "")}${kpi("Gave up", counts.dead, counts.dead ? "text-coral-dark" : "")}${kpi("Wrong key", counts.badKey, counts.badKey ? "text-coral-dark" : "")}${kpi("Duplicates", counts.dup)}</div>

<section class="card mt-6">
  ${stepHeader(1, "Pretend to be the dialer", "Send a message to this page. Try breaking it to see how the receiver copes.")}
  <div class="mt-4 grid gap-3 lg:grid-cols-3">
    <div><label class="label">Format ${help("Real systems send data in different shapes. All three end up the same once received.")}</label><select id="fmt" class="input"><option value="application/json">JSON</option><option value="application/x-www-form-urlencoded">Form fields</option><option value="application/xml">XML</option></select></div>
    <div><label class="label">Secret key ${help("The dialer puts this in the URL. Type anything else to see a rejected message.")}</label><input id="key" class="input" value="console-secret"></div>
    <div><label class="label">Pretend the CRM is down for ${help("The first N saves fail. Watch the message wait and retry.")}</label><select id="fail" class="input"><option value="0">0 attempts (CRM works)</option><option value="1">1 attempt</option><option value="2">2 attempts</option><option value="4">4 attempts (gives up)</option></select></div>
  </div>
  <textarea id="raw" class="input mt-3 h-32 font-mono text-xs" aria-label="Message body"></textarea>
  <div class="mt-3 flex items-center gap-3"><button id="send" class="btn btn-indigo">${icon("send")} Send it</button><span class="text-sm text-grey-2">Send the same message twice to see the duplicate catch.</span></div>
  <div id="send-out" class="mt-3 dev-block"></div>
</section>

<section class="card mt-6"><h2 class="text-lg">All messages</h2><p class="mt-1 text-sm text-grey-2">Newest first. Open one for the full story.</p>${
      deliveries.length
        ? deliveries
            .map(
              (d) => `
  <details class="mt-2 rounded-xl border border-line p-3" data-id="${d.id}">
    <summary class="flex cursor-pointer flex-wrap items-center gap-2">
      ${eventBadge(d.payload.event)}
      <span class="text-sm">${esc(String(d.payload.data?.name ?? (d.payload.leadId ? `contact ${d.payload.leadId}` : "")))}</span>
      ${!d.authKeyValid ? badge("wrong key, ignored", "bg-coral-soft text-coral-dark") : d.duplicate ? badge("duplicate, ignored", "bg-amber-soft text-amber") : forwardBadge(d.forward.status)}
      ${dev(badge(d.format, "bg-paper-2 text-grey-2"))}
      <span class="ml-auto text-xs text-grey">${d.forward.attempts > 1 ? `${d.forward.attempts} tries · ` : ""}${d.forward.nextAttemptAt && d.forward.status === "pending" ? `next try ${untilTime(d.forward.nextAttemptAt)} · ` : ""}${relativeTime(d.receivedAt)}</span>
    </summary>
    <div class="mt-3 grid gap-2 text-sm">
      ${storyLine(d)}
      ${d.forward.lastError && d.authKeyValid && !d.duplicate ? `<div class="text-xs text-coral-dark">${esc(d.forward.lastError)}</div>` : ""}
      <div class="attempts text-xs text-grey"></div>
      <div class="flex items-center gap-3 text-xs">${dev(`<code>key ${esc(d.idempotencyKey)}</code>`)}<button class="btn btn-ghost btn-sm ml-auto" data-replay="${d.id}">${icon("rotate-ccw")} Try saving again</button></div>
      <div class="dev-block">${pre(d.raw)}</div>
    </div>
  </details>`,
            )
            .join("")
        : emptyState("inbox", "No messages yet", "Send one with the form above, or go to Try it and change a contact.")
    }</section>`;

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
    $("#send", root).onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      busy(btn, true, "Sending…");
      const r = await consoleApi.sendRaw(
        $<HTMLSelectElement>("#fmt", root).value,
        $<HTMLTextAreaElement>("#raw", root).value,
        $<HTMLInputElement>("#key", root).value,
        Number($<HTMLSelectElement>("#fail", root).value),
      );
      const b = r.body as { duplicate?: boolean; authKeyValid?: boolean; error?: string };
      if (r.status >= 400) toast(b.error ?? `Rejected (${r.status})`, "error");
      else if (!b.authKeyValid) toast("Received, but the key was wrong, so it was ignored", "warn");
      else if (b.duplicate) toast("Received, but we already had this one, so it was ignored", "warn");
      else toast("Received and being saved to the CRM");
      $("#send-out", root).innerHTML = pre(r.body);
      setTimeout(() => void render(), 800);
    };
    for (const d of $$<HTMLDetailsElement>("details[data-id]", root)) {
      d.ontoggle = async () => {
        if (!d.open) return;
        const { attempts } = await consoleApi.delivery(d.dataset.id!);
        $(".attempts", d).innerHTML = attempts.length
          ? table(
              ["Try", "When", "Result", "Took"],
              attempts.map((a) => [
                String(a.attempt),
                fmtTime(a.at),
                a.ok
                  ? badge("saved", "bg-green-soft text-green")
                  : `${badge("failed", "bg-coral-soft text-coral-dark")} <span class="text-coral-dark">${esc(a.error ?? "")}</span>`,
                `${a.durationMs} ms`,
              ]),
            )
          : "";
      };
    }
    for (const b of $$<HTMLButtonElement>("[data-replay]", root))
      b.onclick = async (e) => {
        e.preventDefault();
        busy(b, true, "Saving…");
        await consoleApi.replay(b.dataset.replay!);
        toast("Tried again");
        await render();
      };
  };
  await render();
};

function storyLine(d: Awaited<ReturnType<typeof consoleApi.deliveries>>[number]): string {
  const steps: string[] = [`Received ${fmtTime(d.receivedAt)} as ${d.format.toUpperCase()}`];
  steps.push(d.authKeyValid ? "Key checked: genuine" : "Key checked: WRONG, so we stopped here");
  if (d.authKeyValid) steps.push(d.duplicate ? "Already had this exact message, so we stopped here" : "Not seen before");
  if (d.authKeyValid && !d.duplicate)
    steps.push(
      d.forward.status === "delivered"
        ? `Saved to the CRM ${relativeTime(d.forward.deliveredAt)}`
        : d.forward.status === "pending"
          ? `Could not save yet (${d.forward.attempts} tr${d.forward.attempts === 1 ? "y" : "ies"}), will retry`
          : d.forward.status === "dead"
            ? `Gave up after ${d.forward.attempts} tries`
            : "Just logged, nothing to save",
    );
  return `<ol class="list-decimal space-y-1 pl-5 text-xs text-grey-2">${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
}

// ---- Push to dialer (journeys) ----------------------------------------------

const journeysView: View = async (root, ctx) => {
  const render = async () => {
    const [triggers, runs] = await Promise.all([consoleApi.journeys(), consoleApi.journeyRuns()]);
    root.innerHTML = `
${pageTitle("Let other apps update the dialer", "The opposite direction: your CRM, a web form or an automation tool sends a message, and the dialer updates the matching person.", "Make an inbox below, then press Send a test message. No other app needed.")}

<section class="card mt-8">
  ${stepHeader(1, "Make an inbox", "Each inbox has its own secret token and a rule for finding the right person.", triggers.length > 0)}
  <form id="new" class="mt-4 grid gap-3 sm:grid-cols-3">
    <div><label class="label">Name it</label><input class="input" name="name" value="Updates from my CRM"></div>
    <div><label class="label">Find the person by ${help("How the dialer knows which contact the message is about.")}</label><select class="input" name="matchOn"><option value="leadId">their dialer id</option><option value="externalId">their id in my CRM</option><option value="phone">their phone number</option></select></div>
    <div class="dev-block"><label class="label">Field map (JSON)</label><input class="input font-mono text-xs" name="fieldMap" value='{"updatedName":"1","updatedPhone":"3","email":"4","status":"status"}'></div>
    <div class="sm:col-span-3 flex items-center gap-3"><button class="btn btn-indigo">${icon("plus")} Create inbox</button><span id="msg" class="text-sm"></span></div>
  </form>
</section>

${triggers
  .map(
    (t) => `<section class="card mt-6">
  ${stepHeader(2, esc(t.name), `Finds the person by ${t.matchOn === "leadId" ? "dialer id" : t.matchOn === "externalId" ? "CRM id" : "phone number"}. Any app that knows the address and token below can use it.`)}
  <div class="mt-4 grid gap-2 text-sm">
    <div class="flex flex-wrap items-center gap-2"><span class="w-20 text-xs uppercase tracking-wider text-grey">Address</span><code class="break-all">${ctx.origin}/journeys/${t.id}/trigger</code></div>
    <div class="flex flex-wrap items-center gap-2"><span class="w-20 text-xs uppercase tracking-wider text-grey">Token</span><code class="break-all">${t.token}</code><button class="ml-auto text-xs text-coral-dark" data-del="${t.id}">Delete inbox</button></div>
  </div>
  <div class="mt-4 grid gap-3 lg:grid-cols-[1fr_auto]">
    <div><label class="label">Message to send ${help("What another app would send. Edit it if you like.")}</label><textarea class="input h-28 font-mono text-xs" data-body="${t.id}">${esc(JSON.stringify({ leadId: 204179334, externalId: 50015, updatedName: "Peter", updatedPhone: "+45 22 33 44 55", email: "peter@holm.dk", status: "privateRedial" }, null, 2))}</textarea></div>
    <div class="flex flex-col justify-end gap-2"><button class="btn btn-coral" data-fire="${t.id}" data-token="${t.token}">${icon("zap")} Send a test message</button><button class="btn btn-ghost btn-sm" data-fire="${t.id}" data-token="wrong">Send with a wrong token</button></div>
  </div>
  <div class="mt-3" data-out="${t.id}"></div>
  ${dev(pre(`curl -X POST '${ctx.origin}/journeys/${t.id}/trigger' \\\n  -H 'Authorization: Bearer ${t.token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"leadId": 204179334, "updatedName": "Peter", "status": "privateRedial"}'`))}
</section>`,
  )
  .join("")}

<section class="card mt-6"><h2 class="text-lg">Messages received</h2>${
      runs.length
        ? table(
            ["When", "Inbox", "Result", "Changed"],
            runs.map((r) => [
              relativeTime(r.at),
              esc(triggers.find((t) => t.id === r.triggerId)?.name ?? r.triggerId),
              !r.authorized
                ? badge("wrong token", "bg-coral-soft text-coral-dark")
                : r.matched
                  ? badge("updated", "bg-green-soft text-green")
                  : badge("nobody matched", "bg-amber-soft text-amber"),
              `<span class="text-xs">${esc(
                Object.entries(r.applied)
                  .map(([k, v]) => `${k} → ${k === "status" ? (STATUS_LABEL[v as keyof typeof STATUS_LABEL] ?? v) : v}`)
                  .join(", "),
              )}${r.error ? `<span class="text-coral-dark"> ${esc(r.error)}</span>` : ""}</span>`,
            ]),
          )
        : emptyState("route", "Nothing received yet", triggers.length ? "Press Send a test message above." : "Create an inbox first.")
    }</section>`;

    $("#new", root).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target as HTMLFormElement);
      try {
        await consoleApi.createJourney({
          name: String(f.get("name")),
          matchOn: f.get("matchOn") as never,
          fieldMap: JSON.parse(String(f.get("fieldMap") ?? '{"updatedName":"1","updatedPhone":"3","email":"4","status":"status"}')) as Record<string, string>,
        });
        toast("Inbox created. Now send it a test message.");
        await render();
      } catch (err) {
        fail($("#msg", root), err);
      }
    };
    for (const b of $$<HTMLButtonElement>("[data-del]", root))
      b.onclick = async () => {
        if (!confirm("Delete this inbox? Apps using it will get errors.")) return;
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
          toast("That message is not valid JSON", "error");
          return;
        }
        busy(b, true, "Sending…");
        const r = await consoleApi.fireJourney(id, b.dataset.token!, body);
        const out = r.body as { matched?: number; applied?: Record<string, string>; error?: string };
        const applied =
          Object.entries(out.applied ?? {})
            .map(([k, v]) => `${k} → ${k === "status" ? (STATUS_LABEL[v as keyof typeof STATUS_LABEL] ?? v) : v}`)
            .join(", ") || "nothing";
        $(`[data-out="${id}"]`, root).innerHTML =
          r.status < 300
            ? `<div class="rounded-2xl bg-green-soft px-4 py-3 text-sm">${icon("check-circle", "icon text-green")} The dialer found the person and updated: <b>${esc(applied)}</b>. Because it went through the normal save, a webhook fired too. See <a class="underline" href="#deliveries">Incoming</a>.</div>${dev(pre(r.body))}`
            : `<div class="rounded-2xl bg-coral-soft px-4 py-3 text-sm text-coral-dark">${icon("x", "icon")} Rejected (${r.status}): ${esc(out.error ?? "")}</div>${dev(pre(r.body))}`;
        toast(r.status < 300 ? "Updated" : "Rejected", r.status < 300 ? "ok" : "warn");
        setTimeout(() => void render(), 1500);
      };
    }
  };
  await render();
};

// ---- Activity (request log) -------------------------------------------------

const requestsView: View = async (root) => {
  const rows = await consoleApi.requests();
  const describe = (r: (typeof rows)[number]) => {
    const p = r.path;
    const verb = r.method;
    if (p === "/organization") return "Checked the login";
    if (p === "/fields") return "Fetched the list of field names";
    if (p === "/leads" && verb === "GET") return r.query.includes("lastModifiedTime") ? "Asked for contacts changed since last sync" : "Fetched contacts";
    if (p.startsWith("/leads/") && verb === "PUT") return `Updated contact ${p.split("/")[2]}`;
    if (p === "/leads" && verb === "POST") return "Created a contact";
    if (p === "/webhooks" && verb === "POST") return "Turned on a notification";
    if (p.startsWith("/webhooks/") && verb === "DELETE") return "Turned off a notification";
    if (p === "/webhooks") return "Listed notifications";
    if (p === "/imports" && verb === "POST") return "Started preparing an import";
    if (/^\/imports\/\d+\/insert$/.test(p)) return "Uploaded rows to an import";
    if (/^\/imports\/\d+\/start$/.test(p)) return "Launched an import";
    if (p.startsWith("/imports")) return "Checked on imports";
    if (p.startsWith("/field-mappings"))
      return `${verb === "POST" ? "Saved" : verb === "DELETE" ? "Deleted" : verb === "PUT" ? "Changed" : "Read"} a field-name set`;
    if (p.startsWith("/campaigns") && p.endsWith("addContact")) return "Put a person on a campaign";
    if (p.startsWith("/contacts-external")) return "Updated a person by their CRM id";
    if (p.startsWith("/contacts") || p.startsWith("/pools")) return "Looked at people / lists";
    return `${verb} ${p}`;
  };
  root.innerHTML = `
${pageTitle("Everything the dialer was asked", "A line for every request this console made to the dialer, newest first. Green is fine; amber means we were asked to slow down; red is an error.", "In developer view you also get the exact path, query and request id to quote in a support ticket.")}
<section class="card mt-8">${
    rows.length
      ? table(
          [
            "When",
            "What",
            "Result",
            "Took",
            `Budget left ${help("The dialer allows 60 requests a minute. This is how many were left after this call.")}`,
            ...(devMode() ? ["Path", "Request id"] : []),
          ],
          rows.map((r) => [
            relativeTime(r.at),
            `${esc(describe(r))}${r.emitted.length ? `<div class="text-xs text-grey">→ sent: ${r.emitted.map(eventLabel).join(", ")}</div>` : ""}`,
            badge(
              r.status < 300 ? "ok" : r.status === 429 ? "slow down" : `error ${r.status}`,
              r.status < 300 ? "bg-green-soft text-green" : r.status === 429 ? "bg-amber-soft text-amber" : "bg-coral-soft text-coral-dark",
            ),
            `${r.durationMs} ms`,
            `${r.rateLimitRemaining}/60`,
            ...(devMode()
              ? [
                  `<code class="text-xs">${r.method} ${esc(r.path)}${r.query ? `?${esc(decodeURIComponent(r.query))}` : ""}</code>`,
                  `<code class="text-xs">${r.id.slice(0, 8)}</code>`,
                ]
              : []),
          ]),
        )
      : emptyState("scroll-text", "Nothing yet", "Use any other page and come back.")
  }</section>`;
};

// ---- Health check (diagnose) -----------------------------------------------

const diagnoseView: View = async (root) => {
  const [checks, overview] = await Promise.all([consoleApi.diagnose(), consoleApi.overview()]);
  const problems = checks.filter((c) => c.level !== "ok");
  const tone = { ok: "border-green/40", warn: "border-amber/60", error: "border-coral/60" };
  const word = { ok: "Fine", warn: "Worth a look", error: "Needs fixing" };
  root.innerHTML = `
${pageTitle("Is everything working?", problems.length ? `${problems.length} thing${problems.length > 1 ? "s" : ""} to look at. Each one says what it means and how to fix it.` : "Everything looks good.", "Re-run any time by reloading this page.")}
<div class="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">${kpi("People", overview.leads)}${kpi("Notifications on", overview.webhooks)}${kpi("Messages in", overview.deliveries.total)}${kpi("Saved to CRM", overview.deliveries.delivered, "text-green")}${kpi("Gave up", overview.deliveries.dead, overview.deliveries.dead ? "text-coral-dark" : "")}${kpi("In your CRM", overview.crm)}</div>
<div class="mt-6 grid gap-3">${checks.map((c) => `<div class="card border-2 ${tone[c.level]}"><div class="flex items-center gap-3">${badge(word[c.level], c.level === "ok" ? "bg-green-soft text-green" : c.level === "warn" ? "bg-amber-soft text-amber" : "bg-coral-soft text-coral-dark")}<strong>${esc(c.title)}</strong></div>${c.detail ? `<p class="mt-2 text-sm text-grey-2">${esc(c.detail)}</p>` : ""}${c.fix ? `<p class="mt-2 flex items-start gap-2 text-sm">${icon("wrench", "icon mt-0.5 text-indigo-brand")}<span><b>How to fix:</b> ${esc(c.fix)}</span></p>` : ""}</div>`).join("")}</div>`;
};
