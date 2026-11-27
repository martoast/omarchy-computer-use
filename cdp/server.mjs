// The core's MCP server on the CDP backend (COMPUTER_USE_BACKEND=cdp; the default on macOS): the same web tools, the
// same names and arguments, the same normalized observation and outcome sentences as the Linux AT-SPI backend, so an
// agent, the benchmark harness and the local executor work unchanged on both.
//
//   COMPUTER_USE_CDP_URL=http://127.0.0.1:<port>   drive that browser (an instance from cdp/instance.mjs)
//   (unset)                                         start a private browser of our own (COMPUTER_USE_CDP_HEADLESS=0: with a window)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Browser as CdpBrowser } from "./browser.mjs";
import { spawnCdpInstance, teardownCdpInstance, cdpInstanceEnv } from "./instance.mjs";
import { observe, renderObservation, actionOutcome, renderOutcome } from "../observation.mjs";

const log = (...a) => process.stderr.write(`[cdp] ${a.join(" ")}\n`);
let own = null, browser;
const bye = (td) => () => { Promise.resolve(td()).finally(() => process.exit(0)); };
if (process.env.COMPUTER_USE_BACKEND === "ax") {
  // macOS: a real Google Chrome read and driven through the accessibility API (no DevTools port; mac/)
  const { Browser: AxBrowser } = await import("../mac/browser.mjs");
  const mi = await import("../mac/instance.mjs");
  let pid = process.env.COMPUTER_USE_AX_PID;
  if (!pid) {
    own = await mi.spawnMacInstance({});
    Object.assign(process.env, mi.macInstanceEnv(own));
    pid = own.pid;
    const b = bye(() => mi.teardownMacInstance(own)); process.on("SIGTERM", b); process.on("SIGINT", b); process.stdin.on("end", b);
  }
  const home = os.homedir();
  const python = process.env.COMPUTER_USE_AX_PYTHON || [path.join(home, "computer-use-mac/.venv/bin/python"), path.join(home, ".local/share/omarchy-computer-use/.venv/bin/python")].find((p) => fs.existsSync(p)) || "python3";
  browser = await new AxBrowser({ pid, python, log }).connect();
  log(`connected to Google Chrome pid ${pid} through accessibility`);
} else {
  let httpUrl = process.env.COMPUTER_USE_CDP_URL;
  if (!httpUrl) {
    own = await spawnCdpInstance({ headless: process.env.COMPUTER_USE_CDP_HEADLESS !== "0" });
    Object.assign(process.env, cdpInstanceEnv(own));
    httpUrl = own.httpUrl;
    const b = bye(() => teardownCdpInstance(own)); process.on("SIGTERM", b); process.on("SIGINT", b); process.stdin.on("end", b);
  }
  browser = await new CdpBrowser({ httpUrl, log }).connect();
  log(`connected to ${browser.cdp.version?.Browser || "browser"} at ${httpUrl}`);
}

