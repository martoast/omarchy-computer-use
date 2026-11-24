#!/usr/bin/env python3
"""find_first_live: when names tie, a control in the PAGE wins over browser chrome.

Live Bandcamp 2026-11-23: click_element(text="close") on an open filter dialog resolved to Chromium's title-bar Close
(it comes first in tree order), the click gate refused it, and the dialog's own Close was never reached.
Synthetic accessibles only; no browser."""
import atspi_bridge as ab

passed = failed = 0


def check(label, got, want):
    global passed, failed
    ok = got == want
    print(("ok   " if ok else "FAIL ") + label + ("" if ok else f"  got={got!r} want={want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


class Ext:
    def __init__(self, w, h):
        self.width, self.height = w, h


class Comp:
    def __init__(self, visible):
        self.v = visible

    def get_extents(self, _ct):
        return Ext(20, 20) if self.v else Ext(0, 0)


class Doc:
    def __init__(self, uri):
        self.uri = uri

    def get_document_attribute_value(self, attr):
        return self.uri if attr in ("DocURL", "URI") else None


class Node:
    def __init__(self, role, name="", children=(), uri=None, visible=True, label=""):
        self.role, self.name, self.children, self.label = role, name, list(children), label
        self._doc = Doc(uri) if uri else None
        self._comp = Comp(visible)
        self.parent = None
        for c in self.children:
            c.parent = self

    def get_role_name(self): return self.role
    def get_name(self): return self.name
    def get_parent(self): return self.parent
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, i): return self.children[i]
    def get_document_iface(self): return self._doc
    def get_component_iface(self): return self._comp


def tree(page_close_visible=True, with_page_close=True):
    chrome_close = Node("button", "Close", label="chrome")
    page_close = Node("button", "close", label="page", visible=page_close_visible)
    dialog = Node("dialog", "more filters", [page_close] if with_page_close else [Node("button", "Apply", label="apply")])
    doc = Node("document web", "Bandcamp", [dialog], uri="https://bandcamp.com/discover/classical/vinyl")
    frame = Node("frame", "Bandcamp - Chromium", [Node("tool bar", "", [chrome_close]), doc])
    return Node("application", "Chromium", [frame])


t, n = ab.find_first_live(tree(), "close", "button")
check("text 'close' resolves to the page dialog's Close, not the window's", t.label, "page")
check("  both matches are still counted", n, 2)

t, _ = ab.find_first_live(tree(with_page_close=False), "close", "button")
check("with no page Close, the chrome Close is still found (the click gate refuses it later)", t.label, "chrome")

t, _ = ab.find_first_live(tree(page_close_visible=False), "close", "button")
check("a VISIBLE chrome control still beats a hidden page duplicate", t.label, "chrome")

print(f"\n{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
