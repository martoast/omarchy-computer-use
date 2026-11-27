// The browser through the Chrome DevTools Protocol: the page's accessibility tree (the same tree Chromium gives AT-SPI
// on Linux and the macOS accessibility API on a Mac), real input events, and verification read back from the page.
// Works the same on Linux and macOS, needs no OS accessibility permission, and drives ONE browser instance without
// it having keyboard focus (so it can run beside a person's own windows).
//
// The snapshot it builds has the bridge's shape (AT-SPI role names, ref, name, states, region, cy, href…), so
// observation.mjs turns it into the same normalized observation as on Linux; action results use the same sentences
// ("Clicked …", "Transition observed …", "Not scrolled", "FAILED: …") so actionOutcome() reads them the same way.
import { CDP, PageSession } from "./cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chromium accessibility roles -> the AT-SPI names observation.mjs maps (ROLE_MAP)
const ROLE = {
  button: "push button", link: "link", textbox: "entry", searchbox: "entry", textField: "entry", combobox: "combo box",
  ComboBoxGrouping: "combo box", ComboBoxMenuButton: "combo box", PopUpButton: "combo box", checkbox: "check box",
  menuitemcheckbox: "check box", radio: "radio button", menuitemradio: "radio button", switch: "toggle button",
  menuitem: "menu item", option: "menu item", MenuListOption: "menu item", tab: "page tab", slider: "slider",
  spinbutton: "spin button", heading: "heading", image: "image", img: "image", dialog: "dialog", alertdialog: "dialog",
  paragraph: "paragraph", StaticText: "static", listitem: "list item",
};
const ACTIONABLE = new Set(["push button", "toggle button", "link", "entry", "password text", "combo box", "check box", "radio button", "menu item", "page tab", "slider", "spin button"]);
const LANDMARK = { banner: "banner", navigation: "navigation", search: "search", main: "main", contentinfo: "contentinfo", complementary: "complementary", form: "form", region: "region" };
const OMNIBOX_NAME = "Address and search bar";

// substantive choices dismiss_dialog never makes on a person's behalf (same rule as the Linux bridge)
const SUBSTANTIVE = /\b(accept|reject|agree|allow|consent|subscribe|sign ?up|register|preferences|settings|manage|customi[sz]e|continue|buy|add to)\b/i;

const KEYS = {
  Return: ["Enter", "Enter", 13, "\r"], Enter: ["Enter", "Enter", 13, "\r"], KP_Enter: ["Enter", "NumpadEnter", 13, "\r"],
  Tab: ["Tab", "Tab", 9], Escape: ["Escape", "Escape", 27], BackSpace: ["Backspace", "Backspace", 8], Backspace: ["Backspace", "Backspace", 8],
  Delete: ["Delete", "Delete", 46], Left: ["ArrowLeft", "ArrowLeft", 37], Up: ["ArrowUp", "ArrowUp", 38], Right: ["ArrowRight", "ArrowRight", 39],
  Down: ["ArrowDown", "ArrowDown", 40], Page_Down: ["PageDown", "PageDown", 34], Next: ["PageDown", "PageDown", 34], PageDown: ["PageDown", "PageDown", 34],
  Page_Up: ["PageUp", "PageUp", 33], Prior: ["PageUp", "PageUp", 33], PageUp: ["PageUp", "PageUp", 33], Home: ["Home", "Home", 36], End: ["End", "End", 35],
  space: [" ", "Space", 32, " "], minus: ["-", "Minus", 189, "-"], plus: ["+", "Equal", 187, "+"], period: [".", "Period", 190, "."], comma: [",", "Comma", 188, ","],
};
const SCROLL_KEYS = new Set(["PageDown", "PageUp", "Home", "End", " ", "ArrowDown", "ArrowUp"]);
const MOD = { alt: 1, ctrl: 2, logo: 4, meta: 4, shift: 8 };

function keyDef(name) {
  if (KEYS[name]) return KEYS[name];
  if (/^F\d{1,2}$/.test(name)) return [name, name, 111 + Number(name.slice(1))];
  if (name.length === 1) {
    const up = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? `Key${up}` : /\d/.test(name) ? `Digit${name}` : "";
    return [name, code, up.charCodeAt(0), name];
  }
  return null;
}

// In-page helpers, run with Runtime.callFunctionOn on resolved nodes (no globals left on the page).
const FN_FACTS = `function(...els) {
  const vh = innerHeight, vw = innerWidth;
  return els.map((el) => {
    try {
      if (!el || !el.isConnected) return null;
      const e = el.nodeType === 1 ? el : el.parentElement;
      if (!e) return null;
      let r = e.getBoundingClientRect(), x = r.left, y = r.top;
      // inside a same-origin frame: add the frame's offset
      try { let w = e.ownerDocument.defaultView; while (w && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; } } catch {}
      const vis = (e.checkVisibility ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true) && r.width >= 1 && r.height >= 1;
      const a = e.closest ? e.closest("a[href]") : null;
      const tag = e.tagName.toLowerCase();
      return { x, y, w: r.width, h: r.height, vis, href: a ? a.href : null, tag, type: e.type || null,
               pw: tag === "input" && (e.type === "password"), sel: tag === "select" };
    } catch (err) { return null; }
  });
}`;

// the cue of a nameless control, by geometry (same rule as mac/axhelper.py pick_cue): a text box inside, above or left
// of the control's box and close; else the heading above it; else nothing
export function pickCue(b, cands, heading) {
  let best = null;
  for (const c of cands) { const k = c.box;
    const ovx = Math.min(b.x + b.w, k.x + k.w) - Math.max(b.x, k.x), ovy = Math.min(b.y + b.h, k.y + k.h) - Math.max(b.y, k.y);
    let d;
    if (ovx > 0 && ovy > 0 && k.w <= b.w + 4 && k.h <= b.h + 4) d = 0;
    else if (ovx > 0 && k.y + k.h <= b.y + 4 && b.y - (k.y + k.h) <= 40) d = 1 + (b.y - (k.y + k.h));
    else if (ovy > 0 && k.x + k.w <= b.x + 4 && b.x - (k.x + k.w) <= 200) d = 50 + (b.x - (k.x + k.w));
    else continue;
    if (!best || d < best.d) best = { d, text: c.text }; }
  if (best) return { how: "near", text: best.text };
  if (heading && heading.y <= b.y) return { how: "under", text: heading.text };
  return null;
}

