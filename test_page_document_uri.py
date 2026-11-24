#!/usr/bin/env python3
"""Executable tests for page_document_uri_action.

No browser, no registry: synthetic accessibles duck-type the slice of
Atspi.Accessible the traversal touches, and every visit is COUNTED, so "the
focus search and the content descent were skipped" is measured rather than
asserted.

The ORACLE is the real navigation_focus_action(app)["page_document_uri_raw"],
not a restatement of its rules in this file. Every equivalence case asserts the
two agree, so if the historical semantics are subtler than I understood, these
fail rather than encoding my misunderstanding.

Why this exists: the two URI-only callers (the pre-typing submit baseline and
the submit-transition poll) read only that one field, while navigation_focus
pays for TWO full-tree walks to produce it -- a focus search they discard, and a
document collection that descends through the entire page content subtree
hunting nested documents. Measured, one such read cost ~880ms mid-navigation,
and that cost is what decides how many samples fit inside the watch budget: an
expensive probe makes a late navigation commit LESS likely to be seen.

It replaces test_navigation_focus_count.py, whose subject (a count_content flag)
was removed once no caller passed it.
"""
import sys

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


class NoStates:
    def contains(self, _state):
        return False


class DocIface:
    def __init__(self, uri, key="DocURL"):
        self._uri, self._key = uri, key

    def get_document_attribute_value(self, attr):
        return self._uri if attr == self._key else None


class Node:
    """Duck-types just enough Accessible, and records every visit by name."""

    def __init__(self, role, name="", uri=None, uri_key="DocURL", doc_iface=True,
                 children=(), visits=None, raises=None):
        self.role, self._name, self._children = role, name, list(children)
        self._iface = DocIface(uri, uri_key) if doc_iface else None
        self.visits = visits if visits is not None else {}
        self._raises = raises  # "role" | "children" | "child_at" | None
        self.path = None

    def get_role_name(self):
        self.visits[self._name or self.role] = self.visits.get(self._name or self.role, 0) + 1
        if self._raises == "role":
            raise RuntimeError("role probe failed")
        return self.role

    def get_name(self):
        return self._name

    def get_child_count(self):
        if self._raises == "children":
            raise RuntimeError("child count failed")
        return len(self._children)

    def get_child_at_index(self, i):
        if self._raises == "child_at" and i == 0:
            raise RuntimeError("child fetch failed")
        return self._children[i]

    def get_state_set(self):
        # The FOCUS pass's fingerprint. page_document_uri_action must never
        # reach this: it does not look at states at all.
        self.visits["<state_set>"] = self.visits.get("<state_set>", 0) + 1
        return NoStates()

    def get_document_iface(self):
        return self._iface

    def get_parent(self):
        return None


def app_with(*children, visits=None):
    v = visits if visits is not None else {}
    for c in children:
        _share(c, v)
    return Node("application", "app", children=children, visits=v)


def _share(node, visits):
    node.visits = visits
    for c in node._children:
        _share(c, visits)


def doc(uri, name="doc", children=(), role="document web", **kw):
    return Node(role, name, uri=uri, children=children, **kw)


def frame(*children):
    return Node("frame", "frame", children=list(children))


def agree(label, app_a, app_b):
    """Both built the same way; the oracle is the real navigation_focus."""
    want = ab.navigation_focus_action(app_b)["page_document_uri_raw"]
    got = ab.page_document_uri_action(app_a)["page_document_uri_raw"]
    check(label + f"  (oracle={want!r})", got, want)
    return got


# --- EQUIVALENCE against the real navigation_focus ---------------------------
def plain():
    return app_with(frame(doc("https://www.rei.com/", children=[
        Node("link", "c0"), Node("link", "c1"), Node("link", "c2")])))


agree("a plain page yields its URI", plain(), plain())


def internal_first():
    return app_with(frame(
        doc("chrome://omnibox-popup.top-chrome/x.html", "popup", children=[Node("link", "p0")]),
        doc("https://www.rei.com/search", "page")))


check("a browser-internal document FIRST is skipped, not returned",
      agree("browser-internal first", internal_first(), internal_first()),
      "https://www.rei.com/search")


def blank():
    return app_with(frame(doc("about:blank", "blank")))


check("about:blank IS returned — 'about' is not a browser scheme",
      agree("about:blank", blank(), blank()), "about:blank")


def no_iface_then_real():
    return app_with(frame(
        doc(None, "ifaceless", doc_iface=False),
        doc("https://shop.test/x", "real")))


check("a document with no Document interface is passed over",
      agree("no document interface", no_iface_then_real(), no_iface_then_real()),
      "https://shop.test/x")


def uri_attribute():
    return app_with(frame(doc("https://shop.test/attr", "attr", uri_key="URI")))


check("the URI attribute is honoured when DocURL is absent",
      agree("URI attribute fallback", uri_attribute(), uri_attribute()),
      "https://shop.test/attr")

for label, uri in [("whitespace-only", "   "), ("scheme-less", "/foo/bar"), ("empty", "")]:
    def only(u=uri):
        return app_with(frame(doc(u, "bad"), doc("https://shop.test/ok", "good")))
    check(f"a {label} URI is not a page document",
          agree(f"{label} URI", only(), only()), "https://shop.test/ok")