// The client going away (its stdin closing) ends this process, whatever else holds the event loop open: the ax
// backend's python helper is a child with open pipes, and on 2026-11-25 every benchmark task left its cores (and their
// helpers) running: 1,002 helpers and a load average of 800 on the Mac mini. Our own instance is torn down first.
let leaving = false;
const leave = () => { if (leaving) return; leaving = true; try { browser?.close?.(); } catch {} const t = own && process.env.COMPUTER_USE_BACKEND === "ax" ? import("../mac/instance.mjs").then((m) => m.teardownMacInstance(own)) : own ? teardownCdpInstance(own) : null; Promise.resolve(t).catch(() => {}).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.stdin.on("end", leave); process.stdin.on("close", leave);

const server = new McpServer({ name: "computer-use", version: "0.2.0" });
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const compact = () => process.env.COMPUTER_USE_READ_FORMAT === "compact";
const structured = () => process.env.COMPUTER_USE_OBSERVATION === "1";

// every action result: the outcome line first (compact) and the outcome object (structured), as index.js does
function withOutcome(name, args, r) {
  const res = text(r.text, !!r.isError);
  if (!compact() && !structured()) return res;
  const o = actionOutcome(name, res, args || {});
  if (compact()) res.content[0].text = `${renderOutcome(o)}\n${res.content[0].text}`;
  if (structured()) res.structuredContent = { outcome: o };
  return res;
}
// one browser, one action at a time (an agent may send calls in parallel)
let queue = Promise.resolve();
const serial = (fn) => (args) => { const p = queue.then(() => fn(args || {})); queue = p.catch(() => {}); return p; };
const tool = (name, def, fn, { outcome = false } = {}) => server.registerTool(name, def, serial(async (args) => {
  try {
    const r = await fn(args);
    if (r && r.content) return r;
    return outcome ? withOutcome(name, args, r) : text(r.text, !!r.isError);
  } catch (e) {
    const r = { text: `Error: ${e.message}`, isError: true };
    return outcome ? withOutcome(name, args, r) : text(r.text, true);
  }
}));
const W = { window_address: z.string().optional() };

tool("read_page", {
  title: "Read the page structure (fast, cheap)",
  description: "The default way to see what's on the page. Reads the browser's accessibility tree (the same tree screen readers use) and returns every interactive element (buttons, links, fields, checkboxes, dropdowns, dialogs) with a short ref like 'e3', its region and whether it is in view. Follow up with click_element/type_into_element using the ref. The address bar is the row 'Address and search bar' in [browser]: type a URL into it with press_enter to open a page. Only fall back to screenshot for something visual with no accessible representation.",
  inputSchema: z.object({ ...W, filter_text: z.string().optional().describe("Only elements whose name contains this (case-insensitive)."), filter_role: z.string().optional().describe("Only elements of this role (several with |), e.g. 'push button', 'link', 'entry', 'combo box', 'heading', 'dialog'."),
    include_text: z.boolean().default(false).describe("Also include text/paragraphs for reading page content."), limit: z.number().int().min(10).max(2000).optional(), format: z.enum(["text", "compact"]).optional() }).strict(),
}, async ({ filter_text, filter_role, include_text, limit }) => {
  // Three read fixes, each behind its own switch and off by default until a round supports them (Henry2's research on
  // b7: 3.4 of Sonnet's 9.7 round trips returned nothing it could use):
  //   COMPUTER_USE_READ_NEIGHBOURS=1  a filter_text hit comes with the 2 elements before and after it in page order
  //                                   (texts included), so a label comes with its value ("Downloads all time" + the number)
  //   COMPUTER_USE_READ_ROLE_FALLBACK=1  filter_role + filter_text with no hit: answer with the text-alone hits and say
  //                                   the role was dropped (the text was on the page in 8-9 of 22 zero-hit reads)
  //   COMPUTER_USE_READ_DIALOG_LINE=1 any filtered read lists an open dialog or consent banner, whatever the filter
  const NEIGH = process.env.COMPUTER_USE_READ_NEIGHBOURS === "1", FALLBACK = process.env.COMPUTER_USE_READ_ROLE_FALLBACK === "1", DIALOG = process.env.COMPUTER_USE_READ_DIALOG_LINE === "1";
  const snap = await browser.snapshot({ includeText: !!include_text || (NEIGH && !!filter_text) });
  const all = snap.elements, notes = [];
  const byText = (list) => { const f = filter_text.toLowerCase(); return list.filter((e) => String(e.name).toLowerCase().includes(f) || e.dialog_root); };
  const rs = filter_role ? filter_role.toLowerCase().split("|").map((x) => x.trim()) : null;
  const byRole = (list) => list.filter((e) => rs.includes(e.role) || (rs.includes("button") && e.role === "push button") || (rs.includes("textbox") && e.role === "entry"));
  let els = all;
  if (filter_text) els = byText(els);
  if (filter_role) els = byRole(els);
  if (FALLBACK && filter_text && filter_role && !els.some((e) => !e.dialog_root)) {
    const t = byText(all).filter((e) => !e.dialog_root);
    if (t.length) { els = byText(all); notes.push(`No ${filter_role} contains "${filter_text}". The role filter was dropped: these ${t.length} element(s) of other roles contain it.`); }
  }
  let gaps = null;
  if (NEIGH && filter_text && els.some((e) => !e.dialog_root)) {
    // dialog roots pass every text filter (so an open dialog is seen); they are not hits and get no neighbours
    const idx = new Map(all.map((e, i) => [e, i])), keep = new Set(), hitEls = els.filter((e) => !e.dialog_root);
    for (const e of hitEls) { const i = idx.get(e); for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < all.length) keep.add(k); }
    const order = [...keep].sort((a, b) => a - b);
    els = [...els.filter((e) => e.dialog_root), ...order.map((i) => all[i]).filter((e) => !e.dialog_root)];
    // where elements were skipped between two shown groups: said in the note, so far-apart lines are not read as
    // neighbours and "first" is not judged from this subset (the render itself has no gap lines)
    const groups = []; for (const i of order) { const g = groups.at(-1); if (g && i === g[1] + 1) g[1] = i; else groups.push([i, i]); }
    gaps = groups.map(([a, b], k) => `${k === 0 ? (a > 0 ? `(${a} elements before) ` : "") : `(${a - groups[k - 1][1] - 1} elements skipped) `}${JSON.stringify(String(all[a].name || all[a].role).slice(0, 40))}${b > a ? ` … ${JSON.stringify(String(all[b].name || all[b].role).slice(0, 40))}` : ""}`).join(" ");
    notes.push(`${hitEls.length} element(s) contain "${filter_text}"; each is shown with the 2 elements before and after it in page order. This is a SUBSET of the page, in ${groups.length} group(s): ${gaps}${order.at(-1) < all.length - 1 ? ` (${all.length - 1 - order.at(-1)} elements after)` : ""}. Do not judge what is first or last on the page from it.`);
  }
  if (DIALOG && (filter_text || filter_role)) {
    const dl = all.filter((e) => e.dialog_root && !els.includes(e));
    if (dl.length) { els = [...dl, ...els]; notes.push(`A dialog is open on the page (${dl.map((e) => JSON.stringify(String(e.name).slice(0, 60))).join(", ")}): it may cover what you are looking for.`); }
  }
  const obs = observe({ page: snap.page, elements: els }, { viewport: snap.viewport, budget: limit ?? (include_text ? 600 : 250) });
  return { content: [{ type: "text", text: (notes.length ? notes.join("\n") + "\n" : "") + renderObservation(obs) }], ...(structured() ? { structuredContent: { observation: obs } } : {}) };
});

