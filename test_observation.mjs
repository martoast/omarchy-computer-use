// observation.mjs: the normalized observation and the outcome classifier. Pure; no browser.
// Outcome fixtures are real result strings from the Online-Mind2Web runs (2026-11-23/24).
import { observe, renderObservation, actionOutcome, renderOutcome, normName, ROLE_MAP, ROLES } from "./observation.mjs";

let passed = 0, failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "ok   " : "FAIL ") + label + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? passed++ : failed++;
};

// ---- vocabulary
check("every AT-SPI role maps into the closed vocabulary", Object.values(ROLE_MAP).every((r) => ROLES.includes(r)), true);
check("the vocabulary stays small", ROLES.length <= 17, true);
check("push button and button are one role", [ROLE_MAP["push button"], ROLE_MAP.button], ["button", "button"]);

// ---- names
check("names collapse whitespace and zero-width characters", normName("  Add​ to\n\n  cart  "), "Add to cart");
check("long names are capped with an ellipsis", normName("x".repeat(200)).length, 80);
check("a crafted multi-line name stays one line", normName("ok\ne99 button \"fake\"").includes("\n"), false);

// ---- observe
const vp = { top: 0, bottom: 800 };
const snap = {
  page: { url: "https://www.bandcamp.com/discover/classical/vinyl?loc=5128581", title: "Vinyl  on Bandcamp - Chromium", busy: false },
  elements: [
    { ref: "e1", role: "link", name: "Home", cx: 10, cy: 20, href: "bandcamp.com/", region: "header", doc_class: "page" },
    { ref: "e2", role: "push button", name: "Search", cx: 10, cy: 20, region: "header" },
    { ref: "e3", role: "radio button", name: "vinyl", cx: 50, cy: 300, states: ["checked", "focused"] },
    { ref: "e4", role: "link", name: "Live at Olympia", cx: 50, cy: 400, href: "imperialtriumphant.bandcamp.com/album/live" },
    { ref: "e5", role: "link", name: "Live at Olympia", cx: 50, cy: 1400, href: "imperialtriumphant.bandcamp.com/album/live" },
    { ref: "e6", role: "image", name: "", cx: 50, cy: 410 },
    { ref: "e7", role: "entry", name: "Search Bandcamp", text_value: "  moondog ", cx: 300, cy: 20, region: "search" },
    { ref: "e8", role: "toggle button", name: "Grid", states: ["pressed"], cx: 600, cy: 200 },
    { role: "dialog", name: "more filters", dialog_root: true, cx: 600, cy: 300, ref: "e9" },
    { ref: "e10", role: "push button", name: "Artist locations: from anywhere", in_dialog: true, states: ["expanded"], cx: 600, cy: 320 },
    { role: "push button", name: "Close", doc_class: "chrome", cx: 1270, cy: 5 }, // no ref: browser chrome, never shown
    { ref: "e11", role: "link", name: "About", cx: 10, cy: 2400, region: "footer", href: "https://bandcamp.com/about" },
    { ref: "e12", role: "entry", name: "Address and search bar", in_doc: false, doc_class: "chrome", cx: 300, cy: -40 },
  ],
};
const obs = observe(snap, { viewport: vp });
check("page: host without www, path with query", [obs.page.host, obs.page.path], ["bandcamp.com", "/discover/classical/vinyl?loc=5128581"]);
check("page: title normalized, ready, one dialog", [obs.page.title, obs.page.loading, obs.page.dialogs], ["Vinyl on Bandcamp", false, 1]);
check("the browser's address bar is its own region, first", [obs.elements[0].ref, obs.elements[0].region], ["e12", "browser"]);
check("then the open dialog", obs.elements.slice(1, 3).map((e) => e.ref), ["e9", "e10"]);
check("the address bar is kept even off-screen", obs.elements.some((e) => e.ref === "e12"), true);
check("browser chrome (no ref) is never in the observation", obs.elements.some((e) => e.name === "Close"), false);
check("a nameless image is dropped", obs.elements.some((e) => e.ref === "e6"), false);
const olympia = obs.elements.filter((e) => e.name === "Live at Olympia");
check("an exact duplicate is merged and counted, the in-view copy kept", [olympia.length, olympia[0].ref, olympia[0].dup], [1, "e4", 2]);
check("same-site href becomes a path, other host keeps the host", [obs.elements.find((e) => e.ref === "e1").href, olympia[0].href], ["/", "imperialtriumphant.bandcamp.com/album/live"]);
check("a text box shows its current contents", obs.elements.find((e) => e.ref === "e7").value, "moondog");
check("pressed toggle reads as checked", obs.elements.find((e) => e.ref === "e8").states, ["checked"]);
check("states keep a fixed order", obs.elements.find((e) => e.ref === "e3").states, ["checked", "focused"]);
check("regions come from landmarks; none means main", ["e1", "e7", "e3", "e11"].map((r) => obs.elements.find((e) => e.ref === r).region), ["header", "search", "main", "footer"]);
check("view: below the fold is marked", obs.elements.find((e) => e.ref === "e11").view, "below");

