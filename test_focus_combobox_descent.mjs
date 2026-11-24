// Fixture pin for the focus_editable_at combobox descent (atspi_bridge.py).
//
// Best Buy wraps its search <input> in an ARIA combobox: a click lands on the combobox, which is not itself
// EDITABLE, so the editable-only search finds nothing under the point and typing goes nowhere (prod logged
// focus_editable_at found=false there). This drives a real headless instance against a deterministic localhost
// page and pins the three paths:
//   editable        — a plain <input>, and an <input role=combobox> (Chromium maps it to an editable AT-SPI
//                     "combo box"): the click is on the input; the primary editable-at-point search focuses it.
//   combobox_inner  — a <div role=combobox> wrapper (a non-editable "combo box" node) whose <input> sits far
//                     from the click: no editable under the point, so the descent focuses the inner input.
//   found:false     — empty space is a no-op the caller ignores.
import "./test_support/temp_site_memory.mjs"; // never the user's own site memory
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnHeadlessInstance, teardownHeadlessInstance, instanceEnv } from "./headless_instance.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// #plain: a normal input. #cb: <input role=combobox> (editable combo box). #wrap: a non-editable combobox
// wrapper whose inner #q sits at its right edge, far from a left-side click; the wrapper eats mousedown so a
// click never reaches #q (Best Buy's behaviour). #s mirrors document.activeElement + its value for assertions.
const page = `<!doctype html><meta charset=utf-8><title>combobox-descent</title>
<style>input{position:absolute;box-sizing:border-box}#plain{left:400px;top:200px;width:340px;height:32px}
#cb{left:400px;top:280px;width:340px;height:34px}
#wrap{position:absolute;left:400px;top:360px;width:600px;height:44px;border:1px solid #888}
#q{position:absolute;right:8px;top:10px;width:130px;height:24px}</style>
<h1 id="s">idle</h1>
<input id="plain" placeholder="Plain">
<input id="cb" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="lcb" placeholder="Search combobox">
<ul id="lcb" role="listbox" style="position:absolute;display:none"></ul>
<div id="wrap" role="combobox" tabindex="0" aria-label="Search store" aria-expanded="false" aria-haspopup="listbox" aria-owns="lw">
  <input id="q" role="searchbox" aria-autocomplete="list"><ul id="lw" role="listbox" style="display:none"></ul>
</div>
<script>const s=document.getElementById("s");
document.getElementById("wrap").addEventListener("mousedown",e=>{if(e.target.id!=="q")e.preventDefault()});
const paint=()=>{const el=document.activeElement;const v=(el&&"value"in el)?el.value:"";
  s.textContent='focus='+(el?el.tagName+"#"+el.id:"NONE")+' val="'+v+'"'};
document.addEventListener("focusin",paint);document.addEventListener("input",paint);
document.addEventListener("focusout",()=>setTimeout(paint,0));paint();</script>`;

const server = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let handle, client;
try {
  handle = await spawnHeadlessInstance({ label: "combobox-descent", initialUrl: `http://127.0.0.1:${server.address().port}/` });
  client = new Client({ name: "combobox-descent", version: "1" });
  await client.connect(new StdioClientTransport({ command: "node", args: [path.join(ROOT, "index.js")], cwd: ROOT,
    env: { ...process.env, ...instanceEnv(handle), AUTOMATION_BACKEND: "headless", COMPUTER_USE_MANUAL_TOOLS: "1" } }));
  const call = async (n, a = {}) => (await client.callTool({ name: n, arguments: a })).content?.filter((i) => i.type === "text").map((i) => i.text).join("\n") || "";
  const status = async () => (await call("read_page", { include_text: true, limit: 60 })).match(/focus=\S+ val="[^"]*"/)?.[0] || "?";
  const nodeAt = (tree, role, name) => { const m = tree.match(new RegExp(`^\\S+\\t${role}\\t"${name}"\\t@(\\d+),(\\d+)`, "m")); return m ? { x: Number(m[1]), y: Number(m[2]) } : null; };
  await sleep(2500);
  const tree = await call("read_page", { limit: 80 });

  // --- combobox_inner: the descent path (Best Buy) ---
  const wrap = nodeAt(tree, "combo box", "Search store");
  assert.ok(wrap, "the <div role=combobox> wrapper must surface as a non-editable AT-SPI combo box node");
  const wx = wrap.x + 30, wy = wrap.y + 22; // left of the wrapper, far from #q on the right
  await call("click", { x: wx, y: wy }); await sleep(250);
  assert.match(await status(), /focus=BODY/, "a click on the wrapper must NOT reach the inner input on its own");
  const fInner = JSON.parse(await call("focus_editable_at", { x: wx, y: wy }));
  assert.equal(fInner.found, true);
  assert.equal(fInner.path, "combobox_inner", "must descend into the wrapper for the inner input");
  assert.equal(fInner.focused, true);
  await sleep(200);
  assert.match(await status(), /focus=INPUT#q/, "the descent must focus the inner input #q");
  await call("type_text", { text: "running shoes" }); await sleep(300);
  assert.match(await status(), /focus=INPUT#q val="running shoes"/, "typing must land in the descended input");

  // --- editable: the primary path is unchanged (plain input, and an editable <input role=combobox>) ---
  const plain = nodeAt(tree, "entry", "Plain");
  assert.ok(plain, "the plain input must surface as an editable entry");
  const fPlain = JSON.parse(await call("focus_editable_at", { x: plain.x + 20, y: plain.y + 15 }));
  assert.equal(fPlain.found, true); assert.equal(fPlain.path, "editable", "a plain input keeps the direct editable path");
  const cb = nodeAt(tree, "combo box", "Search combobox");
  assert.ok(cb, "<input role=combobox> must surface as a combo box node");
  const fCb = JSON.parse(await call("focus_editable_at", { x: cb.x + 20, y: cb.y + 16 }));
  assert.equal(fCb.found, true);
  assert.equal(fCb.path, "editable", "an editable <input role=combobox> is taken by the primary path, not the descent");

  // --- found:false: empty space is a no-op ---
  assert.deepEqual(JSON.parse(await call("focus_editable_at", { x: 5, y: 5 })), { found: false }, "empty space must be a no-op");
} finally {
  try { await client?.close(); } catch {}
  if (handle) await teardownHeadlessInstance(handle);
  server.close();
}
console.log("PASS — focus_editable_at combobox descent (editable / combobox_inner / found:false)");
