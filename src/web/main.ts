import "./styles.css";
import { consoleApi, DialerApi } from "./api";
import { LEAD_STATUSES, type Field, type Lead, type LeadStatus } from "../core/types";
import { eventLabel, relativeTime, STATUS_LABEL, STATUS_TONE } from "./labels";
import { $, $$, busy, dev, devMode, emptyState, esc, eventBadge, explain, fail, help, icon, pre, setDevMode, stepHeader, toast } from "./ui";
import { renderToolkit, type ToolkitContext } from "./toolkit";

let api: DialerApi | null = null;
let fields = new Map<number, Field>();

const name = (lead: Lead, fieldName: string) => lead.masterData.find((p) => fields.get(p.id)?.name === fieldName)?.value ?? "";

// Each tab has a plain-language name and a one-line "what you do here".
const NAV: { hash: string; label: string; sub: string; icon: string }[] = [
  { hash: "#demo", label: "Try it", sub: "See a webhook fire", icon: "play" },
  { hash: "#import", label: "Add people", sub: "Upload a spreadsheet", icon: "upload" },
  { hash: "#mapping", label: "Match fields", sub: "Dialer names ↔ CRM names", icon: "git-compare-arrows" },
  { hash: "#connector", label: "Sync to CRM", sub: "Keep both systems equal", icon: "refresh-cw" },
  { hash: "#deliveries", label: "Incoming", sub: "What the dialer sent us", icon: "inbox" },
  { hash: "#journeys", label: "Push to dialer", sub: "Let other apps update it", icon: "route" },
  { hash: "#requests", label: "Activity", sub: "Every API call", icon: "scroll-text" },
  { hash: "#diagnose", label: "Health check", sub: "Find and fix problems", icon: "stethoscope" },
];

setDevMode(devMode());

$("#app").innerHTML = `
<header class="border-b border-line bg-white">
  <div class="container-x flex flex-wrap items-center gap-3 py-4">
    <a href="#demo" class="mr-2 flex items-center gap-2 text-lg font-bold">${icon("phone-outgoing", "icon text-indigo-brand")} Dialer Console</a>
    <span id="conn" class="text-sm text-grey">Not connected</span>
    <div class="ml-auto flex items-center gap-2">
      <button id="dev-toggle" class="toggle" aria-pressed="${devMode()}" title="Show the API codes, paths and raw JSON behind every label">${icon("code", "icon h-4 w-4")} Developer view</button>
      <button id="reset" class="toggle" title="Put all demo data back to how it started">${icon("rotate-ccw", "icon h-4 w-4")} Start over</button>
    </div>
  </div>
  <nav id="nav" class="container-x flex flex-wrap gap-1 pb-3">${NAV.map((n) => `<a class="nav-link" href="${n.hash}"><span class="flex items-center gap-2">${icon(n.icon)}<span>${n.label}</span></span><span class="nav-sub">${n.sub}</span></a>`).join("")}</nav>
</header>
<main class="container-x py-10"><div id="view"></div></main>
<footer class="pb-10 text-center text-xs text-grey">
  <p>Everything here is a safe copy. Nothing you do reaches a real dialer or CRM.</p>
  <p class="mt-1">Guides: <code>docs/playbook.md</code> · <code>docs/errors.md</code> · Login <code>demo</code> / <code>demo</code></p>
</footer>`;

$("#dev-toggle").onclick = () => {
  const on = !devMode();
  setDevMode(on);
  $("#dev-toggle").setAttribute("aria-pressed", String(on));
  toast(on ? "Developer view on: API codes are shown next to labels" : "Developer view off");
};

$("#reset").onclick = async () => {
  if (!confirm("Put all demo data back to the start? Your imports, webhooks and CRM records will be removed.")) return;
  await consoleApi.reset();
  sessionStorage.removeItem("creds");
  localStorage.removeItem("welcome");
  location.hash = "#demo";
  location.reload();
};

// ---- the guided demo -------------------------------------------------------