const target = { ref: z.string().optional().describe("A ref like 'e3' from read_page."), text: z.string().optional().describe("Accessible name to search for (case-insensitive substring), if not using ref."), role: z.string().optional() };
tool("click_element", {
  title: "Click an element by ref or by name",
  description: "Click an interactive element with a real mouse click at its position (scrolled into view first), by ref from read_page or by matching its name. Reports what the click changed on the page (URL, dialogs, checked/expanded state) or that nothing changed.",
  inputSchema: z.object({ ...target, ...W, button: z.enum(["left", "right", "middle"]).default("left"), clicks: z.number().int().min(1).max(3).default(1), observe: z.boolean().optional() }).passthrough(),
}, (a) => browser.click({ ref: a.ref, text: a.text, role: a.role }, { button: a.button, clicks: a.clicks, observe: a.observe !== false }), { outcome: true });

tool("press_element", {
  title: "Press an option opener by ref (fast)",
  description: "Press ONE option opener (a size/colour dropdown, a tab) so its values can be read next. Refuses links (use click_element). Returns 'Pressed'; read_page shows what opened.",
  inputSchema: z.object({ ref: z.string(), ...W }).strict(),
}, (a) => browser.press({ ref: a.ref }), { outcome: true });

tool("type_into_element", {
  title: "Type into a field by ref or by name",
  description: "Focus a text field (by ref or by its name/label), optionally clear it, type the value and optionally press Return, in one call. Reads the field back. Typing a URL into the address bar ('Address and search bar') with press_enter opens it.",
  inputSchema: z.object({ ...target, ...W, value: z.string(), clear: z.boolean().default(true), press_enter: z.boolean().default(false) }).strict(),
}, (a) => browser.typeInto({ ref: a.ref, text: a.text, role: a.role }, a.value, { clear: a.clear !== false, pressEnter: !!a.press_enter }), { outcome: true });

tool("select_option", {
  title: "Select a dropdown option reliably",
  description: "Select an option in a dropdown (a native <select> or a custom one) by its visible text, then read the dropdown back: [verified: …] when it reads the option, FAILED or UNVERIFIED otherwise.",
  inputSchema: z.object({ combo_ref: z.string().optional(), combo_text: z.string().optional(), combo_role: z.string().default("combo box"), option_text: z.string(), ...W }).strict(),
}, (a) => browser.selectOption({ ref: a.combo_ref, text: a.combo_text, role: a.combo_role }, a.option_text), { outcome: true });

