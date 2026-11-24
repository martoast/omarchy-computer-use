// Serialization boundary for LINE-ORIENTED tool output.
//
// Everything the MCP tools print is parsed downstream line-by-line (the fast
// agent's REF_LINE index, the page-header/establishment parsers, the delivery
// evidence excerpts), and element names, hrefs, and the window title are
// PAGE-CONTROLLED strings. An accessible name carrying a literal newline used
// to split an output row mid-line, handing the page attacker-controlled
// LINE-INITIAL text — enough to fabricate a `# title (url)` header row or a
// fake `eN\t...` ref row (safety review finding V1). Tabs are just as
// load-bearing: the row format is tab-delimited. The fix lives HERE, at the
// boundary, so one element is always exactly one output line for every parser
// at once — per-parser hardening is defense-in-depth, never the substitute.
//
// The replacement is U+FFFD: visibly present (a reader can see something was
// there), never whitespace, never format-significant. Normal Unicode —
// accents, CJK, emoji — passes through untouched.
const UNSAFE_INLINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function sanitizeInline(value) {
  return String(value ?? "").replace(UNSAFE_INLINE, "\uFFFD");
}

// Dedicated SERVER-CONTROLLED page-URL marker (safety review finding V2: the
// human `# title (url)` header row mixes the attacker-controlled window title
// with the tool-attested URL, and in the {title, no url} page state the only
// parenthesized URL on that row would be title-supplied). The marker is
// emitted ONLY from snap.page.url — never derived from a title — and only
// when that URL is valid http(s); its value is the URL parser's normalized
// serialization, sanitized again as belt-and-braces. Anything else yields ""
// so absence stays meaningful (fail-closed).
export function formatPageUrlMarker(url) {
  if (typeof url !== "string" || !url) return "";
  let parsed;
  try { parsed = new URL(url); } catch { return ""; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  const value = sanitizeInline(parsed.href);
  return /^\S+$/.test(value) ? `[page-url: ${value}]\n` : "";
}

// Anchored, whole-line parse; the FIRST marker wins because the server emits
// it ahead of any page-derived text (and sanitizeInline means page content can
// no longer mint new lines at all).
const PAGE_URL_MARKER_LINE = /^\[page-url: (https?:\/\/\S+)\]$/;

export function parsePageUrlMarker(text) {
  for (const line of String(text || "").split("\n")) {
    const match = PAGE_URL_MARKER_LINE.exec(line);
    if (match) return match[1];
  }
  return null;
}

// Anchored, whole-line parsing for the OTHER server-emitted markers the fast
// agent's state machine trusts (safety review finding V3). `outputText
// .includes("[product candidates]")` was a substring test over a body that also
// carries page-controlled element names, so a page could put that exact text in
// an accessible name and be quoted back into the output. sanitizeInline now
// stops a page minting new LINES at all, but the parser must not depend on that
// alone: a marker only counts when it IS the whole line, which a quoted name
// (`eN\trole\t"[product candidates]"\t@x,y`) can never be.
export function hasMarkerLine(text, marker) {
  const want = `[${marker}]`;
  return String(text || "").split("\n").some((line) => line === want);
}

// The readiness verdict line, e.g. `[navigation ready: url-and-product-link]`.
// Returns the reason, or null when no whole-line verdict is present.
const NAVIGATION_READY_LINE = /^\[navigation ready: ([a-z0-9:_-]+)\]$/;

export function parseNavigationReadyReason(text) {
  for (const line of String(text || "").split("\n")) {
    const match = NAVIGATION_READY_LINE.exec(line);
    if (match) return match[1];
  }
  return null;
}