const welcomeDismissed = () => localStorage.getItem("welcome") === "done";

function welcomeCard(): string {
  if (welcomeDismissed()) return "";
  return `
  <section class="card mt-8 border-2 border-indigo-soft bg-indigo-soft/40">
    <div class="flex items-start gap-4">
      <span class="icon-box">${icon("help-circle")}</span>
      <div class="flex-1">
        <h2 class="text-lg">New here? Follow the numbers.</h2>
        <p class="mt-1 text-sm text-grey-2">Nothing here is real, so you cannot break anything. A good first visit takes about five minutes:</p>
        <ol class="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
          <li><b>Try it</b> (this page) — see a message go from the dialer to a CRM.</li>
          <li><b>Add people</b> — upload a list and watch duplicates get caught.</li>
          <li><b>Sync to CRM</b> — press Preview, then Sync.</li>
          <li><b>Incoming</b> — break things on purpose and watch them recover.</li>
        </ol>
        <p class="mt-3 text-xs text-grey-2">Curious what the API is doing underneath? Switch on <b>Developer view</b> in the top right at any time.</p>
      </div>
      <button id="welcome-close" class="text-grey hover:text-ink" aria-label="Dismiss">${icon("x")}</button>
    </div>
  </section>`;
}

function renderDemo(): void {
  const connected = api !== null;
  $("#view").innerHTML = `
<div class="mx-auto max-w-3xl">
  <h1 class="text-3xl">Watch the dialer talk to your CRM</h1>
  <p class="lead mt-3">A dialer is the software a call centre uses to phone people. When an agent finishes a call, the dialer can <b>tell another system what happened</b>. That message is a <i>webhook</i>. This page lets you trigger one and watch it arrive, in three clicks.</p>
  ${welcomeCard()}

  <section class="card mt-8" id="step-1">
    ${stepHeader(1, "Connect", "This is the login a real integration would use. It is pre-filled for you.", connected)}
    <form id="login" class="mt-5 flex flex-wrap items-end gap-3">
      <div><label class="label">Username</label><input class="input" id="user" value="demo" autocomplete="username"></div>
      <div><label class="label">Password</label><input class="input" id="pass" type="password" value="demo" autocomplete="current-password"></div>
      <button class="btn btn-coral" ${connected ? "disabled" : ""}>${connected ? `${icon("check")} Connected` : "Connect"}</button>
      <span id="login-msg" class="text-sm"></span>
    </form>
    ${explain("What happens behind the button", `The page sends <code>GET /organization</code> with an <code>Authorization: Basic …</code> header, exactly like a customer's server would. If the credentials are right, the dialer replies with the organisation's name.`)}
  </section>

  <section class="card mt-6 ${connected ? "" : "opacity-40"}" id="step-2">
    ${stepHeader(2, "Turn on notifications", "Tell the dialer: “when a contact is saved, send a message to this page.”")}
    <div id="hook-area" class="mt-5"></div>
    ${explain("What happens behind the button", `<code>POST /webhooks</code> with an event, a URL and a secret key. The dialer stores it and will call that URL every time the event happens. The key travels as <code>?authKey=…</code> so the receiver can tell real messages from fakes.`)}
  </section>

  <section class="card mt-6 ${connected ? "" : "opacity-40"}" id="step-3">
    ${stepHeader(3, "Change a contact", "Pick a new outcome for any person below, as an agent would after a call.")}
    <div id="leads-area" class="mt-5"></div>
    ${explain("What happens behind the dropdown", `<code>PUT /leads/{id}</code> with <code>{ "status": "…" }</code>. Closing outcomes (sale, not interested, wrong number, not a fit) also mark the contact inactive and fire a second, more specific event.`)}
  </section>

  <section class="card mt-6 ${connected ? "" : "opacity-40"}" id="step-4">
    ${stepHeader(4, "See the message arrive", "Newest first. Each one is a webhook the dialer delivered to this page.")}
    <div id="events-area" class="mt-5"></div>
    <p class="mt-4 text-sm text-grey-2">Want to see what happened to each message afterwards (saved to CRM, retried, rejected)? Open <a class="font-semibold text-indigo-brand underline" href="#deliveries">Incoming</a>.</p>
  </section>
</div>`;

  const close = document.getElementById("welcome-close");
  if (close)
    close.onclick = () => {
      localStorage.setItem("welcome", "done");
      close.closest("section")?.remove();
    };

  $("#login").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>("#login button");
    busy(btn, true, "Connecting…");
    try {
      await connect($<HTMLInputElement>("#user").value, $<HTMLInputElement>("#pass").value);
      toast("Connected. Now turn on notifications in step 2.");
      renderDemo();
    } catch (err) {
      busy(btn, false);
      fail($("#login-msg"), err);
    }
  };

  if (connected) void Promise.all([loadHooks(), loadLeads(), loadEvents()]);
  else {
    $("#hook-area").innerHTML = `<p class="text-sm text-grey">Connect first.</p>`;
    $("#leads-area").innerHTML = `<p class="text-sm text-grey">Connect first.</p>`;
    $("#events-area").innerHTML = `<p class="text-sm text-grey">Connect first.</p>`;
  }
}

