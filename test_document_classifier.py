#!/usr/bin/env python3
"""Pure unit tests for the page-vs-browser-document classifier (no AT-SPI).
Run: python3 test_document_classifier.py

Why this exists: `is_in_document` answers "does this node have a document
ancestor", and Chromium's omnibox suggestion dropdown IS a `document web` — so
browser UI answers yes. Telling page content from browser UI needs the
document's own URI, and the scheme must be PARSED: a real product URL can
contain a scheme name as ordinary path text."""
import sys
from atspi_bridge import classify_document_uri, BROWSER_DOC_SCHEMES

cases = [
    # --- browser-internal WebUI ------------------------------------------------
    ("omnibox popup (the one measured live)",
     "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html", "browser_internal"),
    ("chrome settings", "chrome://settings/", "browser_internal"),
    ("chrome-untrusted", "chrome-untrusted://read-anything-side-panel/", "browser_internal"),
    ("chrome-search NTP", "chrome-search://local-ntp/local-ntp.html", "browser_internal"),
    ("extension page", "chrome-extension://abcdefghijklmnop/popup.html", "browser_internal"),
    ("devtools", "devtools://devtools/bundled/devtools_app.html", "browser_internal"),
    ("chrome-error", "chrome-error://chromewebdata/", "browser_internal"),
    ("scheme case is ignored", "CHROME://SETTINGS/", "browser_internal"),
    ("leading whitespace is ignored", "  chrome://settings/", "browser_internal"),

    # --- real page surfaces -----------------------------------------------------
    ("https store page", "https://www.youngla.com/", "page"),
    ("http page", "http://example.com/a", "page"),
    ("local fixture", "file:///tmp/fixture.html", "page"),
    ("data url", "data:text/html,<h1>x</h1>", "page"),
    ("about:blank is not browser UI for our purposes", "about:blank", "page"),

    # --- the reason schemes are PARSED, not prefix-matched ----------------------
    # Each of these would be misclassified by a naive startswith()/contains check.
    ("page path merely containing a browser scheme name",
     "https://example.com/blog/chrome://tips", "page"),
    ("page path named after devtools", "https://example.com/devtools/guide", "page"),
    ("host containing chrome-extension", "https://chrome-extension.example.com/", "page"),

    # --- unknown: neither, on purpose -------------------------------------------
    ("missing uri", None, "unknown"),
    ("empty uri", "", "unknown"),
    ("blank uri", "   ", "unknown"),
    ("no scheme", "www.example.com/path", "unknown"),
    ("non-string", 1234, "unknown"),
]

fails = 0
for label, uri, want in cases:
    got = classify_document_uri(uri)
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  got={got!r} want={want!r} uri={uri!r}"))
    if not ok:
        fails += 1

# A mock document object: proves the accessible-taking predicates agree with the
# pure classifier, and that popup content can never be reported as page content.
class FakeDocIface:
    def __init__(self, uri): self.uri = uri
    def get_document_attribute_value(self, key):
        return self.uri if key == "DocURL" else None

class FakeDoc:
    def __init__(self, uri): self._i = FakeDocIface(uri)
    def get_document_iface(self): return self._i

from atspi_bridge import is_page_document, is_browser_internal_document, document_uri

mock_cases = [
    ("mock Omnibox Popup document is NOT page content",
     FakeDoc("chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html"), False, True),
    ("mock store document IS page content", FakeDoc("https://www.youngla.com/"), True, False),
    ("mock document with no URI is neither", FakeDoc(None), False, False),
]
for label, doc, want_page, want_internal in mock_cases:
    gp, gi = is_page_document(doc), is_browser_internal_document(doc)
    ok = gp == want_page and gi == want_internal
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  page={gp} internal={gi}"))
    if not ok:
        fails += 1

ok = is_page_document(None) is False and is_browser_internal_document(None) is False
print(f"{'ok  ' if ok else 'FAIL'} a missing document is neither page nor browser-internal")
if not ok:
    fails += 1

# --- focus ranking when Chromium reports several FOCUSED nodes at once --------
# in_doc cannot break this tie: the omnibox popup is under a document too, so the
# old "first in_doc hit wins" rule could return the popup while a page node was
# also focused — and which one it returned depended on traversal order.
from atspi_bridge import rank_focus_hits