export class Browser {
  constructor({ httpUrl, log = () => {} }) {
    this.httpUrl = httpUrl; this.log = log;
    this.refs = new Map();      // ref -> { backendNodeId, sessionId }
    this.refOf = new Map();     // backendNodeId -> ref
    this.nextRef = 1;
    this.last = null;           // last snapshot
  }

  async connect() {
    this.cdp = await CDP.connect(this.httpUrl);
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    // a link that opens a new tab: follow it, like a person looking at the browser would
    this.cdp.on("Target.targetCreated", async ({ targetInfo }) => {
      if (targetInfo.type !== "page" || !this.page || targetInfo.openerId !== this.page.targetId) return;
      this.newTab = targetInfo.targetId;
    });
    this.cdp.on("Target.targetDestroyed", ({ targetId }) => { if (this.page && targetId === this.page.targetId) this.pageGone = true; });
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    let t = targetInfos.find((x) => x.type === "page" && !x.url.startsWith("devtools://"));
    if (!t) t = { targetId: (await this.cdp.send("Target.createTarget", { url: "about:blank" })).targetId };
    await this.attach(t.targetId);
    return this;
  }

  async attach(targetId) {
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    this.page = new PageSession(this.cdp, targetId, sessionId); this.settledSeq = -1;
    await this.page.init();
    await this.cdp.send("Target.activateTarget", { targetId }).catch(() => {});
    this.pageGone = false; this.newTab = null;
    this.refs.clear(); this.refOf.clear();
  }

  // switch to a tab opened by the last action (or away from a closed one)
  async followTabs() {
    if (this.newTab) { const id = this.newTab; await this.attach(id); return `opened a new tab`; }
    if (this.pageGone) {
      const { targetInfos } = await this.cdp.send("Target.getTargets");
      const t = targetInfos.find((x) => x.type === "page");
      if (t) { await this.attach(t.targetId); return "the tab closed; now on the remaining tab"; }
    }
    return null;
  }

  refFor(key, backendNodeId, sessionId) {
    let ref = this.refOf.get(key);
    if (!ref) { ref = `e${this.nextRef++}`; this.refOf.set(key, ref); }
    this.refs.set(ref, { backendNodeId, sessionId });
    return ref;
  }

  async pageInfo() {
    try {
      return await this.page.evaluate(`({ url: location.href, title: document.title, ready: document.readyState, vh: innerHeight, vw: innerWidth, sy: scrollY })`);
    } catch { return { url: "", title: "", ready: "loading", vh: 800, vw: 1280, sy: 0 }; }
  }