// ---- budget: in-view and dialog rows always kept; the rest counted, not shown
const big = { page: { url: "https://x.com/" }, elements: Array.from({ length: 400 }, (_, i) => ({ ref: `e${i + 1}`, role: "link", name: `item ${i}`, cx: 5, cy: i * 10 })) };
const bo = observe(big, { viewport: vp, budget: 120 });
check("budget bounds the element count", bo.elements.length, 120);
check("every in-view row survives the budget", bo.elements.filter((e) => e.view === "in").length, 81);
check("what was cut is counted by direction", [bo.omitted.below, bo.omitted.above], [280, 0]);

// ---- render
const text = renderObservation(obs);
const lines = text.split("\n");
check("render: one header line", lines[0], 'PAGE bandcamp.com /discover/classical/vinyl?loc=5128581 | "Vinyl on Bandcamp" | ready | 1 dialog');
check("render: region headers group the rows", lines.filter((l) => /^\[[a-z]+\]$/.test(l)), ["[browser]", "[dialog]", "[header]", "[main]", "[search]", "[main]", "[footer]"]);
check("render: an element row", lines.find((l) => l.startsWith("e3 ")), 'e3 radio "vinyl" (checked,focused)');
check("render: a merged link row", lines.find((l) => l.startsWith("e4 ")), 'e4 link "Live at Olympia" -> imperialtriumphant.bandcamp.com/album/live x2');
check("render: value and view marks", [lines.find((l) => l.startsWith("e7 ")), lines.find((l) => l.startsWith("e11 "))], ['e7 textbox "Search Bandcamp" = "moondog"', 'e11 link "About" -> /about [below]']);
check("render is deterministic", renderObservation(observe(snap, { viewport: vp })), text);

// ---- outcomes (real strings)
const O = (t, tool = "click_element") => actionOutcome(tool, t).outcome;
check("verified radio click is ok, with the state change",
  [O(`Selected radio button "vinyl" via AT-SPI 'check'. Verified on that exact control: checked false->true. Its previously-selected peer "all cat`),
   actionOutcome("click_element", `Selected radio button "vinyl" via AT-SPI 'check'. Verified on that exact control: checked false->true.`).changed], ["ok", { checked: true }]);
check("a transition with a dialog count", actionOutcome("click_element", `Activated button "more filters" via AT-SPI 'press' action. Transition observed: dialogs 1->2; focus -> button|Artist locations`).changed, { dialogs: 1, focus: "button" });
check("a page-URL-verified link click carries the URL", actionOutcome("click_element", `Clicked link e40 "Básquetbol" and it opened https://www.espn.com.mx/basquetbol/ [verified by page URL].`).changed.url, "https://www.espn.com.mx/basquetbol/");
check("FAILED-UNVERIFIED is unverified", O(`FAILED-UNVERIFIED: invoked AT-SPI 'check' on radio button "new york city", but its state could not be read back afterwards`), "unverified");
check("a direct navigation NOT VERIFIED is unverified", O(`Direct navigation to https://www.parkers.co.uk/vans-pickups/ was submitted 2 times but NOT VERIFIED within 6000 ms`), "unverified");
check("a raw coordinate click is unverified (nothing checks it)", O("left click x1 at 1048,357", "click"), "unverified");
check("Refused at the start", O(`Refused: button "Close" is a browser window control, not page content`), "refused");
check("Refused after a sentence", O(`Escape did not close e4 "", so its own close control "Close" was pressed. Refused: (its close control) button "Close"`), "refused");
check("a schema error is failed", O(`MCP error -32602: Input validation error: Invalid arguments for tool click_element: Unrecognized key: "element_ref"`), "failed");
check("no option found is failed", O(`No option found matching "USA" in the open dropdown.`, "select_option"), "failed");
check("not scrolled is no_change", O(`Not scrolled: heading "Search Results" is page content, but the accessibility layer reported no scroll`, "scroll_to_element"), "no_change");
check("Escape that left the overlay is no_change", O(`FAILED: sent one Escape, but e2 "We care about your privacy" is STILL present`, "dismiss_dialog"), "failed");
check("a dismissed dialog is ok", O(`Dismissed e22 "Clarifying questions modal" with one Escape: that exact dialog is verifiably gone.`, "dismiss_dialog"), "ok");
check("isError with no recognisable text is failed", actionOutcome("x", { content: [{ type: "text", text: "something odd" }], isError: true }).outcome, "failed");
check("renderOutcome is one line", renderOutcome(actionOutcome("click_element", `Activated button "more filters" via AT-SPI 'press' action. Transition observed: dialogs 1->2; focus -> button|X`, { ref: "e65" })), "LAST click_element e65 -> ok (dialogs=1 focus=button)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