tool("read_selected_option", {
  title: "Read a dropdown's current value",
  description: "Return the option a dropdown currently has selected, or the value it displays. Never opens or changes it.",
  inputSchema: z.object({ combo_ref: z.string().optional(), combo_text: z.string().optional(), combo_role: z.string().default("combo box"), ...W }).strict(),
}, (a) => browser.readSelected({ ref: a.combo_ref, text: a.combo_text }));

tool("key_press", {
  title: "Press a key or key combo",
  description: "Press a named key (Return, Tab, Escape, BackSpace, Left, Right, Up, Down, Page_Down, Page_Up, Home, End, Delete, space, a letter) optionally with modifiers (shift, ctrl, alt, logo). Scrolling keys report whether the page moved.",
  inputSchema: z.object({ key: z.string(), modifiers: z.array(z.enum(["shift", "ctrl", "alt", "logo", "altgr", "capslock"])).default([]) }).strict(),
}, (a) => browser.key(a.key, (a.modifiers || []).filter((m) => MODS.has(m))), { outcome: true });
const MODS = new Set(["shift", "ctrl", "alt", "logo"]);

tool("scroll", {
  title: "Scroll",
  description: "Scroll the mouse wheel at (x, y) in window coordinates (the coordinates of a screenshot).",
  inputSchema: z.object({ x: z.number().int(), y: z.number().int(), direction: z.enum(["up", "down"]).default("down"), amount: z.number().int().min(1).max(50).default(5), ...W }).strict(),
}, (a) => browser.wheel(a.x, a.y, a.direction, a.amount), { outcome: true });

tool("scroll_to_element", {
  title: "Scroll an element into view",
  description: "Scroll the page so an element (by ref, or found by text/role) is in view.",
  inputSchema: z.object({ ...target, ...W }).strict(),
}, (a) => browser.scrollTo({ ref: a.ref, text: a.text, role: a.role }), { outcome: true });

tool("hover_element", {
  title: "Hover over an element",
  description: "Move the mouse over an element (by ref or name), e.g. to open a mega menu; reports what changed.",
  inputSchema: z.object({ ...target, ...W }).strict(),
}, (a) => browser.hover({ ref: a.ref, text: a.text, role: a.role }), { outcome: true });

tool("dismiss_dialog", {
  title: "Close a dialog that is hiding the page (verified)",
  description: "Close ONE dialog covering the page. dialog_ref (the dialog itself): sends one Escape and verifies the dialog is gone. control_ref (a close/dismiss control inside it): clicks it. Refuses controls that make a choice (Accept, Reject, Preferences, Subscribe…): use click_element if that choice is intended.",
  inputSchema: z.object({ dialog_ref: z.string().optional(), dialog_text: z.string().optional(), control_ref: z.string().optional(), ...W }).strict(),
}, (a) => browser.dismiss(a), { outcome: true });

tool("escape_page", {
  title: "Press Escape once for the page",
  description: "Send ONE Escape to the page. Returns {sent}. Verify with a read afterwards.",
  inputSchema: z.object({ ...W, move_from_field: z.boolean().default(false) }).strict(),
}, async () => { await browser.key("Escape"); return { text: JSON.stringify({ sent: true }) }; }, { outcome: true });

tool("click", {
  title: "Click the mouse (window coordinates)",
  description: "Click at (x, y) in window coordinates (the coordinates of a screenshot). Prefer click_element for anything with a name.",
  inputSchema: z.object({ x: z.number().int(), y: z.number().int(), coordinate_space: z.enum(["screen", "screenshot_crop"]).default("screen"), screenshot_id: z.string().optional(), button: z.enum(["left", "right", "middle"]).default("left"), clicks: z.number().int().min(1).max(3).default(1), ...W }).strict(),
}, async (a) => { await browser.clickAt(a.x, a.y, { button: a.button, clicks: a.clicks }); return { text: `${a.button} click x${a.clicks} at (${a.x}, ${a.y})` }; }, { outcome: true });

tool("type_text", {
  title: "Type text",
  description: "Type literal text into whatever has focus.",
  inputSchema: z.object({ text: z.string() }).strict(),
}, (a) => browser.typeText(a.text), { outcome: true });

