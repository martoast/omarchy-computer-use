const SEARCH_NAMES = /^(?:q|query|keyword|search|searchterm)$/i;
// An <input> that cannot carry user-typed text can never be the search field,
// no matter how search-y its name is. Without this a `<input type="hidden"
// name="q">` (ubiquitous: locale/store-scope carriers) or a `<input
// type="submit" name="search">` wins the form and produces a pattern that
// either drops the query or is simply wrong.
const NON_TEXT_INPUT_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "checkbox", "radio", "file", "password", "range", "color"]);
// Never bake a session/tracking parameter into a DURABLE site-memory pattern.
const VOLATILE_PARAM = /^(?:utm_|_ga|_gl)|^(?:gclid|fbclid|msclkid|dclid|irclickid|sessionid|session_id|sid|jsessionid|cid|ref|referrer)$/i;

function attrs(tag) {
  const out = {};
  for (const match of tag.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return out;
}

export function searchPatternFromHtml(html, homepageUrl) {
  const home = new URL(homepageUrl);
  if (home.protocol !== "https:") return null;
  for (const match of String(html).matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const form = attrs(match[0].slice(0, match[0].indexOf(">") + 1));
    if (form.method && form.method.toLowerCase() !== "get") continue;
    let field = null;
    for (const input of match[1].matchAll(/<(?:input|textarea)\b[^>]*>/gi)) {
      const candidate = attrs(input[0]);
      if (!candidate.name || candidate.disabled != null) continue;
      if (NON_TEXT_INPUT_TYPES.has((candidate.type || "").toLowerCase())) continue;
      const semanticSearch = candidate.type?.toLowerCase() === "search"
        || SEARCH_NAMES.test(candidate.name)
        || /search|what can we help you find/i.test(`${candidate.placeholder || ""} ${candidate["aria-label"] || ""}`);
      if (semanticSearch) { field = candidate.name; break; }
    }
    if (!field) continue;
    let action;
    try { action = new URL(form.action || home.pathname, home); } catch { continue; }
    // Exact origin, not just hostname: a same-host form action on another
    // port/scheme is a different origin and must not be learned as this site's
    // search route.
    if (action.origin !== home.origin) continue;
    // Drop the fragment, exactly as observed-route learning does. A
    // client-rendered widget commonly declares action="#" or "/?search=", which
    // resolves against the homepage and carries the empty fragment straight
    // into DURABLE site memory — live: https://www.ulta.com/?search={query}#.
    // A fragment is never sent to the server, so it can only ever be noise in a
    // learned search route.
    action.hash = "";
    action.searchParams.set(field, "{query}");
    return action.toString().replace(/%7Bquery%7D/i, "{query}");
  }
  return null;
}

export async function discoverSearchUrlPattern(homepageUrl, { fetchImpl = fetch, timeoutMs = 8000, maxBytes = 1_000_000 } = {}) {
  const home = new URL(homepageUrl);
  if (home.protocol !== "https:") return null;
  const response = await fetchImpl(home, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/html" } });
  if (!response.ok || !response.body) return null;
  const finalUrl = new URL(response.url || home);
  if (finalUrl.protocol !== "https:" || finalUrl.hostname.toLowerCase() !== home.hostname.toLowerCase()) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "", total = 0, truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    html += decoder.decode(value, { stream: true });
    // Retail homepages routinely exceed any sane byte cap. Bailing out on
    // oversize meant discovery silently never fired on exactly the big sites
    // that need it. The header search form lives near the top of the document,
    // so PARSE THE BOUNDED PREFIX instead. A form cut in half simply has no
    // closing tag and matches nothing — truncation can only lose a pattern,
    // never invent one.
    if (total > maxBytes) { truncated = true; await reader.cancel(); break; }
  }
  if (!truncated) html += decoder.decode();
  return searchPatternFromHtml(html, finalUrl);
}

// DURABLE ROUTE LEARNING FROM A VERIFIED BROWSER NAVIGATION.
//
// The homepage-fetch discovery above cannot see a client-rendered search form
// (Ulta: verified live navigation to /search?search=... yet its site memory
// stayed empty across sessions, so every run re-fought a remounting search
// widget). But by the time a search RESULTS page is verified ready, the
// browser has already proven the route: the observed URL is the real search
// route and the submitted query text is known. Infer the `{query}` pattern
// from those two facts only — no extra network, nothing fetched, nothing
// guessed.
//
// Fail-closed rules, all required:
//   - https only, no embedded credentials, no fragment carried through;
//   - EXACTLY ONE query parameter whose decoded, normalized value binds the
//     submitted query text. Zero means this URL does not encode the query;
//     two or more (e.g. `?q=shoes&utm_term=shoes`) means the binding is
//     ambiguous and picking either would be a guess;
//   - the caller must have verified the destination first, and must not hand
//     in a product/detail URL (enforced by the caller, which knows which read
//     was a search read).
// Volatile session/tracking params are dropped rather than frozen into
// permanent site memory; every other param is preserved, because the observed
// URL is what actually worked (e.g. Nordstrom Rack's `origin=keywordsearch`).
export function searchPatternFromObservedUrl(observedUrl, queryText, { maxLength = 500 } = {}) {
  const normalize = (value) => String(value ?? "").replace(/[+\s]+/g, " ").trim().toLowerCase();
  const target = normalize(queryText);
  if (!target) return null;
  let url;
  try { url = new URL(observedUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  let field = null;
  for (const [key, value] of url.searchParams) {
    if (VOLATILE_PARAM.test(key)) continue;
    if (normalize(value) !== target) continue;
    if (field !== null) return null; // ambiguous binding — refuse rather than guess
    field = key;
  }
  if (field === null) return null;
  const pattern = new URL(url.toString());
  pattern.hash = "";
  for (const key of [...pattern.searchParams.keys()]) if (VOLATILE_PARAM.test(key)) pattern.searchParams.delete(key);
  pattern.searchParams.set(field, "{query}");
  const text = pattern.toString().replace(/%7Bquery%7D/i, "{query}");
  return text.length <= maxLength && text.includes("{query}") ? text : null;
}

// May this verified read learn a search route, and from WHAT TEXT?
//
// Extracted so the provenance rule is a property of a tested function rather
// than of a call site: expected_heading is structurally incapable of reaching
// the learner. A heading is whatever the page titles its results with
// ("Search results", "132 items") — it is not the submitted query, and binding
// a URL parameter to one would learn the wrong datum whenever a heading
// happened to equal a parameter value.
export const MAX_SEARCH_QUERY_LENGTH = 200;
export function searchRouteLearningQuery({ acceptProductLink = false, searchQuery } = {}) {
  if (searchQuery === undefined || searchQuery === null) return { ok: false, reason: "no-search-query" };
  if (typeof searchQuery !== "string") return { ok: false, reason: "search-query-invalid" };
  // Outside search mode there is no submitted query to learn from, so a
  // supplied one is an error rather than something silently ignored.
  if (!acceptProductLink) return { ok: false, reason: "search-query-outside-search-mode" };
  const query = searchQuery.trim();
  if (!query) return { ok: false, reason: "search-query-empty" };
  if (query.length > MAX_SEARCH_QUERY_LENGTH) return { ok: false, reason: "search-query-too-long" };
  return { ok: true, query };
}
