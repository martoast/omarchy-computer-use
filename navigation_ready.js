const CONTENT_ROLES_FOR_READY = new Set(["heading", "link", "button", "entry", "combo box", "paragraph", "static"]);

function stableProductIdentity(pathname) {
  const path = pathname.replace(/\/+$/, "");
  const matches = [
    ["product", path.match(/\/(?:p\/[^/]+\/)?product\/(\d{6,})(?:\/color\/(\d+))?$/i)],
    ["itm", path.match(/\/itm\/(\d{6,})$/i)],
    ["ip", path.match(/\/ip\/(?:[^/]+\/)?(\d{6,})$/i)],
    // `.html` SKU tail where the canonical URL rewrites the marketing slug to a
    // placeholder: Foot Locker's `/product/nike-v5-rnr-mens/J5228001.html` lands
    // on `/product/~/J5228001.html`. The SKU is the identity; the slug is not.
    // The `/product/` prefix and the alphanumeric-with-a-digit SKU are both
    // required, so a category or content `.html` page carries no identity.
    ["html-sku", path.match(/\/product\/[^/]+\/((?=[a-z0-9]*\d)[a-z0-9]{6,})\.html$/i)],
  ];
  const found = matches.find(([, match]) => match);
  return found ? `${found[0]}:${found[1][1].toUpperCase()}:${found[1][2] || ""}` : null;
}

function sameDestinationPath(expected, observed) {
  const path = (url) => url.pathname.replace(/\/+$/, "") || "/";
  if (path(expected) === path(observed)) return true;
  const expectedIdentity = stableProductIdentity(expected.pathname);
  return expectedIdentity != null && expectedIdentity === stableProductIdentity(observed.pathname);
}

