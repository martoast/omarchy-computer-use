// select_option reads the dropdown back (live Coach: type-ahead "selected"
// California while the page said "State is required.").
import { selectionReadBack } from "./index.js";

let failed = 0;
const eq = (label, got, want) => { const ok = got === want; if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${got}`}`); };

eq("selected option matches", selectionReadBack("California", { selected: "California" }).kind, "verified");
eq("case and spacing ignored", selectionReadBack("California", { selected: "  california " }).kind, "verified");
eq("a longer option label containing the choice", selectionReadBack("California", { selected: "California (CA)" }).kind, "verified");
eq("a different option is a contradiction", selectionReadBack("California", { selected: "Colorado" }).kind, "contradicted");
eq("displayed value counts when nothing reports selected", selectionReadBack("California", { selected: null, shown: "California" }).kind, "verified");
eq("a placeholder face is unknown, not verified", selectionReadBack("California", { selected: null, shown: "State" }).kind, "unknown");
eq("no read-back at all is unknown", selectionReadBack("California", null).kind, "unknown");
eq("a bridge error is unknown", selectionReadBack("California", { error: "no element" }).kind, "unknown");
eq("a one-letter choice never matches by containment", selectionReadBack("M", { selected: "XL - Medium Tall" }).kind, "contradicted");

if (failed) { console.log(`\nFAIL — ${failed} case(s)`); process.exit(1); }
console.log("\nPASS — dropdown read-back verdicts");
process.exit(0);
