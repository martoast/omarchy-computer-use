// The normalized observation: ONE fixed shape for "what is on the page now" and "what did my last action do",
// the same on every site and from every tool. Built for a small local model first (stable fields, a closed
// vocabulary, no prose) and rendered as compact text for a large one. Pure functions only; no I/O.
//
//   observe(snapshot, ctx)        -> Observation          (from a bridge snapshot: page + elements)
//   renderObservation(obs)        -> string                (compact text, grouped by region, one line per element)
//   actionOutcome(tool, result)   -> Outcome               (any core tool's result -> a closed outcome enum + changes)
//
// Observation = {
//   v: 1,
//   page: { url, host, path, title, loading: bool, dialogs: n },
//   elements: [ { ref, role, name, value?, states: [..], region, view, href?, off_site?, dup? } ],
//   omitted: { below: n, above: n, budget: n },
// }
// Outcome = { tool, target?, outcome: "ok"|"no_change"|"unverified"|"refused"|"failed"|"blocked",
//             changed: { url?, dialogs?, focus?, checked?, expanded?, selected? }, detail }

export const OBS_VERSION = 2;   // 2: a nameless control may carry a cue marker (label / under) after its name

// ---- roles: AT-SPI's names -> a closed vocabulary of 17 ------------------------------------------------------
export const ROLE_MAP = {
  "button": "button", "push button": "button",
  "toggle button": "toggle",
  "link": "link",
  "entry": "textbox", "text": "textbox",
  "password text": "password",
  "combo box": "dropdown",
  "check box": "checkbox", "check menu item": "checkbox",
  "radio button": "radio", "radio menu item": "radio",
  "menu item": "menuitem",
  "page tab": "tab",
  "slider": "slider",
  "spin button": "number",
  "heading": "heading",
  "image": "image",
  "dialog": "dialog", "alert": "dialog",
  "paragraph": "text", "static": "text", "section": "text", "list item": "text",
};
export const ROLES = [...new Set(Object.values(ROLE_MAP))];
// what a role can be acted on with: lets a small model pick the tool from the role in most cases
export const ROLE_ACTIONS = {
  button: ["click"], toggle: ["click"], link: ["click"], menuitem: ["click", "hover"], tab: ["click"],
  textbox: ["type"], password: [], dropdown: ["select"], checkbox: ["click"], radio: ["click"],
  slider: ["click"], number: ["type"], heading: [], image: [], dialog: ["dismiss"], text: [],
};

// ---- states: a fixed set ---------------------------------------------------------------------------------------
const STATE_ORDER = ["checked", "selected", "expanded", "disabled", "focused"];
function normStates(el, role) {
  const s = new Set(el.states || []);
  if (s.has("pressed")) s.add("checked"); // a pressed toggle is "on": one word for both
  return STATE_ORDER.filter((k) => s.has(k));
}

// ---- regions ---------------------------------------------------------------------------------------------------
// The bridge stamps `region` from the nearest ARIA landmark (banner/navigation/main/contentinfo/complementary/
// search/form); a dialog always wins. Missing means "main" when the page declares no landmarks at all.
export const REGIONS = ["browser", "dialog", "header", "nav", "search", "main", "aside", "footer"];
export const LANDMARK_TO_REGION = {
  banner: "header", navigation: "nav", search: "search", main: "main", contentinfo: "footer",
  complementary: "aside", form: "main", region: "main",
};
function regionOf(el) {
  // the browser's own controls that carry a ref (the address bar): never part of the page
  if (el.in_doc === false || el.doc_class === "chrome") return "browser";
  if (el.in_dialog || el.dialog_root) return "dialog";
  return REGIONS.includes(el.region) ? el.region : "main";
}

// ---- names -----------------------------------------------------------------------------------------------------
const NAME_MAX = 80;
export function normName(name) {
  let s = String(name ?? "")
    .replace(/[​-‍⁠﻿­]/g, "") // zero-width and soft hyphen
    .replace(/[  -   　]/g, " ") // odd spaces
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX - 1).trimEnd() + "…";
  return s;
}

// ---- where on screen -------------------------------------------------------------------------------------------
function viewOf(el, viewport) {
  if (!viewport || el.cy == null) return "in";
  if (el.cy < viewport.top) return "above";
  if (el.cy > viewport.bottom) return "below";
  return "in";
}

