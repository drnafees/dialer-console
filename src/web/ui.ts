// Tiny DOM helpers shared by the views. No framework; render strings, then bind.

import {
  ArrowRight,
  Check,
  CheckCircle,
  Code,
  Eye,
  FlaskConical,
  GitCompareArrows,
  HelpCircle,
  Inbox,
  Info,
  PhoneOutgoing,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  ScrollText,
  Send,
  Stethoscope,
  Upload,
  Wrench,
  X,
  Zap,
  createElement,
  type IconNode,
} from "lucide";

const ICONS: Record<string, IconNode> = {
  "arrow-right": ArrowRight,
  check: Check,
  "check-circle": CheckCircle,
  code: Code,
  eye: Eye,
  "flask-conical": FlaskConical,
  "git-compare-arrows": GitCompareArrows,
  "help-circle": HelpCircle,
  inbox: Inbox,
  info: Info,
  "phone-outgoing": PhoneOutgoing,
  play: Play,
  plus: Plus,
  "refresh-cw": RefreshCw,
  "rotate-ccw": RotateCcw,
  route: Route,
  save: Save,
  "scroll-text": ScrollText,
  send: Send,
  stethoscope: Stethoscope,
  upload: Upload,
  wrench: Wrench,
  x: X,
  zap: Zap,
};
import { ApiError } from "./api";
import { ACTION_LABEL, eventLabel, FORWARD_LABEL, statusLabel } from "./labels";

export const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
export const $$ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { hour12: false }) : "-");
export const pre = (v: unknown) =>
  `<pre><code class="whitespace-pre-wrap !text-xs">${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</code></pre>`;

// Lucide icons only, via icon("name").
export function icon(name: string, cls = "icon"): string {
  const node = ICONS[name];
  if (!node) return "";
  const el = createElement(node);
  el.setAttribute("class", cls);
  return el.outerHTML;
}

export const badge = (text: string, cls: string) => `<span class="badge ${cls}">${esc(text)}</span>`;

export const STATUS_BADGE: Record<string, string> = {
  delivered: "bg-green-soft text-green",
  completed: "bg-green-soft text-green",
  ok: "bg-green-soft text-green",
  pending: "bg-amber-soft text-amber",
  queued: "bg-amber-soft text-amber",
  processing: "bg-amber-soft text-amber",
  running: "bg-amber-soft text-amber",
  warn: "bg-amber-soft text-amber",
  dead: "bg-coral-soft text-coral-dark",
  failed: "bg-coral-soft text-coral-dark",
  error: "bg-coral-soft text-coral-dark",
  created: "bg-paper-2 text-grey-2",
  create: "bg-accent-soft text-accent",
  update: "bg-indigo-soft text-indigo-brand",
  skip: "bg-paper-2 text-grey-2",
  skipped: "bg-paper-2 text-grey-2",
  insert: "bg-accent-soft text-accent",
  duplicate: "bg-paper-2 text-grey-2",
  blacklisted: "bg-coral-soft text-coral-dark",
};
export const statusBadge = (s: string) => badge(s, STATUS_BADGE[s] ?? "bg-paper-2 text-grey-2");

// ---- developer mode: show raw API codes next to plain-language labels ----
export const devMode = () => localStorage.getItem("devMode") === "1";
export function setDevMode(on: boolean): void {
  localStorage.setItem("devMode", on ? "1" : "0");
  document.documentElement.classList.toggle("dev", on);
}
// Visible only in developer mode.
export const dev = (html: string) => `<span class="dev-only">${html}</span>`;
// A label with its code alongside in developer mode.
export const labelled = (label: string, code: string) => `${esc(label)}${dev(` <code>${esc(code)}</code>`)}`;

