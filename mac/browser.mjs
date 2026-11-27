// The browser through the macOS accessibility API: a real Google Chrome (mac/instance.mjs) read and driven by
// mac/axhelper.py. Same methods, snapshot shape and result sentences as cdp/browser.mjs, so cdp/server.mjs serves
// either one and observation.mjs / actionOutcome() read them the same way.
//
// What differs from CDP, on purpose: no DevTools connection to the page at all (the page sees a person's browser),
// clicks are accessibility presses (AXPress), typing and keys are key events posted to Chrome's process only, so the
// person's own mouse pointer and keyboard focus are never taken. The page's change clock is the AXObserver's count.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OMNIBOX_NAME = "Address and search bar";
const SUBSTANTIVE = /\b(accept|reject|agree|allow|consent|subscribe|sign ?up|register|preferences|settings|manage|customi[sz]e|continue|buy|add to)\b/i;
const SCROLL_KEYS = new Set(["Page_Down", "Next", "PageDown", "Page_Up", "Prior", "PageUp", "Home", "End", "space", "Down", "Up"]);

export class Browser {
  constructor({ pid, python = process.env.COMPUTER_USE_AX_PYTHON || "python3", log = () => {} } = {}) {
    this.pid = Number(pid); this.python = python; this.log = log;
    this.seq = 0; this.waiting = new Map(); this.last = null; this.actSeq = 0; this.settledAct = -1; this.settledLoads = -1;
  }

