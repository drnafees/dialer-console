// Tiny DOM helpers shared by the views. No framework; render strings, then bind.

import {
  ArrowRight,
  CheckCircle,
  Eye,
  FlaskConical,
  GitCompareArrows,
  Inbox,
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
  Zap,
  createElement,
  type IconNode,
} from "lucide";

const ICONS: Record<string, IconNode> = {
  "arrow-right": ArrowRight,
  "check-circle": CheckCircle,
  eye: Eye,
  "flask-conical": FlaskConical,
  "git-compare-arrows": GitCompareArrows,
  inbox: Inbox,
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
  zap: Zap,
};
import { ApiError } from "./api";

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