// Product-detail URL recognition, in two GENERAL families — no per-store
// paths. Live gap that motivated family (b) and the widened marker set:
// `product-link-missing` timed out on REI, Macy's and Nordstrom Rack while
// product links were plainly present in the snapshot, because the marker set
// listed `products` but not the singular `product` (REI `/product/<id>/<slug>`,
// Macy's `/shop/product/<slug>`), and Nordstrom Rack's `/s/<slug>/<id>` shape
// carries no marker segment at all.
//
// (a) MARKER SEGMENT: a path segment from the conventional product-namespace
//     vocabulary followed by at least one more segment. This subsumes the
//     former bespoke `/product/x/y/sku/N` alternative.
const PRODUCT_MARKER_PATH = /\/(?:ip|itm|dp|pd|p|t|prd|prod|product|products|sku)\/[^/?#]+(?:\/[^/?#]+)?/i;
// (b) SLUG + STABLE ID: a hyphenated word-slug segment followed by a terminal
//     numeric id of >=5 digits (optionally a single letter prefix, e.g.
//     Target's `A-79399156`). Both halves are required on purpose: a bare
//     `/c/12345` or `/browse/12345` category id has no multi-word slug, and a
//     slug with a 1-3 digit tail is a paging/section link, not a SKU. That is
//     what keeps this family from swallowing category pages.
const PRODUCT_SLUG_ID_PATH = /\/[a-z0-9]+(?:-[a-z0-9]+)+\/(?:[a-z]-)?\d{5,}\/?$/i;

// Content/category routes that carry a slug+id yet are NOT products (Walmart's `/cp/<slug>/<id>` curated
// shelves — "Get it Fast", "New Arrivals" — would otherwise match the generic slug+id family below).
const CONTENT_ROUTE_PATH = /^\/(?:cp|cat|category)(?:\/|$)/i;
// (c) TERMINAL SKU .html PDP: a `.../<sku-code>.html` file whose SKU token carries a
//     run of >=4 digits — the shape used by many Salesforce Commerce Cloud / .html
//     storefronts (Lacoste `.../polos/L1312-51.html`, Hugo Boss `…/hbna50123.html`,
//     Kipling/Ralph Lauren `…/12345.html`). The >=4-digit run is the SKU signal: a
//     word-only category file (`/polos.html`, `/clothing.html`) has no such run, so
//     this can't swallow category pages. Requires a preceding path segment (depth).
const PRODUCT_HTML_SKU_PATH = /\/[^/?#]+\/[a-z0-9][a-z0-9_-]*\d{4,}[a-z0-9_-]*\.html?(?:[?#]|$)/i;
//   - a hyphenated product slug, then a CODE file whose digits are not in one run: Michael Kors
//     `/signature-logo-cotton-blend-hoodie/OS552J948U.html` (2026-10-31: three digits at most in a row, so one of the two results of
//     "men signature logo hoodie" was not a product and the search came back empty). 8-14 letters and digits, at least 3 digits and 2
//     letters (2026-11-12: MK's trainers are "43F6NKFS3L" — four digits — so its whole women's sneakers grid was not products and Karla's
//     "Sale de tenis para dama MK" showed the page's scarf rail instead). Its slugs may end in a stray hyphen ("keely-tassel-suede-trainer-/").
const PRODUCT_SLUG_CODE_HTML_PATH = /\/[a-z0-9]+(?:-[a-z0-9]+)+-?\/(?=(?:[a-z]*\d){3})(?=(?:\d*[a-z]){2})[a-z0-9]{8,14}\.html?(?:[?#]|$)/i;
export function productShapedPath(pathname) {
  const path = String(pathname || "");
  if (CONTENT_ROUTE_PATH.test(path)) return false;
  return PRODUCT_MARKER_PATH.test(path) || PRODUCT_SLUG_ID_PATH.test(path) || PRODUCT_HTML_SKU_PATH.test(path) || PRODUCT_SLUG_CODE_HTML_PATH.test(path);
}

// Some platforms carry the product IDENTITY in the QUERY, not the path: Gap Inc (Gap, Old Navy) uses
// `/browse/product.do?pid=<digits>`, which productShapedPath rejects (no `/product/<seg>` and no slug+id).
// These name a single-product ROUTE — never a plural listing ("products"), category, or search route.
const PRODUCT_ROUTE_SEGMENTS = new Set(["product", "productpage", "pdp", "prod"]);
// Numeric product-id query keys. A specific product only — a category id (`cid`) or a search key is excluded,
// so a listing page that carries an id query is never misread as a product.
const PRODUCT_ID_QUERY_KEYS = new Set(["pid", "productid", "prodid", "skuid", "partnumber"]);

// Is this URL a single-PRODUCT page? True when the PATH is product-shaped (Target /p/…, /prod/…, Shopify
// /products/<slug>, Nordstrom Rack slug+id — via productShapedPath), OR — for the query-identity platforms —
// when BOTH a single-product route segment is in the path AND a product-id query key carries a numeric value.
// Both halves are required for the query shape, exactly like isSearchShapedUrl, so a category/listing page that
// merely carries an id query is excluded. No per-store branch.
export function productShapedUrl(url) {
  let parsed;
  try { parsed = new URL(String(url ?? "")); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (productShapedPath(parsed.pathname)) return true;
  const onProductRoute = parsed.pathname.split("/").filter(Boolean).some((raw) => {
    const segment = raw.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]/g, "");
    return PRODUCT_ROUTE_SEGMENTS.has(segment);
  });
  if (!onProductRoute) return false;
  for (const [rawKey, value] of parsed.searchParams) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (PRODUCT_ID_QUERY_KEYS.has(key) && /^\d{3,}$/.test(String(value).trim())) return true;
  }
  return false;
}

// Are two URLs the SAME product page? Host + path must match; and where the product identity lives in the QUERY
// (Gap Inc /browse/product.do?pid=…), the product-id key must match too — so two DIFFERENT Gap products (same
// path, different pid) are not conflated, unlike equivalentProductUrl (host+path only, query ignored). Hash and
// incidental query params (searchText, vid, tracking) are ignored, so a PDP that self-mutates its URL after load
// (Gap drops searchText and settles the hash) stays the same product and its candidate read is not aborted as a
// navigation. Anything unparseable is "not the same" (fail closed, as the prior raw compare did).
export function sameProductUrl(a, b) {
  let x, y;
  try { x = new URL(String(a)); y = new URL(String(b)); } catch { return false; }
  if (x.hostname.toLowerCase().replace(/^www\./, "") !== y.hostname.toLowerCase().replace(/^www\./, "")) return false;
  if (x.pathname.replace(/\/+$/, "") !== y.pathname.replace(/\/+$/, "")) return false;
  const pid = (u) => { for (const [k, v] of u.searchParams) if (PRODUCT_ID_QUERY_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, ""))) return String(v).trim(); return null; };
  const px = pid(x), py = pid(y);
  return px === null || py === null ? true : px === py;
}

// Is this URL a SEARCH-RESULTS route? Both halves are required, and that is the
// whole point: a recognised search route in the PATH *and* a recognised search
// key carrying a non-empty value in the QUERY. Requiring only the query key
// would classify any product or category page that happens to carry `?q=` as a
// results page — the exact over-classification that would let a homepage
// carousel establish a search destination it never reached.
//
// Path vocabulary is normalised (lowercased, extension stripped, punctuation
// removed) so Best Buy's `/site/searchpage.jsp` and eBay's `/sch/i.html` are
// recognised without per-store paths. The short exact names are listed rather
// than pattern-matched because they carry no "search" substring: Amazon `/s`,
// eBay `/sch`. Nordstrom Rack's PRODUCT path `/s/<slug>/<id>` also begins with
// `s`, which is precisely why the query-key half is mandatory — that URL has no
// search key and stays excluded.
const SEARCH_PATH_SEGMENTS = new Set(["s", "sch", "srch", "find", "results"]);
const SEARCH_QUERY_KEYS = new Set(["q", "query", "k", "st", "kw", "nkw", "keyword", "keywords",
  "searchterm", "searchtext", "searchquery", "term", "text", "ntt"]);

export function isSearchShapedUrl(url) {
  let parsed;
  try { parsed = new URL(String(url ?? "")); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const onSearchRoute = parsed.pathname.split("/").filter(Boolean).some((raw) => {
    const segment = raw.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]/g, "");
    return segment.includes("search") || SEARCH_PATH_SEGMENTS.has(segment);
  });
  if (!onSearchRoute) return false;
  for (const [rawKey, value] of parsed.searchParams) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SEARCH_QUERY_KEYS.has(key) && String(value).trim() !== "") return true;
  }
  return false;
}

