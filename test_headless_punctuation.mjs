#!/usr/bin/env node
// LOCAL reproduction of a chat-composer punctuation failure (live probe runs: the query containing "Dick's" came back
// "[NOT VERIFIED: no visible editable field contains the typed value…]" three
// times while the same query spelled "Dicks" verified). No retailer traffic:
// an isolated headless Chromium opens a page served by THIS process (a plain
// <textarea> labelled like a chat composer) and the MCP type_into_element tool
// types apostrophe/quote variants into it. The read-back tells which layer
// loses the character: the typing path (the field's text differs from the
// value) or the verification path (the field holds the value but verify_text
// still says no).
//
// Run: node test_headless_punctuation.mjs   (never wrap in timeout — teardown in finally)
import "./test_support/temp_site_memory.mjs"; // never the user's own site memory
import { spawnHeadlessInstance, teardownHeadlessInstance, instanceEnv } from "./headless_instance.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import path from "node:path";

// The page counts every observable side effect into its title (rev 15 inert proof): input events by kind
// (insertText vs deleteContentBackward vs line breaks), form submissions, keydowns carrying Ctrl/Alt/Meta on a
// non-modifier key, focus changes, selection changes, and which element is active. A keystroke that Chromium reads as
// Backspace shows up as deleteContentBackward, one read as Enter as a submit (input in a form) or a line break
// (textarea), one read as Tab as a focus change — none of which a plain text insertion produces.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>composer fixture</title></head>
<body><main><h1>Composer fixture</h1>
<label for="msg">Escribe tu mensaje</label>
<textarea id="msg" rows="3" cols="80" placeholder="Escribe tu mensaje"></textarea>
<button type="button">Enviar</button>
<form id="f"><label for="q">Consulta</label><input id="q" name="q" size="80"></form>
<script>
  const c = { input: 0, delBack: 0, lineBreak: 0, otherInput: 0, submit: 0, modKey: 0, modKeys: [], focusChanges: 0, selChanges: 0, active: "", passes: 0, lastMark: null };
  // Each typing pass of the server starts with its own select-all (Ctrl+a); snapshotting the counters there lets the
  // test judge the LAST pass (the plan under test) separately from the deliberately unchanged first pass.
  const mark = () => { c.passes++; c.lastMark = { input: c.input, delBack: c.delBack, lineBreak: c.lineBreak, submit: c.submit, modKey: c.modKey, focusChanges: c.focusChanges }; };
  const retitle = () => { c.active = document.activeElement && document.activeElement.id || document.activeElement && document.activeElement.tagName || ""; document.title = "composer fixture " + JSON.stringify(c); };
  document.addEventListener("input", (e) => { const t = e.inputType || ""; if (t === "insertText") c.input++; else if (t === "deleteContentBackward") c.delBack++; else if (t === "insertLineBreak" || t === "insertParagraph") c.lineBreak++; else c.otherInput++; retitle(); });
  // Every keydown carrying Ctrl/Alt/Meta on a non-modifier key is recorded by name; the server's own select-all
  // ("Ctrl+a" before typing) is the only one a clean run may contain.
  document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.altKey || e.metaKey) && !["Control", "Alt", "Meta", "Shift"].includes(e.key)) { c.modKey++; const name = (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + (e.metaKey ? "Meta+" : "") + e.key; if (name === "Ctrl+a") mark(); if (c.modKeys.length < 24) c.modKeys.push(name); } retitle(); });
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); c.submit++; retitle(); });
  document.addEventListener("focusin", () => { c.focusChanges++; retitle(); });
  document.addEventListener("selectionchange", () => { c.selChanges++; retitle(); });
  retitle();