PAGE_HIT = {"role": "document web", "name": "store", "in_doc": True, "doc_class": "page",
            "doc_uri": "https://www.youngla.com/"}
POPUP_HIT = {"role": "combo box", "name": "Ask AI Mode", "in_doc": True, "doc_class": "browser_internal",
             "doc_uri": "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html"}
UNKNOWN_HIT = {"role": "section", "name": "", "in_doc": True, "doc_class": "unknown", "doc_uri": None}
CHROME_HIT = {"role": "entry", "name": "Address and search bar", "in_doc": False, "doc_class": "unknown",
              "doc_uri": None}

rank_cases = [
    ("page first in traversal order -> page wins", [PAGE_HIT, POPUP_HIT], PAGE_HIT),
    ("POPUP first in traversal order -> page STILL wins", [POPUP_HIT, PAGE_HIT], PAGE_HIT),
    ("popup vs unknown -> popup (positively classified) wins", [UNKNOWN_HIT, POPUP_HIT], POPUP_HIT),
    ("page beats everything", [CHROME_HIT, UNKNOWN_HIT, POPUP_HIT, PAGE_HIT], PAGE_HIT),
    ("in-document unknown beats browser chrome outside any document", [CHROME_HIT, UNKNOWN_HIT], UNKNOWN_HIT),
    ("single hit is returned as-is", [POPUP_HIT], POPUP_HIT),
    ("no hits -> None", [], None),
]
for label, hits, want in rank_cases:
    got = rank_focus_hits(list(hits))
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  got={got}"))
    if not ok:
        fails += 1

expected_schemes = {"chrome", "chrome-untrusted", "chrome-search", "chrome-extension", "devtools", "chrome-error"}
ok = expected_schemes <= set(BROWSER_DOC_SCHEMES)
print(f"{'ok  ' if ok else 'FAIL'} the browser-scheme set covers this build's WebUI schemes")
if not ok:
    fails += 1

# CHROMIUM'S EMPTY PLACEHOLDER (live Coach bag 2026-10-04): showing, no URI, no children -- given focus so its tree appears
from atspi_bridge import is_placeholder_document
placeholder_cases = [
    ("the live Coach shape: showing, no URI, 0 children", (None, 0, True), True),
    ("an empty-string URI counts as none", ("", 0, True), True),
    ("a populated page document", ("https://www.coach.com/shopping-bag", 1, True), False),
    ("a URI but no children yet is NOT the placeholder (a page building its tree)", ("https://www.coach.com/shopping-bag", 0, True), False),
    ("a browser-UI document carries a chrome:// URI", ("chrome://omnibox-popup.top-chrome/", 0, True), False),
    ("not showing (a background tab)", (None, 0, False), False),
    ("children unknown", (None, None, True), False),
]
for label, args, want in placeholder_cases:
    got = is_placeholder_document(*args)
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} placeholder: {label}" + ("" if ok else f"  got={got}"))
    if not ok:
        fails += 1

from atspi_bridge import window_names_a_page
title_cases = [("Shopping Bag | COACH - Chromium", True), ("Shopping Bag | COACH", True), ("New Tab - Chromium", False), ("about:blank", False), ("", False), (None, False), (" - Chromium", False)]
for title, want in title_cases:
    got = window_names_a_page(title)
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} window names a page: {title!r}" + ("" if ok else f"  got={got}"))
    if not ok:
        fails += 1

from atspi_bridge import quiet_while_loading
qwl_cases = [
    (("busy", True, 900, 800), True, "busy, populated, quiet 900 ms: would have settled"),
    (("busy", True, 500, 800), False, "busy, populated, still changing"),
    (("busy", False, 5000, 800), False, "busy and EMPTY (the placeholder / nothing yet): never"),
    (("ready", True, 5000, 800), False, "ready: settle's own rule answers"),
    (("no_document", False, 5000, 800), False, "no document"),
]
for args, want, label in qwl_cases:
    got = quiet_while_loading(*args)
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} quiet while loading: {label}" + ("" if ok else f"  got={got}"))
    if not ok:
        fails += 1

total = len(cases) + len(mock_cases) + len(rank_cases) + 2 + len(placeholder_cases) + len(title_cases) + len(qwl_cases)
print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {total - fails}/{total}")
sys.exit(0 if fails == 0 else 1)