function sameSiteProductLink(entry, expected) {
  if (entry.doc_class !== "page" || entry.role !== "link" || !entry.href) return false;
  try {
    const href = new URL(entry.href, expected);
    if (href.origin !== expected.origin) return false;
    return productShapedPath(href.pathname);
  } catch { return false; }
}

// Readiness evidence may come from TWO walks of the same tree: the broad
// include-text snapshot (which spends its element budget on EVERYTHING in
// pre-order, so a large header/facet region can exhaust it before the first
// product tile) and a role-filtered link scan (which spends budget only on
// matches, so it reaches the results region regardless of what precedes it).
// Merging is evidence-ADDITIVE only: every fail-closed gate downstream
// (same-origin, product-shaped path, page document class) still applies to
// every merged entry, so the union can never make a non-results page ready.
// Dedupe is by the stable D-Bus object path when present — the same identity
// refs use — with a structural fallback for entries that lack one, keeping the
// primary snapshot's entry (and therefore its ref) on collision.
export function mergeReadinessElements(primary = [], supplement = []) {
  const key = (el) => el.obj_path || `${el.role}\u001f${el.name || ""}\u001f${el.href || ""}\u001f${el.cx},${el.cy}`;
  const seen = new Set(primary.map(key));
  const merged = [...primary];
  for (const el of supplement) {
    const k = key(el);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(el);
  }
  return merged;
}

// The supplementary link scan can cure exactly ONE broad-readiness failure:
// product-link-missing on a TRUNCATED snapshot. Every other reason is beyond a
// scan's reach — destination-mismatch means the navigation has not arrived
// (audited: the scan used to fire ~0.65s per poll against the capped OLD page
// while the URL was still in flight), url-and-dialog is already ready and the
// scan only delayed surfacing the dialog, and an uncapped snapshot covered the
// whole tree so a second walk of it can prove nothing more. One more curable
// state exists: a query-mismatch poll that is INDEPENDENTLY eligible for the
// canonical-rewrite acceptance if link evidence existed — the caller derives
// canonicalRewriteEligible from canonicalSearchRewriteReady with hypothetical
// hasProductLink:true, only for a query-mismatch reason. There the scan
// supplies exactly the evidence the real rewrite decision needs, and that real
// decision, with ACTUAL candidates, remains the fail-closed authority after
// the union. Ordinary/ineligible query mismatch stays closed. Pure so the gate
// is deterministic-testable without a browser.
export function shouldRunLinkScan({ acceptProductLink = false, candidateCount = 0, elementCount = 0, limit = 0, reason = "", canonicalRewriteEligible = false } = {}) {
  // The rewrite-eligibility flag is meaningful ONLY for a query-mismatch
  // reason, and the predicate enforces that itself: a caller passing
  // canonicalRewriteEligible=true alongside destination-mismatch or
  // url-and-dialog must not be able to reopen the wasted scans this gate
  // exists to prevent.
  return acceptProductLink === true && candidateCount === 0
    && limit > 0 && elementCount >= limit
    && (reason === "product-link-missing"
      || (reason.startsWith("query-mismatch:") && canonicalRewriteEligible === true));
}

export function productLinkCandidates(elements, expectedUrl, limit = 5) {
  let expected;
  try { expected = new URL(expectedUrl); } catch { return []; }
  return elements.filter((entry) => sameSiteProductLink(entry, expected)).slice(0, limit);
}

// A same-origin storefront ROOT that canonically redirects to its locale home
// (vans.com/ -> vans.com/en-us) is the requested destination, not a mismatch —
// treating it as one cost 7s of pointless polling on a first visit. Deliberately
// narrow: it applies ONLY when the request was the bare origin root, and only
// to a locale-shaped path (`/en-us`, `/us`, `/us/en`). Any other redirect is
// still a mismatch, and the content evidence below (heading / product link /
// page content) is unchanged, so this relaxes the URL check only.
const LOCALE_HOME_PATH = /^\/[a-z]{2}(?:[-_][a-z]{2})?(?:\/[a-z]{2}(?:[-_][a-z]{2})?)?\/?$/i;
function canonicalLocaleHome(expected, observed) {
  return (expected.pathname === "/" || expected.pathname === "") && LOCALE_HOME_PATH.test(observed.pathname);
}
/** A storefront's HOME path: the bare root or the locale-home shape above (`/en-us`, `/us`, `/us/en`). Pure; generic by construction — never a store's own markup. */
export function storefrontRootPath(pathname) {
  const path = String(pathname ?? "");
  return path === "" || path === "/" || LOCALE_HOME_PATH.test(path);
}

