import "./styles.css";
import { ApiError, consoleApi, DialerApi } from "./api";
import { LEAD_STATUSES, type Field, type Lead, type LeadStatus } from "../core/types";

let api: DialerApi | null = null;
let fields = new Map<number, Field>();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const name = (lead: Lead, fieldName: string) => lead.masterData.find((p) => fields.get(p.id)?.name === fieldName)?.value ?? "";

const BADGE: Record<LeadStatus, string> = {
  new: "bg-accent-soft text-accent",
  success: "bg-green-soft text-green",
  notInterested: "bg-paper-2 text-grey-2",
  unqualified: "bg-paper-2 text-grey-2",
  invalid: "bg-coral-soft text-coral-dark",
  automaticRedial: "bg-amber-soft text-amber",
  privateRedial: "bg-amber-soft text-amber",
  unknown: "bg-paper-2 text-grey-2",
};

$("#app").innerHTML = `
<main class="mx-auto max-w-3xl px-6 py-12">
  <h1 class="text-3xl">Dialer Console</h1>
  <p class="mt-2 text-grey-2">A mock of a dialer REST API and a page that uses it. Log in, change a lead, and watch the webhook arrive.</p>

  <section class="card mt-8">
    <h2 class="text-lg">1. Log in</h2>
    <p class="mt-1 text-sm text-grey-2">Basic auth on every request. Demo login is <code>demo</code> / <code>demo</code>.</p>
    <form id="login" class="mt-4 flex flex-wrap items-end gap-3">
      <div><label class="label">Username</label><input class="input" id="user" value="demo"></div>
      <div><label class="label">Password</label><input class="input" id="pass" type="password" value="demo"></div>
      <button class="btn btn-coral">Connect</button>
      <span id="login-msg" class="text-sm"></span>
    </form>
  </section>

  <section class="card mt-6 hidden" id="leads-card">
    <h2 class="text-lg">2. Leads</h2>
    <p class="mt-1 text-sm text-grey-2"><code>GET /leads</code>. Change a status to send <code>PUT /leads/{id}</code>.</p>
    <table class="mt-4 w-full text-sm"><thead class="table-head"><tr><th class="pb-2">Name</th><th class="pb-2">Phone</th><th class="pb-2">Campaign</th><th class="pb-2">Status</th></tr></thead><tbody id="leads"></tbody></table>
  </section>

  <section class="card mt-6 hidden" id="hooks-card">
    <h2 class="text-lg">3. Webhooks</h2>
    <p class="mt-1 text-sm text-grey-2"><code>POST /webhooks</code>. The API calls your URL with <code>?authKey=…</code> when the event happens.</p>
    <form id="hook-form" class="mt-4 flex flex-wrap items-end gap-3">
      <div><label class="label">Event</label><select class="input" id="hook-event"><option>lead_saved</option><option>leadClosedSuccess</option><option>leadClosedNotInterested</option></select></div>
      <div class="flex-1"><label class="label">URL</label><input class="input" id="hook-url" value="${window.location.origin}/hooks/receive"></div>
      <button class="btn btn-indigo">Register</button>
    </form>
    <ul id="hooks" class="mt-4 divide-y divide-line-2 text-sm"></ul>
  </section>

  <section class="card mt-6 hidden" id="events-card">
    <h2 class="text-lg">4. Received webhooks</h2>
    <p class="mt-1 text-sm text-grey-2">What arrived at <code>/hooks/receive</code>, newest first.</p>
    <ul id="events" class="mt-4 grid gap-2 text-sm"></ul>
  </section>

  <p class="mt-10 text-center text-xs text-grey"><button id="reset" class="underline">Reset demo data</button></p>
</main>`;

function fail(el: HTMLElement, e: unknown): void {
  el.textContent = e instanceof ApiError ? `${e.status}: ${e.message}` : String(e);
  el.className = "text-sm text-coral-dark";
}

$("#login").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#login-msg");
  const candidate = new DialerApi({ username: $<HTMLInputElement>("#user").value, password: $<HTMLInputElement>("#pass").value });
  try {
    const org = await candidate.organization();
    api = candidate;
    msg.textContent = `Connected to ${org.name}`;
    msg.className = "text-sm text-green";
    fields = new Map((await api.fields()).map((f) => [f.id, f]));
    for (const id of ["leads-card", "hooks-card", "events-card"]) $(`#${id}`).classList.remove("hidden");
    await Promise.all([loadLeads(), loadHooks(), loadEvents()]);
  } catch (err) {
    fail(msg, err);
  }
};

async function loadLeads(): Promise<void> {
  const leads = await api!.allLeads();
  $("#leads").innerHTML = leads
    .map(
      (l) => `<tr class="border-t border-line-2">
        <td class="py-2">${esc(name(l, "Firstname"))} ${esc(name(l, "Lastname"))}</td>
        <td class="py-2 font-mono text-xs">${esc(name(l, "Phone"))}</td>
        <td class="py-2 text-grey-2">${l.campaignId}</td>
        <td class="py-2"><select class="badge ${BADGE[l.status]} cursor-pointer appearance-none border-0" data-lead="${l.id}">${LEAD_STATUSES.map((s) => `<option ${s === l.status ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`,
    )
    .join("");
  for (const sel of document.querySelectorAll<HTMLSelectElement>("[data-lead]")) {
    sel.onchange = async () => {
      await api!.updateLead(Number(sel.dataset.lead), { status: sel.value as LeadStatus });
      await Promise.all([loadLeads(), loadEvents()]);
    };
  }
}

async function loadHooks(): Promise<void> {
  const hooks = await api!.webhooks();
  $("#hooks").innerHTML = hooks.length
    ? hooks.map((w) => `<li class="flex items-center gap-3 py-2"><span class="badge bg-indigo-soft text-indigo-brand">${esc(w.event)}</span><span class="flex-1 truncate font-mono text-xs">${esc(w.url)}</span><button class="text-xs text-coral-dark" data-del="${w.id}">Delete</button></li>`).join("")
    : `<li class="py-2 text-grey">None yet. Register one, then change a lead status above.</li>`;
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-del]")) {
    btn.onclick = async () => {
      await api!.deleteWebhook(Number(btn.dataset.del));
      await loadHooks();
    };
  }
}

$("#hook-form").onsubmit = async (e) => {
  e.preventDefault();
  await api!.createWebhook({ event: $<HTMLSelectElement>("#hook-event").value as never, url: $<HTMLInputElement>("#hook-url").value, authKey: "console-secret", template: { name: "[1] [2]", phone: "[3]" } });
  await loadHooks();
};

async function loadEvents(): Promise<void> {
  const events = await consoleApi.events();
  $("#events").innerHTML = events.length
    ? events.map((e) => `<li><details class="rounded-xl border border-line p-3"><summary class="flex cursor-pointer items-center gap-3"><span class="badge bg-indigo-soft text-indigo-brand">${esc(e.payload.event)}</span><span>lead ${e.payload.leadId}</span><span class="ml-auto text-xs ${e.authKeyValid ? "text-green" : "text-coral-dark"}">${e.authKeyValid ? "authKey ok" : "authKey wrong"}</span></summary><pre class="mt-3"><code class="whitespace-pre-wrap !text-xs">${esc(JSON.stringify(e.payload, null, 2))}</code></pre></details></li>`).join("")
    : `<li class="text-grey">Nothing yet.</li>`;
}

$("#reset").onclick = async () => {
  await consoleApi.reset();
  location.reload();
};