async function loadHooks(): Promise<void> {
  const hooks = await api!.webhooks();
  const mine = hooks.filter((w) => w.url.startsWith(window.location.origin));
  $("#hook-area").innerHTML = mine.length
    ? `<div class="flex flex-wrap items-center gap-3 rounded-2xl bg-green-soft px-4 py-3 text-sm">${icon("check-circle", "icon text-green")}<span><b>Notifications are on.</b> The dialer will message this page when ${mine.map((w) => `<i>${esc(eventLabel(w.event).toLowerCase())}</i>`).join(" or ")}.</span><button id="hook-off" class="ml-auto text-xs font-semibold text-coral-dark">Turn off</button></div>
       ${dev(`<div class="mt-2 text-xs text-grey">${mine.map((w) => `<code>${esc(w.event)}</code> → <code>${esc(w.url)}</code>`).join("<br>")}</div>`)}`
    : `<div class="flex flex-wrap items-center gap-3"><button id="hook-on" class="btn btn-indigo">${icon("zap")} Turn on notifications</button><span class="text-sm text-grey-2">One click. You can turn it off again any time.</span></div>`;
  const on = document.getElementById("hook-on") as HTMLButtonElement | null;
  if (on)
    on.onclick = async () => {
      busy(on, true, "Turning on…");
      await api!.createWebhook({
        event: "lead_saved",
        url: `${window.location.origin}/hooks/receive`,
        authKey: "console-secret",
        template: { name: "[1] [2]", phone: "[3]", status: "[status]", lead: "[lead_id]", agent: "[last_called_by]" },
      });
      toast("Notifications on. Now change a contact in step 3.");
      await loadHooks();
    };
  const off = document.getElementById("hook-off");
  if (off)
    off.onclick = async () => {
      for (const w of mine) await api!.deleteWebhook(w.id);
      toast("Notifications off", "warn");
      await loadHooks();
    };
}