  // ---- the snapshot: bridge-shaped elements for observation.mjs --------------------------------------------------
  async snapshot({ includeText = false } = {}) {
    await this.followTabs();
    const info = await this.pageInfo();
    const { nodes } = await this.page.send("Accessibility.getFullAXTree", {}, { timeoutMs: 20000 });
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const parent = new Map();
    for (const n of nodes) for (const c of n.childIds || []) parent.set(c, n.nodeId);
    const prop = (n, k) => { const p = (n.properties || []).find((x) => x.name === k); return p ? p.value?.value : undefined; };
    // document order: walk the tree from its root (the flat list Chromium returns is not in reading order)
    const order = [];
    const root = nodes.find((n) => !parent.has(n.nodeId)) || nodes[0];
    const stack = root ? [root.nodeId] : [];
    const seenIds = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const n = byId.get(id);
      if (!n) continue;
      order.push(n);
      const kids = n.childIds || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    for (const n of nodes) if (!seenIds.has(n.nodeId)) order.push(n);
    const want = []; const cue = { heading: null, recent: [], await: [] };
    for (const n of order) {
      if (n.ignored || n.backendDOMNodeId == null) continue;
      const cr = n.role?.value;
      let role = ROLE[cr];
      if (!role) continue;
      if (role === "push button" && prop(n, "pressed") !== undefined) role = "toggle button";
      const isText = role === "paragraph" || role === "static" || role === "list item";
      // CUE for a nameless control (same rule as mac/axhelper.py): the nearest label-like text since the last control,
      // else the nearest heading above; kept apart from the name
      // CUE v2: by GEOMETRY, never tree order (see mac/axhelper.py pick_cue; Henry2's ruling after r1a). Here only the
      // candidates are collected: the last two texts before a nameless control and the first one after it; never text
      // inside a control, a heading, or an alert / status region.
      if (role === "static") { const t = String(n.name?.value ?? "").replace(/\s+/g, " ").trim();
        let p = parent.get(n.nodeId), inside = false;
        for (let d = 0; p && d < 8; d++) { const cr0 = byId.get(p)?.role?.value, pr = ROLE[cr0]; if ((pr && d < 4 && (ACTIONABLE.has(pr) || pr === "heading")) || ["alert", "status", "log", "marquee", "timer", "alertdialog"].includes(cr0)) { inside = true; break; } p = parent.get(p); }
        if (!inside && t.length > 1 && t.length <= 60 && n.backendDOMNodeId != null) { const rec = { text: t, id: n.backendDOMNodeId };
          cue.recent = [...cue.recent, rec].slice(-2); for (const w of cue.await) w.cueCands.push(rec); cue.await = []; } }
      if (isText && !includeText) continue;
      const name = String(n.name?.value ?? "").trim();
      if (role === "static") {
        // text inside a control or heading is that control's name already
        let p = parent.get(n.nodeId), skip = false;
        // (a paragraph covers its text only when it HAS a name: Chrome gives <p> an empty name, and its text was then lost
        // from every read: "1,234,567" and "Downloads all time" in <p> never appeared, even with include_text)
        for (let d = 0; p && d < 4; d++) { const pn = byId.get(p), pr = ROLE[pn?.role?.value]; if (pr && (ACTIONABLE.has(pr) || pr === "heading" || (pr === "paragraph" && String(pn?.name?.value ?? "").trim()))) { skip = true; break; } p = parent.get(p); }
        if (skip || !name) continue;
      }
      // landmark / dialog ancestry
      let region = null, inDialog = false;
      for (let p = parent.get(n.nodeId), d = 0; p && d < 60; p = parent.get(p), d++) {
        const a = byId.get(p); const ar = a?.role?.value;
        if (ar === "dialog" || ar === "alertdialog") inDialog = true;
        if (!region && LANDMARK[ar]) region = LANDMARK[ar];
      }
      const states = [];
      const ch = prop(n, "checked"); if (ch === "true" || ch === true || ch === "mixed") states.push("checked");
      if (prop(n, "pressed") === "true" || prop(n, "pressed") === true) states.push("pressed");
      if (prop(n, "selected") === true) states.push("selected");
      if (prop(n, "expanded") === true) states.push("expanded");
      if (prop(n, "disabled") === true) states.push("disabled");
      if (prop(n, "focused") === true) states.push("focused");
      const w0 = { n, role, name, region, inDialog, states, value: n.value?.value };
      // an "under" cue is never the page's FIRST heading (every control is under it) nor a heading with digits
      if (role === "heading" && name) { cue.nheads = (cue.nheads || 0) + 1; cue.heading = cue.nheads > 1 && !/\d/.test(name) ? w0 : null; }
      // an "under" cue only when the heading is CLOSE: at most 5 kept elements between it and the control, same region
      else if (ACTIONABLE.has(role) && !name) { w0.cueCands = [...cue.recent]; const hd = cue.heading; w0.cueHeading = hd && want.length - want.indexOf(hd) <= 6 && (hd.region || null) === (region || null) ? hd : null; cue.await.push(w0); }
      want.push(w0);
    }
    // facts from the DOM for every kept node, one call: box, visibility, href, input type
    const objs = await Promise.all(want.map((w) => this.page.send("DOM.resolveNode", { backendNodeId: w.n.backendDOMNodeId, objectGroup: "cu-snap" }).then((r) => r.object?.objectId).catch(() => null)));
    const facts = new Array(want.length).fill(null);
    const live = objs.map((o, i) => [o, i]).filter(([o]) => o);
    for (let k = 0; k < live.length; k += 400) {
      const chunk = live.slice(k, k + 400);
      try {
        const r = await this.page.send("Runtime.callFunctionOn", { objectId: chunk[0][0], functionDeclaration: FN_FACTS, arguments: chunk.map(([o]) => ({ objectId: o })), returnByValue: true }, { timeoutMs: 20000 });
        (r.result?.value || []).forEach((f, j) => { facts[chunk[j][1]] = f; });
      } catch (e) {
        // nodes from another frame's context cannot share one call: fall back to one call per node
        await Promise.all(chunk.map(async ([o, i]) => {
          try { const r = await this.page.send("Runtime.callFunctionOn", { objectId: o, functionDeclaration: FN_FACTS, arguments: [{ objectId: o }], returnByValue: true }); facts[i] = r.result?.value?.[0] || null; } catch {}
        }));
      }
    }
    this.page.send("Runtime.releaseObjectGroup", { objectGroup: "cu-snap" }).catch(() => {});
    // boxes of the few text nodes that are cue candidates of some nameless control, in one call
    const cueBox = new Map(); this.cueSeen ||= new Map();
    // a text that IS the accessible name of another control is that control's label, never a cue for this one
    const taken = new Set(want.filter((w) => ACTIONABLE.has(w.role) && w.name).map((w) => w.name.replace(/\s+/g, " ").trim()));
    { const ids = [...new Set(want.flatMap((w) => (w.cueCands || []).map((c) => c.id)))].slice(0, 200);
      const o2 = await Promise.all(ids.map((id) => this.page.send("DOM.resolveNode", { backendNodeId: id, objectGroup: "cu-snap" }).then((r) => r.object?.objectId).catch(() => null)));
      const live2 = o2.map((o, i) => [o, ids[i]]).filter(([o]) => o);
      if (live2.length) { try { const r = await this.page.send("Runtime.callFunctionOn", { objectId: live2[0][0], functionDeclaration: FN_FACTS, arguments: live2.map(([o]) => ({ objectId: o })), returnByValue: true }, { timeoutMs: 8000 });
        (r.result?.value || []).forEach((f, j) => { if (f && f.vis) cueBox.set(live2[j][1], { x: f.x, y: f.y, w: f.w, h: f.h }); }); } catch {} } }
    const elements = [{ ref: this.refFor("omnibox", null, null), role: "entry", name: OMNIBOX_NAME, in_doc: false, text_value: info.url, cy: 0, states: [] }];
    want.forEach((w, i) => {
      const f = facts[i];
      if (!f || !f.vis) return;
      let role = w.role;
      if (f.pw) role = "password text";
      const el = { ref: this.refFor(w.n.backendDOMNodeId, w.n.backendDOMNodeId, this.page.sessionId), role, name: w.name, states: w.states,
        region: w.region || undefined, in_dialog: w.inDialog || undefined, cy: f.y + f.h / 2, cx: f.x + f.w / 2, w: f.w, h: f.h };
      if (role === "dialog") { el.dialog_root = true; el.in_dialog = true; }
      if (w.cueCands && !el.name) {
        const boxOf = (id) => cueBox.get(id); const hi = w.cueHeading ? want.indexOf(w.cueHeading) : -1; const hf = hi >= 0 ? facts[hi] : null;
        let h = pickCue({ x: f.x, y: f.y, w: f.w, h: f.h }, w.cueCands.filter((c) => !taken.has(c.text)).map((c) => ({ text: c.text, box: boxOf(c.id) })).filter((c) => c.box), hf && hf.vis ? { text: w.cueHeading.name, y: hf.y } : null);
        // a cue that CHANGES between two reads of the same control is dropped for good (Resy: one button was under
        // "Popular Cities" in one read and under "Locations" in the next; Kavak: a rotating placeholder text)
        const key = w.n.backendDOMNodeId, was = this.cueSeen.get(key), sig = h ? `${h.how}|${h.text}` : "";
        if (was === "!unstable" || (was !== undefined && was !== sig)) { this.cueSeen.set(key, "!unstable"); h = null; el.hint_unstable = true; } else this.cueSeen.set(key, sig);
        if (h) el.hint = h;
      }
      if (role === "entry" && w.value != null) el.text_value = String(w.value);
      else if ((role === "combo box" || role === "slider" || role === "spin button") && w.value != null && w.value !== "") el.value = String(w.value);
      if (role === "link" && f.href) el.href = f.href;
      if (f.sel) el.native_select = true;
      elements.push(el);
    });
    const busy = info.ready !== "complete" || this.page.loadState === "loading";
    this.last = { page: { url: info.url, title: info.title, busy }, elements, viewport: { top: 0, bottom: info.vh, width: info.vw } };
    return this.last;
  }