  async connect() {
    const child = spawn(this.python, [path.join(HERE, "axhelper.py"), String(this.pid)], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr.on("data", (d) => this.log(`axhelper: ${String(d).trim().slice(0, 400)}`));
    const rl = readline.createInterface({ input: child.stdout });
    const ready = new Promise((res, rej) => { this.waiting.set(0, { res, rej }); child.on("exit", (c) => rej(new Error(`axhelper exited (${c})`))); });
    rl.on("line", (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const w = this.waiting.get(m.id); if (!w) return;
      this.waiting.delete(m.id);
      m.ok ? w.res(m.result) : w.rej(new Error(m.error));
    });
    const r = await ready;
    if (!r.trusted) throw new Error("this python is not allowed to use accessibility: System Settings > Privacy & Security > Accessibility");
    this.cdp = { version: { Browser: "Google Chrome (accessibility)" } }; // what server.mjs logs
    return this;
  }
  close() { try { this.child?.stdin.end(); } catch {} }

  call(cmd, args = {}, timeoutMs = 20000) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.waiting.delete(id); rej(new Error(`${cmd} timed out`)); }, timeoutMs);
      this.waiting.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      this.child.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }

  async followTabs() { return null; } // the helper always reads the focused window's active tab
  async pageInfo() {
    const i = await this.call("info");
    return { url: i.url, title: i.title, ready: i.busy ? "loading" : "complete", vh: this.last?.viewport?.bottom ?? 0, vw: this.last?.viewport?.width ?? 0, clock: i.clock, quiet: i.quiet_ms, loads: i.loads, busy: i.busy };
  }

  async snapshot({ includeText = false } = {}) {
    const s = await this.call("snapshot", { include_text: includeText });
    this.last = s;
    return s;
  }

  label(t) { const e = t.el || {}; return `${t.ref} ${e.role || ""} ${JSON.stringify(e.name || "")}`.replace(/\s+/g, " ").trim(); }

  async find({ ref, text, role }) {
    if (ref) {
      const el = this.last?.elements.find((e) => e.ref === ref);
      if (el?.in_doc === false) return { omnibox: true, ref };
      return { ref, el: el || { ref, role: "?", name: "" } };
    }
    if (!text) return { error: "give a ref or a text to find" };
    const snap = await this.snapshot({ includeText: false });
    const want = String(text).toLowerCase();
    const roles = role ? String(role).toLowerCase().split("|").map((s) => s.trim()) : null;
    const roleOk = (e) => !roles || roles.includes(e.role) || roles.some((r) => (r === "button" && e.role === "push button") || (r === "textbox" && e.role === "entry") || (r === "combobox" && e.role === "combo box") || (r === "checkbox" && e.role === "check box") || (r === "radio" && e.role === "radio button"));
    // a NAME stays inside the web page: "Search" must not match Chrome's "Address and search bar" (Henry2, b1 task 21:
    // a stale-ref retry by name typed the query into the omnibox and opened a Google search). Only a name that asks for
    // the address bar itself reaches it.
    const wantsBar = /address|omnibox|url bar|location bar/.test(want);
    const hits = snap.elements.filter((e) => roleOk(e) && String(e.name).toLowerCase().includes(want) && (e.in_doc !== false || wantsBar));
    if (!hits.length) return { error: `No element found matching "${text}"${role ? ` (role ${role})` : ""}` };
    const exact = hits.find((e) => e.name.toLowerCase() === want);
    const inView = (e) => e.cy >= 0 && e.cy <= snap.viewport.bottom;
    const e = exact || hits.find(inView) || hits[0];
    if (e.in_doc === false) return { omnibox: true, ref: e.ref };
    return { ref: e.ref, el: e };
  }

  // ---- transitions: what an action changed ------------------------------------------------------------------------
  dialogs() { return (this.last?.elements || []).filter((e) => e.role === "dialog").length; }
  async mark() { const i = await this.call("info"); return { url: i.url, clock: i.clock, loads: i.loads, dialogs: this.dialogs(), t: Date.now() }; }
  async watch(before, { maxMs = 1500, quietMs = 300 } = {}) {
    const t0 = Date.now();
    let url = before.url, urlChanged = false, clock = before.clock, i = null;
    while (Date.now() - t0 < maxMs) {
      await sleep(100);
      i = await this.call("info").catch(() => null);
      if (!i) continue;
      if (i.url && i.url !== before.url) { urlChanged = true; url = i.url; break; }
      clock = i.clock;
      if (i.clock > before.clock && i.quiet_ms >= quietMs) break;
    }
    const parts = [];
    if (urlChanged) parts.push(`url changed to ${url}`);
    else if (clock > before.clock) {
      const snap = await this.snapshot().catch(() => null);
      const d = snap ? this.dialogs() : before.dialogs;
      if (d !== before.dialogs) parts.push(`dialogs ${before.dialogs} -> ${d}`);
      parts.push(`page changed (${clock - before.clock} updates)`);
    }
    return { changed: parts.length > 0, text: parts.join("; "), url, urlChanged };
  }
  stateOf(ref) { return this.call("elem_info", { ref }).catch(() => null); }
  stateDiff(a, b) {
    if (!a || !b) return "";
    const out = [];
    for (const k of ["expanded", "selected"]) if ((a[k] === true) !== (b[k] === true) && (a[k] != null || b[k] != null)) out.push(`${k} ${a[k] === true} -> ${b[k] === true}`);
    if ((a.role === "check box" || a.role === "radio button") && a.value !== b.value) out.push(`checked ${a.value === "1"} -> ${b.value === "1"}`);
    return out.join(", ");
  }

  // ---- actions ----------------------------------------------------------------------------------------------------
  async navigate(url) {
    const before = await this.pageInfo();
    this.actSeq++;
    try { await this.call("navigate", { url }); } catch (e) { return { text: `FAILED: navigation to ${url}: ${e.message}`, isError: true }; }
    const t0 = Date.now();
    // the omnibox commits on Return; wait for the page's URL to leave the old one
    while (Date.now() - t0 < 15000) { const i = await this.call("info"); if (i.url && i.url !== before.url) break; await sleep(100); }
    await this.waitSettled({ maxMs: 15000 });
    const info = await this.pageInfo();
    return { text: `Navigated to ${info.url || url}` };
  }

  // the thing a step names may not be on the page YET (it loads after the rest): look again for up to 3 s while the page
  // is still loading or changing, instead of failing at once or waiting for the whole page beforehand
  async findReady(target, maxMs = 3000) {
    const t0 = Date.now();
    for (;;) {
      const t = await this.find(target);
      if (!t.error || !/^No element found/.test(t.error) || Date.now() - t0 >= maxMs) return t;
      const i = await this.call("info").catch(() => null);
      if (i && !i.busy && i.quiet_ms >= 600) return t;   // loaded and still: it is not coming
      await sleep(200);
    }
  }

  async click(target, { button = "left", clicks = 1, observe = true } = {}) {
    const t = await this.findReady(target);
    if (t.error) return { text: t.error, isError: true };
    if (t.omnibox) return { text: `Clicked ${t.ref} entry "${OMNIBOX_NAME}" (the address bar: use type_into_element on it to open a URL)` };
    if (button !== "left" || clicks !== 1) return { text: `FAILED: only a single left click is available on this browser (accessibility press)`, isError: true };
    let pre = await this.stateOf(t.ref);
    if (pre && !pre.alive) return { text: `ref "${t.ref}" is stale: the element is gone from the page (read_page again)`, isError: true };
    // it shows but is not usable yet (sites enable a control when their script has loaded): wait for it, then say so
    for (let k = 0; pre && pre.enabled === false && k < 20; k++) { await sleep(100); pre = await this.stateOf(t.ref); }
    if (pre && pre.enabled === false) return { text: `FAILED: ${this.label(t)} is disabled (still disabled after 2 s): nothing was pressed`, isError: true };
    const before = await this.mark();
    this.actSeq++;
    // a text field: focus it (that is what a click on it does)
    if (["entry", "password text"].includes(t.el?.role)) { await this.call("focus", { ref: t.ref }); return { text: `Clicked ${this.label(t)}. Transition observed: focused` }; }
    try { await this.call("press", { ref: t.ref }); } catch (e) { return { text: `FAILED: ${this.label(t)} could not be pressed: ${e.message}`, isError: true }; }
    const w = observe ? await this.watch(before) : { changed: false, text: "" };
    if (w.urlChanged) await this.waitSettled({ maxMs: 12000 });
    const post = w.urlChanged ? null : await this.stateOf(t.ref);
    const diff = this.stateDiff({ ...pre, role: t.el?.role }, post);
    const what = [w.text, diff].filter(Boolean).join("; ");
    if (what) return { text: `Clicked ${this.label(t)}. Transition observed: ${what}` };
    return { text: `Clicked ${this.label(t)}. No transition observed (the page did not change within 1.5 s)` };
  }

  async press(target) {
    const t = await this.findReady(target);
    if (t.error) return { text: t.error, isError: true };
    if (t.el?.role === "link") return { text: `Refused: ${this.label(t)} is a link; use click_element`, isError: true };
    this.actSeq++;
    try { await this.call("press", { ref: t.ref }); } catch (e) { return { text: `Not pressed: ${this.label(t)}: ${e.message}`, isError: true }; }
    await sleep(250);
    return { text: `Pressed ${this.label(t)}` };
  }

  async hover(target) {
    const t = await this.findReady(target);
    if (t.error) return { text: t.error, isError: true };
    return { text: `FAILED: hover is not available on this browser (it never moves the person's pointer); click ${this.label(t)} instead`, isError: true };
  }

  async clickAt(x, y, { button = "left", clicks = 1 } = {}) {
    const before = await this.mark();
    this.actSeq++;
    const r = await this.call("press_at", { x, y }).catch((e) => ({ err: e.message }));
    if (r.err) return { text: `FAILED: ${r.err}`, isError: true };
    const w = await this.watch(before);
    if (w.urlChanged) await this.waitSettled({ maxMs: 12000 });
    return { text: `Clicked ${r.role || ""} ${JSON.stringify(r.name || "")} at (${x}, ${y})${w.changed ? `. Transition observed: ${w.text}` : ""}` };
  }

  async scrollTo(target) {
    const t = await this.findReady(target);
    if (t.error) return { text: t.error, isError: true };
    const s = await this.stateOf(t.ref);
    if (!s || !s.alive) return { text: `ref "${t.ref}" is stale`, isError: true };
    const inView = s.y != null && s.y >= 0 && s.y + s.h <= s.vh;
    if (inView) return { text: `Already in view: ${this.label(t)}` };
    this.actSeq++;
    await this.call("scroll_into_view", { ref: t.ref }).catch(() => {});
    await sleep(150);
    return { text: `Scrolled ${this.label(t)} into view` };
  }

  async scrollState() { const r = await this.call("scroll_pos").catch(() => ({ y: null })); return String(r.y); }

  async key(name, modifiers = []) {
    // "ctrl+a" as ONE name (planners write it that way; ADO, Mac p5: FAILED unknown key "ctrl+a"): split it. On a Mac the
    // editing shortcuts are Command, not Control: ctrl+a/c/v/x/z mean what a person means by them
    if (typeof name === "string" && name.length > 1 && name.includes("+")) {
      const parts = name.split("+").map((x) => x.trim()).filter(Boolean);
      name = parts.pop(); modifiers = [...modifiers, ...parts.map((m) => m.toLowerCase())];
    }
    if (/^[acvxz]$/i.test(name) && modifiers.length === 1 && /^(ctrl|control)$/.test(modifiers[0])) modifiers = ["cmd"];
    modifiers = modifiers.map((m) => (m === "control" ? "ctrl" : m === "command" || m === "super" ? "cmd" : m === "option" ? "alt" : m));
    const combo = [...modifiers, name].join("+");
    const scrolling = SCROLL_KEYS.has(name) && !modifiers.length;
    if (scrolling) await this.call("focus_page").catch(() => {});
    const before = scrolling ? await this.scrollState() : null;
    const mark = await this.mark();
    this.actSeq++;
    const r = await this.call("key", { name, modifiers });
    if (!r.ok) return { text: `FAILED: unknown key "${name}"`, isError: true };
    if (scrolling) {
      await sleep(300);
      const after = await this.scrollState();
      return { text: after !== before ? `Pressed ${combo}. Scrolled (${before} -> ${after})` : `Pressed ${combo}. Not scrolled: the page did not move` };
    }
    const w = await this.watch(mark, { maxMs: name === "Return" || name === "Enter" ? 2500 : 900 });
    if (w.urlChanged) await this.waitSettled({ maxMs: 12000 });
    return { text: `Pressed ${combo}${w.changed ? `. Transition observed: ${w.text}` : ""}` };
  }

  async wheel(x, y, direction = "down", amount = 5) {
    const before = await this.scrollState();
    this.actSeq++;
    await this.call("wheel", { x, y, dy: (direction === "up" ? -1 : 1) * amount * 100 });
    await sleep(300);
    let after = await this.scrollState();
    if (after === before) {
      // a wheel event Chrome ignored: page keys do the same job
      await this.call("focus_page").catch(() => {});
      for (let i = 0; i < Math.max(1, Math.round(amount / 5)); i++) await this.call("key", { name: direction === "up" ? "Page_Up" : "Page_Down" });
      await sleep(300);
      after = await this.scrollState();
    }
    return { text: after !== before ? `Scrolled ${direction} (${before} -> ${after})` : `Not scrolled: the page did not move at (${x}, ${y})` };
  }

  async typeText(text) {
    this.actSeq++;
    await this.call("type", { text: String(text) }, 60000);
    return { text: `Typed ${JSON.stringify(String(text))} into the focused element` };
  }

  async typeInto(target, value, { clear = true, pressEnter = false } = {}) {
    const t = await this.findReady(target);
    if (t.error) return { text: t.error, isError: true };
    if (t.omnibox) {
      let url = String(value).trim();
      if (!/^[a-z]+:/i.test(url)) url = /\s/.test(url) || !/\./.test(url) ? `https://www.google.com/search?q=${encodeURIComponent(url)}` : `https://${url}`;
      if (!pressEnter) return { text: `Typed ${JSON.stringify(value)} into the address bar (not opened: press_enter opens it)` };
      return this.navigate(url);
    }
    this.actSeq++;
    try { await this.call("focus", { ref: t.ref }); } catch (e) { return { text: `ref "${t.ref}" is stale`, isError: true }; }
    if (clear) {
      const cur = await this.call("value", { ref: t.ref }).catch(() => ({ value: "" }));
      if (cur.value) {
        const sel = await this.call("select_all", { ref: t.ref }).catch(() => ({ len: 0 }));
        await this.call("key", { name: "BackSpace" });
        const left = await this.call("value", { ref: t.ref }).catch(() => ({ value: "" }));
        if (left.value) { await this.call("key", { name: "a", modifiers: ["cmd"] }); await this.call("key", { name: "BackSpace" }); }
      }
    }
    await this.call("type", { text: String(value), ref: t.ref }, 60000);
    await sleep(120);
    let got = (await this.call("value", { ref: t.ref }).catch(() => ({ value: null }))).value;
    // the site swapped the field for a new one when it got focus (Wikipedia's search): read the field that has focus
    if (!(got || "").toLowerCase().includes(String(value).toLowerCase().slice(0, 40))) {
      const f = await this.call("focused_value").catch(() => null);
      if (f && /TextField|ComboBox|TextArea|SearchField/.test(f.role || "")) got = f.value;
    }
    let typedOk = got != null && got.toLowerCase().includes(String(value).toLowerCase().slice(0, 40));
    // still not what was asked: clear and type it once more (paced), then read it back again
    if (!typedOk && got != null) {
      await this.call("select_all", { ref: t.ref }).catch(() => {});
      await this.call("key", { name: "BackSpace" }).catch(() => {});
      await this.call("type", { text: String(value), ref: t.ref }, 60000);
      await sleep(150);
      got = (await this.call("value", { ref: t.ref }).catch(() => ({ value: got }))).value;
      typedOk = got != null && got.toLowerCase().includes(String(value).toLowerCase().slice(0, 40));
    }
    let text = typedOk ? `Typed ${JSON.stringify(value)} into ${this.label(t)} (verified: the field reads ${JSON.stringify(String(got).slice(0, 80))})`
      : `Typed ${JSON.stringify(value)} into ${this.label(t)} — UNVERIFIED: the field reads ${JSON.stringify(String(got ?? "").slice(0, 80))}`;
    if (pressEnter) {
      const before = await this.mark();
      await this.call("key", { name: "Return" });
      const w = await this.watch(before, { maxMs: 3000 });
      if (w.urlChanged) await this.waitSettled({ maxMs: 12000 });
      text += w.changed ? `; pressed Return. Transition observed: ${w.text}` : "; pressed Return. No transition observed";
    }
    return { text };
  }

  async selectOption(target, optionText) {
    const t = await this.find({ ref: target.ref, text: target.text, role: target.ref ? undefined : (target.role || "combo box") });
    if (t.error) return { text: t.error, isError: true };
    const want = String(optionText).trim().toLowerCase();
    this.actSeq++;
    if (t.el?.native_select) {
      const r = await this.call("choose_native", { ref: t.ref, option: optionText }).catch((e) => ({ err: e.message }));
      if (r.err) return { text: `FAILED: ${r.err}`, isError: true };
      if (r.missing) return { text: `No option found matching ${JSON.stringify(optionText)} in ${this.label(t)}. Options: ${r.options.join(" | ")}`, isError: true };
      const ok = String(r.now).toLowerCase() === String(r.chosen).toLowerCase();
      return { text: ok ? `Selected ${JSON.stringify(r.chosen)} in ${this.label(t)} [verified: the dropdown reads ${JSON.stringify(r.now)}]` : `FAILED: the dropdown reads ${JSON.stringify(r.now)}, not ${JSON.stringify(r.chosen)}`, isError: !ok };
    }
    // a custom dropdown: open it, find the option by name, click it, read the dropdown back
    const open = await this.click({ ref: t.ref });
    if (open.isError) return open;
    await sleep(350);
    const snap = await this.snapshot();
    const cands = snap.elements.filter((e) => e.ref !== t.ref && ["menu item", "radio button", "check box", "push button", "link", "list item"].includes(e.role));
    const o = cands.find((e) => e.name.trim().toLowerCase() === want) || cands.find((e) => e.name.trim().toLowerCase().startsWith(want)) || cands.find((e) => e.name.toLowerCase().includes(want));
    if (!o) return { text: `No option found matching ${JSON.stringify(optionText)} after opening ${this.label(t)}`, isError: true };
    const c = await this.click({ ref: o.ref });
    if (c.isError) return c;
    const st = await this.stateOf(t.ref);
    const reads = `${st?.value ?? ""} ${st?.name ?? ""}`.toLowerCase();
    return reads.includes(want) ? { text: `Selected ${JSON.stringify(o.name)} in ${this.label(t)} [verified: the dropdown reads ${JSON.stringify((st?.value || st?.name || "").slice(0, 60))}]` }
      : { text: `Selected ${JSON.stringify(o.name)} (clicked the option) — UNVERIFIED: the dropdown reads ${JSON.stringify((st?.value || st?.name || "").slice(0, 60))}. ${c.text}` };
  }

  async readSelected(target) {
    const t = await this.find({ ref: target.ref, text: target.text, role: target.ref ? undefined : "combo box" });
    if (t.error) return { text: t.error, isError: true };
    const st = await this.stateOf(t.ref);
    return { text: JSON.stringify({ ref: t.ref, selected: st?.value ?? null, shows: st?.name ?? null }) };
  }

  async dismiss({ dialog_ref, dialog_text, control_ref }) {
    if (dialog_ref || dialog_text) {
      const t = await this.find({ ref: dialog_ref, text: dialog_text, role: dialog_ref ? undefined : "dialog" });
      if (t.error) return { text: t.error, isError: true };
      const before = this.dialogs();
      await this.key("Escape");
      await sleep(350);
      const s = await this.stateOf(t.ref);
      const still = s && s.alive && s.w > 1 && s.h > 1;
      await this.snapshot().catch(() => {});
      const after = this.dialogs();
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

  // settled = the page can be USED: it has content and its change clock has been quiet for quietMs. Chrome's own
  // "loading" flag is NOT part of it by default (COMPUTER_USE_SETTLE=early): on real sites the flag stays up for seconds
  // while ads, trackers and images finish, long after the controls a step needs are there (Alex watched the Mac runs
  // wait on pages whose target had been on screen for a while; b7a: 45% of a round's time was tool time). The old rule
  // (wait for the flag too) is COMPUTER_USE_SETTLE=load. A page that never goes quiet returns "usable_changing" after
  // usableMs of having content. COMPUTER_USE_SETTLE_LOG=<file> logs every wait; with COMPUTER_USE_SETTLE_PROBE=1 a
  // background watcher also logs when the OLD rule would have returned, so the saving is measured, not guessed.
  // explicit: the planner ASKED to wait (wait_page_settled, wait_for_element). Then the full-load rule always applies:
  // under "early" such a wait returned in ~100 ms on any loading page with 6 elements, so it could not wait out a
  // "checking your browser" interstitial (d1b task 10: two waits of 86 and 108 ms, then "blocked"; Henry2's hand check).
  // The early rule is only for the settle an action does on its own.
  async waitSettled({ quietMs = 400, usableMs = 1500, maxMs = 15000, urlContains = null, notUrl = null, explicit = false } = {}) {
    const t0 = Date.now(), EARLY = !explicit && (process.env.COMPUTER_USE_SETTLE || "early") !== "load", MIN = 6;
    let readySince = null, contentSince = null, state = "loading", i = null, nEls = 0, lastCount = 0;
    const count = async () => { const s = await this.snapshot().catch(() => null); nEls = s ? s.elements.length : 0; return nEls; };
    const log = (o) => { const f = process.env.COMPUTER_USE_SETTLE_LOG; if (f) { try { fs.appendFileSync(f, JSON.stringify({ t: Date.now(), ...o }) + "\n"); } catch {} } };
    // nothing loaded and nothing of ours acted since the last settle: still settled
    i = await this.call("info").catch(() => null);
    if (i && !urlContains && this.settledAct === this.actSeq && this.settledLoads === i.loads && !i.busy && (!notUrl || i.url !== notUrl)) return { settled: true, reason: "already", state: "complete", ms: Date.now() - t0, ready_ms: 0, events: 0 };
    const startClock = i?.clock ?? 0;
    const done = (reason) => {
      this.settledAct = this.actSeq; this.settledLoads = i.loads;
      const r = { settled: true, reason, state, ms: Date.now() - t0, ready_ms: (readySince ?? contentSince ?? Date.now()) - t0, events: i.clock - startClock };
      log({ url: i.url, reason, ms: r.ms, busy: !!i.busy, elements: nEls, content_ms: contentSince != null ? contentSince - t0 : null });
      if (i.busy && process.env.COMPUTER_USE_SETTLE_PROBE === "1") this.probeLoad(t0, i.url, r.ms, log);
      return r;
    };
    while (Date.now() - t0 < maxMs) {
      i = await this.call("info").catch(() => null);
      if (i) {
        state = i.busy ? "loading" : "complete";
        const urlOk = (!urlContains || i.url.includes(urlContains)) && (!notUrl || i.url !== notUrl);
        if (urlOk && (EARLY || !i.busy)) {
          const now = Date.now();
          if (!i.busy) readySince = readySince ?? now; else readySince = null;
          // quiet: the change clock has been still for quietMs (and, once loaded, the page has been seen for 300 ms)
          const quiet = i.quiet_ms >= quietMs && (i.busy || now - readySince >= 300);
          const need = i.busy ? MIN : 2;                       // loading: real content; loaded: the address bar plus anything
          const since = i.busy ? contentSince : readySince;    // how long the page has been usable
          const due = quiet || (since != null && now - since >= usableMs);
          // a snapshot is not free: take one when a return is due, and every 500 ms while a loading page has shown nothing yet
          if (now - lastCount >= 250 && (due || (i.busy && contentSince == null && now - lastCount >= 500))) {
            lastCount = now;
            if ((await count()) >= need) {
              contentSince = contentSince ?? Date.now();
              if (quiet) return done(i.busy ? "usable_loading" : "quiet");
              if (since != null && Date.now() - since >= usableMs) return done("usable_changing");
            } else if (!i.busy && Date.now() - t0 >= maxMs - 500) return done(quiet ? "quiet" : "usable_changing");   // loaded and empty: the old rule's last resort
          }
        } else { readySince = null; }
      }
      await sleep(100);
    }
    log({ url: i?.url, reason: "timeout", ms: Date.now() - t0, busy: !!i?.busy, elements: nEls, content_ms: contentSince != null ? contentSince - t0 : null });
    return { settled: false, reason: "timeout", state, ms: Date.now() - t0, events: 0 };
  }
  // measurement only: when would the old rule (loading flag down + quiet) have returned for this wait?
  probeLoad(t0, url, earlyMs, log) {
    (async () => {
      const end = t0 + 20000;
      while (Date.now() < end) {
        await sleep(250);
        const i = await this.call("info").catch(() => null);
        if (!i) continue;
        if (i.url !== url) return log({ url, probe: "left_page", early_ms: earlyMs, ms: Date.now() - t0 });
        if (!i.busy && i.quiet_ms >= 400) return log({ url, probe: "load_rule", early_ms: earlyMs, ms: Date.now() - t0, saved_ms: Date.now() - t0 - earlyMs });
      }
      log({ url, probe: "still_loading_20s", early_ms: earlyMs, ms: 20000, saved_ms: 20000 - earlyMs });
    })().catch(() => {});
  }

  async screenshot(region) {
    const r = await this.call("screenshot", { region: region || null }, 20000).catch((e) => ({ err: e.message }));
    if (r.err) throw new Error(r.err);
    return { data: r.png, width: r.width, height: r.height, offset: region ? { x: region.x, y: region.y } : { x: 0, y: 0 } };
  }

  async pageText(maxChars = 4000000) { return (await this.call("text", { max_chars: maxChars }, 30000)).text; }

  async images(cap = 64, minPx = 0) {
    const s = this.last || (await this.snapshot());
    return s.elements.filter((e) => e.role === "image" && (e.w || 0) >= minPx && (e.h || 0) >= minPx).slice(0, cap).map((e) => ({ alt: e.name, src: e.href || null, w: Math.round(e.w), h: Math.round(e.h), y: Math.round(e.cy) }));
  }
}