</script></main></body></html>`;

// Ordinary values (an e-mail in a login field, a password, a short
// word) must verify on the FIRST, ordinary pass. A leading-dash value and the
// sentences that lose keystrokes (measured: the ordinary pass drops a leading
// "-" the same way it drops a leading quote) must still land exactly via the
// bounded segmented retry — never via Enter without exact read-back.
const ORDINARY = new Set(["margarett.waelchi@example.net", "password", "abc"]);
// rev 15.1: values whose ordinary argv carried a keymap-position hazard now get the position-safe plan on the FIRST
// pass and must land in exactly one pass ("-flag": "-"@0; the quoted sentence: '"'@0; the Dick's sentence: "."@28 =
// LEFTCTRL, the "Ctrl+." keydown on HEAD; the 98-char query and the bracketed values: "["@0; the seeded strings).
const RETRY_OK = new Set();
const VALUES = process.env.PUNCTUATION_VALUES ? JSON.parse(process.env.PUNCTUATION_VALUES) : [
  "margarett.waelchi@example.net",
  "password",
  "abc",
  "-flag",
  "Dicks Sporting Goods",
  "Dick's Sporting Goods",
  "Dick’s Sporting Goods",
  "Muéstrame ofertas actuales de tenis para correr en Dick's Sporting Goods; verifica en vivo el precio y la disponibilidad.",
  "\"quoted\" and 'single' and it’s",
  // rev 15: the 98-character QA query of the live run. Attempt 1 loses its leading "[" (keymap index 0 = ESC), and the
  // old segmented retry parked ";" on index 13 = BACKSPACE, deleting the "t" before it ("…Walmar verify…", field diff at 72).
  "[QA-rev131] Current rollback price on men's Nike running shoes at Walmart; verify price and image.",
  // rev 15: attempt 1 loses "[" (ESC); under the old segmented plan ";" is index 13 = BACKSPACE (deletes the "k" before
  // it) and "," is index 14 = TAB — the measurement for both positions in one value.
  "[abcdefghijk;,",
];
// rev 15: values typed into the <input> INSIDE A FORM, where a keystroke read as Enter is an implicit submission.
// "[abcdefghijklmnopqrstuvwxy;" — 27 distinct characters; attempt 1 loses "[" (ESC) so the retry runs, and the old
// segmented plan parked ";" (its 27th distinct entry after Shift_L) on index 27 = ENTER. MEASURED (2026-09-02, HEAD
// plan): the ";" LANDED and the form did NOT submit — Blink runs InsertNewline only from a keypress whose character is
// a carriage return, and this keypress carries ";". The Enter position is therefore not an insertion hazard; rev 15
// still never assigns it (conservative cap), and this value stays as the measurement that pins that fact.
const ENTER_POSITION = "[abcdefghijklmnopqrstuvwxy;";
// Three seeded adversarial strings (fixed LCG, same generator shape as test_input_safety.mjs; alphabet restricted to
// characters the fixture already proves typeable: ASCII letters/digits/space/punctuation plus é and ’). Selection rule,
// stated because attempt 1 is deliberately unchanged in rev 15: the ordinary single invocation parks the value's
// characters at their first-appearance index with NO head, so a punctuation-dense value can put a mark on index 13
// (Backspace), 14 (Tab) or 27 (Enter = implicit submit) during the FIRST pass — effects rev 15 does not touch (they are
// the rev 15.1 case). To exercise the rev 15 retry under the inert proof, a string is kept only if its ordinary argv
// has exactly one hazard and it is index 0 (ESC: the first character is cancelled, nothing else happens), so the first
// pass fails harmlessly and the segmented plan must land the whole value with zero side effects.
const ORDINARY_TYPEWRITER = new Set([2,3,4,5,6,7,8,9,10,11,12,13, 16,17,18,19,20,21,22,23,24,25,26,27, 30,31,32,33,34,35,36,37,38,39,40,41, 43,44,45,46,47,48,49,50,51,52,53, 57, 86]);
const ordinaryHazardIndices = (value) => { const seen = []; for (const ch of value) if (!seen.includes(ch)) seen.push(ch); return seen.map((ch, i) => (!/^[0-9A-Za-z]$/.test(ch) && !ORDINARY_TYPEWRITER.has(i + 1) ? i : -1)).filter((i) => i >= 0); };
const adversarial = (() => {
  let seed = 0x0badf00d >>> 0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const ALPHABET = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789    !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~é’"];
  const out = [];
  let guard = 0;
  while (out.length < 3 && guard++ < 100000) {
    const len = 40 + Math.floor(rnd() * 41);
    let v = ""; for (let i = 0; i < len; i++) v += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    const hazards = ordinaryHazardIndices(v);
    if ((v.match(/[^0-9A-Za-z ]/g) || []).length >= 6 && !/^\s|\s$/.test(v) && hazards.length === 1 && hazards[0] === 0) out.push(v);
  }
  if (out.length !== 3) throw new Error("adversarial selection did not converge");
  return out;
})();
const FORM_VALUES = process.env.PUNCTUATION_VALUES ? [] : [ENTER_POSITION, ...adversarial];
const FIRST_PASS_NOW = new Set(["-flag", "Muéstrame ofertas actuales de tenis para correr en Dick's Sporting Goods; verifica en vivo el precio y la disponibilidad.", "\"quoted\" and 'single' and it’s", "[QA-rev131] Current rollback price on men's Nike running shoes at Walmart; verify price and image.", "[abcdefghijk;,", ENTER_POSITION, ...adversarial]);

const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const handle = await spawnHeadlessInstance({ label: "punctuation-unit", initialUrl: url });
const env = { ...process.env, ...instanceEnv(handle) };
const transport = new StdioClientTransport({ command: "node", args: [path.join(import.meta.dirname, "index.js")], cwd: import.meta.dirname, env });
const mcp = new Client({ name: "punctuation-unit", version: "0.1.0" });
const text = (r) => r.content.find((c) => c.type === "text")?.text || "";
// Direct AT-SPI read of the textarea (independent of the MCP read-back), so the
// verdict says what actually landed, character by character.
import { spawn } from "node:child_process";
const readField = (name = "Escribe tu mensaje") => new Promise((res) => {
  const c = spawn("python3", ["-c", `