  // ---- targets ----------------------------------------------------------------------------------------------------
  async find({ ref, text, role }) {
    if (ref) {
      const r = this.refs.get(ref);
      if (!r) return { error: `ref "${ref}" not found (read_page again: refs come from a read of this page)` };
      if (r.backendNodeId == null) return { omnibox: true, ref };
      const el = this.last?.elements.find((e) => e.ref === ref) || { ref, role: "?", name: "" };
      return { ref, backendNodeId: r.backendNodeId, el };
    }
    if (!text) return { error: "give a ref or a text to find" };
    const snap = await this.snapshot({ includeText: false });
    const want = String(text).toLowerCase();
    const roles = role ? String(role).toLowerCase().split("|").map((s) => s.trim()) : null;
    const roleOk = (e) => !roles || roles.includes(e.role) || roles.some((r) => (r === "button" && e.role === "push button") || (r === "textbox" && e.role === "entry") || (r === "combobox" && e.role === "combo box") || (r === "checkbox" && e.role === "check box") || (r === "radio" && e.role === "radio button"));
    let hits = snap.elements.filter((e) => roleOk(e) && String(e.name).toLowerCase().includes(want));
    // a control with NO name is found by what it shows (dropdown "" = "All Day"): the only handle a caller has for it
    if (!hits.length) hits = snap.elements.filter((e) => roleOk(e) && !String(e.name || "").trim() && e.in_doc !== false && String(e.value ?? e.text_value ?? "").toLowerCase() === want);
    if (!hits.length) return { error: `No element found matching "${text}"${role ? ` (role ${role})` : ""}` };
    const exact = hits.find((e) => e.name.toLowerCase() === want);
    const inView = (e) => e.cy >= 0 && e.cy <= snap.viewport.bottom;
    const e = exact || hits.find(inView) || hits[0];
    if (e.in_doc === false) return { omnibox: true, ref: e.ref };
    return { ref: e.ref, backendNodeId: this.refs.get(e.ref).backendNodeId, el: e };
  }

