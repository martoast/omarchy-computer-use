#!/usr/bin/env node
// Every tool's argument contract, checked at the REAL MCP boundary.
//
// The defect this guards: an unknown argument used to be silently DROPPED. A
// caller who typed `filterRole` instead of `filter_role` was handed the whole
// page with no error and no indication — an unfiltered read mistaken for a
// narrow one. Types and ranges were always validated; only unknown keys leaked.
//
// The tool list is DISCOVERED from the running server, never hard-coded. A
// hand-maintained list would pass forever while a newly added 23rd tool
// silently reopened the hole — the regression has to find tools it was never
// told about.
import "./test_support/temp_site_memory.mjs"; // never the user's own site memory
import { spawnHeadlessInstance, teardownHeadlessInstance, instanceEnv } from "./headless_instance.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

let pass = 0, fail = 0;
const check = (l, c, d = "") => { console.log(`${c ? "ok  " : "FAIL"} ${l}${c ? "" : "  <<< " + d}`); c ? pass++ : fail++; };
const info = (l, v) => console.log(`  · ${l}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

const handle = await spawnHeadlessInstance({ label: "tool-schemas" });
// Input counters are needed to PROVE a rejected call had no side effects,
// so this suite enables them for itself rather than depending on how it
// happens to be invoked.
const env = { ...process.env, ...instanceEnv(handle), COMPUTER_USE_TEST_INPUT_STATS: "1" };
const transport = new StdioClientTransport({ command: "node", args: [path.join(import.meta.dirname, "index.js")], cwd: import.meta.dirname, env });
const mcp = new Client({ name: "tool-schemas", version: "0.1.0" });
// A schema violation can surface EITHER as a thrown error or as an isError
// result carrying the -32602 message, depending on the call path. Both are the
// boundary refusing; treating only the throw as a refusal would have reported
// working validation as broken (it did, on the first run of this file).
const call = async (name, args) => {
  try {
    const r = await mcp.callTool({ name, arguments: args });
    const txt = r.content.map((c) => c.text).join("\n");
    const validation = /-32602|Input validation error/i.test(txt);
    return { rejected: validation, isError: !!r.isError, msg: txt, txt };
  } catch (e) { return { rejected: true, isError: true, msg: String(e.message), txt: String(e.message) }; }
};

try {
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  info("tools discovered from the live server", tools.length);
  check("the server advertises tools at all", tools.length > 0, `${tools.length}`);
  // get_input_stats is registered only when COMPUTER_USE_TEST_INPUT_STATS is
  // set, so the advertised count varies by one. The point of discovery is that
  // whatever IS advertised gets checked — not that the number is a constant.
  info("(note) test-only get_input_stats advertised?", tools.some((t) => t.name === "get_input_stats"));

  // ---------------------------------------------------------------- (a)
  // THE CONTRACT IS VISIBLE TO CLIENTS. additionalProperties:false is how a
  // caller can tell, without guessing, that unknown keys are refused.
  const loose = tools.filter((t) => t.inputSchema?.additionalProperties !== false);
  info("tools NOT advertising additionalProperties:false", loose.map((t) => t.name));
  check("(a) EVERY discovered tool advertises additionalProperties:false — a new tool added with a raw shape fails here",
    loose.length === 0, JSON.stringify(loose.map((t) => t.name)));

  // ---------------------------------------------------------------- (b)
  // EVERY tool rejects an unknown key. Table-driven over the DISCOVERED list,
  // so this covers tools that did not exist when the test was written.
  const accepted = [];
  for (const t of tools) {
    const r = await call(t.name, { __definitely_not_a_real_parameter__: 1 });
    const refused = r.rejected && /Unrecognized key|Input validation error/i.test(r.msg);
    if (!refused) accepted.push({ name: t.name, r });
  }
  info("(b) tools that did NOT reject an unknown key", accepted.map((a) => a.name));
  check("(b) every tool rejects an unknown argument at the MCP boundary",
    accepted.length === 0, JSON.stringify(accepted.slice(0, 3)));

  // ---------------------------------------------------------------- (c)
  // THE LIVE FAILURE that motivated this: a camelCase slip returned the whole
  // page as though it had been filtered.
  const typo = await call("read_page", { window_address: "headless", filterRole: "link" });
  check("(c) the camelCase typo `filterRole` is REFUSED, not silently ignored",
    typo.rejected && /Unrecognized key/i.test(typo.msg), JSON.stringify(typo).slice(0, 200));
  check("(c) and the error NAMES the offending key so the caller can fix it",
    typo.rejected && /filterRole/.test(typo.msg), String(typo.msg).slice(0, 200));

  // ---------------------------------------------------------------- (d)
  // Strictness must not have broken anything that already worked.
  const ok1 = await call("read_page", { window_address: "headless", filter_role: "link", limit: 5 });
  check("(d) a correct call still works", !ok1.rejected && !ok1.isError, JSON.stringify(ok1).slice(0, 160));
  const ok2 = await call("read_page", { window_address: "headless" });
  check("(d) defaults still apply when a key is omitted", !ok2.rejected && !ok2.isError, JSON.stringify(ok2).slice(0, 160));
  const bad1 = await call("read_page", { window_address: "headless", limit: 9999 });
  check("(d) out-of-range is still refused", bad1.rejected && /Too big/i.test(bad1.msg), String(bad1.msg).slice(0, 140));
  const bad2 = await call("read_page", { window_address: "headless", limit: "5" });
  check("(d) a wrong type is still refused", bad2.rejected && /expected number/i.test(bad2.msg), String(bad2.msg).slice(0, 140));
  const bad3 = await call("type_text", { window_address: "headless" });
  check("(d) a missing required argument is still refused", bad3.rejected, String(bad3.msg).slice(0, 140));

  const cropShot = await mcp.callTool({ name: "screenshot", arguments: { region: { x: 500, y: 300, width: 1400, height: 750 }, window_address: "headless" } });
  const cropText = cropShot.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const cropId = /screenshot_id=([^;]+)/.exec(cropText)?.[1];
  const translated = await mcp.callTool({ name: "click", arguments: { x: 220, y: 430, coordinate_space: "screenshot_crop", screenshot_id: cropId } });
  check("(d3) crop-local click is translated once at handler boundary", !translated.isError && /720,730/.test(translated.content.find((c) => c.type === "text")?.text || ""), cropText);
  const staleCrop = await call("click", { x: 220, y: 430, coordinate_space: "screenshot_crop", screenshot_id: cropId });
  check("(d3) consumed crop context is rejected as stale", staleCrop.rejected || staleCrop.isError, staleCrop.msg);
  const boundedShot = await mcp.callTool({ name: "screenshot", arguments: { region: { x: 500, y: 300, width: 1400, height: 750 }, window_address: "headless" } });
  const boundedId = /screenshot_id=([^;]+)/.exec(boundedShot.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"))?.[1];
  const pointerBefore = await mcp.callTool({ name: "get_input_stats", arguments: {} });
  const outOfBounds = await call("click", { x: 1400, y: 430, coordinate_space: "screenshot_crop", screenshot_id: boundedId });
  const pointerAfter = await mcp.callTool({ name: "get_input_stats", arguments: {} });
  check("(d3) out-of-bounds crop point is rejected", outOfBounds.rejected || outOfBounds.isError, outOfBounds.msg);
  check("(d3) out-of-bounds rejection has zero pointer side effects", pointerBefore.content[0].text === pointerAfter.content[0].text, `${pointerBefore.content[0].text} -> ${pointerAfter.content[0].text}`);

  // ---------------------------------------------------------------- (d2)
  // A REJECTED CALL MUST HAVE NO SIDE EFFECTS — proven by counters, not by the
  // presence of validation prose. `click` is the hazardous case: valid
  // coordinates plus one unknown key must move nothing and click nothing.
  // This is the other half of the token ruling: a rejected call never reaches
  // the handler, which is exactly why it must not invalidate recovery evidence
  // either (read_recovery proves the accepted-mutation half).
  const statsOf = async () => {
    const r = await mcp.callTool({ name: "get_input_stats", arguments: {} });
    return JSON.parse(r.content.map((c) => c.text).join("\n"));
  };
  let s0 = null;
  try { s0 = await statsOf(); } catch { s0 = null; }
  if (!s0) {
    info("(d2) get_input_stats unavailable", "requires COMPUTER_USE_TEST_INPUT_STATS=1 — side-effect assertion SKIPPED");
    check("(d2) input stats are available so the side-effect claim can be proven", false,
      "run with COMPUTER_USE_TEST_INPUT_STATS=1");
  } else {
    const rej = await call("click", { x: 7, y: 7, __unknown_key__: true });
    const s1 = await statsOf();
    check("(d2) a click carrying an unknown key is REJECTED", rej.rejected, JSON.stringify(rej).slice(0, 160));
    check("(d2) ...and moved the pointer ZERO times", s1.moves - s0.moves === 0, `moves ${s0.moves}->${s1.moves}`);
    check("(d2) ...and clicked ZERO times", s1.clicks - s0.clicks === 0, `clicks ${s0.clicks}->${s1.clicks}`);
    // The same call WITHOUT the unknown key really does act — otherwise the
    // zero-delta above would prove nothing about rejection.
    const ok = await call("click", { x: 7, y: 7 });
    const s2 = await statsOf();
    check("(d2) control: the SAME call without the unknown key is accepted", !ok.rejected, JSON.stringify(ok).slice(0, 140));
    check("(d2) ...and really does move and click, so the zero-delta above is meaningful",
      (s2.moves - s1.moves) >= 1 && (s2.clicks - s1.clicks) >= 1, `moves +${s2.moves - s1.moves} clicks +${s2.clicks - s1.clicks}`);
  }

  // ---------------------------------------------------------------- (e)
  // filter_state's vocabulary is closed: an invalid value is refused rather
  // than silently matching nothing, which would look identical to "no element
  // is in that state".
  const badState = await call("read_page", { window_address: "headless", filter_state: "banana" });
  check("(e) an invalid filter_state value is refused", badState.rejected, String(badState.msg).slice(0, 160));
  check("(e) and the refusal happens at the MCP boundary, before any handler work",
    badState.rejected && /Input validation error/i.test(badState.msg), String(badState.msg).slice(0, 160));
  for (const s of ["checked", "pressed", "selected", "focused", "expanded", "disabled"]) {
    const r = await call("read_page", { window_address: "headless", filter_state: s, limit: 20 });
    check(`(e) filter_state "${s}" is accepted`, !r.rejected, String(r.msg || "").slice(0, 120));
  }
} catch (e) {
  console.error("FAILED:", e.stack || e.message); fail++;
} finally {
  await mcp.close().catch(() => {});
  await teardownHeadlessInstance(handle);
}
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
