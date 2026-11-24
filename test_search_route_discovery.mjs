import assert from "node:assert/strict";
import { searchPatternFromHtml, searchPatternFromObservedUrl, searchRouteLearningQuery, MAX_SEARCH_QUERY_LENGTH } from "./search_route_discovery.mjs";

assert.equal(searchPatternFromHtml('<form action="/search/" method="GET"><input placeholder="What are you looking for?" name="q"></form>', "https://www.skechers.com/"), "https://www.skechers.com/search/?q={query}");
assert.equal(searchPatternFromHtml('<form action="/s" method="GET"><input placeholder="What can we help you find?" name="searchTerm"></form>', "https://www.target.com/"), "https://www.target.com/s?searchTerm={query}");
assert.equal(searchPatternFromHtml('<form action="https://evil.test/search"><input type="search" name="q"></form>', "https://shop.test/"), null);
assert.equal(searchPatternFromHtml('<form method="POST" action="/search"><input type="search" name="q"></form>', "https://shop.test/"), null);
assert.equal(searchPatternFromHtml('<form action="/login"><input name="email"></form>', "https://shop.test/"), null);
// A field that cannot hold typed text must never win the form.
assert.equal(searchPatternFromHtml('<form action="/search"><input type="hidden" name="q" value="us"><input type="search" name="term"></form>', "https://shop.test/"), "https://shop.test/search?term={query}");
assert.equal(searchPatternFromHtml('<form action="/search"><input type="submit" name="search" value="Go"></form>', "https://shop.test/"), null);
assert.equal(searchPatternFromHtml('<form action="/search"><input type="checkbox" name="query"></form>', "https://shop.test/"), null);
// Same host, different origin (port) is a different origin.
assert.equal(searchPatternFromHtml('<form action="https://shop.test:8443/search"><input type="search" name="q"></form>', "https://shop.test/"), null);

// --- Route learned from a verified in-browser search navigation ------------
assert.equal(searchPatternFromObservedUrl("https://www.rei.com/search?q=men+waterproof+hiking+shoes", "men waterproof hiking shoes"), "https://www.rei.com/search?q={query}");
assert.equal(searchPatternFromObservedUrl("https://www.ulta.com/search?search=fragrance%20free%20moisturizer", "Fragrance Free Moisturizer"), "https://www.ulta.com/search?search={query}");
// Unrelated params that made the URL work are preserved.
assert.equal(searchPatternFromObservedUrl("https://www.nordstromrack.com/search?origin=keywordsearch&keyword=boots", "boots"), "https://www.nordstromrack.com/search?origin=keywordsearch&keyword={query}");
// Tracking/session params are never frozen into durable site memory.
assert.equal(searchPatternFromObservedUrl("https://shop.test/search?q=boots&utm_source=x&sid=abc", "boots"), "https://shop.test/search?q={query}");
// Two params bind the query: ambiguous, so refuse rather than guess.
assert.equal(searchPatternFromObservedUrl("https://shop.test/search?q=boots&keyword=boots", "boots"), null);
// No param carries the query at all.
assert.equal(searchPatternFromObservedUrl("https://shop.test/search?category=boots", "hiking shoes"), null);
assert.equal(searchPatternFromObservedUrl("https://shop.test/collections/boots", "boots"), null);
// Empty / missing query text proves nothing.
assert.equal(searchPatternFromObservedUrl("https://shop.test/search?q=", ""), null);
assert.equal(searchPatternFromObservedUrl("https://shop.test/search?q=boots", "   "), null);
// Transport and credential requirements.
assert.equal(searchPatternFromObservedUrl("http://shop.test/search?q=boots", "boots"), null);
assert.equal(searchPatternFromObservedUrl("https://user:pw@shop.test/search?q=boots", "boots"), null);
assert.equal(searchPatternFromObservedUrl("not a url", "boots"), null);
// Fragments are dropped, not learned.
assert.equal(searchPatternFromObservedUrl("https://shop.test/search?q=boots#results", "boots"), "https://shop.test/search?q={query}");