  async withNode(backendNodeId, fn, args = []) {
    const r = await this.page.send("DOM.resolveNode", { backendNodeId, objectGroup: "cu-act" });
    const objectId = r.object?.objectId;
    if (!objectId) throw new Error("node is gone");
    try {
      const out = await this.page.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: args.map((v) => ({ value: v })), returnByValue: true, awaitPromise: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || "page script failed");
      return out.result?.value;
    } finally { this.page.send("Runtime.releaseObjectGroup", { objectGroup: "cu-act" }).catch(() => {}); }
  }

  // aim, and when something that is not a dialog covers the target (most often a hover menu the mouse opened by
  // resting where the last click was), move the mouse to a corner of the window, let the menu close, aim again
  async aim(backendNodeId) {
    const a = await this.aimOnce(backendNodeId);
    if (!a.covered || a.covered.startsWith("a dialog")) return a;
    const v = await this.page.evaluate("[innerWidth, innerHeight]").catch(() => [1280, 900]);
    await this.mouse("mouseMoved", Math.max(1, v[0] - 3), Math.max(1, v[1] - 3));
    await new Promise((r) => setTimeout(r, 400));
    return this.aimOnce(backendNodeId);
  }

  // scroll the element to the middle of the window and return a point on it that is not covered, or why not
  async aimOnce(backendNodeId) {
    const fn = `function() {
      const e = this.nodeType === 1 ? this : this.parentElement;
      if (!e || !e.isConnected) return { gone: true };
      const before = scrollY;
      e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = e.getBoundingClientRect();
      let ox = 0, oy = 0;
      try { let w = e.ownerDocument.defaultView; while (w && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); ox += fr.left; oy += fr.top; w = w.parent; } } catch {}
      if (r.width < 1 || r.height < 1) return { hidden: true };
      const pts = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.5]];
      const doc = e.ownerDocument;
      let cover = null;
      for (const [fx, fy] of pts) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        // the hit, through shadow roots: document.elementFromPoint stops at a shadow HOST, so a button inside a cookie
        // banner built as a web component read as "covered by" its own banner (s1: dw.com div#cmpwrapper, chedraui)
        let hit = doc.elementFromPoint(x, y);
        for (let k = 0; k < 8 && hit && hit.shadowRoot; k++) { const n = hit.shadowRoot.elementFromPoint(x, y); if (!n || n === hit) break; hit = n; }
        const within = (outer, inner) => { for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true; return false; };   // crosses shadow boundaries, open or closed
        if (hit && (hit === e || within(e, hit) || within(hit, e) || (e.labels && [...e.labels].some((l) => l.contains(hit))))) return { x: x + ox, y: y + oy, scrolled: scrollY !== before };
        if (hit && !cover) cover = (hit.closest("[role=dialog],dialog,[aria-modal=true]") ? "a dialog " : "") + hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + (typeof hit.className === "string" && hit.className ? "." + hit.className.split(/\\s+/)[0] : "");
      }
      return { covered: cover || "something", x: r.left + r.width / 2 + ox, y: r.top + r.height / 2 + oy };
    }`;
    return this.withNode(backendNodeId, fn);
  }

  async mouse(type, x, y, extra = {}) {
    if (type === "mousePressed") this.actSeq = (this.actSeq || 0) + 1;
    await this.page.send("Input.dispatchMouseEvent", { type, x, y, button: extra.button || "none", clickCount: extra.clickCount || 0, buttons: extra.buttons || 0, ...extra });
  }
  async clickAt(x, y, { button = "left", clicks = 1 } = {}) {
    await this.mouse("mouseMoved", x, y);
    for (let i = 1; i <= clicks; i++) {
      await this.mouse("mousePressed", x, y, { button, clickCount: i, buttons: button === "left" ? 1 : button === "right" ? 2 : 4 });
      await this.mouse("mouseReleased", x, y, { button, clickCount: i, buttons: 0 });
    }
  }

  // ---- transition watch: what an action changed on the page ---------------------------------------------------------
  async mark() {
    const info = await this.pageInfo();
    await this.page.evaluate(`(() => { if (!window.__cuMo) { window.__cuMut = 0; window.__cuMutAt = Date.now(); window.__cuMo = new MutationObserver((l) => { window.__cuMut += l.length; window.__cuMutAt = Date.now(); }); window.__cuMo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); } return true; })()`).catch(() => {});
    const mut = await this.page.evaluate("window.__cuMut || 0").catch(() => 0);
    return { url: info.url, mut, dialogs: await this.dialogCount(), t: Date.now() };
  }
  async dialogCount() {
    return this.page.evaluate(`[...document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]")].filter((d) => { const r = d.getBoundingClientRect(); return r.width > 1 && r.height > 1 && (!d.checkVisibility || d.checkVisibility({ opacityProperty: true, visibilityProperty: true })); }).length`).catch(() => 0);
  }
  async watch(before, { maxMs = 1500, quietMs = 300 } = {}) {
    const t0 = Date.now();
    let lastMut = null, quietSince = Date.now(), urlChanged = false, url = before.url, mut = before.mut;
    while (Date.now() - t0 < maxMs) {
      await sleep(100);
      if (this.newTab || this.pageGone) break;
      const info = await this.pageInfo();
      if (info.url && info.url !== before.url) { urlChanged = true; url = info.url; break; }
      const m = await this.page.evaluate("window.__cuMut").catch(() => null);
      if (m == null) { urlChanged = true; break; } // the document was replaced
      if (m !== lastMut) { lastMut = m; quietSince = Date.now(); }
      if (m > before.mut && Date.now() - quietSince >= quietMs) { mut = m; break; }
      mut = m;
    }
    const tab = await this.followTabs();
    const parts = [];
    if (tab) parts.push(tab);
    if (urlChanged) { const info = await this.pageInfo(); url = info.url || url; parts.push(`url changed to ${url}`); }
    const dialogs = tab || urlChanged ? null : await this.dialogCount();
    if (dialogs != null && dialogs !== before.dialogs) parts.push(`dialogs ${before.dialogs} -> ${dialogs}`);
    if (!urlChanged && !tab && mut > before.mut) parts.push(`page changed (${mut - before.mut} updates)`);
    return { changed: parts.length > 0, text: parts.join("; "), url, urlChanged: urlChanged || !!tab };
  }
  async axState(backendNodeId) {
    try {
      const { nodes } = await this.page.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false });
      const n = nodes.find((x) => !x.ignored) || nodes[0];
      const p = (k) => (n?.properties || []).find((x) => x.name === k)?.value?.value;
      return { checked: p("checked"), expanded: p("expanded"), selected: p("selected"), pressed: p("pressed"), value: n?.value?.value, name: n?.name?.value, focused: p("focused") };
    } catch { return null; }
  }
  stateDiff(a, b) {
    if (!a || !b) return "";
    const out = [];
    for (const k of ["checked", "expanded", "selected", "pressed"]) {
      const x = a[k] === true || a[k] === "true" || a[k] === "mixed", y = b[k] === true || b[k] === "true" || b[k] === "mixed";
      if (a[k] !== undefined || b[k] !== undefined) if (x !== y) out.push(`${k} ${x} -> ${y}`);
    }
    return out.join(", ");
  }
  label(t) { const e = t.el || {}; return `${t.ref} ${e.role || ""} ${JSON.stringify(e.name || "")}`.replace(/\s+/g, " ").trim(); }

  // ---- actions ----------------------------------------------------------------------------------------------------
  async navigate(url) {
    const before = await this.pageInfo();
    try {
      const r = await this.page.send("Page.navigate", { url }, { timeoutMs: 30000 });
      if (r.errorText) return { text: `FAILED: navigation to ${url} failed: ${r.errorText}`, isError: true };
    } catch (e) { return { text: `FAILED: navigation to ${url}: ${e.message}`, isError: true }; }
    await this.waitSettled({ maxMs: 15000, notUrl: before.url === url ? null : before.url });
    const info = await this.pageInfo();
    this.refs.clear(); this.refOf.clear();
    return { text: `Navigated to ${info.url || url}` };
  }

  async click(target, { button = "left", clicks = 1, observe = true } = {}) {
    const t = await this.find(target);
    if (t.error) return { text: t.error, isError: true };
    if (t.omnibox) return { text: `Clicked ${t.ref} entry "${OMNIBOX_NAME}" (the address bar: use type_into_element on it to open a URL)` };
    const pre = await this.axState(t.backendNodeId);
    let aim;
    try { aim = await this.aim(t.backendNodeId); } catch (e) { return { text: `ref "${t.ref}" is stale: the element is gone from the page (read_page again)`, isError: true }; }
    if (aim.gone) return { text: `ref "${t.ref}" is stale: the element is gone from the page (read_page again)`, isError: true };
    if (aim.hidden) return { text: `FAILED: ${this.label(t)} is not rendered (zero size or hidden); it may live in a closed menu: open that first`, isError: true };
    if (aim.covered) return { text: `FAILED: ${this.label(t)} is covered by ${aim.covered} at its position; close or scroll past what covers it`, isError: true };
    const before = await this.mark();
    await this.clickAt(aim.x, aim.y, { button, clicks });
    const w = observe ? await this.watch(before) : { changed: false, text: "" };
    if (w.urlChanged) await this.waitSettled({ maxMs: 12000 });
    const post = w.urlChanged ? null : await this.axState(t.backendNodeId);
    const diff = this.stateDiff(pre, post);
    const what = [w.text, diff].filter(Boolean).join("; ");
    if (what) return { text: `Clicked ${this.label(t)}. Transition observed: ${what}` };
    return { text: `Clicked ${this.label(t)}. No transition observed (the page did not change within 1.5 s)` };
  }

  async press(target) {
    const t = await this.find(target);
    if (t.error) return { text: t.error, isError: true };
    if (t.el?.role === "link") return { text: `Refused: ${this.label(t)} is a link; use click_element`, isError: true };
    let aim;
    try { aim = await this.aim(t.backendNodeId); } catch { return { text: `ref "${t.ref}" is stale`, isError: true }; }
    if (aim.gone || aim.hidden) return { text: `Not pressed: ${this.label(t)} is not rendered`, isError: true };
    await this.clickAt(aim.x, aim.y);
    await sleep(250);
    return { text: `Pressed ${this.label(t)}` };
  }

  async hover(target) {
    const t = await this.find(target);
    if (t.error) return { text: t.error, isError: true };
    const aim = await this.aim(t.backendNodeId).catch(() => ({ gone: true }));
    if (aim.gone || aim.hidden) return { text: `FAILED: ${this.label(t)} is not rendered`, isError: true };
    const before = await this.mark();
    await this.mouse("mouseMoved", aim.x, aim.y);
    const w = await this.watch(before, { maxMs: 900 });
    return { text: `Hovering ${this.label(t)}${w.changed ? `. Transition observed: ${w.text}` : ""}` };
  }

  async scrollTo(target) {
    const t = await this.find(target);
    if (t.error) return { text: t.error, isError: true };
    const r = await this.withNode(t.backendNodeId, `function() { const e = this.nodeType === 1 ? this : this.parentElement; const b = e.getBoundingClientRect(); const inView = b.top >= 0 && b.bottom <= innerHeight; if (!inView) e.scrollIntoView({ block: "center", behavior: "instant" }); return inView; }`).catch(() => null);
    if (r == null) return { text: `ref "${t.ref}" is stale`, isError: true };
    return { text: r ? `Already in view: ${this.label(t)}` : `Scrolled ${this.label(t)} into view` };
  }

  async scrollState() {
    return this.page.evaluate(`(() => { let e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); const s = [Math.round(scrollY)]; while (e) { if (e.scrollHeight > e.clientHeight + 2) s.push(Math.round(e.scrollTop)); e = e.parentElement; } return s.join(","); })()`).catch(() => "");
  }

  async key(name, modifiers = []) {
    const d = keyDef(name);
    if (!d) return { text: `FAILED: unknown key "${name}"`, isError: true };
    const [key, code, keyCode, text] = d;
    const mods = modifiers.reduce((m, k) => m | (MOD[k] || 0), 0);
    const before = SCROLL_KEYS.has(key) && !mods ? await this.scrollState() : null;
    const mark = await this.mark();
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mods };
    await this.page.send("Input.dispatchKeyEvent", { type: text && !mods ? "keyDown" : "rawKeyDown", ...base, ...(text && !mods ? { text, unmodifiedText: text } : {}) });
    this.actSeq = (this.actSeq || 0) + 1; await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    const combo = [...modifiers, name].join("+");
    if (before != null) {
      await sleep(250);
      const after = await this.scrollState();
      return { text: after !== before ? `Pressed ${combo}. Scrolled (${before} -> ${after})` : `Pressed ${combo}. Not scrolled: the page did not move` };
    }
    const w = await this.watch(mark, { maxMs: key === "Enter" ? 2500 : 900 });
    if (w.urlChanged) await this.waitSettled({ maxMs: 12000 });
    return { text: `Pressed ${combo}${w.changed ? `. Transition observed: ${w.text}` : ""}` };
  }

  async wheel(x, y, direction = "down", amount = 5) {
    const before = await this.scrollState();
    await this.mouse("mouseMoved", x, y);
    this.actSeq = (this.actSeq || 0) + 1; await this.page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: (direction === "up" ? -1 : 1) * amount * 100 });
    await sleep(300);
    const after = await this.scrollState();
    return { text: after !== before ? `Scrolled ${direction} (${before} -> ${after})` : `Not scrolled: the page did not move at (${x}, ${y})` };
  }

  async typeText(text) {
    this.actSeq = (this.actSeq || 0) + 1; await this.page.send("Input.insertText", { text: String(text) });
    return { text: `Typed ${JSON.stringify(String(text))} into the focused element` };
  }

  async typeInto(target, value, { clear = true, pressEnter = false } = {}) {
    const t = await this.find(target);
    if (t.error) return { text: t.error, isError: true };
    if (t.omnibox) {
      let url = String(value).trim();
      if (!/^[a-z]+:/i.test(url)) url = /\s/.test(url) || !/\./.test(url) ? `https://www.google.com/search?q=${encodeURIComponent(url)}` : `https://${url}`;
      if (!pressEnter) return { text: `Typed ${JSON.stringify(value)} into the address bar (not opened: press_enter opens it)` };
      return this.navigate(url);
    }
    const aim = await this.aim(t.backendNodeId).catch(() => ({ gone: true }));
    if (aim.gone) return { text: `ref "${t.ref}" is stale`, isError: true };
    if (aim.hidden) return { text: `FAILED: ${this.label(t)} is not rendered`, isError: true };
    // focus the field the way a person does (a click), unless something covers it: then focus it directly
    if (!aim.covered) await this.clickAt(aim.x, aim.y);
    await this.page.send("DOM.focus", { backendNodeId: t.backendNodeId }).catch(() => {});
    if (clear) {
      await this.withNode(t.backendNodeId, `function() { const e = this; if (e.select && "value" in e) e.select(); else { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } return true; }`).catch(() => {});
      await this.page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      this.actSeq = (this.actSeq || 0) + 1; await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    }
    this.actSeq = (this.actSeq || 0) + 1; await this.page.send("Input.insertText", { text: String(value) });
    await sleep(120);
    const got = await this.withNode(t.backendNodeId, `function() { const e = this; return "value" in e ? String(e.value) : String(e.innerText || e.textContent || ""); }`).catch(() => null);
    const typedOk = got != null && got.toLowerCase().includes(String(value).toLowerCase().slice(0, 40));
    let text = typedOk ? `Typed ${JSON.stringify(value)} into ${this.label(t)} (verified: the field reads ${JSON.stringify(String(got).slice(0, 80))})`
      : `Typed ${JSON.stringify(value)} into ${this.label(t)} — UNVERIFIED: the field reads ${JSON.stringify(String(got ?? "").slice(0, 80))}`;
    if (pressEnter) {
      const before = await this.mark();
      await this.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
      this.actSeq = (this.actSeq || 0) + 1; await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      const w = await this.watch(before, { maxMs: 3000 });
      if (w.urlChanged) await this.waitSettled({ maxMs: 12000 });
      text += w.changed ? `; pressed Return. Transition observed: ${w.text}` : "; pressed Return. No transition observed";
    }
    return { text };
  }

  async selectOption(...a) { this.actSeq = (this.actSeq || 0) + 1; return this.selectOptionInner(...a); }
  async selectOptionInner(target, optionText) {
    const t = await this.find({ ref: target.ref, text: target.text, role: target.ref ? undefined : (target.role || "combo box") });
    if (t.error) return { text: t.error, isError: true };
    const want = String(optionText).trim().toLowerCase();
    // a native <select>: choose by its options, fire the events a person's choice fires, read it back
    const native = await this.withNode(t.backendNodeId, `function(want) {
      const e = this; if (e.tagName !== "SELECT") return null;
      const opts = [...e.options]; const norm = (s) => String(s).trim().toLowerCase();
      const o = opts.find((x) => norm(x.text) === want) || opts.find((x) => norm(x.text).includes(want)) || opts.find((x) => norm(x.value) === want);
      if (!o) return { missing: true, options: opts.slice(0, 15).map((x) => x.text.trim()) };
      e.focus(); e.value = o.value; o.selected = true;
      e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
      return { chosen: o.text.trim(), now: e.options[e.selectedIndex]?.text.trim() };
    }`, [want]).catch(() => null);
    // a styled dropdown whose real control is a transparent <select> laid OVER it (Resy's time picker: the read shows the
    // styled box, clicks on it answered "covered by select#time", and select_option found no option): the select that
    // covers the target IS the dropdown; choose in it the same way
    const cover = native ? null : await this.withNode(t.backendNodeId, `function(want) {
      const e = this.nodeType === 1 ? this : this.parentElement; if (!e) return null;
      e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = e.getBoundingClientRect(); let hit = e.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      for (let k = 0; k < 8 && hit && hit.shadowRoot; k++) { const n = hit.shadowRoot.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!n || n === hit) break; hit = n; }
      const sel = hit && hit.tagName === "SELECT" ? hit : (e.querySelector && e.querySelector("select")) || (e.parentElement && e.parentElement.querySelector(":scope > select"));
      if (!sel || sel.tagName !== "SELECT") return null;
      const opts = [...sel.options]; const norm = (s) => String(s).trim().toLowerCase();
      const o = opts.find((x) => norm(x.text) === want) || opts.find((x) => norm(x.text).includes(want)) || opts.find((x) => norm(x.value) === want);
      if (!o) return { missing: true, options: opts.slice(0, 15).map((x) => x.text.trim()) };
      sel.focus(); sel.value = o.value; o.selected = true;
      sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { chosen: o.text.trim(), now: sel.options[sel.selectedIndex]?.text.trim(), via: "the select that covers it" };
    }`, [want]).catch(() => null);
    const nat = native || cover;
    if (nat) {
      const native = nat;
      if (native.missing) return { text: `No option found matching ${JSON.stringify(optionText)} in ${this.label(t)}. Options: ${native.options.join(" | ")}`, isError: true };
      await sleep(400);
      const ok = String(native.now).toLowerCase() === String(native.chosen).toLowerCase();
      return { text: ok ? `Selected ${JSON.stringify(native.chosen)} in ${this.label(t)} [verified: the dropdown reads ${JSON.stringify(native.now)}]` : `FAILED: the dropdown reads ${JSON.stringify(native.now)}, not ${JSON.stringify(native.chosen)}`, isError: !ok };
    }
    // a custom dropdown: open it, find the option by name among what APPEARED, click it, read the dropdown back.
    // (s1, 2026-11-27: three sites answered "No option found" 350 ms after the click: the list renders later, its items
    // are plain text without a role, or it carries no name the model could have guessed. Now: the options are looked for
    // for up to 2 s, among elements that are new since before the click first, plain text items included; and a miss
    // says what did appear, so the caller can choose from it without looking at pixels.)
    const before = new Set((await this.snapshot({ includeText: true })).elements.map((e) => `${e.role}\u0000${e.name}`));
    const open = await this.click({ ref: t.ref });
    if (open.isError) return open;
    const OPT = ["menu item", "radio button", "check box", "push button", "link", "list item", "static", "paragraph"];
    const norm = (x) => String(x || "").trim().toLowerCase();
    const pick = (list) => list.find((e) => norm(e.name) === want) || list.find((e) => norm(e.name).startsWith(want)) || list.find((e) => norm(e.name).includes(want));
    let o = null, fresh = [];
    for (let k = 0; k < 5 && !o; k++) {
      await sleep(k ? 400 : 350);
      const snap = await this.snapshot({ includeText: true });
      const cands = snap.elements.filter((e) => e.ref !== t.ref && OPT.includes(e.role) && e.name);
      fresh = cands.filter((e) => !before.has(`${e.role}\u0000${e.name}`));
      o = pick(fresh) || pick(cands.filter((e) => e.role !== "static" && e.role !== "paragraph"));
    }
    if (!o) {
      const seen = [...new Set(fresh.map((e) => e.name.trim()))].slice(0, 15);
      return { text: `No option found matching ${JSON.stringify(optionText)} after opening ${this.label(t)}. ${seen.length ? `After opening, these appeared: ${seen.join(" | ")}` : "Nothing new appeared after opening it (it may need a key press, or its options are not exposed to the accessibility tree)"}`, isError: true };
    }
    const c = await this.click({ ref: o.ref });
    if (c.isError) return c;
    const st = await this.axState(t.backendNodeId);
    const reads = `${st?.value ?? ""} ${st?.name ?? ""}`.toLowerCase();
    return reads.includes(want) ? { text: `Selected ${JSON.stringify(o.name)} in ${this.label(t)} [verified: the dropdown reads ${JSON.stringify((st?.value || st?.name || "").slice(0, 60))}]` }
      : { text: `Selected ${JSON.stringify(o.name)} (clicked the option) — UNVERIFIED: the dropdown reads ${JSON.stringify((st?.value || st?.name || "").slice(0, 60))}. ${c.text}` };
  }

  async readSelected(target) {
    const t = await this.find({ ref: target.ref, text: target.text, role: target.ref ? undefined : "combo box" });
    if (t.error) return { text: t.error, isError: true };
    const v = await this.withNode(t.backendNodeId, `function() { return this.tagName === "SELECT" ? (this.options[this.selectedIndex]?.text || "").trim() : null; }`).catch(() => null);
    const st = await this.axState(t.backendNodeId);
    return { text: JSON.stringify({ ref: t.ref, selected: v ?? st?.value ?? null, shows: st?.name ?? null }) };
  }

  async dismiss({ dialog_ref, dialog_text, control_ref }) {
    if (dialog_ref || dialog_text) {
      const t = await this.find({ ref: dialog_ref, text: dialog_text, role: dialog_ref ? undefined : "dialog" });
      if (t.error) return { text: t.error, isError: true };
      const before = await this.dialogCount();
      await this.key("Escape");
      await sleep(350);
      const still = await this.withNode(t.backendNodeId, `function() { const e = this.nodeType === 1 ? this : this.parentElement; if (!e.isConnected) return false; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && (!e.checkVisibility || e.checkVisibility({ opacityProperty: true, visibilityProperty: true })); }`).catch(() => false);
      const after = await this.dialogCount();
      return still ? { text: `Escape sent; the dialog ${this.label(t)} is STILL present (dialogs ${before} -> ${after}). It ignores Escape: close it with a close control inside it (control_ref)` }
        : { text: `Dismissed the dialog ${this.label(t)} with Escape (dialogs ${before} -> ${after})` };
    }
    if (control_ref) {
      const t = await this.find({ ref: control_ref });
      if (t.error) return { text: t.error, isError: true };
      if (SUBSTANTIVE.test(t.el?.name || "")) return { text: `Refused: ${this.label(t)} makes a choice on the person's behalf, not just a close. Use click_element if that choice is intended.`, isError: true };
      const r = await this.click({ ref: control_ref });
      return r.isError ? r : { text: r.text.replace(/^Clicked/, "Dismissed via") };
    }
    return { text: "give dialog_ref, dialog_text or control_ref", isError: true };
  }

  // "settled" = usable, not fully loaded: the document is interactive with real content and the DOM has gone quiet.
  // Waiting for the load event and an idle network (ads, trackers, video) cost 3-8 s per navigation on big sites.
  //   quiet           DOM quiet for quietMs and no request in flight
  //   usable_quiet    DOM quiet for busyQuietMs while requests still run (ad/analytics traffic)
  //   usable_changing content there for usableMs but the DOM keeps changing (carousels, tickers)
  async waitSettled({ quietMs = 400, busyQuietMs = 600, usableMs = 1500, maxMs = 15000, urlContains = null, notUrl = null } = {}) {
    const t0 = Date.now();
    let lastMut = null, quietSince = Date.now(), readySince = null, state = "loading", events = 0;
    const probe = `(() => { if (!window.__cuMo) { window.__cuMut = 0; window.__cuMutAt = Date.now(); window.__cuMo = new MutationObserver((l) => { window.__cuMut += l.length; window.__cuMutAt = Date.now(); }); window.__cuMo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); }
      const b = document.body; const n = b ? b.querySelectorAll("a[href],button,input,select,textarea,[role=button],[role=link]").length : 0;
      // visible text, not textContent (inline <script> text made an empty shell look like content)
      return { r: document.readyState, m: window.__cuMut, q: Date.now() - (window.__cuMutAt || 0), u: location.href, c: n >= 3 || (b && b.innerText.length > 200) }; })()`;
    // nothing navigated since the last settle and the DOM is quiet right now: settled already (planners call this a lot)
    // (or nothing of ours acted on it since: the page we called usable is still the page we called usable)
    if (this.settledSeq === this.page.navSeq && !urlContains) {
      const st = await this.page.evaluate(probe, { timeoutMs: 1500 }).catch(() => null);
      const untouched = this.settledAct === this.actSeq;
      if (st && st.r !== "loading" && st.c && (untouched || (st.q ?? 0) >= quietMs || this.page.busyRequests() === 0) && (!notUrl || st.u !== notUrl)) return { settled: true, reason: "already", state: st.r, ms: Date.now() - t0, ready_ms: 0, events: 0 };
    }
    while (Date.now() - t0 < maxMs) {
      await this.followTabs();
      let st;
      try { st = await this.page.evaluate(probe, { timeoutMs: 1500 }); } catch { st = null; }
      if (st) {
        state = st.r;
        const urlOk = (!urlContains || st.u.includes(urlContains)) && (!notUrl || st.u !== notUrl);
        if (st.m !== lastMut) { if (lastMut != null) events += Math.max(0, st.m - lastMut); lastMut = st.m; quietSince = Date.now(); }
        if (st.r !== "loading" && st.c && urlOk) {
          readySince = readySince ?? Date.now();
          // quiet as the page itself measured it (time since its last DOM change): an already quiet page returns at once
          const quiet = st.q ?? Date.now() - quietSince, net = this.page.busyRequests();
          const out = (reason) => { this.settledSeq = this.page.navSeq; this.settledAct = this.actSeq; return { settled: true, reason, state, ms: Date.now() - t0, ready_ms: readySince - t0, events }; };
          // and ready for a moment as WE saw it: a document right after the swap reported itself quiet with an empty tree
          const seen = Date.now() - readySince >= 300;
          if (seen && quiet >= quietMs && net === 0) return out("quiet");
          if (seen && quiet >= busyQuietMs) return out("usable_quiet");
          if (Date.now() - readySince >= usableMs) return out("usable_changing");
        } else readySince = null;
      }
      await sleep(100);
    }
    return { settled: false, reason: "timeout", state, ms: Date.now() - t0, events };
  }

  async pageText(maxChars = 4000000) {
    const t = await this.page.evaluate(`document.body ? document.body.innerText : ""`).catch(() => "");
    return String(t).slice(0, maxChars);
  }

  async images(cap = 64, minPx = 0) {
    return this.page.evaluate(`[...document.images].map((i) => { const r = i.getBoundingClientRect(); return { alt: (i.alt || "").trim().slice(0, 120), src: i.currentSrc || i.src, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + scrollY) }; }).filter((x) => x.w >= ${Number(minPx) || 0} && x.h >= ${Number(minPx) || 0} && x.w > 0).slice(0, ${Number(cap) || 64})`).catch(() => []);
  }
}