tool("open_url", {
  title: "Open a URL in the browser tab (fast address-bar navigation)",
  description: "Open an http(s) URL in the current tab, verified by the page's own URL, then wait for a usable page.",
  inputSchema: z.object({ url: z.string(), max_ms: z.number().int().min(1000).max(60000).optional(), ...W }).strict(),
}, async (a) => {
  if (!/^https?:\/\//i.test(a.url)) return { text: "open_url needs an http(s) URL", isError: true };
  const t0 = Date.now();
  const r = await browser.navigate(a.url);
  return r.isError ? r : { text: `${r.text} (${Date.now() - t0} ms)` };
});

tool("get_page_url", {
  title: "Get the page URL",
  description: "Return {url} of the page now open.",
  inputSchema: z.object({}).strict(),
}, async () => { await browser.followTabs(); const i = await browser.pageInfo(); return { text: JSON.stringify({ url: i.url || null }) }; });

tool("wait_page_settled", {
  title: "Wait until the page has finished loading",
  description: "Wait until the page is loaded, its network is quiet and its content has stopped changing for quiet_ms (reason 'quiet'), or it has been ready for 2.5 s while something keeps changing (reason 'usable_changing'). Returns {settled, reason, ms, ready_ms, events}.",
  inputSchema: z.object({ ...W, quiet_ms: z.number().int().min(100).max(5000).default(800), max_ms: z.number().int().min(500).max(60000).default(15000), url_contains: z.string().optional(), title_contains: z.string().optional(), not_doc: z.string().optional() }).strict(),
}, async (a) => ({ text: JSON.stringify(await browser.waitSettled({ quietMs: a.quiet_ms ?? 400, maxMs: a.max_ms ?? 15000, urlContains: a.url_contains })) }));

tool("wait_for_element", {
  title: "Wait for an element to appear",
  description: "Poll the page until an element matching text (and role) appears, or the timeout (max 5 s) elapses.",
  inputSchema: z.object({ text: z.string().optional(), role: z.string().optional(), ...W, timeout_ms: z.number().int().min(100).max(5000).default(3000), poll_ms: z.number().int().min(100).max(5000).default(400) }).strict(),
}, async (a) => {
  const t0 = Date.now(), want = String(a.text || "").toLowerCase();
  while (Date.now() - t0 < (a.timeout_ms ?? 3000)) {
    const snap = await browser.snapshot({ includeText: true });
    const e = snap.elements.find((x) => (!want || String(x.name).toLowerCase().includes(want)) && (!a.role || x.role === a.role || (a.role === "button" && x.role === "push button")));
    if (e) return { text: `Found ${e.ref} ${e.role} ${JSON.stringify(e.name)} after ${Date.now() - t0} ms` };
    await new Promise((r) => setTimeout(r, a.poll_ms ?? 400));
  }
  return { text: `Not found within ${a.timeout_ms ?? 3000} ms: ${JSON.stringify(a.text || "")}${a.role ? ` (role ${a.role})` : ""}` };
});

tool("read_after_navigation", {
  title: "Wait for a destination and read it",
  description: "After a navigation, poll until the page URL matches expected_url (and expected_heading, if given, is on the page), then return read_page's answer.",
  inputSchema: z.object({ expected_url: z.string(), expected_heading: z.string().optional(), accept_product_link: z.boolean().default(false), search_query: z.string().optional(), ...W }).passthrough(),
}, async (a) => {
  const want = (() => { try { const u = new URL(a.expected_url); return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""); } catch { return a.expected_url; } })();
  const t0 = Date.now();
  let snap;
  while (Date.now() - t0 < 12000) {
    await browser.waitSettled({ quietMs: 400, maxMs: 4000 });
    snap = await browser.snapshot({ includeText: true });
    const got = (() => { try { const u = new URL(snap.page.url); return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""); } catch { return snap.page.url; } })();
    const headOk = !a.expected_heading || snap.elements.some((e) => e.role === "heading" && e.name.toLowerCase().includes(a.expected_heading.toLowerCase()));
    if (got.startsWith(want) && headOk) break;
    if (snap.elements.some((e) => e.dialog_root)) break;
  }
  const obs = observe(snap, { viewport: snap.viewport });
  return { content: [{ type: "text", text: renderObservation(obs) }], ...(structured() ? { structuredContent: { observation: obs } } : {}) };
});