def nothing():
    return app_with(frame(Node("tool bar", "bar", children=[Node("push button", "b0")])))


check("no document at all yields None", agree("no documents", nothing(), nothing()), None)


def two_pages():
    return app_with(frame(doc("https://first.test/", "first"), doc("https://second.test/", "second")))


check("the FIRST page document in child order wins",
      agree("first wins", two_pages(), two_pages()), "https://first.test/")


def nested():
    return app_with(frame(doc("https://outer.test/", "outer",
                              children=[doc("https://inner.test/", "inner", role="document frame")])))


check("an iframe INSIDE a page document does not displace the outer one",
      agree("nested iframe", nested(), nested()), "https://outer.test/")


def outer_blind():
    """The case that proves a non-page document must NOT stop the walk."""
    return app_with(frame(doc(None, "outer", doc_iface=False,
                              children=[doc("https://inner.test/", "inner", role="document frame")])))


check("an unreadable outer document still yields its nested frame's URI",
      agree("blind outer, readable inner", outer_blind(), outer_blind()), "https://inner.test/")

# --- CAP PARITY, pinned against the oracle rather than my reading ------------
# The historical cap counts EVERY document collect_docs appended, whatever its
# class. So browser-internal documents occupy positions too, and the check is
# `> 12` on ENTRY, which admits a THIRTEENTH.
def at_position(pos):
    """`pos-1` browser-internal documents, then the real page at position pos."""
    docs = [doc(f"chrome://filler/{i}.html", f"f{i}") for i in range(pos - 1)]
    docs.append(doc("https://www.rei.com/", "target"))
    return app_with(frame(*docs))


check("a page document at encountered position 13 is still reachable",
      agree("position 13", at_position(13), at_position(13)), "https://www.rei.com/")
check("a page document at encountered position 14 is past the cap",
      agree("position 14", at_position(14), at_position(14)), None)


def at_depth(d):
    node = doc("https://deep.test/", "target")
    for i in range(d - 1):
        node = Node("section", f"s{i}", children=[node])
    return app_with(node)


check("a page document at depth 20 is found", agree("depth 20", at_depth(20), at_depth(20)), "https://deep.test/")
check("a page document at depth 21 is past the cap", agree("depth 21", at_depth(21), at_depth(21)), None)

# --- EXCEPTIONS: never a crash, never a fabricated URI ----------------------
def role_raises():
    return app_with(frame(Node("section", "broken", raises="role",
                               children=[doc("https://hidden.test/", "hidden")]),
                          doc("https://visible.test/", "visible")))


check("a node whose role probe raises skips its subtree",
      agree("role probe raises", role_raises(), role_raises()), "https://visible.test/")


def children_raise():
    return app_with(frame(Node("section", "broken", raises="children",
                               children=[doc("https://hidden.test/", "hidden")]),
                          doc("https://visible.test/", "visible")))


check("a node whose child count raises skips its subtree",
      agree("child count raises", children_raise(), children_raise()), "https://visible.test/")


def child_at_raises():
    return app_with(Node("frame", "frame", raises="child_at",
                         children=[doc("https://skipped.test/", "skipped"),
                                   doc("https://sibling.test/", "sibling")]))


check("one unfetchable child does not abandon its siblings",
      agree("child fetch raises", child_at_raises(), child_at_raises()), "https://sibling.test/")

# --- COUNTERS: the passes that were removed, measured -----------------------
visits_new, visits_full = {}, {}
a = plain(); _share(a, visits_new); a.visits = visits_new
b = plain(); _share(b, visits_full); b.visits = visits_full
ab.page_document_uri_action(a)
ab.navigation_focus_action(b)
check("navigation_focus visits the document's content nodes", visits_full.get("c0", 0) > 0, True)
check("the URI-only action NEVER enters the content subtree", visits_new.get("c0", 0), 0)
check("  ...for any of them", [visits_new.get(f"c{i}", 0) for i in range(3)], [0, 0, 0])
check("the URI-only action never inspects states (no focus pass)", visits_new.get("<state_set>", 0), 0)
check("  whereas navigation_focus does", visits_full.get("<state_set>", 0) > 0, True)
check("and it stops AT the document rather than walking past it", visits_new.get("doc", 0), 1)

# --- the removed flag is really gone ----------------------------------------
# A dead parameter is the defect this task chain corrected twice; assert it
# cannot be resurrected by a caller passing it.
try:
    ab.navigation_focus_action(plain(), False)
    check("navigation_focus takes no count_content parameter", "accepted a second argument", "TypeError")
except TypeError:
    check("navigation_focus takes no count_content parameter", "TypeError", "TypeError")
check("and its payload carries the content count unconditionally",
      "page_content_nodes" in ab.navigation_focus_action(plain()), True)

print(f"\n{'PASS' if failed == 0 else 'FAIL'} — {passed}/{passed + failed}")
sys.exit(0 if failed == 0 else 1)
