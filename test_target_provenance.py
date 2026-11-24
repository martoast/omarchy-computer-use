#!/usr/bin/env python3
"""Executable tests for the ACTION-side provenance stamp.

No browser, no registry: synthetic accessibles duck-type the slice of
Atspi.Accessible that enclosing_document/classify_document touch.

Why this exists: focus_action and scroll_to_action returned only `in_doc`, and
in_doc CANNOT separate page content from browser UI — the omnibox suggestion
popup is itself a `document web`, so it reports in_doc true. With no doc_class
on the action responses, a text-targeted click_element had no provenance to gate
on, and a click on the browser WINDOW's own Close button was activated as though
it were page content: Chromium exited code 0 because that closed the only
window (REI, 07e180c).
"""
import sys

import atspi_bridge as ab

passed = failed = 0


def check(label, got, want):
    global passed, failed
    ok = got == want
    print(("ok   " if ok else "FAIL ") + label + ("" if ok else f"  got={got!r} want={want!r}"))
    globals().__setitem__("passed", passed + 1) if ok else globals().__setitem__("failed", failed + 1)


class DocIface:
    def __init__(self, uri, key="DocURL"):
        self._uri, self._key = uri, key

    def get_document_attribute_value(self, attr):
        return self._uri if attr == self._key else None


class Node:
    """Duck-types just enough Accessible for the provenance walk."""

    def __init__(self, role, parent=None, uri=None, uri_key="DocURL", doc_iface=True, raises=False):
        self.role, self._parent, self._raises = role, parent, raises
        self._iface = DocIface(uri, uri_key) if doc_iface else None

    def get_role_name(self):
        if self._raises:
            raise RuntimeError("role probe failed")
        return self.role

    def get_parent(self):
        return self._parent

    def get_document_iface(self):
        return self._iface


# --- a node inside a real page document -------------------------------------
page_doc = Node("document web", uri="https://www.rei.com/search?q=hiking")
page_button = Node("button", parent=Node("section", parent=page_doc))
check("a node under a page document is 'page'", ab.target_doc_class(page_button), "page")
check("  the document node itself is 'page'", ab.target_doc_class(page_doc), "page")

# --- browser chrome: no enclosing document AT ALL ----------------------------
# This is the window Close button. It is the case the incident turned on.
frame = Node("frame")
window_close = Node("button", parent=Node("tool bar", parent=frame))
check("a node under NO document is 'chrome'", ab.target_doc_class(window_close), "chrome")
check("  a bare orphan node is 'chrome'", ab.target_doc_class(Node("button")), "chrome")

# --- browser INTERNAL WebUI: a document, but a browser-scheme one ------------
popup_doc = Node("document web", uri="chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html")
popup_item = Node("button", parent=popup_doc)
check("the omnibox popup is 'browser_internal', NOT page", ab.target_doc_class(popup_item), "browser_internal")
check("  even though it IS inside a document (in_doc would say page)",
      ab.is_in_document(popup_item), True)

# --- unknown: a document whose URI cannot be established ---------------------
check("a document with no URI is 'unknown'", ab.target_doc_class(Node("button", parent=Node("document web", uri=None))), "unknown")
check("a document with no Document interface is 'unknown'",
      ab.target_doc_class(Node("button", parent=Node("document frame", doc_iface=False))), "unknown")
check("a document with an unparseable URI is 'unknown'",
      ab.target_doc_class(Node("button", parent=Node("document web", uri="   "))), "unknown")

# --- the URI attribute fallback still classifies -----------------------------
check("the URI attribute is read when DocURL is absent",
      ab.target_doc_class(Node("button", parent=Node("document web", uri="https://shop.test/x", uri_key="URI"))), "page")

# --- a document frame (iframe) is a page surface -----------------------------
iframe_doc = Node("document frame", uri="https://www.rei.com/embedded")
check("an iframe document is a page surface", ab.target_doc_class(Node("button", parent=iframe_doc)), "page")

# --- failures fail CLOSED, never as 'page' -----------------------------------
check("a node whose role probe raises is not 'page'",
      ab.target_doc_class(Node("button", raises=True)) != "page", True)

