// node test_clean_href.mjs — which link clicks may become a direct address-bar navigation.
import { cleanHrefDirectEligible } from "./navigation_ready.js";
let pass = 0, fail = 0;
const check = (label, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"} ${label}`); };
const page = "https://www.example.org/news";
check("a link to another page on the same site is eligible", cleanHrefDirectEligible("https://www.example.org/about", page) === true);
check("another origin is not eligible", cleanHrefDirectEligible("https://ads.example.net/x", page) === false);
// instructure.com "About Us" (2026-11-23): href="#" opens a mega menu; navigating to it changes nothing.
check("href=\"#\" on this page is not a navigation", cleanHrefDirectEligible("https://www.example.org/news#", page) === false);
check("an in-page anchor is not a navigation", cleanHrefDirectEligible("https://www.example.org/news#team", page) === false);
check("the page's own address is not a navigation", cleanHrefDirectEligible("https://www.example.org/news", page) === false);
check("same path with a different query IS a navigation", cleanHrefDirectEligible("https://www.example.org/news?page=2", page) === true);
check("without a known current page the old rule stands", cleanHrefDirectEligible("https://www.example.org/news#", null) === true);
console.log(fail ? `FAIL — ${pass} passed, ${fail} failed` : `PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