// Conservative, generic blocker/loading/auth wording a store serves at the SAME
// URL instead of the page: bot-mitigation interstitials, rate-limit waits,
// access denials, login walls, error pages. Matched against page HEADINGS only,
// and only on the no-expected-heading product-page path. Deliberately
// conservative: a genuine product heading that happens to contain one of these
// words ("Error-Proof … Login Board Game") also fails closed here; the caller
// can then pass the exact heading it read, which takes the authoritative
// heading-match path above and is unaffected by this list.
const INTERSTITIAL_TEXT = /\b(?:access denied|please wait|sorry for the wait|verify (?:that )?you(?:'re| are)(?: a)? human|are you a (?:human|robot)|captcha|robot check|security check|checking your browser|just a moment|one more step|sign in|log in|login|something went wrong|page not found|not found|forbidden|service unavailable|temporarily unavailable|too many requests|rate limit(?:ed)?|error)\b/i;

/** PURE. Same registrable domain (last two labels; enough for the stores we carry). */
export function sameStore(a, b) {
  const site = (h) => h.toLowerCase().split(".").slice(-2).join(".");
  return a.protocol === b.protocol && site(a.hostname) === site(b.hostname);
}

/** PURE. Same store (registrable domain) and a cart/checkout link that landed on a checkout page. */
export function checkoutRedirect(expected, observed) {
  const site = (h) => h.toLowerCase().split(".").slice(-2).join(".");
  if (expected.protocol !== observed.protocol || site(expected.hostname) !== site(observed.hostname)) return false;
  return /\/(?:cart|carts|checkout|checkouts)(?:\/|$)/i.test(expected.pathname) && /\/checkouts?(?:\/|$)/i.test(observed.pathname);
}

export function navigationReady({ expectedUrl, observedUrl, observedTitle, expectedHeading, acceptProductLink = false, elements = [] } = {}) {
  let expected, observed;
  try { expected = new URL(expectedUrl); observed = new URL(observedUrl); } catch { return { ready: false, reason: "invalid-url" }; }
  // "www." is the same store (live Owala 2026-09-26: expected www.owalalife.com, the store serves owalalife.com,
  // and the read waited out its whole 7 s timeout on a page that had arrived).
  const bareOrigin = (u) => `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, "")}`;
  // A store's cart link that redirects into its checkout has arrived (live Gymshark 2026-09-26: expected
  // us.checkout.gymshark.com/cart/c/…, landed on /checkouts/cn/…; the read waited out 7 s on a loaded checkout).
  if (checkoutRedirect(expected, observed)) return { ready: true, reason: "checkout-redirect" };
  // The same store moved us to one of its own regional hosts for the SAME page (live DFYNE 2026-09-26: from a MX
  // exit us.dfyne.com/products/x lands on dfyne.com/products/x): it has arrived — the region is the agent's next
  // concern, not a 7 s wait. Same registrable domain AND same path only.
  if (bareOrigin(expected) !== bareOrigin(observed) && sameStore(expected, observed) && sameDestinationPath(expected, observed)) {
    return { ready: true, reason: "same-store-regional-redirect" };
  }
  if (bareOrigin(expected) !== bareOrigin(observed)) return { ready: false, reason: "destination-mismatch" };
  if (!sameDestinationPath(expected, observed) && !canonicalLocaleHome(expected, observed)) return { ready: false, reason: "destination-mismatch" };
  // Amazon's th / psc only ask its page to show that variant; it drops them once loaded (2026-10-07: a pinned /dp/<ASIN>?th=1&psc=1
  // read as "not ready, query-mismatch:psc" on the page that had arrived, and the quote steps were handed back)
  // …and a Shopify product page's ?variant= (live Owala 2026-10-07: /products/freesip?variant=… is rewritten on load to
  // ?selectionType=local&Color=…; the read waited out its 7 s and the quote's steps were handed to the model, ~20 s): the page shows
  // that variant; the add guard checks the chosen options on the page before any add
  const displayHint = (key) => (/(?:^|\.)amazon\.com$/i.test(expected.hostname) && /^(?:th|psc)$/.test(key))
    || (key === "variant" && /\/products\/[^/]+\/?$/.test(expected.pathname));
  for (const [key, value] of expected.searchParams) if (!displayHint(key) && observed.searchParams.get(key) !== value) return { ready: false, reason: `query-mismatch:${key}` };
  if (elements.some((entry) => entry.doc_class === "page" && entry.role === "dialog"
      && (entry.modal === true || entry.states?.includes("modal")))) return { ready: true, reason: "url-and-dialog" };
  const needle = String(expectedHeading || "").trim().toLowerCase();
  const headings = elements.filter((entry) => entry.doc_class === "page" && entry.role === "heading" && entry.name);
  const hasProductLink = elements.some((entry) => sameSiteProductLink(entry, expected));
  const hasPageContent = elements.some((entry) => entry.doc_class === "page" && CONTENT_ROLES_FOR_READY.has(entry.role));
  if (acceptProductLink && !hasProductLink) return { ready: false, reason: "product-link-missing" };
  if (needle && !headings.some((entry) => entry.name.toLowerCase().includes(needle))) {
    // Some product pages commit their document title before exposing the main
    // heading through AT-SPI. Accept that signal only for a verified product
    // destination with real page content; generic/search pages still require
    // their semantic heading (or the explicit product-link fallback above).
    if (!acceptProductLink && productShapedPath(observed.pathname) && hasPageContent
        && String(observedTitle || "").toLowerCase().includes(needle)) {
      return { ready: true, reason: "url-and-title" };
    }
    if (!acceptProductLink) return { ready: false, reason: "heading-missing" };
    return { ready: true, reason: "url-and-product-link" };
  }
  if (acceptProductLink) return { ready: true, reason: "url-heading-and-product-link" };
  if (!needle && !hasPageContent) return { ready: false, reason: "content-missing" };
  // A PRODUCT destination read without an expected heading (the caller did not
  // know the page's exact heading and must not guess the tile title) stays
  // fail-closed: the exact URL plus a GENUINE page heading is required, not
  // just any content — a bare shell, a loading page or an interstitial that
  // kept the URL exposes buttons/statics but no product heading — and a
  // heading that is itself a blocker/loading/auth message ("Access Denied",
  // "Please wait", "Verify you are human", "Sign in") is not product evidence
  // either: a same-URL interstitial must never read as the product page.
  if (!needle && productShapedPath(observed.pathname)) {
    if (headings.length === 0) return { ready: false, reason: "content-missing" };
    if (headings.some((entry) => INTERSTITIAL_TEXT.test(entry.name))) return { ready: false, reason: "interstitial-page" };
  }
  return { ready: true, reason: needle ? "url-and-heading" : "url-and-content" };
}

// ONE reviewed sentence, used verbatim in the three places that otherwise
// forbid re-searching (this readiness guidance, the fast-agent system prompt
// and parallel_search's preloaded task paragraph) so they can never disagree.
// Live failure it closes (Target, 2026-09-02, engine session 1030): the
// preloaded Spanish route /s?searchTerm=tenis%20para%20correr was structurally
// ready but every candidate was unrelated (anti-chafe, T-shirts, books, clogs);
// three earlier runs recovered with one "running shoes" search at turn 2 and
// reached the PDP by turn 6, the fourth obeyed "do not resubmit" literally and
// reported blocked at turn 2. The browser model translates; there is no
// glossary. The loop enforces the "exactly one" bound (fast_agent.mjs).
export const CORRECTED_SEARCH_RULE = "If NONE of the listed candidates is the requested product type — typical when a localized (e.g. Spanish) query is not understood by the store — do exactly ONE corrected search: type a concise 2–4 word English product phrase into the site's search field (clear true, press Enter) or into the advertised searchUrlPattern, then read the new results once and choose from them. Never do this when at least one listed candidate is relevant, never resubmit the same keywords, and never a second time; if the corrected results are still unrelated, report blocked.";

/** The site-search query carried by a search-shaped URL, or null. */
export function searchQueryFromUrl(url) {
  let parsed;
  try { parsed = new URL(String(url ?? "")); } catch { return null; }
  for (const [rawKey, value] of parsed.searchParams) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SEARCH_QUERY_KEYS.has(key) && String(value).trim() !== "") return String(value).trim();
  }
  return null;
}