function hostPath(url) {
  try { const u = new URL(url); return { host: u.hostname.replace(/^www\./, ""), path: (u.pathname + u.search).slice(0, 200) }; }
  catch { return { host: "", path: "" }; }
}
function shortHref(href, pageHost) {
  if (!href) return undefined;
  try {
    const u = new URL(/^[a-z]+:/i.test(href) ? href : `https://${href}`);
    const host = u.hostname.replace(/^www\./, "");
    const p = (u.pathname || "/").slice(0, 100);
    return host === pageHost ? p : `${host}${p}`;
  } catch { return String(href).slice(0, 100); }
}

// ---- observe ---------------------------------------------------------------------------------------------------
// ctx: { viewport: {top, bottom} in the same coordinates as el.cy, budget (default 250) }
// Rules, in order:
//   1. only elements with a ref (actionable page content) plus headings/text the caller asked for;
//   2. normalize role / name / states / region / view;
//   3. drop nameless images and nameless text; merge exact duplicates (same role+name+href+region), keeping the
//      one in view, and count them (`dup`);
//   4. order: open dialog first (it covers the page), then document order;
//   5. budget: everything in view and in a dialog is kept; the rest is kept in order until the budget, and the
//      remainder is only counted (omitted.below/above), so the shape stays bounded on a 3,000-node page.
export function observe(snapshot, ctx = {}) {
  const budget = ctx.budget ?? 250;
  const page = snapshot.page || {};
  const { host, path } = hostPath(page.url || "");
  const raw = (snapshot.elements || []).filter((el) => el.ref || el.dialog_root);
  const seen = new Map();
  const out = [];
  for (const el of raw) {
    const role = ROLE_MAP[el.role];
    if (!role) continue;
    const name = normName(el.name);
    if (!name && (role === "image" || role === "text" || role === "heading")) continue;
    const e = { ref: el.ref, role, name, states: normStates(el, role), region: regionOf(el), view: viewOf(el, ctx.viewport) };
    if (el.text_value != null && role !== "password") e.value = normName(el.text_value);
    else if (el.value != null && typeof el.value !== "object") e.value = String(el.value);
    const href = shortHref(el.href, host);
    if (href) e.href = href;
    // a control with no name carries a cue from the page (its label text, or the heading it sits under): shown as a
    // separate marker after the name, never inside the quotes. LINE FORMAT 2 (2026-11-27).
    if (!name && el.hint?.text) e.hint = { how: el.hint.how === "label" ? "label" : "under", text: normName(el.hint.text).slice(0, 60) };
    if (el.off_site) e.off_site = true;
    const key = `${role}\u0000${name}\u0000${href || ""}\u0000${e.region}\u0000${e.value ?? ""}`;
    const prev = name ? seen.get(key) : undefined;
    if (prev) {
      prev.dup = (prev.dup || 1) + 1;
      if (prev.view !== "in" && e.view === "in") Object.assign(prev, { ref: e.ref, view: "in", states: e.states });
      continue;
    }
    if (name) seen.set(key, e);
    out.push(e);
  }
  const dialogs = out.filter((e) => e.role === "dialog").length || (snapshot.elements || []).filter((el) => el.dialog_root).length;
  const ordered = [...out.filter((e) => e.region === "browser"), ...out.filter((e) => e.region === "dialog"),
    ...out.filter((e) => e.region !== "dialog" && e.region !== "browser")];
  const keep = [];
  const omitted = { below: 0, above: 0, budget: 0 };
  const always = (e) => e.region === "dialog" || e.region === "browser" || e.view === "in";
  let room = budget - ordered.filter(always).length;
  for (const e of ordered) {
    if (always(e)) { keep.push(e); continue; }
    if (room > 0) { keep.push(e); room--; continue; }
    omitted[e.view === "above" ? "above" : "below"]++;
    omitted.budget++;
  }
  return {
    v: OBS_VERSION,
    // the window title carries the browser's name (" - Chromium"): page noise on every read
    page: { url: page.url || "", host, path, title: normName(String(page.title || "").replace(/\s+[-–]\s+(Chromium|Google Chrome|Chrome)$/i, "")), loading: !!page.busy, dialogs },
    elements: keep,
    omitted,
  };
}