import warnings; warnings.filterwarnings('ignore')
import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi
import sys, json
pid=int(sys.argv[1]); d=Atspi.get_desktop(0); app=None
for i in range(d.get_child_count()):
    a=d.get_child_at_index(i)
    try:
        if a and a.get_process_id()==pid: app=a; break
    except: pass
def find(acc,depth=0):
    if depth>40: return None
    try:
        if acc.get_role_name()=='entry' and sys.argv[2] in (acc.get_name() or ''): return acc
    except: return None
    try: n=acc.get_child_count()
    except: return None
    for i in range(n):
        c=acc.get_child_at_index(i)
        if c is not None:
            f=find(c,depth+1)
            if f: return f
    return None
e=find(app)
if e is None: print(json.dumps(None)); sys.exit(0)
ti=e.get_text_iface(); n=Atspi.Text.get_character_count(ti)
print(json.dumps(Atspi.Text.get_text(ti,0,n) if n>0 else ''))
`, String(handle.chromiumPid), name], { env });
  let o = ""; c.stdout.on("data", (d) => o += d); c.on("close", () => { try { res(JSON.parse(o.trim())); } catch { res(null); } });
});
const firstDiff = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return a.length === b.length ? -1 : n; };
const results = [];
let code = 0;
try {
  await mcp.connect(transport);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let page = "";
  for (let i = 0; i < 20; i++) {
    page = text(await mcp.callTool({ name: "read_page", arguments: { window_address: "headless", include_text: true, limit: 200 } }));
    if (/Escribe tu mensaje/.test(page)) break;
    await sleep(500);
  }
  const refOf = (name) => new RegExp(`^(e\\d+)\\t(?:entry|text)\\t"${name}"`, "m").exec(page)?.[1];
  const ref = refOf("Escribe tu mensaje");
  if (!ref) throw new Error(`textarea not found in read_page:\n${page.slice(0, 1200)}`);
  const formRef = refOf("Consulta");
  if (!formRef) throw new Error(`form input not found in read_page:\n${page.slice(0, 1200)}`);
  const counters = (pageText) => { const m = /^# composer fixture (\{.*\}) - Chromium/m.exec(pageText); return m ? JSON.parse(m[1]) : null; };
  const readCounters = async () => counters(text(await mcp.callTool({ name: "read_page", arguments: { window_address: "headless", include_text: false, limit: 5 } })));
  const TARGETS = [
    { name: "Escribe tu mensaje", id: "msg", ref, values: VALUES },
    { name: "Consulta", id: "q", ref: formRef, values: FORM_VALUES },
  ];
  for (const target of TARGETS) for (const value of target.values) {
    const before = await readCounters();
    const typed = text(await mcp.callTool({ name: "type_into_element", arguments: { ref: target.ref, window_address: "headless", value, clear: true } }));
    const after = await readCounters();
    const verified = /\[verified/i.test(typed) && !/NOT VERIFIED/i.test(typed);
    const actual = await readField(target.name);
    const landed = actual === value;
    const diffAt = typeof actual === "string" ? firstDiff(actual, value) : -2;
    const firstPass = /\[verified: text present/.test(typed); // the retry path reports its method instead
    const passesSoFar = after && before ? after.passes - before.passes : 0;
    const pathOk = ORDINARY.has(value) ? firstPass : FIRST_PASS_NOW.has(value) ? (firstPass && passesSoFar === 1) : true; // ordinary and first-pass-now values must not need the fallback; RETRY_OK values may use it
    // rev 15 inert proof: the only landed effects of typing are text insertions into the target.
    const delta = (k) => (after && before ? after[k] - before[k] : NaN);
    const newModKeys = after && before ? after.modKeys.slice(before.modKeys.length) : null;
    // The LAST pass is the plan under test (attempt 1 is deliberately unchanged in rev 15 and may lose or Ctrl-tag a
    // character on its own): judge it from the counters snapshot at its select-all.
    const lastMark = after && before && after.passes > before.passes ? after.lastMark : null;
    const lastPass = lastMark ? { submit: after.submit - lastMark.submit, delBack: after.delBack - lastMark.delBack, lineBreak: after.lineBreak - lastMark.lineBreak, input: after.input - lastMark.input, modKeys: newModKeys.slice(newModKeys.lastIndexOf("Ctrl+a") + 1) } : null;
    const passes = after && before ? after.passes - before.passes : 0;
    const inert = !!lastPass && delta("submit") === 0 && lastPass.delBack === 0 && lastPass.lineBreak === 0 && lastPass.modKeys.length === 0 && after.active === target.id;
    const effects = after && before ? { submit: delta("submit"), delBack: delta("delBack"), lineBreak: delta("lineBreak"), modKeys: newModKeys, passes, lastPass, input: delta("input"), otherInput: delta("otherInput"), focusChanges: delta("focusChanges"), selChanges: delta("selChanges"), active: after.active } : null;
    results.push({ target: target.id, value, verified, landed, diffAt, actual, typed: typed.slice(0, 220), firstPass, pathOk, inert, effects });
    console.log(JSON.stringify({ target: target.id, value, verified, landed, firstPass, pathOk, inert, effects, diffAt, actualLen: typeof actual === "string" ? actual.length : null, valueLen: value.length, typed: typed.slice(0, 140) }));
  }
  const failures = results.filter((r) => !r.verified || !r.landed || !r.pathOk || !r.inert);
  if (failures.length) { code = 2; console.error(`FAIL — PUNCTUATION: ${failures.length} of ${results.length} values did not round-trip inertly: ${failures.map((f) => `${f.target}:${JSON.stringify(f.value.slice(0, 30))} verified=${f.verified} landed=${f.landed} diffAt=${f.diffAt} inert=${f.inert} effects=${JSON.stringify(f.effects)}`).join(" | ")}`); }
  else console.log(`PASS — headless punctuation typing: ${results.length} values verified, landed and inert (no submit, no backspace, no line break, no modified key, focus kept)`);
} catch (error) {
  code = 1;
  console.error("punctuation reproduction error:", error?.stack || error);
} finally {
  await mcp.close().catch(() => {});
  await teardownHeadlessInstance(handle).catch(() => {});
  server.close();
}
process.exit(code);