// --- Route-learning provenance: the query, never a heading -----------------
// A heading fragment must never be able to reach the learner, so the only text
// it accepts is the explicitly supplied submitted query.
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: true, searchQuery: "men waterproof hiking shoes" }), { ok: true, query: "men waterproof hiking shoes" });
// Heading != query still learns, because the query is supplied separately.
const headingUnlikeQuery = searchRouteLearningQuery({ acceptProductLink: true, searchQuery: "men waterproof hiking shoes" });
assert.equal(searchPatternFromObservedUrl("https://www.rei.com/search?q=men+waterproof+hiking+shoes", headingUnlikeQuery.query), "https://www.rei.com/search?q={query}");
// A page heading alone never learns: with no search_query there is no datum.
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: true }), { ok: false, reason: "no-search-query" });
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: true, searchQuery: null }), { ok: false, reason: "no-search-query" });
assert.deepEqual(searchRouteLearningQuery({}), { ok: false, reason: "no-search-query" });
// ...and a heading that happens to equal a parameter value cannot be smuggled
// in as the query, because nothing passes a heading to this function at all.
assert.equal(searchPatternFromObservedUrl("https://www.rei.com/search?q=men+waterproof+hiking+shoes", "Search results"), null);
assert.equal(searchPatternFromObservedUrl("https://shop.test/c?dept=shoes&view=grid", "shoes"), "https://shop.test/c?dept={query}&view=grid"); // binding is by value, so provenance is what protects it
// Outside search mode a supplied query is rejected, not ignored.
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: false, searchQuery: "hiking shoes" }), { ok: false, reason: "search-query-outside-search-mode" });
// Empty / whitespace-only / oversize / wrong-type are rejected.
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: true, searchQuery: "" }), { ok: false, reason: "search-query-empty" });
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: true, searchQuery: "   " }), { ok: false, reason: "search-query-empty" });
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: true, searchQuery: "x".repeat(MAX_SEARCH_QUERY_LENGTH + 1) }), { ok: false, reason: "search-query-too-long" });
assert.equal(searchRouteLearningQuery({ acceptProductLink: true, searchQuery: "x".repeat(MAX_SEARCH_QUERY_LENGTH) }).ok, true);
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: true, searchQuery: 42 }), { ok: false, reason: "search-query-invalid" });
// Surrounding whitespace is trimmed, not treated as part of the query.
assert.deepEqual(searchRouteLearningQuery({ acceptProductLink: true, searchQuery: "  boots  " }), { ok: true, query: "boots" });

// --- Fragments never reach a durable pattern ------------------------------
// The Ulta shape: a client-rendered widget declaring action="#", which resolves
// against the homepage and used to carry the empty fragment into site memory.
assert.equal(searchPatternFromHtml('<form action="#"><input type="search" name="search"></form>', "https://www.ulta.com/"), "https://www.ulta.com/?search={query}");
assert.equal(searchPatternFromHtml('<form action="/search#"><input type="search" name="q"></form>', "https://shop.test/"), "https://shop.test/search?q={query}");
assert.equal(searchPatternFromHtml('<form action="/search#results"><input type="search" name="q"></form>', "https://shop.test/"), "https://shop.test/search?q={query}");
assert.equal(searchPatternFromHtml('<form action="https://shop.test/search#top"><input type="search" name="q"></form>', "https://shop.test/"), "https://shop.test/search?q={query}");
assert.equal(searchPatternFromHtml('<form action="/?search=#"><input type="search" name="search"></form>', "https://shop.test/"), "https://shop.test/?search={query}");
// Guard: the no-fragment cases are byte-identical to before the change.
assert.equal(searchPatternFromHtml('<form action="/search/" method="GET"><input placeholder="What are you looking for?" name="q"></form>', "https://www.skechers.com/"), "https://www.skechers.com/search/?q={query}");
assert.equal(searchPatternFromHtml('<form action="/s" method="GET"><input placeholder="What can we help you find?" name="searchTerm"></form>', "https://www.target.com/"), "https://www.target.com/s?searchTerm={query}");

console.log("PASS — search route discovery");