export function navigationReadyGuidance(reason) {
  if (["url-and-product-link", "url-heading-and-product-link", "url-query-rewritten-and-product-link"].includes(reason)) {
    return `[search results ready: do not reopen, clear, or resubmit search; choose a relevant same-origin, product-shaped candidate listed below; do not use a screenshot while candidates are listed. If a browser permission prompt or banner appears after this, the destination stays established — do not restart the search; press Escape once if it is browser UI, then do ONE broad read_page to refresh content and obtain FRESH candidate refs, since a re-render can stale the refs listed here, and act on a fresh candidate. ${CORRECTED_SEARCH_RULE}]`;
  }
  return "";
}

export function cleanHrefReached(expectedUrl, observedUrl) {
  try {
    const expected = new URL(expectedUrl);
    const observed = new URL(observedUrl);
    if (expected.origin !== observed.origin || !sameDestinationPath(expected, observed)) return false;
    for (const [key, value] of expected.searchParams) {
      if (observed.searchParams.get(key) !== value) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function transientBrowserNavigationError(elements = []) {
  const text = elements.map((entry) => [entry?.name, entry?.value, entry?.text].filter(Boolean).join(" ")).join("\n");
  return /ERR_HTTP2_PROTOCOL_ERROR/i.test(text) ? "http2-protocol-error" : null;
}

export function canonicalSearchRewriteReady({ expectedUrl, observedUrl, token, hasProductLink = false } = {}) {
  if (!hasProductLink || !token || token.state !== "pending" || token.requestedUrl !== expectedUrl) return false;
  if (token.prevPage?.state !== "known" || !observedUrl || observedUrl === token.prevPage.uri) return false;
  try {
    const expected = new URL(expectedUrl), observed = new URL(observedUrl);
    if (expected.origin !== observed.origin) return false;
    if (expected.pathname.replace(/\/+$/, "") !== observed.pathname.replace(/\/+$/, "")) return false;
    return expected.search.length > 1 && observed.search.length > 1;
  } catch { return false; }
}

export function cleanHrefDirectEligible(href, currentPageUrl = null) {
  try {
    const url = new URL(href);
    // Direct address-bar navigation is only a replacement for activating a
    // link on the CURRENT storefront.  A sponsored/off-site href may be a
    // perfectly valid URL, but navigating to it would silently bypass the
    // bridge's [OFF-SITE REDIRECT] warning and the caller's intent to stay on
    // the store.  When the current page is known, require exact origin parity.
    if (currentPageUrl != null) {
      const current = new URL(currentPageUrl);
      if (current.origin !== url.origin) return false;
    }
    // Macy's product tiles expose slug-only hrefs that 404 when loaded
    // directly; their page action supplies the product identity/router state.
    if (/(^|\.)macys\.com$/i.test(url.hostname)
        && /^\/shop\/product\/[^/]+\/?$/i.test(url.pathname)
        && !url.searchParams.has("ID")) return false;
    return true;
  } catch {
    return false;
  }
}

// A semantic-link fallback is permitted only with positive evidence that the
// omnibox submission never left the original page and with an exact live
// accessibility identity to activate. Missing/moved URL observations and
// browser error pages stay fail-closed because the navigation may be in flight.
export function shouldFallbackToSemanticLink({ href, beforeUrl, observedUrl, recovery, objPath } = {}) {
  return !recovery
    && typeof objPath === "string" && objPath.length > 0
    && cleanHrefDirectEligible(href, beforeUrl)
    && typeof beforeUrl === "string" && beforeUrl === observedUrl
    && shouldResubmitNavigation(beforeUrl, observedUrl);
}

// Should a clean-href address-bar navigation that has not yet reached its
// destination be SUBMITTED AGAIN, or merely waited on?
//
// Live cost that motivated this (Zappos, 12-20s per click_element): the
// direct-href path submitted the URL twice unconditionally whenever the first
// readiness poll expired. On a slow page the second submission ABORTS the
// still-loading first navigation and restarts it, so the page load is paid
// twice for no added certainty. The URL the browser is showing tells the two
// cases apart: if it POSITIVELY never left the pre-submit URL, the keystrokes
// genuinely did not take and resubmitting is the fix; anything else means the
// only thing possibly missing is time. Verification is unchanged — acceptance
// still requires cleanHrefReached against the real observed URL.
//
// The burden of proof runs one way only. An earlier version resubmitted when
// the URL could not be read at all, on the reasoning that "nothing observable
// proves nothing happened" — which is exactly backwards, and cost a live
// Zappos navigation a second submission and 14.2s ("submitted 2 times but NOT
// VERIFIED: the page is at an unobservable URL"; it had in fact navigated, and
// read_after_navigation went on to accept it). An unreadable URL is the ABSENCE
// of evidence, not evidence of absence. So resubmission requires positive
// proof: an exact, unchanged, OBSERVABLE WEB PAGE URL. Everything else waits
// out the bounded same-submission grace window and then fails honestly.
//
// "Web page URL" is load-bearing, not decoration. `chrome-error://chromewebdata/`
// and `file:///...` both parse successfully, so parseability alone would let two
// identical error-page readings buy a resubmission — and an error page is
// precisely the state where the browser HAS moved. Only http(s) is a real
// pre-submit page destination in this flow; credentials are rejected because a
// URL carrying them is not a reading to act on.
export function shouldResubmitNavigation(beforeUrl, observedUrl) {
  if (typeof beforeUrl !== "string" || typeof observedUrl !== "string") return false;
  if (!beforeUrl || !observedUrl || observedUrl !== beforeUrl) return false;
  let url;
  try { url = new URL(observedUrl); } catch { return false; } // an unparseable reading proves nothing
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !url.username && !url.password;
}

// ── Failed-destination classes (whole-row semantics) ────────────────────────
// Used by the supervisor's ONE bounded homepage recovery after a preloaded
// search destination rendered the store's own application-error page (New
// Balance conversation 52, 2026-09-02). Two DISJOINT closed classes, each
// matched against a WHOLE heading/static/paragraph row — never a bare
// substring like "error", "sorry", "login" or "please wait" inside prose:
//   challenge          — bot mitigation / access denial / login wall: NEVER recoverable
//   application_error  — the store's application/server error page, or a
//                        structured navigation-error text: recoverable once
// Challenge wins when both appear. Empty shells, loading pages, ordinary
// headings and product titles that merely contain one of these words are null.
const ROW_TRAIL = "[\\s.!…]*";
// rev 31 (live human check, 2026-09-03): the page said "Robot or human?" and
// "Activate and hold the button to confirm that you're human" on a "/blocked"
// route — none of it was in this vocabulary, so the challenge was never
// classified, the profile ledger recorded a completed session and the
// quarantine never fired. The families below are generic anti-bot phrasings.
const CHALLENGE_ROW = new RegExp("^(?:access denied|403 forbidden|forbidden|captcha|robot check|security check|checking your browser(?: before accessing[^\\n]{0,80}?)?|just a moment|one more step|please wait|sorry for the wait|too many requests|429 too many requests|rate limited|are you a (?:human|robot)\\??|verify (?:that )?you(?:'re|’re| are)(?: a)? human|please verify you are a human"
  + "|(?:press|tap|click) (?:&|and) hold(?: to confirm (?:that )?you(?:'re|’re| are)(?: a human(?: \\(and not a bot\\))?)?)?|robot or human\\??|human or robot\\??|(?:activate|press|click|hold) (?:and hold )?(?:the )?button[^\\n]{0,60}?(?:human|robot)|confirm (?:that )?you(?:'re|’re| are)(?: a)? human|let us know you(?:'re|’re| are)(?: a)? human|prove you(?:'re|’re| are) (?:not a robot|(?:a )?human)|verify your identity|unusual traffic[^\\n]{0,80}?|we(?:'ve|’ve| have) detected unusual (?:traffic|activity)[^\\n]{0,80}?|human verification(?: required)?|bot detection)" + ROW_TRAIL + "$", "i");
// Login-wall copy is matched on HEADING rows only (rev 11): a storefront's
// header routinely carries a static/link "Sign in", which is not a wall.
const LOGIN_WALL_HEADING_ROW = new RegExp("^(?:sign in(?: to continue)?|log ?in(?: to continue)?|login required|please (?:sign|log) in(?: to continue)?)" + ROW_TRAIL + "$", "i");
// rev 14 (live Dick's run, 2026-09-02): the retailer's own interstitial said
// "We're sorry! The site is currently unavailable" under the document title
// "Site Unavailable" with an Akamai-style reference line, and none of it matched:
// the "we're sorry" alternative wanted "something went wrong", the
// "unavailable" alternatives wanted "service/temporarily", the code alternative
// wanted the word "code", and the title never reaches a row at all — so the
// run fell to verification_incomplete instead of store_error. Three generic,
// store-free additions: UNAVAILABILITY_ROW (whole-row "the site/service/page/
// store is currently unavailable / down / under maintenance", the "we're sorry"
// form of it, "down for maintenance"), REFERENCE_CODE_ROW (the
// segment.hex.epoch.hex reference shape, with or without a "reference #/no./
// code/id" label — a classification HINT only, never a bypass, never logged
// beyond the class), and a document-TITLE vocabulary (whole-title, anchored,
// after stripping ONLY the trailing " - Chromium"; a product or results title
// such as "Error-Proof Login Board Game | Target" can never match).
const UNAVAILABILITY_ROW = "(?:the )?(?:site|service|page|store) is (?:currently |temporarily )?(?:unavailable|down|under maintenance)|we(?:'|’)re sorry[!.,]? (?:the )?(?:site|service|page|store) is (?:currently |temporarily )?(?:unavailable|down|under maintenance)|(?:down|back) (?:shortly )?for maintenance";
const REFERENCE_CODE_SHAPE = "\\d{1,3}\\.[0-9a-f]{6,12}\\.\\d{9,11}\\.[0-9a-f]{6,12}";
const REFERENCE_CODE_ROW = "(?:(?:reference|error|support|incident)(?: (?:#|no\\.?|number|code|id))?:? ?#?)?" + REFERENCE_CODE_SHAPE;
const APPLICATION_ERROR_ROW = new RegExp("^(?:oops!?,?(?: something went wrong)?|something went wrong|an error (?:has )?occurred|we(?:'|’)re sorry,? (?:something went wrong|an error (?:has )?occurred)|error(?: page)?|internal server error|5\\d\\d (?:internal server error|service unavailable|bad gateway|gateway time-?out|server error)|service unavailable|temporarily unavailable|this page is temporarily unavailable|page not found|not found|404(?: page)?(?: not found)?|(?:support )?(?:error|reference|incident) code:? ?[A-Za-z0-9._-]{4,80}|ERR_[A-Z0-9_]{4,60}|this site can(?:'|’)t be reached|" + UNAVAILABILITY_ROW + "|" + REFERENCE_CODE_ROW + ")" + ROW_TRAIL + "$", "i");
// Document-title vocabulary (whole title, anchored). The title is the page's
// own diagnosis and is already in every read output's header; it is never a
// product or results title by construction of these forms.
const CHROMIUM_TITLE_SUFFIX = / - Chromium$/;
const APPLICATION_ERROR_TITLE = /^(?:(?:site|service|page|store) (?:is )?(?:currently |temporarily )?unavailable|(?:error|oops!?|something went wrong|service unavailable|internal server error|bad gateway|gateway time-?out)(?: [-–|] .{1,120})?|\d{3} (?:error|service unavailable|bad gateway|internal server error)|error \d{3})$/i;
const CHALLENGE_TITLE = /^(?:access denied|access to this page has been denied\.?|forbidden|403 forbidden|robot or human\??|human or robot\??|human verification|bot detection|unusual traffic|security verification|verify your identity|are you a (?:human|robot)\??|just a moment\.{0,3})$/i;
// rev 31: the classic anti-bot ROUTES, matched as an exact path segment
// ("/blocked?url=…", "/captcha", "/challenge/…"); a longer segment such as
// "/blocked-drains" never matches. Evidence for a non-product read only —
// the caller's gates (no candidates, no verified product page) still apply.
const CHALLENGE_ROUTE_SEGMENTS = new Set(["blocked", "captcha", "challenge", "bot-detection", "human-verification", "access-denied", "sorry"]);
export function challengeRoutePath(pathname) {
  return String(pathname || "").toLowerCase().split("/").some((segment) => CHALLENGE_ROUTE_SEGMENTS.has(segment));
}
function challengeRouteUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try { return challengeRoutePath(new URL(url).pathname); } catch { return false; }
}
/** The observed document title as the classifier reads it: NFC, single-spaced, trailing " - Chromium" (only) stripped. Null when absent. */
export function pageTitleForClassification(title) {
  if (typeof title !== "string") return null;
  const text = title.normalize("NFC").replace(/\s+/g, " ").trim().replace(CHROMIUM_TITLE_SUFFIX, "").trim();
  return text && text.length <= 200 ? text : null;
}
const FAILED_DESTINATION_ROLES = new Set(["heading", "static", "paragraph"]);
/**
 * Closed failed-destination class of a read: "challenge" | "application_error" | null.
 * `rows` are the read's element rows ({ role, name }); `title` is the observed
 * document title (rev 14), judged whole and anchored. Challenge wins when both
 * classes appear, from rows or from the title alike.
 */
export function classifyFailedDestination(rows = [], { title = null, url = null } = {}) {
  let applicationError = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const role = String(row?.role || "").toLowerCase();
    if (!row || !FAILED_DESTINATION_ROLES.has(role)) continue;
    const text = String(row.name || "").normalize("NFC").replace(/\s+/g, " ").trim();
    if (!text || text.length > 200) continue;
    if (CHALLENGE_ROW.test(text) || (role === "heading" && LOGIN_WALL_HEADING_ROW.test(text))) return "challenge";
    if (APPLICATION_ERROR_ROW.test(text)) applicationError = true;
  }
  const observedTitle = pageTitleForClassification(title);
  if (observedTitle && CHALLENGE_TITLE.test(observedTitle)) return "challenge";
  if (challengeRouteUrl(url)) return "challenge"; // rev 31: the route itself is evidence
  if (observedTitle && APPLICATION_ERROR_TITLE.test(observedTitle)) applicationError = true;
  return applicationError ? "application_error" : null;
}

// ── Human check the PERSON can pass (challenge hand-off) ──────────────────
// A challenge page is only handed to the shopper when it carries an INTERACTIVE
// human check: PerimeterX's "Press & Hold" (live BBW / Ralph Lauren: the copy is
// split over rows, "Press & Hold to confirm you are" / "a human (and not a
// bot)."), "hold the button … human", "confirm/verify you are a human", "Robot
// or human?". A hard denial ("Access denied", "403 Forbidden") or a login wall
// has nothing a person can press and is never handed off. Rows of any role are
// read (the hold control itself is a button), each bounded; never a bare
// "robot"/"human" substring. This harness never presses such a control itself: the person does.
const HUMAN_CHECK_TEXT = /\b(?:press|tap|click|touch)\s*(?:&|and)\s*hold\b|\b(?:activate|press|click|tap|hold)\b[^\n]{0,40}?\bbutton\b[^\n]{0,60}?\b(?:human|robot)\b|\b(?:confirm|verify|prove)\s+(?:that\s+)?you(?:'re|’re|\s+are)\s+(?:a\s+)?human\b|\bare you a (?:human|robot)\b|\brobot or human\b|\bhuman or robot\b/i;
/** PURE. Does this read (element rows {role, name}) show a human check a person can pass? */
export function humanCheckSignal(rows = []) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.name || "").normalize("NFC").replace(/\s+/g, " ").trim();
    if (text && text.length <= 200 && HUMAN_CHECK_TEXT.test(text)) return true;
  }
  return false;
}