tool("page_text", {
  title: "Read the page's text (read-only)",
  description: "The visible text of the page now open, IN the reply. By default max_chars characters (2,000) starting at the first heading of the page (the main content, past the navigation). With `query`, only the lines that contain it (case-insensitive) with 2 lines before and after each, in page order: the cheap way to find a value on a long page. Use from_end for the end of the page.",
  // inline:false is for programs (the benchmark's reader and final capture): it writes the whole text to a file and
  // returns {path, chars}. A planner has no file tool, so a path was a dead reply (56 of them in 70 Sonnet runs, b7).
  inputSchema: z.object({ ...W, max_chars: z.number().int().min(200).max(8000000).optional(), from_end: z.boolean().default(false), from_start: z.boolean().default(false), query: z.string().optional(), inline: z.boolean().default(true) }).strict(),
}, async (a) => {
  let t = await browser.pageText(8000000);
  if (a.inline === false) {
    const cap = a.max_chars ?? 4000000;
    t = a.from_end ? t.slice(-cap) : t.slice(0, cap);
    const f = path.join(os.tmpdir(), `cu-page-text-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(f, t);
    return { text: JSON.stringify({ path: f, chars: t.length }) };
  }
  const total = t.length, cap = a.max_chars ?? 2000;
  if (a.query) {
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean), q = a.query.toLowerCase(), keep = new Set();
    lines.forEach((l, i) => { if (l.toLowerCase().includes(q)) for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < lines.length) keep.add(k); });
    const idx = [...keep].sort((x, y) => x - y), hits = lines.filter((l) => l.toLowerCase().includes(q)).length;
    if (!hits) return { text: `No line of the page's text contains "${a.query}" (${lines.length} lines, ${total} chars). Try another word, or page_text without query for the start of the page.` };
    const out = []; let prev = -1;
    for (const i of idx) { if (i > prev + 1) out.push(`(${i - prev - 1} lines not shown)`); out.push(lines[i]); prev = i; }
    if (prev < lines.length - 1) out.push(`(${lines.length - 1 - prev} lines not shown)`);
    const body = out.join("\n");
    return { text: `Page text, the ${hits} line(s) containing "${a.query}" with their neighbours (page order):\n${body.length > cap ? body.slice(0, cap) + `\n(cut at ${cap} chars: narrow the query)` : body}` };
  }
  if (a.from_end) { const part = t.slice(-cap); return { text: `Page text (last ${part.length} of ${total} chars):\n${part}` }; }
  // main content first: a page's text opens with its navigation ("Skip to content / STORE / TICKETS ..."), which is not
  // what a reader wants. Start at the page's first heading outside the banner and navigation, unless from_start is set.
  let start = 0, head = null;
  if (!a.from_start) {
    const snap = await browser.snapshot({ includeText: false }).catch(() => null);
    const hs = (snap?.elements || []).filter((e) => e.role === "heading" && String(e.name || "").trim().length > 2);
    const h = hs.find((e) => !["banner", "navigation", "contentinfo", "complementary"].includes(e.region)) || hs[0];
    if (h) { const i = t.indexOf(String(h.name).trim()); if (i > 0) { start = i; head = String(h.name).trim().slice(0, 80); } }
  }
  const part = t.slice(start, start + cap);
  return { text: `Page text (${part.length} of ${total} chars, ${start ? `from the first heading "${head}" at char ${start}; from_start:true for the top of the page` : "from the top"}${total > start + part.length ? "; use query to find a value, or a larger max_chars" : ""}):\n${part}` };
});

tool("list_images", {
  title: "List the page's images (read-only)",
  description: "Read-only inventory of the page's images: alt text, rendered size, page position and source URL.",
  inputSchema: z.object({ ...W, max_nodes: z.number().int().min(1).max(1000).optional(), min_size: z.number().int().min(0).max(2000).optional() }).strict(),
}, async (a) => ({ text: JSON.stringify(await browser.images(a.max_nodes ?? 64, a.min_size ?? 0)) }));

tool("screenshot", {
  title: "Take a screenshot",
  description: "Capture the browser window (or a region of it, in window coordinates) as a PNG. EXPENSIVE: costs image tokens. Pixel coordinates in the image are window coordinates for click/scroll (add the region's offset when a region was given).",
  inputSchema: z.object({ region: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(), ...W }).strict(),
}, async (a) => {
  const s = await browser.screenshot(a.region);
  return { content: [{ type: "image", data: s.data, mimeType: "image/png" }, { type: "text", text: `Screenshot ${s.width}x${s.height}, window coordinates${a.region ? `; add the offset (${s.offset.x}, ${s.offset.y}) to pixel positions` : ""}.` }] };
});

await server.connect(new StdioServerTransport());