// ---- render (compact text for a large model; also the human-readable form of the training data) ----------------
// PAGE bandcamp.com /discover/classical/vinyl | "Vinyl on Bandcamp" | ready | 1 dialog
// [dialog]
// e127 button "Artist locations: from anywhere" (expanded)
// [main]
// e59 radio "vinyl" (checked)
// e60 link "Live at Olympia" -> /album/live-at-olympia
// ... 212 more below
const q = (s) => JSON.stringify(s);
export function renderElement(e) {
  let line = `${e.ref} ${e.role} ${q(e.name)}`;
  if (e.hint) line += ` (${e.hint.how} ${q(e.hint.text)})`;
  if (e.value !== undefined && e.value !== "") line += ` = ${q(e.value)}`;
  if (e.states.length) line += ` (${e.states.join(",")})`;
  if (e.href) line += ` -> ${e.href}${e.off_site ? " [off-site]" : ""}`;
  if (e.view !== "in") line += ` [${e.view}]`;
  if (e.dup) line += ` x${e.dup}`;
  return line;
}
export function renderObservation(obs) {
  const p = obs.page;
  const head = `PAGE ${p.host} ${p.path} | ${q(p.title)} | ${p.loading ? "loading" : "ready"}${p.dialogs ? ` | ${p.dialogs} dialog${p.dialogs > 1 ? "s" : ""}` : ""}`;
  const lines = [head];
  let region = null;
  for (const e of obs.elements) {
    if (e.region !== region) { lines.push(`[${e.region}]`); region = e.region; }
    lines.push(renderElement(e));
  }
  if (!obs.elements.length) lines.push("(no elements)");
  const o = obs.omitted || {};
  if (o.above) lines.push(`... ${o.above} more above`);
  if (o.below) lines.push(`... ${o.below} more below`);
  return lines.join("\n");
}

// ---- outcomes: any core tool's result text -> a closed enum + what changed -------------------------------------
// The core's action tools already VERIFY against the page; this turns their sentences into fields. Ordered: the
// first matching rule wins. Built and tested against real result strings from the benchmark runs.
export const OUTCOMES = ["ok", "no_change", "unverified", "refused", "failed", "blocked"];
const OUTCOME_RULES = [
  ["blocked", /\b(captcha|human check|press and hold|access denied|you have been blocked)\b/i],
  ["refused", /(^\s*|\.\s+)Refused\b/],
  ["failed", /^\s*(MCP error|Error\b|No element found|No option found|ref "[^"]+" (not found|is stale|has no)|FAILED:)|\bis outside the visible window\b/i],
  ["unverified", /\b(FAILED-UNVERIFIED|UNVERIFIED|NOT VERIFIED)\b|^\s*(left|right|middle) click x\d+ at\b/],
  ["no_change", /(^\s*Not scrolled\b|\b(No transition observed|nothing changed|did not change|STILL present|still selected)\b)/i],
  ["ok", /\b(Verified|verified by|Transition observed|Already in view|Scrolled|Typed|Selected|Clicked|Activated|Pressed|Navigated|Hovering|Dismissed|rebuilt|opened https?:)/i],
];
export function actionOutcome(tool, result, args = {}) {
  const text = typeof result === "string" ? result
    : (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
  const isError = typeof result === "object" && !!result?.isError;
  let outcome = null;
  for (const [name, re] of OUTCOME_RULES) if (re.test(text)) { outcome = name; break; }
  const matched = !!outcome;
  if (!outcome) outcome = isError ? "failed" : "ok";
  if (outcome === "ok" && isError) outcome = "failed";
  const changed = {};
  const url = text.match(/\b(?:opened|Navigated (?:directly )?to|url changed(?: to)?)\s+(https?:\/\/[^\s\]\)"']+)/i);
  if (url) changed.url = url[1].replace(/[.,;]+$/, "");
  else if (/\burl changed\b/i.test(text)) changed.url = true;
  const dlg = text.match(/dialogs (\d+)\s*->\s*(\d+)/);
  if (dlg) changed.dialogs = Number(dlg[2]) - Number(dlg[1]);
  for (const k of ["checked", "expanded", "selected", "pressed"]) {
    const m = text.match(new RegExp(`\\b${k} (true|false)\\s*->\\s*(true|false)`));
    if (m) changed[k === "pressed" ? "checked" : k] = m[2] === "true";
  }
  const focus = text.match(/focus -> ([a-z ]+)\|/i);
  if (focus) changed.focus = ROLE_MAP[focus[1].trim()] || focus[1].trim();
  const target = args.ref || (args.text ? String(args.text).slice(0, 60) : undefined);
  return { tool, ...(target ? { target } : {}), outcome, changed, detail: normName(text).slice(0, 160), ...(matched ? {} : { fallback: true }) };
}
export function renderOutcome(o) {
  const ch = Object.entries(o.changed).map(([k, v]) => `${k}=${v === true ? "yes" : v}`).join(" ");
  return `LAST ${o.tool}${o.target ? ` ${o.target}` : ""} -> ${o.outcome}${ch ? ` (${ch})` : ""}`;
}