async function loadLeads(flashId?: number): Promise<void> {
  const leads = await api!.allLeads();
  $("#leads-area").innerHTML = `
  <table class="w-full text-sm"><thead class="table-head"><tr><th class="pb-2">Person</th><th class="pb-2">Phone</th><th class="pb-2">Outcome of last call ${help("What the agent recorded after calling. Change it to simulate a new call.")}</th></tr></thead>
  <tbody>${leads
    .map(
      (l) => `<tr class="border-t border-line-2 ${l.id === flashId ? "flash" : ""}">
        <td class="py-2.5">${esc(name(l, "Firstname"))} ${esc(name(l, "Lastname"))}${dev(`<span class="ml-2 text-xs text-grey">lead ${l.id} · campaign ${l.campaignId}</span>`)}</td>
        <td class="py-2.5 font-mono text-xs">${esc(name(l, "Phone"))}</td>
        <td class="py-2.5"><select class="status-select ${STATUS_TONE[l.status]}" data-lead="${l.id}" aria-label="Outcome for ${esc(name(l, "Firstname"))}">${LEAD_STATUSES.filter(
          (s) => s !== "unknown",
        )
          .map((s) => `<option value="${s}" ${s === l.status ? "selected" : ""}>${STATUS_LABEL[s]}${devMode() ? ` (${s})` : ""}</option>`)
          .join("")}</select></td></tr>`,
    )
    .join("")}</tbody></table>`;
  for (const sel of $$<HTMLSelectElement>("[data-lead]")) {
    sel.onchange = async () => {
      const id = Number(sel.dataset.lead);
      sel.disabled = true;
      await api!.updateLead(id, { status: sel.value as LeadStatus });
      toast(`Saved. Watch step 4.`);
      await Promise.all([loadLeads(id), loadEvents(true)]);
    };
  }
}

async function loadEvents(highlightNewest = false): Promise<void> {
  const events = await consoleApi.events();
  $("#events-area").innerHTML = events.length
    ? `<ul class="grid gap-2">${events
        .map(
          (e, i) =>
            `<li><details class="rounded-xl border border-line p-3 ${highlightNewest && i === 0 ? "flash" : ""}"><summary class="flex cursor-pointer flex-wrap items-center gap-3">${eventBadge(e.payload.event)}<span>${esc(String(e.payload.data?.name ?? `contact ${e.payload.leadId}`))}</span>${e.payload.data?.status ? `<span class="text-grey-2">→ ${esc(STATUS_LABEL[e.payload.status] ?? e.payload.status)}</span>` : ""}<span class="ml-auto text-xs ${e.authKeyValid ? "text-green" : "text-coral-dark"}">${e.authKeyValid ? "genuine" : "wrong key"} · ${relativeTime(e.receivedAt)}</span></summary><div class="mt-3 text-xs text-grey-2">This is the exact message the dialer sent:</div>${pre(e.payload)}</details></li>`,
        )
        .join("")}</ul>`
    : emptyState(
        "inbox",
        "No messages yet",
        "Turn on notifications (step 2), then change someone's outcome (step 3). The message will show up here within a second.",
      );
}

// ---- connection + routing ---------------------------------------------------

async function connect(username: string, password: string): Promise<void> {
  const candidate = new DialerApi({ username, password });
  const org = await candidate.organization();
  api = candidate;
  fields = new Map((await api.fields()).map((f) => [f.id, f]));
  sessionStorage.setItem("creds", JSON.stringify({ username, password }));
  $("#conn").innerHTML = `${icon("check-circle", "icon text-green")} Connected to <b>${esc(org.name)}</b>`;
}

const ctx = (): ToolkitContext => ({ api: api!, fields, origin: window.location.origin });

async function route(): Promise<void> {
  const hash = location.hash || "#demo";
  for (const a of $$<HTMLAnchorElement>("#nav a")) a.toggleAttribute("aria-current", a.getAttribute("href") === hash);
  window.scrollTo({ top: 0 });
  if (hash === "#demo") return renderDemo();
  if (!api) {
    $("#view").innerHTML =
      `<div class="mx-auto max-w-xl">${emptyState("phone-outgoing", "Connect first", "Every page talks to the dialer, so it needs the login from step 1.", `<a class="btn btn-coral" href="#demo">Go to step 1</a>`)}</div>`;
    return;
  }
  await renderToolkit(hash.slice(1), $("#view"), ctx());
}

window.addEventListener("hashchange", () => void route());

(async () => {
  const saved = sessionStorage.getItem("creds");
  if (saved) {
    try {
      const c = JSON.parse(saved) as { username: string; password: string };
      await connect(c.username, c.password);
    } catch {
      sessionStorage.removeItem("creds");
    }
  }
  await route();
})();