// ── Omnibox typing outcome (closed, exact) ───────────────────────────────────
// What index.js's type_into_element said about an ADDRESS-BAR typing with
// press_enter. Only these deterministic strings exist (index.js 3029–3163):
//   submitted               "… and pressed Enter" (optionally "[navigation focus verified: …]")
//   nav_unverified          "… and pressed Enter — NAVIGATION FOCUS UNVERIFIED: …" (the read decides)
//   not_pressed_autocomplete "— Return NOT pressed: the field contains MORE than the requested value"
//   not_pressed_unfocused   "— Return NOT pressed: the value is present but the field is not confirmed focused"
//   not_pressed_unverified  "— Return NOT pressed (refusing to submit unverified text)"
//   typed_only              a typing that never asked to submit ("Typed into …" without "pressed Enter")
// Anything else is null. NOT-pressed outcomes are checked first so a completed
// or unverified value can never read as a submission.
export function omniboxSubmitOutcome(text) {
  const out = String(text || "");
  if (!/^(?:ERROR: )?Typed into \S+ /.test(out)) return null;
  if (/Return NOT pressed: the field contains MORE than the requested value/.test(out)) return "not_pressed_autocomplete";
  if (/Return NOT pressed: the value is present but the field is not confirmed focused/.test(out)) return "not_pressed_unfocused";
  if (/Return NOT pressed \(refusing to submit unverified text\)/.test(out)) return "not_pressed_unverified";
  if (/and pressed Enter — NAVIGATION FOCUS UNVERIFIED/.test(out)) return "nav_unverified";
  if (/and pressed Enter/.test(out)) return "submitted";
  return "typed_only";
}
