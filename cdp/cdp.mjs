// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket (Node >= 22): one browser connection,
// flat sessions per page target. No dependencies.

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map(); // "sessionId|Method" -> Set(fn)
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { code: msg.error.code }));
        else p.resolve(msg.result);
        return;
      }
      for (const key of [`${msg.sessionId || ""}|${msg.method}`, `*|${msg.method}`]) {
        const hs = this.handlers.get(key);
        if (hs) for (const h of [...hs]) { try { h(msg.params || {}, msg.sessionId); } catch {} }
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
      this.pending.clear();
      this.closed = true;
    });
  }

  static async connect(httpUrl, { timeoutMs = 15000 } = {}) {
    const t0 = Date.now();
    let info;
    for (;;) {
      try { info = await (await fetch(`${httpUrl.replace(/\/$/, "")}/json/version`)).json(); break; }
      catch (e) { if (Date.now() - t0 > timeoutMs) throw new Error(`no browser answering at ${httpUrl}: ${e.message}`); await new Promise((r) => setTimeout(r, 200)); }
    }
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Error("websocket error")), { once: true }); });
    const c = new CDP(ws);
    c.version = info;
    return c;
  }

  send(method, params = {}, sessionId = undefined, { timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(method, fn, sessionId = "*") {
    const key = `${sessionId}|${method}`;
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key).add(fn);
    return () => this.handlers.get(key)?.delete(fn);
  }

  close() { try { this.ws.close(); } catch {} }
}

// One page target, attached with a flat session. Tracks network requests in flight and the main frame's URL.
export class PageSession {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp; this.targetId = targetId; this.sessionId = sessionId;
    this.inflight = new Map(); // requestId -> started ms
    this.lastNetwork = Date.now();
    this.loadState = "unknown";
    const on = (m, fn) => cdp.on(m, fn, sessionId);
    on("Network.requestWillBeSent", (p) => { if (p.type !== "WebSocket" && p.type !== "EventSource") this.inflight.set(p.requestId, Date.now()); this.lastNetwork = Date.now(); });
    const done = (p) => { this.inflight.delete(p.requestId); this.lastNetwork = Date.now(); };
    on("Network.loadingFinished", done); on("Network.loadingFailed", done);
    on("Page.frameStartedLoading", () => { this.loadState = "loading"; });
    on("Page.loadEventFired", () => { this.loadState = "loaded"; });
    on("Page.javascriptDialogOpening", (p) => { this.jsDialog = p; });
    on("Page.javascriptDialogClosed", () => { this.jsDialog = null; });
  }
  send(method, params = {}, opts) { return this.cdp.send(method, params, this.sessionId, opts); }
  // requests started in the last 10 s that are still open (long polls and beacons older than that do not hold a page "busy")
  busyRequests() { const now = Date.now(); let n = 0; for (const t of this.inflight.values()) if (now - t < 10000) n++; return n; }
  async init() {
    await Promise.all([this.send("Page.enable"), this.send("Network.enable"), this.send("Runtime.enable"), this.send("DOM.enable"), this.send("Accessibility.enable")]);
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});
    // native alert/confirm dialogs would freeze the page for every later call: accept alerts, refuse the rest, and say so
    this.cdp.on("Page.javascriptDialogOpening", (p) => {
      this.lastJsDialog = { type: p.type, message: String(p.message || "").slice(0, 200) };
      this.send("Page.handleJavaScriptDialog", { accept: p.type === "alert" || p.type === "beforeunload" }).catch(() => {});
    }, this.sessionId);
  }
  async evaluate(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result?.value;
  }
}