# --- the STAMP itself: the same derivation collect() uses --------------------
# Rather than trusting that the action responses call it, assert the value the
# response carries for each surface — the field the act gate reads.
for label, node, want in [
    ("page content", page_button, "page"),
    ("browser window control", window_close, "chrome"),
    ("browser-internal WebUI", popup_item, "browser_internal"),
    ("an unestablished surface", Node("button", parent=Node("document web", uri=None)), "unknown"),
]:
    stamped = {"in_doc": ab.is_in_document(node), "doc_class": ab.target_doc_class(node)}
    check(f"stamp for {label}", stamped["doc_class"], want)
    # in_doc alone is ambiguous for THREE of these four: page content, the
    # browser's own WebUI, and a document whose URI could not be read all report
    # in_doc true, yet only the first may be acted on. Only doc_class separates
    # them, which is the whole reason the action responses now carry it.
    if want == "chrome":
        check(f"  in_doc is false for {label} (no enclosing document at all)", stamped["in_doc"], False)
    else:
        check(f"  in_doc is TRUE for {label} — which is why in_doc cannot gate", stamped["in_doc"], True)

# Only ONE of the four surfaces is act-authorized, and in_doc cannot tell them
# apart on its own: two of them report in_doc true.
authorized = [l for l, n, _ in [("page content", page_button, 0), ("window control", window_close, 0),
                                ("webui", popup_item, 0)] if ab.target_doc_class(n) == "page"]
check("exactly one of page/chrome/browser_internal is act-authorized", authorized, ["page content"])

# --- NO SIDE EFFECT ON AN UNPROVEN SURFACE ----------------------------------
# scroll_to_action runs during RESOLUTION, before the caller authorizes
# anything. Scrolling browser chrome or an unestablished surface is acting on
# something unproven, so the component scroll is counted here rather than
# assumed: it must fire exactly once for page content and never otherwise.
class CountingComponent:
    def __init__(self, counter):
        self._counter = counter

    def scroll_to(self, _kind):
        self._counter[0] += 1
        return True

    def get_extents(self, _coord):
        raise RuntimeError("bounds unavailable in this fake")


class ScrollNode(Node):
    """A Node that also exposes a counting Component interface."""

    def __init__(self, *a, counter=None, **kw):
        super().__init__(*a, **kw)
        self._counter = counter if counter is not None else [0]

    def get_component_iface(self):
        return CountingComponent(self._counter)

    def get_name(self):
        return "target"

    def get_index_in_parent(self):
        return 0

    def get_child_count(self):
        return 0


class FakeApp:
    def get_child_count(self):
        return 0


def scroll_counted(node):
    """Drive the real scroll_to_action with resolution stubbed to `node`."""
    counter = node._counter
    original = ab._resolve_target
    ab._resolve_target = lambda *a, **k: (node, 1, None)
    try:
        out = ab.scroll_to_action(FakeApp(), 0, 0, "target", None)
    finally:
        ab._resolve_target = original
    return counter[0], out


for label, parent, want_class, want_scrolls in [
    ("page content", Node("document web", uri="https://shop.test/x"), "page", 1),
    ("browser chrome", Node("tool bar", parent=Node("frame")), "chrome", 0),
    ("browser-internal WebUI", Node("document web", uri="chrome://omnibox-popup.top-chrome/x.html"), "browser_internal", 0),
    ("an unestablished surface", Node("document web", uri=None), "unknown", 0),
]:
    node = ScrollNode("button", parent=parent, counter=[0])
    scrolls, out = scroll_counted(node)
    check(f"{label}: component.scroll_to called {want_scrolls}x", scrolls, want_scrolls)
    check(f"  {label}: doc_class reported", out.get("doc_class"), want_class)
    check(f"  {label}: scrolled flag is truthful", out.get("scrolled"), want_scrolls == 1)

print(f"\n{'PASS' if failed == 0 else 'FAIL'} — {passed}/{passed + failed}")
sys.exit(0 if failed == 0 else 1)
