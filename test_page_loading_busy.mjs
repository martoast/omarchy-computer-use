// A page Chromium reports BUSY can expose only part of its tree (live Coach bag:
// no "Proceed to Checkout" for ~30 s after launch). read_after_navigation keeps
// polling while busy within its budget, and says so if it runs out.
import { readAfterNavigationAction, PAGE_LOADING_NOTE } from "./index.js";

let failed = 0;
const check = (label, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — ${detail}`}`); };

const URL_ = "https://www.coach.com/shopping-bag";
const row = (ref, role, name) => ({ ref, role, name, cx: 10, cy: 10, in_doc: true, doc_class: "page" });
const partial = [row("e1", "heading", "My Bag (1)"), row("e2", "static", "Total $54.00")];
const full = [...partial, row("e3", "button", "Proceed to Checkout")];

async function run(frames, timeout_ms) {
  let clock = 0, i = 0;
  const deps = {
    resolveWindow: async () => ({ pid: 1, at: [0, 0] }),
    readUri: async () => URL_,
    snapshot: async () => frames[Math.min(i++, frames.length - 1)],
    getToken: () => null, recordVisit: async () => {}, learnSearchRoute: async () => {},
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  };
  const r = await readAfterNavigationAction({ expected_url: URL_, expected_heading: "My Bag", timeout_ms, poll_ms: 300 }, deps);
  return r.content[0].text;
}

const busy = { elements: partial, page: { url: URL_, title: "Shopping Bag", busy: true } };
const done = { elements: full, page: { url: URL_, title: "Shopping Bag" } };

let text = await run([busy, busy, done], 7000);
check("waits out BUSY and returns the complete tree", text.includes("Proceed to Checkout") && !text.includes("page still loading"), text.slice(0, 200));
text = await run([busy], 1000);
check("budget spent while busy → ready, with the loading note", text.startsWith("[navigation ready") && text.includes(PAGE_LOADING_NOTE.trim()), text.slice(0, 200));
text = await run([done], 7000);
check("a loaded page returns on the first poll without the note", text.includes("Proceed to Checkout") && !text.includes("page still loading"), text.slice(0, 200));

if (failed) { console.log(`\nFAIL — ${failed} case(s)`); process.exit(1); }
console.log("\nPASS — busy pages are waited out or flagged");
process.exit(0);