export const eventBadge = (e: string) => badge(eventLabel(e), "bg-indigo-soft text-indigo-brand") + dev(` <code>${esc(e)}</code>`);
export const forwardBadge = (s: string) => badge(FORWARD_LABEL[s] ?? s, STATUS_BADGE[s] ?? "bg-paper-2 text-grey-2");
export const actionBadge = (s: string) => badge(ACTION_LABEL[s] ?? s, STATUS_BADGE[s] ?? "bg-paper-2 text-grey-2");
export const leadStatusBadge = (s: string, tone: string) => badge(statusLabel(s), tone) + dev(` <code>${esc(s)}</code>`);

// ---- toasts ----
export function toast(message: string, tone: "ok" | "warn" | "error" = "ok"): void {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.className = "pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2";
    document.body.appendChild(host);
  }
  for (const old of host.children) old.remove();
  const el = document.createElement("div");
  el.className = `toast toast-${tone}`;
  el.innerHTML = `${icon(tone === "ok" ? "check-circle" : tone === "warn" ? "info" : "x")}<span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => el.classList.add("toast-out"), 3200);
  setTimeout(() => el.remove(), 3800);
}

// ---- small reusable blocks ----
export const help = (text: string) => `<span class="help" tabindex="0">${icon("help-circle", "icon h-4 w-4")}<span class="help-tip">${esc(text)}</span></span>`;

export const emptyState = (iconName: string, title: string, hint: string, actionHtml = "") =>
  `<div class="empty">${icon(iconName, "icon h-8 w-8 text-grey")}<p class="mt-3 font-semibold">${esc(title)}</p><p class="mt-1 text-sm text-grey-2">${esc(hint)}</p>${actionHtml ? `<div class="mt-4">${actionHtml}</div>` : ""}</div>`;

export const stepHeader = (n: number, title: string, sub: string, done = false) =>
  `<div class="flex items-start gap-4"><span class="step ${done ? "step-done" : ""}">${done ? icon("check", "icon h-4 w-4 text-white") : n}</span><div><h2 class="text-lg">${title}</h2>${sub ? `<p class="mt-1 text-sm text-grey-2">${sub}</p>` : ""}</div></div>`;

export const explain = (title: string, body: string) =>
  `<details class="explain"><summary>${icon("info", "icon h-4 w-4")} ${esc(title)}</summary><div class="mt-2 text-sm text-grey-2">${body}</div></details>`;

export const busy = (btn: HTMLButtonElement, on: boolean, label?: string) => {
  btn.disabled = on;
  if (label) btn.dataset.label ??= btn.innerHTML;
  if (on && label) btn.innerHTML = `<span class="spinner"></span> ${esc(label)}`;
  if (!on && btn.dataset.label) btn.innerHTML = btn.dataset.label;
};

export function fail(el: HTMLElement, e: unknown): void {
  el.textContent = e instanceof ApiError ? `${e.status}: ${e.message}` : String(e);
  el.className = "text-sm text-coral-dark";
}

export function note(el: HTMLElement, text: string, tone: "ok" | "warn" = "ok"): void {
  el.textContent = text;
  el.className = `text-sm ${tone === "ok" ? "text-green" : "text-amber"}`;
}

export const card = (title: string, sub: string, body: string, id?: string) =>
  `<section class="card mt-6"${id ? ` id="${id}"` : ""}><h2 class="text-lg">${title}</h2>${sub ? `<p class="mt-1 text-sm text-grey-2">${sub}</p>` : ""}${body}</section>`;

export const table = (head: string[], rows: string[][], empty = "Nothing yet.") =>
  rows.length
    ? `<table class="mt-4 w-full text-sm"><thead class="table-head"><tr>${head.map((h) => `<th class="pb-2 pr-3">${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr class="border-t border-line-2 align-top">${r.map((c) => `<td class="py-2 pr-3">${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<p class="mt-4 text-sm text-grey">${empty}</p>`;

export const kpi = (label: string, value: string | number, tone = "") =>
  `<div class="rounded-2xl border border-line p-4"><div class="text-xs uppercase tracking-wider text-grey">${label}</div><div class="mt-1 text-2xl font-bold ${tone}">${value}</div></div>`;
