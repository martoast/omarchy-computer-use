#!/usr/bin/env python3
"""Structured accessibility-tree bridge for the computer-use MCP server.

Reads the live AT-SPI tree (the same API screen readers use) for a given
process, filters it down to elements worth acting on, and emits compact JSON
with REAL PHYSICAL SCREEN COORDINATES already computed. This exists so the
calling agent never has to burn a screenshot + vision pass just to find out
where a button is.

Coordinate note: AT-SPI on Wayland reports element bounds relative to the
client's own top-level surface, not true screen coordinates (a Wayland
client can't see its absolute position on screen). This script is handed
the window's real screen offset (from hyprctl) and adds it in, so callers
get real, directly-usable screen pixels.
"""
import os
import re
import sys
import json
import time
import warnings
from urllib.parse import urlsplit, unquote

warnings.filterwarnings("ignore")

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

# Role names as THIS at-spi2-core actually reports them (verified against
# Atspi.role_get_name() on 2.60.6, 2026-08-28): buttons are "button", NOT
# "push button" (renamed upstream in atk 2.46), and tabs are "page tab".
# The old set used "push button"/"tab", which NEVER matched on this system —
# every button on every page was silently invisible to read_page AND
# unfindable by click_element/wait_for_element (the Victoria's Secret
# "unclosable popup" was this: its OK button was in the tree the whole time
# as role "button"). Verify against role_get_name(), never against docs or
# another distro's behavior, if this ever seems wrong again.
INTERACTIVE_ROLES = {
    "button",
    "toggle button",
    "link",
    "entry",
    "password text",
    "combo box",
    "check box",
    "radio button",
    "menu item",
    "check menu item",
    "radio menu item",
    "page tab",
    "slider",
    "spin button",
}
# "dialog"/"alert" included so read_page actually SHOWS popups (cookie
# consent, email overlays) — VS's consent dialog has role "dialog" with a
# proper name, and being able to see it (and its buttons) beats inferring
# its existence from a screenshot.
STRUCTURAL_ROLES = {"heading", "image", "dialog", "alert"}

# Accept the legacy/HTML-ish names callers (and old site-memory files) may
# still use, mapped to what this at-spi actually reports.
ROLE_ALIASES = {
    "push button": "button",
    "tab": "page tab",
}


def normalize_role(role):
    if not role:
        return role
    return ROLE_ALIASES.get(role, role)


CHROMIUM_APP_NAMES = ("chromium", "chrome")
MAX_REPORTED_PIDS = 8
# References held during the pass in case it MISSES. Object references only, no
# calls made on them, so this costs nothing until a miss is proven.
MAX_CACHED_APPS = 128


def _chromium_like_pids(cached):
    """Bounded, deduped pids of Chromium-like apps among the cached records.

    Called ONLY after a lookup has already missed. This is where get_name is
    paid, precisely so that a successful lookup never pays it at all. A name
    probe that raises is skipped rather than counted: pid_probe_error_count is
    about pid probes, and conflating the two would misreport which half of the
    registry was unwell."""
    out = []
    for app, app_pid in cached:
        if len(out) >= MAX_REPORTED_PIDS:
            break
        if app_pid in out:
            continue
        try:
            name = (app.get_name() or "").lower()
        except Exception:
            continue
        if any(marker in name for marker in CHROMIUM_APP_NAMES):
            out.append(app_pid)
    return out


def find_app_by_pid(pid, stats=None):
    """The registry app for `pid`, or None.

    `stats` (optional dict) is filled DURING THIS SAME PASS — there is no second
    enumeration and the success path is unchanged. It exists because a miss
    currently reports only "not found", which cannot distinguish the three
    things that produce it: the window's owning process changed (so the frozen
    HEADLESS_CHROMIUM_PID no longer matches anything), the application
    deregistered while its process lives, or the registry itself lost apps.
    Those need different fixes, and the harness could not tell them apart.

    Only COUNTS and Chromium-like PIDs are recorded. Application names are never
    reported: they are supplied by other applications on a shared session bus,
    and a diagnostic must not become a channel for text this harness does not
    control.

    THE SUCCESS PATH IS UNCHANGED, and that is load-bearing: this runs on EVERY
    tool call. A matching pid returns IMMEDIATELY — before any get_name, and
    without visiting a single later child — so a successful lookup costs exactly
    what it always did. Passing `stats` only buys bounded bookkeeping and a list
    of app REFERENCES held in case the pass ends in a miss; nothing is called on
    those references unless the miss actually happens."""
    desktop = Atspi.get_desktop(0)
    count = desktop.get_child_count()
    if stats is not None:
        stats["desktop_child_count"] = count
        stats["readable_pid_count"] = 0
        stats["pid_probe_error_count"] = 0
        stats["chromium_like_pids"] = []
    cached = []
    for i in range(count):
        app = desktop.get_child_at_index(i)
        if app is None:
            if stats is not None:
                stats["pid_probe_error_count"] += 1
            continue
        try:
            app_pid = app.get_process_id()
        except Exception:
            # Previously swallowed silently, which made a registry that could
            # not answer indistinguishable from one that answered "absent".
            if stats is not None:
                stats["pid_probe_error_count"] += 1
            continue
        if app_pid == pid:
            return app  # hot path: no name probe, no later children, no extra work
        if stats is not None:
            stats["readable_pid_count"] += 1
            if len(cached) < MAX_CACHED_APPS:
                cached.append((app, app_pid))
    # The lookup has now PROVEN a miss, so the diagnostic may pay for names.
    if stats is not None:
        stats["chromium_like_pids"] = _chromium_like_pids(cached)
    return None


def target_pid_alive(pid):
    """Does SOMETHING hold this pid right now? Deliberately weak: pids are
    recycled, so this proves the number is in use, never that it is still our
    Chromium. It is reported as one input among several, not as a verdict."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return None


def obj_path(acc):
    """The AT-SPI D-Bus OBJECT PATH of this node, e.g.
    "/org/a11y/atspi/accessible/243" — a per-node identity assigned by the
    application that FOLLOWS THE NODE across sibling insert/remove/reorder and
    goes away when the node is destroyed (empirically verified for Chromium,
    issue #5 spike). Exposed as the GI `path` attribute (public get_path() is
    absent on this binding). Returns None if unavailable — callers MUST treat a
    missing path as no-identity and fail closed, never guess. This is the ref
    identity primitive; it is NOT the child-index tree path used elsewhere."""
    try:
        p = acc.path
        return p if isinstance(p, str) and p.startswith("/org/a11y/atspi/accessible/") else None
    except Exception:
        return None


def doc_gen_of(acc):
    """The object path of the DOCUMENT node enclosing `acc` — the ref generation
    token (issue #5). Walks ancestors to the nearest document node. None if not
    inside a document (e.g. browser chrome)."""
    cur = acc
    d = 0
    while cur is not None and d < 60:
        try:
            if cur.get_role_name() in ("document web", "document frame"):
                return obj_path(cur)
            cur = cur.get_parent()
        except Exception:
            return None
        d += 1
    return None


def squash_text(text):
    """PURE. Lowercase, without spaces, hyphens and underscores: "Check Out" -> "checkout"."""
    return "".join(ch for ch in (text or "").lower() if ch not in " -_\u00a0")


def dropdown_name(acc):
    """A stand-in name for a nameless combo box: '[dropdown] after "<label>"' from the nearest named sibling before it (or before
    its parent). Empty when nothing named precedes it."""
    try:
        node = acc
        for _level in range(3):
            parent = node.get_parent()
            if parent is None:
                return ""
            idx = node.get_index_in_parent()
            for j in range(idx - 1, max(-1, idx - 4), -1):
                sib = parent.get_child_at_index(j)
                label = (sib.get_name() or "").strip() if sib else ""
                if not label and sib is not None and sib.get_child_count() > 0:
                    first = sib.get_child_at_index(0)
                    label = (first.get_name() or "").strip() if first else ""
                if label:
                    return f'[dropdown] after "{label[:40]}"'
            node = parent
    except Exception:
        return ""
    return ""


def icon_button_name(acc):
    """A stand-in name for a nameless small button: '[icon button] after "<previous named sibling>"'.
    Empty when the button is not icon-sized or nothing named precedes it."""
    try:
        comp = acc.get_component_iface()
        ext = comp.get_extents(Atspi.CoordType.WINDOW) if comp else None
        if ext is None or ext.width <= 0 or ext.height <= 0 or ext.width > 64 or ext.height > 64:
            return ""
        parent = acc.get_parent()
        idx = acc.get_index_in_parent()
        for j in range(idx - 1, max(-1, idx - 4), -1):
            sib = parent.get_child_at_index(j)
            label = (sib.get_name() or "").strip() if sib else ""
            if not label and sib is not None and sib.get_child_count() > 0:
                first = sib.get_child_at_index(0)
                label = (first.get_name() or "").strip() if first else ""
            if label:
                return f'[icon button] after "{label[:40]}"'
    except Exception:
        return ""
    return ""


def get_bounds(acc, offset_x, offset_y):
    try:
        comp = acc.get_component_iface()
        if not comp:
            return None
        ex = comp.get_extents(Atspi.CoordType.WINDOW)
        if ex.width <= 0 or ex.height <= 0:
            return None
        x = ex.x + offset_x
        y = ex.y + offset_y
        return {
            "x": x,
            "y": y,
            "w": ex.width,
            "h": ex.height,
            "cx": x + ex.width // 2,
            "cy": y + ex.height // 2,
        }
    except Exception:
        return None


def get_link_path(acc):
    """Real link destination with tracking query params stripped -- e.g. an
    Amazon product page's ".../dp/B0GX2LPFHV/" vs a category page's "/b/" or
    "/s/". This is the single most reliable signal for telling a real
    single-product link apart from a carousel/category/brand-store link,
    which otherwise look identical from visible text alone (both can be
    named after the same product). Tracking query params on real
    e-commerce sites routinely run to 500+ characters and carry zero
    identifying signal, so they're dropped entirely rather than truncated.
    Returns the full scheme+host+path URL (query-string-free) -- safe to
    navigate to directly (typing a URL with no "?" into the address bar has
    none of the autocomplete-corruption issues a query string triggers),
    which is the whole point: a caller can navigate straight to a known-
    good link destination instead of clicking, sidestepping any click-
    target ambiguity (duplicate/overlay elements, hover-preview timing)
    entirely for the very common case of a plain, cleanly-linked resource.
    """
    try:
        hl = acc.get_hyperlink()
        if not hl:
            return None
        uri = hl.get_uri(0)
        if not uri or uri.startswith("javascript:") or uri.startswith("#"):
            return None
        parts = urlsplit(uri)
        if not parts.scheme or not parts.netloc:
            return None
        # Sanity check: a real URL path never contains a literal space or
        # CSS-selector syntax. Caught live: a link named "Results" on an
        # Amazon search page exposed an AT-SPI hyperlink URI that was
        # actually a raw CSS selector (".s-asin a:has(h2)", not a real
        # destination) -- direct-navigation trusted it and typed a garbage
        # URL into the address bar. Reject anything that looks like this
        # instead of assuming every AT-SPI hyperlink URI is real.
        decoded_path = unquote(parts.path)
        if any(c in decoded_path for c in (" ", "(", ")", ":")):
            return None
        return f"{parts.scheme}://{parts.netloc}{parts.path}"
    except Exception:
        return None


def get_link_href_full(acc):
    """Like get_link_path but KEEPS the query string (drops only the fragment). Some stores put the product
    identity in the query — Gap/Old-Navy's results tiles link to `/browse/product.do?pid=<id>` — which the
    path-only get_link_path strips, leaving the harvester unable to tell products apart. This is EXPOSED as a
    separate href_full field, never used for direct-navigation (a query string can corrupt address-bar
    autocomplete; that is the whole reason get_link_path drops it). Same fail-closed guards as get_link_path."""
    try:
        hl = acc.get_hyperlink()
        if not hl:
            return None
        uri = hl.get_uri(0)
        if not uri or uri.startswith("javascript:") or uri.startswith("#"):
            return None
        parts = urlsplit(uri)
        if not parts.scheme or not parts.netloc:
            return None
        decoded = unquote(parts.path + ("?" + parts.query if parts.query else ""))
        if any(c in decoded for c in (" ", "(", ")")):
            return None
        base = f"{parts.scheme}://{parts.netloc}{parts.path}"
        return f"{base}?{parts.query}" if parts.query else base
    except Exception:
        return None


# ONE shared source of truth for state-name -> Atspi.StateType member, so
# get_states and _state_snapshot can never diverge again. Members are
# UNPREFIXED on this binding (SHOWING, not STATE_SHOWING) — verified; the old
# getattr("STATE_"+name) silently returned nothing so get_states/read_page
# states were ALWAYS empty and focus_action always reported focused=false
# (gh issue #4 follow-up P1).
_STATE_MAP = {
    "showing": Atspi.StateType.SHOWING,
    "enabled": Atspi.StateType.ENABLED,
    "sensitive": Atspi.StateType.SENSITIVE,
    "focused": Atspi.StateType.FOCUSED,
    "checked": Atspi.StateType.CHECKED,
    # PRESSED is the state an aria-pressed toggle button carries, and it is
    # DISTINCT from CHECKED -- MEASURED: <button aria-pressed="true"> reports
    # role "toggle button" with PRESSED set and CHECKED clear. Omitting it made
    # a selected variant serialize identically to an unselected one, so
    # read_page, element_states and transition detection were all blind to the
    # single state a toggle-button picker uses to say "this one is chosen".
    "pressed": Atspi.StateType.PRESSED,
    "selected": Atspi.StateType.SELECTED,
    "expanded": Atspi.StateType.EXPANDED,
    "editable": Atspi.StateType.EDITABLE,
}

# Roles where enabled/disabled is a MEANINGFUL property. A static/heading/
# panel lacking ENABLED is not "disabled" — only interactive controls are.
_DISABLEABLE_ROLES = {
    "button", "toggle button", "link", "entry", "password text", "combo box",
    "check box", "radio button", "menu item", "check menu item",
    "radio menu item", "page tab", "slider", "spin button",
}


def get_states(acc):
    """Output vocabulary: checked/pressed/selected/focused/expanded (present when
    set), plus 'disabled'. Uses the shared _STATE_MAP so it can't drift from
    _state_snapshot."""
    try:
        ss = acc.get_state_set()
        role = acc.get_role_name()
    except Exception:
        return []
    names = []
    for name in ("checked", "pressed", "selected", "focused", "expanded"):
        try:
            if ss.contains(_STATE_MAP[name]):
                names.append(name)
        except Exception:
            pass
    # 'disabled' ONLY for an interactive-role control that reports NEITHER
    # ENABLED nor SENSITIVE (a genuinely disabled control). A static/heading
    # lacking ENABLED is not disabled; a partial/defunct set that still has
    # SENSITIVE is not labeled disabled either.
    try:
        if (role in _DISABLEABLE_ROLES
                and not ss.contains(_STATE_MAP["enabled"])
                and not ss.contains(_STATE_MAP["sensitive"])):
            names.append("disabled")
    except Exception:
        pass
    return names


def collect(app, offset_x, offset_y, include_text, text_filter, role_filter, limit, state_filter=None, dialog_contents=False, loose_roles=False, start_path=None, anchor=None, page_url_known=None):
    # SEVERAL ROLES IN ONE WALK ("entry|combo box|button", 2026-10-08): a checkout form read was three whole-page walks (~0.9 s
    # each, twice per address fill); the tree is walked once and each role matched.
    role_set = {normalize_role(r.strip()) for r in role_filter.split("|") if r.strip()} if role_filter and "|" in role_filter else set()
    results = []
    counter = [0]
    # start_path (read_page start_at_ref, 2026-09-29): collect nothing until the DFS reaches the node with this object
    # path, then collect as usual — so a buy box past the first 500 rows (live YETI) can be read without dropping
    # the provenance the walk carries down from the document. `anchor` (a dict) reports whether it was found.
    started = [start_path is None]

    # Current page's own hostname, used to flag links whose href points
    # somewhere else entirely (a different subdomain/domain) -- ad-tracking
    # redirects (e.g. a sponsored search result linking through an ad
    # server before the real product) are reliably on a different host than
    # the page you're on, on any site, so this is a general signal rather
    # than a per-store rule. Caught live: a sponsored Amazon result's href
    # went to "aax-us-east-retail-direct.amazon.com/x/c/..." instead of a
    # normal "/dp/<ASIN>/" product path, and got clicked as if it were a
    # real product link, costing ~60s in an ad redirect chain.
    current_host = None
    try:
        # the caller's page info when it has it (one page-info read per snapshot, 2026-10-08)
        page_url = page_url_known if page_url_known is not None else get_page_info(app).get("url")
        if page_url:
            current_host = urlsplit(page_url).netloc.lower()
    except Exception:
        current_host = None

    def visit(acc, depth, in_doc=False, doc_gen=None, doc_class="unknown", in_dialog=False):
        if len(results) >= limit or depth > 40:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        name = ""  # read below, only for a node this read can return
        # The enclosing document node's OBJECT PATH is the "generation" token
        # (issue #5): it changes on reload/navigation, so a ref captured on a
        # prior document fails stale even if an element object path is later
        # reused. Set it when we cross into a document subtree.
        if role in ("document web", "document frame"):
            doc_gen = obj_path(acc)
            # Classify the document ONCE, here, where we already cross it — so
            # the class travels with every element from the moment it is
            # collected rather than being filtered back out of serialized
            # output later. One Document-interface read per document, not per node.
            doc_class = classify_document(acc)
        # Track whether we're inside the web document. Elements outside it
        # are browser chrome (omnibox, toolbar buttons) — still useful to
        # SHOW (the address bar is a legitimate target), but they must not
        # be recorded into per-domain site memory: Chromium's "Ask AI Mode"
        # omnibox got saved as a Victoria's Secret site field and misled a
        # debugging session (gh issue #1, non-blocking cleanup).
        in_doc = in_doc or role in ("document web", "document frame")
        # is_root: is THIS node a dialog's root, as opposed to something inside
        # one? Captured BEFORE in_dialog absorbs it, so a modal's descendants are
        # never miscounted as further modals.
        # in_dialog: inside ANY dialog/alert subtree, not just a particular one —
        # a second modal's own text and buttons must never be counted as page
        # content restored by dismissing the first.
        is_root = is_dialog_node(acc, role)
        in_dialog = in_dialog or is_root
        if not started[0] and obj_path(acc) == start_path:
            started[0] = True
            if anchor is not None:
                anchor["found"] = True

        wanted_roles = INTERACTIVE_ROLES | STRUCTURAL_ROLES
        if include_text:
            wanted_roles = wanted_roles | {"paragraph", "static", "section", "list item"}
        # "Read the popup": a dialog's options are often bare <li> nodes (live
        # On: every size in its size sheet), so they count as content there.
        if dialog_contents and in_dialog:
            wanted_roles = wanted_roles | {"list item"}

        # A dialog ROOT is always collectable, whatever role Chromium gave it
        # and whether or not it has an accessible name.
        # The name gate is what this actually rescues, MEASURED: a
        # div[role=dialog] with no accessible name (its visible heading is a
        # child, which is ordinary markup) was dropped from read_page entirely —
        # an unnamed overlay covering the page is the very worst row to lose,
        # since it is the reason the page looks dead.
        # The role gate is belt-and-braces: on THIS Chromium div[role=dialog]
        # maps to `dialog` and div[role=alertdialog] to `alert`, both already in
        # STRUCTURAL_ROLES (measured). It matters only where an ARIA dialog role
        # is not mapped natively, which is_dialog_node still detects from
        # xml-roles.
        # THE NAME ONLY WHERE IT CAN MATTER (2026-10-08): every node's name was one more round trip to the browser — on a checkout
        # page a read took ~0.55 s against ~0.24 s for a walk without names — though only a returnable role that passes the role
        # filter ever uses it. Containers and other roles skip it; the rows returned are unchanged.
        role_ok = (not role_filter) or (role == role_filter) or (role in role_set) or (
            loose_roles and role_filter in ("button", "link") and role in ("button", "link", "push button")) or (
            dialog_contents and role_filter == "dialog" and in_dialog)
        if (role in wanted_roles or is_root) and role_ok:
            try:
                name = acc.get_name() or ""
            except Exception:
                name = ""
        # A small nameless icon button in the page takes a stand-in name from the
        # named control just before it (live Sephora 2026-09-26: the basket's trash
        # icon is a bare button after combo box "Quantity"; dropped, the agent
        # could not remove leftover items and fell back to screenshot clicks).
        if not name and in_doc and role in ("button", "push button"):
            name = icon_button_name(acc)
        # A nameless DROPDOWN takes a stand-in name from the label before it (live Amazon 2026-10-07: the shoe size <select> had no
        # name, so read_page showed only its options, all at one point; the agent pressed an option twice, it never stuck, the
        # quote failed). With the dropdown in the read, select_option can open it and type the size.
        if not name and in_doc and role == "combo box":
            name = dropdown_name(acc)
        if (role in wanted_roles and (name or role in ("entry", "password text"))) or is_root:
            # FILTERS FIRST (2026-10-08): role and name are already read; the position and states are two more round trips to the
            # browser per node, and a filtered read ("entry", "button", a text) fetched them for EVERY named node only to drop
            # most of them. A node that cannot match is not measured; the rows returned are unchanged.
            pre_needles = [t for t in text_filter.split("||") if t] if (text_filter and "||" in text_filter) else [text_filter]
            pre_text = (not text_filter) or any((t.lower() in name.lower()) or (
                squash_text(t) and squash_text(t) in squash_text(name)) for t in pre_needles)
            pre_role = (not role_filter) or (role == role_filter) or (role in role_set) or (
                loose_roles and role_filter in ("button", "link") and role in ("button", "link", "push button")) or (
                dialog_contents and role_filter == "dialog" and in_dialog)
            bounds = get_bounds(acc, offset_x, offset_y) if (pre_text and pre_role) else None
            # Skip off-canvas screen-reader-only elements (e.g. a
            # "position: absolute; top: -9999px" skip-link or a decoy
            # landmark heading reused across every page of a site) --
            # legitimately real, but never what read_page/wait_for_element
            # callers actually want. Caught live: a hidden "Search Results"
            # heading (present on every page template, positioned off-canvas
            # at y=-6704) kept satisfying a generic role-only wait_for_element
            # even after the agent had already reached the real, visible
            # product page -- it just never noticed, since this decoy
            # "matched" first. A large POSITIVE x/y is normal (below-the-fold
            # or off to the side, real and reachable by scrolling) and is
            # NOT filtered -- only meaningfully negative coordinates, which
            # only ever occur from this deliberate off-canvas-hiding trick.
            # Rows just above the window are still content (live Lululemon at the demo's width: its sticky order
            # summary's Subtotal sat at y=-77 and was dropped, so the summary could not be read); the decoys this
            # filter exists for sit thousands of pixels away (-6704, -9999).
            if bounds and (bounds["x"] < -1000 or bounds["y"] < -1000):
                bounds = None
            if bounds:
                # "checkout" finds "Check Out", "e-mail" finds "Email" (live Nordstrom: the agent searched
                # "checkout" and missed its "Check Out" link): compared without spaces and hyphens too.
                # "a||b||c" matches ANY of the texts in ONE walk (the reader's buy-panel read: "add to cart||$||sold"
                # walked a 3,000-node Walmart tree three times, ~5.6 s; once is ~2 s).
                needles = [t for t in text_filter.split("||") if t] if (text_filter and "||" in text_filter) else [text_filter]
                matches_text = (not text_filter) or any((t.lower() in name.lower()) or (
                    squash_text(t) and squash_text(t) in squash_text(name)) for t in needles)
                # dialog_contents widens a "dialog" filter from the roots to
                # everything inside them — the popup's own controls, which is
                # what a caller reading "the dialog" needs to act on.
                # A button and a link are the same thing to a shopper (live Nordstrom: "Check Out" is a link;
                # the agent's button-filtered read found nothing).
                matches_role = (not role_filter) or (role == role_filter) or (role in role_set) or (
                    loose_roles and role_filter in ("button", "link") and role in ("button", "link", "push button")) or (
                    dialog_contents and role_filter == "dialog" and in_dialog)
                # STATE FILTER: the PRESENCE of a positive serialized state.
                # It answers "which controls report themselves checked/pressed/
                # selected/..." and deliberately CANNOT express the negation: an
                # unchecked box, an unpressed toggle and a control that never
                # exposes the state at all are indistinguishable here — all
                # three simply carry nothing — so a "not checked" filter would
                # return a set no caller could interpret.
                # Computed once here and reused for the entry, so the filter and
                # the reported states can never disagree.
                states = get_states(acc)
                # CONJUNCTIVE with text and role: an element must satisfy EVERY
                # filter supplied, never any-of.
                matches_state = (not state_filter) or (state_filter in states)
                if started[0] and matches_text and matches_role and matches_state:
                    counter[0] += 1
                    ref = f"e{counter[0]}"
                    entry = {
                        "ref": ref,
                        "role": role,
                        "name": name[:120],
                        **bounds,
                    }
                    # Ref IDENTITY (issue #5): serialize the D-Bus object path +
                    # the document generation. resolveElement passes these back
                    # to the action, which resolves the UNIQUE live node by them
                    # and fails stale otherwise — never name/geometry/coords.
                    # TEST-ONLY (gated): simulate a snapshot that lacks object-path
                    # identity, to exercise the ref fail-closed branch (issue #5 (j)).
                    if not os.environ.get("COMPUTER_USE_TEST_NO_OBJPATH"):
                        op = obj_path(acc)
                        if op:
                            entry["obj_path"] = op
                        if doc_gen:
                            entry["doc_gen"] = doc_gen
                    if role == "link":
                        link_path = get_link_path(acc)
                        if link_path:
                            entry["href"] = link_path
                            link_full = get_link_href_full(acc)
                            if link_full and link_full != link_path:
                                entry["href_full"] = link_full  # query kept for the harvester (Gap ?pid=); never for direct-nav
                            if current_host:
                                href_host = urlsplit(link_path).netloc.lower()
                                if href_host and site_of(href_host) != site_of(current_host):
                                    entry["off_site"] = True
                    value = None
                    try:
                        val_iface = acc.get_value_iface()
                        if val_iface:
                            value = val_iface.get_current_value()
                    except Exception:
                        pass
                    if value is not None:
                        entry["value"] = value
                    if states:
                        entry["states"] = states
                    # ALWAYS explicit: a consumer that must require a
                    # positively non-document node cannot distinguish absent
                    # from false, and "absent" was the shape browser chrome had.
                    entry["in_doc"] = bool(in_doc)
                    # "page" | "browser_internal" | "unknown". in_doc cannot carry
                    # this: the omnibox dropdown is itself a document web, so it
                    # reports in_doc=true while being browser UI.
                    entry["doc_class"] = doc_class if in_doc else "chrome"
                    if in_dialog:
                        entry["in_dialog"] = True
                    # Only the root carries this, so counting/enumerating
                    # dialogs never multiplies by their descendants.
                    if is_root:
                        entry["dialog_root"] = True
                    results.append(entry)

        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            if len(results) >= limit:
                return
            try:
                child = acc.get_child_at_index(i)
            except Exception:
                continue
            if child is not None:
                visit(child, depth + 1, in_doc, doc_gen, doc_class, in_dialog)

    visit(app, 0)
    return results


# --- Document identity: page surface vs browser-internal WebUI ----------------
# MEASURED on this Chromium: the omnibox suggestion dropdown is itself a
# `document web` node, so "has a document ancestor" (is_in_document) CANNOT tell
# page content from browser UI. Their Document interfaces do:
#     page  -> URI "https://…" / "file:///…"
#     popup -> URI "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html"
# Classification is therefore by URI SCHEME, parsed rather than prefix-matched so
# a page URL that merely CONTAINS a scheme name (…/chrome-extension-guide) can
# never be mistaken for browser UI.
BROWSER_DOC_SCHEMES = frozenset({
    "chrome", "chrome-untrusted", "chrome-search", "chrome-extension",
    "devtools", "chrome-error",
})


def classify_document_uri(uri):
    """PURE (unit-tested): "browser_internal" | "page" | "unknown".
    A present URI with a browser scheme is browser UI; a present URI with any
    other scheme is a page surface; missing or unparseable is UNKNOWN — never
    silently treated as either, because the two callers want opposite defaults
    (the read side must not hide real content, the act side must not act on an
    unproven surface)."""
    if not uri or not isinstance(uri, str):
        return "unknown"
    try:
        scheme = urlsplit(uri.strip()).scheme.lower()
    except Exception:
        return "unknown"
    if not scheme:
        return "unknown"
    return "browser_internal" if scheme in BROWSER_DOC_SCHEMES else "page"


def document_uri(doc):
    """The document's own URI via the Document interface, or None."""
    try:
        di = doc.get_document_iface()
        if not di:
            return None
        return di.get_document_attribute_value("DocURL") or di.get_document_attribute_value("URI")
    except Exception:
        return None


def enclosing_document(acc):
    """The nearest document node at or above acc, or None."""
    cur = acc
    depth = 0
    while cur is not None and depth < 60:
        try:
            if cur.get_role_name() in ("document web", "document frame"):
                return cur
            cur = cur.get_parent()
        except Exception:
            return None
        depth += 1
    return None


def classify_document(doc):
    return "unknown" if doc is None else classify_document_uri(document_uri(doc))


def target_doc_class(acc):
    """The doc_class of a resolved ACTION target, derived exactly as collect()
    derives it for a snapshot entry: the enclosing document's classification,
    or "chrome" when the node lives under no document at all.

    The action responses previously returned only `in_doc`, which CANNOT stand
    in for this — the omnibox suggestion popup is itself a `document web`, so
    in_doc is true for browser UI (see the note above classify_document_uri).
    Without this field the act side had no provenance to gate on, and a
    text-targeted click could reach a browser window control."""
    doc = enclosing_document(acc)
    return "chrome" if doc is None else classify_document(doc)


def is_browser_internal_document(doc):
    """True ONLY on positive evidence (a URI carrying a browser scheme)."""
    return classify_document(doc) == "browser_internal"


def is_page_document(doc):
    """True ONLY on positive evidence (a URI carrying a non-browser scheme)."""
    return classify_document(doc) == "page"


def get_page_info(app):
    info = {}
    try:
        for i in range(app.get_child_count()):
            frame = app.get_child_at_index(i)
            if frame and frame.get_role_name() == "frame":
                info["title"] = frame.get_name()
                break
    except Exception:
        pass

    def find_documents(acc, out, depth=0):
        """EVERY document in the tree, not just the first — the caller must be
        able to choose the page one rather than whichever DFS reached first."""
        if depth > 20 or len(out) > 12:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        if role in ("document web", "document frame"):
            out.append(acc)
            # Not into a document's own subtree (2026-10-08): the walk into the page document visited every node of the page
            # (~0.11 s, twice per read) only to append iframes AFTER it — the page document is always found first and is the one
            # picked; a document inside it never is.
            return
        try:
            for i in range(acc.get_child_count()):
                child = acc.get_child_at_index(i)
                if child:
                    find_documents(child, out, depth + 1)
        except Exception:
            pass

    # Collect EVERY document, then pick a positively-identified PAGE document.
    # Taking the first one DFS happens to reach can hand back the Omnibox
    # Popup's chrome:// URL as if it were the page (measured: the popup document
    # exists in the tree even while closed). If no page document can be proven,
    # the URL is reported as unknown rather than falling back to browser UI.
    docs = []
    find_documents(app, docs)
    page_doc = next((d for d in docs if is_page_document(d)), None)
    if page_doc is not None:
        url = document_uri(page_doc)
        if url:
            info["url"] = url
        # Chromium marks the page document BUSY until it has finished loading,
        # and while it is, the tree can be a stale PART of the page (live Coach
        # bag: 50 rows ending at the order total for ~30 s after launch, no
        # "Proceed to Checkout", then 237 rows at once when BUSY cleared).
        # Right after launch the same stall can show as a page document with
        # NO content at all and no BUSY flag (live Coach: 0 children for ~30 s,
        # the agent read an empty page and gave up). A store page is never
        # empty, so that counts as loading too; "busy" only ever buys a bounded
        # wait and a note, never a failure.
        try:
            if page_doc.get_state_set().contains(Atspi.StateType.BUSY) or page_doc.get_child_count() == 0:
                info["busy"] = True
        except Exception:
            pass
    else:
        info["url_unknown_reason"] = ("no page document could be positively identified"
                                      + (" (only browser-internal documents present)" if docs else " (no document found)"))
    return info


def find_all_live(app, text_filter, role_filter):
    """Walk the tree and return ALL live Atspi.Accessible objects matching
    the filters, in document order (not just serialized bounds), so callers
    can act on a specific one AND know how many total matches existed.
    Duplicate markup for the same visible name+role is common on real sites
    (responsive-breakpoint nav variants, screen-reader-only skip links) --
    silently picking the wrong one makes a click a no-op with no error."""
    wanted_roles = INTERACTIVE_ROLES | STRUCTURAL_ROLES
    found = []

    def visit(acc, depth):
        if depth > 40 or len(found) >= 50:
            return
        try:
            role = acc.get_role_name()
            name = acc.get_name() or ""
        except Exception:
            return
        if role in wanted_roles and (name or role in ("entry", "password text")):
            matches_text = (not text_filter) or (text_filter.lower() in name.lower())
            matches_role = (not role_filter) or (role == role_filter)
            if matches_text and matches_role:
                found.append(acc)
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            if len(found) >= 50:
                return
            try:
                child = acc.get_child_at_index(i)
            except Exception:
                continue
            if child is not None:
                visit(child, depth + 1)

    visit(app, 0)
    return found


def is_in_document(acc):
    """True if acc lives under a web-document node (i.e. it is page content,
    not browser chrome like the omnibox / Find bar / side panel). Walks the
    parent chain. Used by the caller to bind Return-submit safety to the
    ACTUAL address bar rather than any chrome editable that merely happens
    to hold the same text (gh issue #1 follow-up)."""
    cur = acc
    depth = 0
    while cur is not None and depth < 60:
        try:
            if cur.get_role_name() in ("document web", "document frame"):
                return True
            cur = cur.get_parent()
        except Exception:
            return False
        depth += 1
    return False


def is_visibly_rendered(acc):
    """True if this element currently has a real, nonzero on-screen size.
    Filters out hidden/duplicate accessibility markup (a second copy of the
    same nav link for a different responsive breakpoint, a skip-navigation
    link, etc.) that AT-SPI still reports even though it has no actual
    clickable surface right now -- clicking one of these is silently a
    no-op, which is exactly the bug this exists to avoid."""
    try:
        comp = acc.get_component_iface()
        if not comp:
            return False
        ex = comp.get_extents(Atspi.CoordType.SCREEN)
        return ex.width > 0 and ex.height > 0
    except Exception:
        return False


def find_first_live(app, text_filter, role_filter):
    """Return (target, match_count). Prefers an exact (trimmed,
    case-insensitive) name match over a mere substring match -- e.g.
    searching "Men" should hit the "Men" nav link, not "accessibility
    statement" just because it contains "men" and happened to be found
    first walking the tree. Within that preference, prefers a VISIBLY
    RENDERED element (real on-screen size) over one that merely exists in
    the tree, since duplicate/hidden accessibility markup sharing the same
    name+role is common on real sites (responsive-breakpoint nav variants,
    screen-reader-only links) and clicking one is silently a no-op."""
    matches = find_all_live(app, text_filter, role_filter)
    if not matches:
        return None, 0
    needle = (text_filter or "").strip().lower()

    def is_exact(acc):
        try:
            return acc.get_name().strip().lower() == needle
        except Exception:
            return False

    exact = [m for m in matches if is_exact(m)]
    ranked = exact if exact else matches
    for m in ranked:
        if is_visibly_rendered(m):
            return m, len(matches)
    return ranked[0], len(matches)


def resolve_by_objpath(app, doc_gen, target_path, expect_role=None, expect_name=None):
    """Resolve the UNIQUE live node identified by (doc_gen, obj_path) — the ref
    identity captured by read_page (issue #5). ONE fresh DFS, no name/geometry/
    child-index fallback ever. Steps:
      1. SCOPE: if doc_gen is present (an IN-DOCUMENT element), find the document
         node whose object path == doc_gen and search only its subtree — this is
         the GENERATION GATE: a reload/navigation makes doc_gen absent -> stale_doc,
         so a reused in-document object path can never mis-target. If doc_gen is
         absent (BROWSER CHROME, which is not inside a web document and whose
         object paths are session-stable, not subject to per-navigation reuse),
         scope to the whole application instead.
      2. Within that scope, find the node whose object path == target_path
         (object paths are per-node and FOLLOW the node; a destroyed/recreated
         node gets a different path). Zero -> stale_none, >1 -> stale_ambiguous.
      3. SANITY (not identity): if expect_role/expect_name are given and differ
         from the live node, return stale_mismatch rather than act.
    Returns (node|None, status) with status in {ok, stale_noident, stale_doc,
    stale_none, stale_ambiguous, stale_mismatch}."""
    if not target_path:
        return None, "stale_noident"

    doc = [None]

    def find_doc(acc, depth):
        if doc[0] is not None or depth > 40:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        if role in ("document web", "document frame") and obj_path(acc) == doc_gen:
            doc[0] = acc
            return
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                find_doc(c, depth + 1)

    if doc_gen:
        find_doc(app, 0)
        if doc[0] is None:
            return None, "stale_doc"  # document reloaded/navigated -> generation gate
        scope = doc[0]
    else:
        scope = app  # chrome element: no document generation, scope to the app

    hits = []

    # FIRST HIT ENDS THE WALK (2026-10-10): an object path is the node's D-Bus object path, unique within the application's
    # connection — a second hit could only be the same node reached twice, never another one. Walking on to prove uniqueness
    # cost ~0.8 s per resolve on a page with a long product rail (4 resolves per click). Every gate stays: doc_gen, stale_none,
    # the role/name sanity check below.
    def find_node(acc, depth):
        if depth > 60 or hits:
            return
        if obj_path(acc) == target_path:
            hits.append(acc)
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                find_node(c, depth + 1)

    find_node(scope, 0)
    if not hits:
        return None, "stale_none"
    if len(hits) > 1:
        return None, "stale_ambiguous"
    node = hits[0]
    try:
        if expect_role and node.get_role_name() != expect_role:
            return None, "stale_mismatch"
        # names are stored truncated to 120 in the snapshot; compare on that basis
        live_name = node.get_name() or ""
        if not live_name and (expect_name or "").startswith("[icon button] after "):
            live_name = icon_button_name(node)  # the stand-in name read_page gave it
        if not live_name and (expect_name or "").startswith("[dropdown] after "):
            live_name = dropdown_name(node)
        if expect_name is not None and live_name[:120] != expect_name[:120]:
            return None, "stale_mismatch"
    except Exception:
        return None, "stale_mismatch"
    return node, "ok"


def _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg):
    """Front-door for the target actions. If obj_path_arg is present, resolve by
    the (doc_gen, obj_path) IDENTITY (issue #5) and, on any failure, return a
    stale_ref dict (never fall back to name/geometry). Otherwise resolve the
    legacy way via find_first_live (text/role) — UNCHANGED for non-ref callers.
    Returns (target|None, match_count, stale_dict|None)."""
    if obj_path_arg:
        node, status = resolve_by_objpath(app, doc_gen_arg, obj_path_arg, role_filter, text_filter)
        if status != "ok":
            return None, 0, {"stale_ref": True, "status": status,
                             "reason": "this ref no longer identifies a live element (" + status +
                                       ") — the page changed; call read_page again and use a fresh ref"}
        return node, 1, None
    t, mc = find_first_live(app, text_filter, role_filter)
    return t, mc, None


def get_selected_action(app, text_filter, role_filter, obj_path_arg=None, doc_gen_arg=None):
    if obj_path_arg:
        target, _mc, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
        if stale:
            return stale
    else:
        target, _ = find_first_live(app, text_filter, role_filter)
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}"}
    try:
        sel = target.get_selection_iface()
        if sel and sel.get_n_selected_children() > 0:
            child = sel.get_selected_child(0)
            return {"role": target.get_role_name(), "name": target.get_name(), "selected": child.get_name() if child else None}
    except Exception:
        pass
    # Fallback: some comboboxes expose the current value as a STATE_SELECTED child
    # found via the ordinary child walk rather than the Selection interface —
    # directly, or one level down (a native <select>: combo box > menu > menu item).
    try:
        for i in range(target.get_child_count()):
            child = target.get_child_at_index(i)
            if child is None:
                continue
            states = child.get_state_set()
            if states.contains(Atspi.StateType.SELECTED):
                return {"role": target.get_role_name(), "name": target.get_name(), "selected": child.get_name()}
            for j in range(min(child.get_child_count(), 400)):
                grand = child.get_child_at_index(j)
                if grand is not None and grand.get_state_set().contains(Atspi.StateType.SELECTED):
                    return {"role": target.get_role_name(), "name": target.get_name(), "selected": grand.get_name()}
    except Exception:
        pass
    # Last resort: the text the control itself displays (a custom dropdown's
    # button-like face), reported separately so a caller never mistakes it for
    # a proven selection.
    shown = None
    try:
        ti = target.get_text_iface()
        if ti:
            shown = (Atspi.Text.get_text(ti, 0, -1) or "").strip()[:200] or None
    except Exception:
        shown = None
    return {"role": target.get_role_name(), "name": target.get_name(), "selected": None, "shown": shown}


def scroll_to_action(app, offset_x, offset_y, text_filter, role_filter, obj_path_arg=None, doc_gen_arg=None):
    target, match_count, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
    if stale:
        return stale
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}"}
    # PROVENANCE BEFORE ANY SIDE EFFECT. Scrolling is a real effect on a real
    # surface, and this runs during RESOLUTION — before the caller has
    # authorized anything. Scrolling browser chrome, the browser's own WebUI, or
    # a surface whose document could not even be established means acting on an
    # unproven surface, and it also spends the settle wait below on a target
    # that is about to be refused. So only a POSITIVE page is scrolled;
    # everything else is classified and measured without being touched.
    doc_class = target_doc_class(target)
    scrolled = False
    # ALREADY IN VIEW: no scroll, no settle (2026-10-08: every dropdown read and select paid ~0.5 s here — the scroll and its
    # 0.35 s settle — for a control already on screen; a checkout State pick does three such calls). Fully inside the page
    # document's visible box, in the same coordinate space; anything unsure is scrolled as before.
    in_view = False
    if doc_class == "page":
        try:
            doc = enclosing_document(target)
            te = target.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
            de = doc.get_component_iface().get_extents(Atspi.CoordType.WINDOW) if doc is not None else None
            in_view = bool(de and te.width > 0 and te.height > 0 and de.width > 0 and de.height > 0
                           and te.x >= de.x and te.y >= de.y and te.x + te.width <= de.x + de.width and te.y + te.height <= de.y + de.height)
        except Exception:
            in_view = False
    if doc_class == "page" and not in_view:
        try:
            comp = target.get_component_iface()
            comp.scroll_to(Atspi.ScrollType.ANYWHERE)
            scrolled = True
        except Exception as e:
            return {"error": f"scroll_to failed: {e}"}
    # Sleep IN-PROCESS, holding the same live object handle, then read its
    # bounds fresh. This is the actual fix for a real bug: the old code
    # returned bounds immediately (stale -- pre-layout-settle) and left the
    # caller to re-fetch fresh coordinates via a brand new text+role search
    # in a separate process (object handles can't cross a process
    # boundary) -- which, whenever duplicate markup exists for the same
    # name+role (very common: responsive-breakpoint nav variants,
    # screen-reader-only links), could silently re-resolve to a DIFFERENT,
    # possibly hidden/non-functional element than the one just scrolled to.
    # Caught live: a confirmed real product link's ref-based click landed on
    # a duplicate at different coordinates and never navigated. Holding the
    # object across the sleep, in one process, eliminates the re-search
    # entirely -- there is no second element to accidentally pick.
    # The settle wait exists so a SCROLL can land before bounds are read. With no
    # scroll there is nothing to settle, so an unproven surface costs no delay.
    if scrolled:
        time.sleep(0.35)
    bounds = get_bounds(target, offset_x, offset_y)
    result = {"role": target.get_role_name(), "name": target.get_name(), "match_count": match_count,
              "in_doc": is_in_document(target), "doc_class": doc_class, "scrolled": scrolled,
              "landmark": _nearest_landmark(target),
              "obj_path": obj_path(target), "doc_gen": doc_gen_of(target), **(bounds or {})}
    if target.get_role_name() == "link":
        href = get_link_path(target)
        if href:
            result["href"] = href
            try:
                page_url = get_page_info(app).get("url")
                if page_url:
                    current_host = urlsplit(page_url).netloc.lower()
                    href_host = urlsplit(href).netloc.lower()
                    if current_host and href_host and site_of(href_host) != site_of(current_host):
                        result["off_site"] = True
            except Exception:
                pass
    return result


def focus_action(app, offset_x, offset_y, text_filter, role_filter, obj_path_arg=None, doc_gen_arg=None):
    # Grab keyboard focus via the accessibility API directly, instead of
    # relying on a synthetic mouse click to land on the right spot and
    # happen to focus the field. Caught live: a human confirmed clicking +
    # typing + Enter works fine in the same field our automation was
    # blocked on -- our synthetic click was landing without ever properly
    # focusing the element (e.g. an autocomplete overlay steals it, or
    # coordinates are stale by click time), so the typed text and Return
    # went nowhere. grab_focus() is the same mechanism a screen reader uses
    # to move focus and works even when a pointer click wouldn't.
    target, match_count, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
    if stale:
        return stale
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}"}
    # Waits are adaptive (2026-09-26: a fixed 0.2 s + 0.15 s here was ~0.35 s of every typed field): settle
    # only when the scroll actually moved the field, then poll for focus instead of sleeping a fixed time.
    before = get_bounds(target, offset_x, offset_y)
    try:
        comp = target.get_component_iface()
        comp.scroll_to(Atspi.ScrollType.ANYWHERE)
    except Exception as e:
        return {"error": f"scroll_to failed: {e}"}
    if get_bounds(target, offset_x, offset_y) != before:
        time.sleep(0.2)
    grabbed = False
    try:
        comp = target.get_component_iface()
        grabbed = bool(comp.grab_focus())
    except Exception:
        grabbed = False
    focused = False
    deadline = time.time() + 0.35
    while True:
        focused = "focused" in get_states(target)
        if focused or time.time() >= deadline:
            break
        time.sleep(0.025)
    bounds = get_bounds(target, offset_x, offset_y)
    # The page's focused editable, read in this same process: the caller's focus proof without a second
    # bridge process (~0.37 s per typed field).
    # FAST PATH (2026-10-10): the target itself reports FOCUSED inside a page document — it IS the focused node a whole-tree walk
    # would rank first (rank_focus_hits prefers the page's focus over chrome's), without visiting every node: on a checkout page
    # with a long product rail the walk cost ~2.3 s of every typed field (2.5 s focus on a 1,200-product test page vs 0.22 s).
    focused_now = None
    try:
        if focused and is_in_document(target):
            ss_t = target.get_state_set()
            node = focused_node_info(target, target.get_role_name(), ss_t, True)
            if node.get("doc_class") == "page":
                focused_now = node
    except Exception:
        focused_now = None
    if focused_now is None:
        try:
            focused_now = get_focused_action(app).get("focused")
        except Exception:
            focused_now = None
    return {
        "focused_now": focused_now,
        "role": target.get_role_name(),
        "name": target.get_name(),
        "match_count": match_count,
        "grab_focus_called": grabbed,
        "focused": focused,
        "in_doc": is_in_document(target),
        "doc_class": target_doc_class(target),
        "landmark": _nearest_landmark(target),
        "obj_path": obj_path(target),
        "doc_gen": doc_gen_of(target),
        **(bounds or {}),
    }


def read_text_action(app, text_filter, role_filter):
    """Read the CURRENT text content of a field (entry/combo box), for
    verifying that typed text actually landed. A popup's click-outside-
    dismiss handler can silently consume the focusing click, so the
    keystrokes that follow go nowhere while the tool reports success
    (caught live on Victoria's Secret: the click on the search box
    dismissed the cookie dialog and the typed query evaporated). Checks the
    target's own Text interface first, then any descendant that exposes
    one (an ARIA combobox usually wraps the real <input> as a child)."""
    target, _ = find_first_live(app, text_filter, role_filter)
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}"}

    def text_of(acc):
        # NOTE: must call the UNBOUND Atspi.Text methods. get_text_iface()
        # returns the same underlying Accessible object, so a bound
        # ti.get_text(0, n) resolves to the deprecated 1-arg
        # Accessible.get_text() iface getter and throws TypeError — caught
        # live: every read silently returned "" because of this collision.
        try:
            ti = acc.get_text_iface()
            if ti:
                n = Atspi.Text.get_character_count(ti)
                if n > 0:
                    return Atspi.Text.get_text(ti, 0, min(n, 300))
        except Exception:
            pass
        return None

    def search(acc, depth):
        if depth > 6:
            return None
        t = text_of(acc)
        if t is not None:
            return t
        try:
            for i in range(acc.get_child_count()):
                child = acc.get_child_at_index(i)
                if child is not None:
                    found = search(child, depth + 1)
                    if found is not None:
                        return found
        except Exception:
            pass
        return None

    return {"role": target.get_role_name(), "name": target.get_name(), "text": search(target, 0) or ""}


EDITABLE_ROLES = ("entry", "combo box", "password text")


def text_selection_span(ti):
    """PURE given a Text interface (unit-tested with fakes): the FIRST text
    selection as [start, end] character offsets, or None when the field has no
    selection or the interface cannot say. rev 30b: Chromium's omnibox inline
    autocomplete is a SELECTED suffix, and this is the only evidence that makes a
    Delete keystroke safe (it removes exactly the selection)."""
    try:
        count = Atspi.Text.get_n_selections(ti)
    except Exception:
        return None
    if not isinstance(count, int) or count < 1:
        return None
    try:
        rng = Atspi.Text.get_selection(ti, 0)
    except Exception:
        return None
    start = getattr(rng, "start_offset", None)
    end = getattr(rng, "end_offset", None)
    if start is None and isinstance(rng, (tuple, list)) and len(rng) >= 2:
        start, end = rng[0], rng[1]
    if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end < start:
        return None
    return [start, end]


MASK_CHARS = set("\u2022\u25cf\u2027\u00b7*")


def masked_match(needle, text):
    """PURE (unit-tested). A password field reads back only as mask characters: it holds the typed value when it
    shows exactly one mask character per character of the value (nothing else can be checked, by design)."""
    t = text or ""
    return bool(needle) and len(t) == len(needle) and all(c in MASK_CHARS for c in t)


def site_of(host):
    """PURE (unit-tested). The registrable domain of a host ("us.checkout.gymshark.com" -> "gymshark.com",
    "shop.example.co.uk" -> "example.co.uk"): a store's own checkout subdomain is the same site, not an
    off-site redirect (live 2026-09-26: Owala's and Gymshark's checkout buttons were refused, so the agent
    typed the checkout URL instead of clicking)."""
    h = (host or "").lower().split(":")[0].rstrip(".")
    parts = [p for p in h.split(".") if p]
    if len(parts) < 2:
        return h
    two_level = len(parts) >= 3 and parts[-2] in ("co", "com", "org", "net", "gov", "ac") and len(parts[-1]) == 2
    return ".".join(parts[-3:] if two_level else parts[-2:])


def autofill_popup_action(app):
    """Is Chrome's own address-autofill dropdown open? It is a separate top-level frame (not the page's) holding a
    list box whose last row is "Manage addresses…" (live Owala checkout 2026-09-26). Returns {open, rows}; never
    the rows' text (they carry the saved address)."""
    for j in range(app.get_child_count()):
        try:
            w = app.get_child_at_index(j)
        except Exception:
            continue
        if w is None:
            continue
        found = {"open": False, "rows": 0}

        def walk(n, d):
            if d > 12 or found["open"]:
                return
            try:
                role = n.get_role_name()
                name = (n.get_name() or "").strip().lower()
            except Exception:
                return
            if role in ("document web", "document frame"):
                return  # the page itself: a site's own list is not Chrome's
            if role == "list item" and name.startswith("manage addresses"):
                found["open"] = True
                # Is Chrome's own "Manage addresses…" row the highlighted one? Return on it opens the settings
                # tab instead of picking the address.
                try:
                    st = n.get_state_set()
                    found["manage_selected"] = bool(st.contains(Atspi.StateType.SELECTED) or st.contains(Atspi.StateType.FOCUSED))
                except Exception:
                    found["manage_selected"] = False
                try:
                    lb = n.get_parent()
                    while lb is not None and lb.get_role_name() != "list box":
                        lb = lb.get_parent()
                    if lb is not None:
                        def count(x, dd):
                            if dd > 6: return 0
                            c = 1 if x.get_role_name() == "list item" else 0
                            return c + sum(count(x.get_child_at_index(k), dd + 1) for k in range(x.get_child_count()) if x.get_child_at_index(k) is not None)
                        found["rows"] = count(lb, 0)
                except Exception:
                    pass
                return
            try:
                k = n.get_child_count()
            except Exception:
                return
            for i in range(min(k, 200)):
                c = n.get_child_at_index(i)
                if c is not None:
                    walk(c, d + 1)

        walk(w, 0)
        if found["open"]:
            return found
    return {"open": False, "rows": 0}


def digits_match(needle, text):
    """PURE (unit-tested). A phone-like value the page reformats as it is typed ("5550100199" shown as
    "(555) 010-0199" or "+1 555-010-0199") is the same value: when the needle is 7+ digits with at most a couple of
    separators, the field matches if its digits end with the needle's digits. Shorter values (a ZIP) and values
    with letters keep the strict exact/prefix rule."""
    nd = "".join(c for c in (needle or "") if c.isdigit())
    if len(nd) < 7 or len((needle or "").strip()) - len(nd) > 4:
        return False
    if any(c.isalpha() for c in (text or "")):
        return False
    td = "".join(c for c in (text or "") if c.isdigit())
    return len(td) >= len(nd) and td.endswith(nd) and len(td) - len(nd) <= 3


def verify_text_action(app, value):
    """Does an editable field currently contain this value? Identity-
    independent on purpose: focus-expanding search widgets (caught live on
    Victoria's Secret) REPLACE the element the caller targeted the moment
    they activate, so verifying against the original element's name finds
    nothing even when the text landed fine. Searching for the VALUE is
    robust to any such restructuring.

    Tightened per review (gh issue #1): only SHOWING editable-role fields
    count, and the match must be exact or a prefix (autocomplete may append
    a completion) -- a bare substring anywhere in any input risked false
    positives from stale duplicates or unrelated fields. Collects up to 5
    candidates and prefers one inside the web document over browser chrome."""
    needle = (value or "").strip().lower()
    if not needle:
        return {"found": False}
    matches = []
    # EARLY EXIT (2026-10-10): a FOCUSED, EXACT match inside the page is the one the ranking below puts first (and isSubmitSafe needs
    # nothing more), so the walk stops there instead of visiting every node — on a checkout with a long product rail the full walk
    # cost ~1.3 s of every typed field. The candidate count is then the matches seen so far.
    done = [False]

    def visit(acc, depth, in_doc):
        if depth > 40 or len(matches) >= 5 or done[0]:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        in_doc = in_doc or role in ("document web", "document frame")
        if role in EDITABLE_ROLES:
            try:
                ss = acc.get_state_set()
                showing = ss.contains(Atspi.StateType.SHOWING)
            except Exception:
                showing = False
            if showing:
                try:
                    ti = acc.get_text_iface()
                    if ti:
                        n = Atspi.Text.get_character_count(ti)
                        if n > 0:
                            t = Atspi.Text.get_text(ti, 0, min(n, 400))
                            tt = (t or "").strip().lower()
                            # A phone the page reformats counts as exact (digits_match); every other value
                            # keeps the strict exact/prefix rule.
                            masked = role == "password text" and masked_match((value or "").strip(), (t or "").strip())
                            if tt == needle or tt.startswith(needle) or digits_match(needle, tt) or masked:
                                try:
                                    focused = ss.contains(Atspi.StateType.FOCUSED)
                                except Exception:
                                    focused = False
                                done[0] = bool(focused and in_doc and (tt == needle or digits_match(needle, tt) or masked))
                                matches.append({
                                    "role": role,
                                    "name": (acc.get_name() or "")[:80],
                                    "text": t[:120],
                                    "match": "exact" if (tt == needle or digits_match(needle, tt) or masked) else "prefix",
                                    "in_doc": in_doc,
                                    "focused": focused,
                                    # rev 30b: the field's full length and its selection, so
                                    # index.js can prove an inline-autocomplete suffix.
                                    "text_length": n,
                                    "selection": text_selection_span(ti),
                                })
                except Exception:
                    pass
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            if len(matches) >= 5 or done[0]:
                return
            try:
                child = acc.get_child_at_index(i)
            except Exception:
                continue
            if child is not None:
                visit(child, depth + 1, in_doc)

    visit(app, 0, False)
    if not matches:
        return {"found": False}
    # Rank: a FOCUSED match first (submit-safety requires that the value
    # lives in the field that will receive Return — review P2, gh issue
    # #1), then exact over prefix, then document over chrome.
    matches.sort(key=lambda m: (not m["focused"], m["match"] != "exact", not m["in_doc"]))
    best = matches[0]
    return {"found": True, "candidates": len(matches), **best}


def _norm_field_text(v):
    return " ".join((v or "").replace(",", " ").replace(".", " ").lower().split())


def field_value_status(expect, text, mode="exact"):
    """PURE (unit-tested). How a field's text compares with the value it should hold, as a status only
    (the caller never sees the text). "exact": equal after case/space/punctuation folding, or the field
    extends it with a ZIP+4 ("12345" vs "12345-6789"). "street": same house number and same first
    street-name word ("123 Main St" vs "123 Main Street"), what an address suggestion writes."""
    t = _norm_field_text(text)
    if not t:
        return "empty"
    e = _norm_field_text(expect)
    if t == e or digits_match(expect, text):
        return "match"
    if e.isdigit() and len(e) == 5 and len(t) == 10 and t.startswith(e + "-") and t[6:].isdigit():
        return "match"
    if mode == "street":
        ew, tw = e.split(), t.split()
        if len(ew) >= 2 and len(tw) >= 2 and ew[0] == tw[0] and ew[1] == tw[1]:
            return "match"
    return "differs"


def field_checks_action(app, checks):
    """For each {name, expect, mode}: the status of the SHOWING in-page editable field(s) with that accessible
    name -- match / differs / empty / missing. Only statuses are returned, never field text, so a caller
    (the private-address fill) can confirm what a suggestion filled without the value reaching the model."""
    fields = []

    def visit(acc, depth, in_doc):
        if depth > 40 or len(fields) >= 200:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        in_doc = in_doc or role in ("document web", "document frame")
        if in_doc and role in EDITABLE_ROLES:
            try:
                showing = acc.get_state_set().contains(Atspi.StateType.SHOWING)
            except Exception:
                showing = False
            if showing:
                text = ""
                try:
                    ti = acc.get_text_iface()
                    if ti:
                        n = Atspi.Text.get_character_count(ti)
                        text = Atspi.Text.get_text(ti, 0, min(n, 400)) if n > 0 else ""
                except Exception:
                    text = ""
                fields.append(((acc.get_name() or "").strip().lower(), text or ""))
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                child = acc.get_child_at_index(i)
            except Exception:
                continue
            if child is not None:
                visit(child, depth + 1, in_doc)

    visit(app, 0, False)
    out = []
    for c in checks or []:
        name = (c.get("name") or "").strip().lower()
        texts = [t for (n, t) in fields if n == name]
        if not texts:
            out.append("missing")
            continue
        statuses = [field_value_status(c.get("expect"), t, c.get("mode") or "exact") for t in texts]
        out.append("match" if "match" in statuses else ("differs" if "differs" in statuses else "empty"))
    return {"statuses": out}


def rank_focus_hits(hits):
    """PURE (unit-tested): choose which FOCUSED node to report when Chromium
    exposes more than one at once.
    The old rule preferred the first hit with in_doc -- but browser WebUI (the
    omnibox popup) is ALSO under a document, so in_doc no longer separates page
    from chrome, and traversal order alone could hand back the popup while a
    positively-classified page node was focused too. Rank by DOCUMENT CLASS:
    a page-focused node beats a browser-internal one beats anything unclassified,
    and ties keep traversal order (stable sort)."""
    order = {"page": 0, "browser_internal": 1}

    def key(h):
        cls = h.get("doc_class")
        if cls in order:
            return order[cls]
        return 2 if h.get("in_doc") else 3

    return sorted(hits, key=key)[0] if hits else None


def first_page_document(app, depth_limit=20):
    """The first PAGE document in tree order (never browser UI: an omnibox popup or a chrome:// page), or None.
    Does not descend into a document, so it stays cheap enough to poll."""
    stack = [(app, 0)]
    while stack:
        acc, depth = stack.pop()
        if depth > depth_limit:
            continue
        try:
            role = acc.get_role_name()
        except Exception:
            continue
        if role in ("document web", "document frame"):
            # Only the tab on screen: a background tab keeps its document in the tree (Ctrl+U opens view-source in
            # a new tab while the product page stays behind it).
            try:
                showing = acc.get_state_set().contains(Atspi.StateType.SHOWING)
            except Exception:
                showing = False
            if showing and classify_document(acc) == "page":
                return acc
            continue
        try:
            n = acc.get_child_count()
        except Exception:
            continue
        for i in range(n - 1, -1, -1):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                stack.append((c, depth + 1))
    return None


def settle_verdict(state, quiet_for_ms, elapsed_ms, quiet_ms, max_ms):
    """PURE. The page is settled when its document is READY (a page document, not BUSY, with content) AND the
    browser has announced no structural change for `quiet_ms`. Past `max_ms` it answers not-settled with the reason,
    never a guess. Returns None while still waiting."""
    if state == "ready" and quiet_for_ms >= quiet_ms:
        return {"settled": True, "reason": "quiet"}
    if elapsed_ms >= max_ms:
        return {"settled": False, "reason": "still_changing" if state == "ready" else state}
    return None


def quiet_while_loading(state, populated, quiet_for_ms, quiet_ms):
    """PURE. LOG ONLY (lead 2026-10-04: collect a day of per-store counts before settle may rely on the populated document
    instead of load-complete): the page document still BUSY (its load not complete) yet already holding content, and the
    browser quiet for `quiet_ms` -- the moment a populated-document rule would have answered settled."""
    return state == "busy" and bool(populated) and quiet_for_ms >= quiet_ms


def wait_settled_action(app, pid, quiet_ms=800, max_ms=15000, url_contains=None, title_contains=None, not_doc=None, placeholder_focus_ok=False):
    """READY-TO-LOOK, from the browser's own signals rather than a fixed sleep.
    Chromium marks a loading page document BUSY and announces every node added or removed (children-changed) through
    AT-SPI. This listens to those announcements for THIS browser only, and answers as soon as the page document is
    ready and the tree has been quiet for `quiet_ms`. Bounded by `max_ms`; a page that never stops changing (a live
    carousel) answers settled:false with how long it has been changing, and the caller decides."""
    from gi.repository import GLib
    t0 = time.monotonic()
    last = [t0]
    events = [0]

    def on_event(ev):
        try:
            src = ev.source
            if src is not None and src.get_process_id() == pid:
                last[0] = time.monotonic()
                events[0] += 1
        except Exception:
            pass

    listener = Atspi.EventListener.new(on_event)
    kinds = ("object:children-changed", "object:state-changed:busy", "document:load-complete", "document:reload")
    for kind in kinds:
        try:
            listener.register(kind)
        except Exception:
            pass
    result = {}
    loop = GLib.MainLoop()
    first_ready = [None]

    seen_title = [None]
    seen_doc = [None]
    populated = [False]
    would_settle = [None]

    def page_state():
        doc = first_page_document(app)
        if doc is None:
            return "no_document", None
        uri = document_uri(doc) or ""
        seen_doc[0] = obj_path(doc)
        try:
            seen_title[0] = doc.get_name()
        except Exception:
            pass
        # After a navigation, the page is the NEW document: while the one we navigated away from is still the one on
        # screen, nothing has loaded yet (a view-source: page has the same URI and no title, only a new document).
        if not_doc and seen_doc[0] == not_doc:
            return "old_document", uri
        if url_contains and url_contains not in uri:
            return "other_document", uri
        # A view-source: page reports the SAME document URI as the page it shows; its title is what tells them apart.
        if title_contains:
            try:
                title = doc.get_name() or ""
            except Exception:
                title = ""
            if title_contains.lower() not in title.lower():
                return "other_document", uri
        try:
            if doc.get_state_set().contains(Atspi.StateType.BUSY):
                populated[0] = doc.get_child_count() > 0
                return "busy", uri
            if doc.get_child_count() == 0:
                return "empty", uri
        except Exception:
            return "unreadable", uri
        return "ready", uri

    placeholder_focus = [None]

    def tick():
        now = time.monotonic()
        state, uri = page_state()
        # NO PAGE DOCUMENT YET may be Chromium's empty placeholder: a page whose scripts hang on a proxy connect holds its document
        # as a placeholder (live Coach bag: 33 s; through the US exit that was IPv6 blackholing, fixed in the exit config 2026-10-04 —
        # 2.5 s since). Once, after 800 ms, the placeholder is re-focused (grab_focus, never a click or a key), which fills it
        if placeholder_focus_ok and state == "no_document" and placeholder_focus[0] is None and (now - t0) * 1000 >= 800:
            placeholder_focus[0] = dict(focus_placeholder_document_action(app), at_ms=round((now - t0) * 1000))
        if state == "ready" and first_ready[0] is None:
            first_ready[0] = now
        if would_settle[0] is None and quiet_while_loading(state, populated[0], (now - last[0]) * 1000, quiet_ms):
            would_settle[0] = round((now - t0) * 1000)
        verdict = settle_verdict(state, (now - last[0]) * 1000, (now - t0) * 1000, quiet_ms, max_ms)
        if verdict is None:
            return True
        result.update(verdict)
        result.update({"ms": round((now - t0) * 1000), "events": events[0], "uri": uri, "title": seen_title[0], "doc": seen_doc[0], "state": state,
                       "ready_ms": round((first_ready[0] - t0) * 1000) if first_ready[0] else None,
                       "quiet_for_ms": round((now - last[0]) * 1000)})
        # log only (the caller logs it and strips it from the tool's answer): settle timed out on a BUSY document that had been
        # populated and quiet since N ms
        if not verdict.get("settled") and state == "busy" and would_settle[0] is not None:
            result["would_have_settled_ms"] = would_settle[0]
        if placeholder_focus[0] is not None:
            result["placeholder_focus"] = placeholder_focus[0]
            if placeholder_focus[0].get("grabbed") and first_ready[0] is not None:
                result["placeholder_focus"]["ready_after_ms"] = round((first_ready[0] - t0) * 1000) - placeholder_focus[0].get("at_ms", 0)
        loop.quit()
        return False

    GLib.timeout_add(100, tick)
    loop.run()
    for kind in kinds:
        try:
            listener.deregister(kind)
        except Exception:
            pass
    return result


def document_text_action(app, max_chars=4000000, node_budget=400000, reverse=False):
    """READ-ONLY (2026-09-29, view-source photo fallback): the text of the first page document, leaf by leaf, one
    line per text-bearing leaf, in document order. Built for a view-source: page, whose every source line is a leaf,
    so a store's embedded product data can be read through the browser session the store already accepted, with no
    CDP or script. Bounded by characters and nodes; `truncated` says when a bound cut it short. `reverse` walks from
    the END (a page's embedded app data usually closes the document: the budget then reaches it in a few nodes);
    the returned text is still in document order."""
    doc = [None]

    def find(acc, depth=0):
        if doc[0] is not None or depth > 20:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        if role in ("document web", "document frame") and classify_document(acc) == "page":
            doc[0] = acc
            return
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                find(c, depth + 1)

    find(app)
    if doc[0] is None:
        return {"ok": False, "reason": "no_page_document"}
    parts, size, nodes, truncated = [], 0, 0, False
    stack = [doc[0]]
    while stack:
        acc = stack.pop()
        nodes += 1
        if nodes > node_budget or size > max_chars:
            truncated = True
            break
        try:
            n = acc.get_child_count()
        except Exception:
            continue
        if n == 0:
            try:
                ti = acc.get_text_iface()
                if ti:
                    t = Atspi.Text.get_text(ti, 0, -1) or ""
                    if t:
                        parts.append(t)
                        size += len(t) + 1
            except Exception:
                pass
            continue
        for i in (range(n) if reverse else range(n - 1, -1, -1)):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                stack.append(c)
    text = "\n".join(reversed(parts) if reverse else parts)
    # The budget keeps the part the walk started from: the END when reading from the end.
    text = text[-max_chars:] if reverse else text[:max_chars]
    return {"ok": True, "uri": document_uri(doc[0]), "text": text, "nodes": nodes, "truncated": truncated}


def page_document_uri_action(app):
    """The page document's RAW URI and nothing else, in ONE truncated traversal.

    Exactly reproduces navigation_focus_action(app)["page_document_uri_raw"] --
    that function is the oracle the tests compare against, not this docstring.
    It exists because the two URI-only callers (the pre-typing submit baseline
    and the submit-transition poll) read only that field, while
    navigation_focus pays for TWO full-tree walks to produce it: a focus search
    they discard, and a document collection that descends through the entire
    page content subtree hunting nested documents. Measured, one such read cost
    ~880ms mid-navigation, and the transition poll's cost is what decides how
    many samples fit inside the watch budget.

    EQUIVALENCE, which is the whole risk here:
      * raw_uri is `next(...)` over page documents in traversal order, so
        stopping at the first one yields the same value. Stopping EARLIER can
        never be affected by the caps, since an early exit reaches the winner at
        or before the point the full scan would.
      * The document-position counter increments for EVERY encountered
        document-role node BEFORE classification -- browser-internal,
        missing-URI and unknown documents all occupy a position -- because the
        historical cap counts everything collect_docs appended, not just the
        page ones.
      * That cap is checked on ENTRY as `> 12`, so a THIRTEENTH document is
        still admitted. Reproduced deliberately rather than tidied: a page
        document at encountered position 13 must stay reachable and 14 must not.
      * A document that is not a page surface does NOT stop the walk, which is
        what keeps the iframe cases working -- an outer document with no URI
        whose nested frame has one still yields the nested one.
      * about:blank IS a page surface here ("about" is not in
        BROWSER_DOC_SCHEMES) and is returned, exactly as the raw field always
        has -- a fresh tab positively IS showing that document.
    Returns ONLY the one field, so there is no fabricated focus, doc_class,
    content count or presence flag that a caller could mistake for evidence."""
    found = [None]
    docs_seen = [0]

    def walk(acc, depth=0):
        if found[0] is not None or depth > 20 or docs_seen[0] > 12:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        if role in ("document web", "document frame"):
            docs_seen[0] += 1  # position is claimed before classification
            uri = document_uri(acc)
            if uri and classify_document_uri(uri) == "page":
                found[0] = uri
                return
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            if found[0] is not None:
                return
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                walk(c, depth + 1)

    walk(app)
    return {"page_document_uri_raw": found[0]}


def is_placeholder_document(uri, child_count, showing):
    """PURE (unit-tested). Chromium's EMPTY PLACEHOLDER for a page's accessibility document: showing, no URI, no children.
    A page whose scripts hang on a proxy connect holds its document as this placeholder even though it already HAS focus (live Coach
    bag 2026-10-04: ~31 s, the page painted the whole time — through the US exit that was IPv6 blackholing, fixed in the exit config;
    populated in 2.5 s since); a re-focus (grab_focus) filled it in ~2 s. A browser-UI document always carries a chrome:// URI, so it
    never matches."""
    return bool(showing) and not uri and child_count == 0


def window_names_a_page(title):
    """PURE (unit-tested). The browser window's title names a loaded page: not empty, not a new/blank tab (lead guardrail)."""
    t = re.sub(r"\s*-\s*Chromium\s*$", "", title or "").strip()
    return bool(t) and t.lower() not in ("new tab", "about:blank", "untitled")


def focused_in_populated_document(app, max_nodes=4000):
    """Does keyboard focus sit inside a POPULATED document (one with a URI or children) -- a field mid-typing, a control? Then
    no focus is taken from it (lead guardrail). Bounded walk; any doubt → True (never steal)."""
    seen = [0]
    found = [None]

    def walk(acc, depth=0):
        if found[0] is not None or depth > 30 or seen[0] > max_nodes:
            return
        seen[0] += 1
        try:
            if acc.get_state_set().contains(Atspi.StateType.FOCUSED) and acc.get_role_name() not in ("frame", "application"):
                found[0] = acc
                return
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                walk(c, depth + 1)

    walk(app)
    if seen[0] > max_nodes:
        return True
    if found[0] is None:
        return False
    doc = enclosing_document(found[0])
    if doc is None:
        return False  # browser UI (the omnibox, the toolbar) — not a page field
    try:
        return bool(document_uri(doc)) or doc.get_child_count() > 0
    except Exception:
        return True


def focus_placeholder_document_action(app, skip_title=None):
    """Give focus to the page's EMPTY PLACEHOLDER document (is_placeholder_document) -- AT-SPI grab_focus, never a click or a
    key -- so Chromium exposes the page's tree now instead of when its hung scripts finally fail (a page whose scripts hang on a
    proxy connect holds its document as a placeholder; the US exit's IPv6 blackholing, fixed in its config 2026-10-04, was one such
    cause). Lead guardrails (2026-10-04): the caller
    passes it ONLY for our own headless instances; acts only when the placeholder is the ONLY showing document of this app's
    frame, the window title already names a page, and focus is not inside a populated document. Returns {placeholder, grabbed,
    title, why}."""
    docs = []

    def collect_docs(acc, out, depth=0):
        if depth > 20 or len(out) > 12:
            return
        try:
            if acc.get_role_name() in ("document web", "document frame"):
                out.append(acc)
                return
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                collect_docs(c, out, depth + 1)

    collect_docs(app, docs)
    showing = []
    for d in docs:
        try:
            if d.get_state_set().contains(Atspi.StateType.SHOWING):
                showing.append(d)
        except Exception:
            pass
    if len(showing) != 1:
        return {"placeholder": False, "grabbed": False, "showing": len(showing)}
    d = showing[0]
    try:
        n = d.get_child_count()
    except Exception:
        n = None
    if not is_placeholder_document(document_uri(d), n, True):
        return {"placeholder": False, "grabbed": False}
    title = None
    try:
        for i in range(app.get_child_count()):
            fr = app.get_child_at_index(i)
            if fr and fr.get_role_name() == "frame":
                title = fr.get_name()
                break
    except Exception:
        title = None
    if not window_names_a_page(title):
        return {"placeholder": True, "grabbed": False, "why": "the window names no page yet", "title": title}
    if skip_title is not None and (title or "") == skip_title:
        return {"placeholder": True, "grabbed": False, "why": "already given focus once for this page", "title": title}
    if focused_in_populated_document(app):
        return {"placeholder": True, "grabbed": False, "why": "focus is inside a populated document", "title": title}
    grabbed = False
    try:
        grabbed = bool(d.get_component_iface().grab_focus())
    except Exception:
        grabbed = False
    return {"placeholder": True, "grabbed": grabbed, "title": (title or "")[:80]}


def navigation_focus_action(app):
    """Where does keyboard focus actually live, and is that a real page?
    Used as the postcondition of an omnibox navigation (issue: a lingering
    Omnibox Popup keeps focus and the page document's subtree is not exposed).
    Returns the focused node with its enclosing document's URI and class, plus a
    page-content count as SUPPLEMENTARY evidence only -- the verdict is the focus
    classification, never the content count.

    This is the FULL observation and it always pays for all of it. Callers that
    want only the page document's URI must use page_document_uri_action instead,
    which is a single truncated traversal rather than a lightened version of
    this one -- a flag here that no caller passed would be dead weight."""
    foc = get_focused_action(app).get("focused")
    content = 0
    try:
        docs = []

        def collect_docs(acc, out, depth=0):
            if depth > 20 or len(out) > 12:
                return
            try:
                if acc.get_role_name() in ("document web", "document frame"):
                    out.append(acc)
                n = acc.get_child_count()
            except Exception:
                return
            for i in range(n):
                try:
                    c = acc.get_child_at_index(i)
                except Exception:
                    continue
                if c is not None:
                    collect_docs(c, out, depth + 1)

        collect_docs(app, docs)
        page_docs = [d for d in docs if is_page_document(d)]

        def count(acc, depth=0):
            total = 0
            if depth > 40:
                return 0
            try:
                if acc.get_role_name() in ("link", "heading", "static", "image", "paragraph"):
                    total += 1
                n = acc.get_child_count()
            except Exception:
                return total
            for i in range(n):
                try:
                    c = acc.get_child_at_index(i)
                except Exception:
                    continue
                if c is not None:
                    total += count(c, depth + 1)
            return total

        for d in page_docs:
            content += count(d)
    except Exception:
        pass
    # NAMED FOR WHAT IT ACTUALLY PROVES. This says a page document EXISTS — it
    # does NOT say the current navigation committed, and it must never be read
    # that way. MEASURED with a deliberately slow HTTP response: navigating away
    # from a loaded page keeps the PREVIOUS document (its URI unchanged) for the
    # entire in-flight window, and the new URI appears only when the response
    # arrives. No BUSY state is exposed on the document OR the frame anywhere in
    # that window, so this build offers no in-flight signal to key on.
    present_uri = next((u for u in (document_uri(d) for d in page_docs) if u and u != "about:blank"), None)
    # The RAW URI keeps about:blank. A fresh tab genuinely IS showing
    # about:blank, and that is a POSITIVELY OBSERVED document identity — quite
    # different from "this walk found nothing", which can mean a capped or
    # failed traversal just as easily as an empty browser. Callers that need
    # positive pre-navigation evidence must use this field, never infer absence
    # from the filtered one.
    raw_uri = next((u for u in (document_uri(d) for d in page_docs) if u), None)
    return {"focused": foc,
            "doc_class": (foc or {}).get("doc_class", "unknown") if foc else "none",
            "doc_uri": (foc or {}).get("doc_uri") if foc else None,
            "page_content_nodes": content,
            "page_document_uri": present_uri,
            "page_document_uri_raw": raw_uri,
            "page_document_present": present_uri is not None}


def focused_node_info(acc, role, ss, in_doc):
    """One FOCUSED node as get_focused_action reports it."""
    node = {
        "role": role,
        "name": (acc.get_name() or "")[:80],
        # Object-path identity (issue #6), so a caller can tell
        # "focus landed on the control I just activated" from
        # "focus moved somewhere else" WITHOUT comparing role/name
        # strings -- a control that relabels or changes role as a
        # result of its own activation would otherwise look like a
        # focus move to a different node.
        "obj_path": obj_path(acc),
        "editable": role in EDITABLE_ROLES or ss.contains(Atspi.StateType.EDITABLE),
        "showing": ss.contains(Atspi.StateType.SHOWING),
        "enabled": ss.contains(Atspi.StateType.ENABLED),
        "in_doc": in_doc,
    }
    b = get_bounds(acc, 0, 0)
    if b:
        node["b"] = [b["x"], b["y"], b["w"], b["h"]]
    # WHICH document this focus belongs to. `in_doc` alone cannot say:
    # the omnibox popup is itself a document web, so chrome UI reports
    # in_doc=true. The URI settles it.
    encl = enclosing_document(acc)
    node["doc_uri"] = document_uri(encl) if encl is not None else None
    node["doc_class"] = classify_document(encl)
    return node


def get_focused_action(app):
    """Return the currently focused node WHATEVER its role -- when a dynamic
    widget moves focus to e.g. its clear button, that IS the evidence a
    caller needs (per review: reporting only editables collapsed the
    interesting case to 'nothing'). `editable` says whether it can receive
    typed text. Prefers a focused node inside the web document, since
    browser chrome (e.g. the omnibox AI element) can report FOCUSED in
    parallel with the page's own focus."""
    hits = []
    # The first FOCUSED node inside a PAGE document is the one rank_focus_hits picks (page beats everything else; ties keep
    # traversal order): the walk stops there (2026-10-10: ~1.6 s, twice per click_element, on a page with a long product rail).
    page_hit = [False]

    def visit(acc, depth, in_doc):
        if depth > 40 or len(hits) >= 5 or page_hit[0]:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        in_doc = in_doc or role in ("document web", "document frame")
        try:
            ss = acc.get_state_set()
            if ss.contains(Atspi.StateType.FOCUSED):
                hits.append(focused_node_info(acc, role, ss, in_doc))
                page_hit[0] = hits[-1].get("doc_class") == "page"
        except Exception:
            return
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            if len(hits) >= 5 or page_hit[0]:
                return
            try:
                child = acc.get_child_at_index(i)
            except Exception:
                continue
            if child is not None:
                visit(child, depth + 1, in_doc)

    visit(app, 0, False)
    best = rank_focus_hits(hits)
    # All hits are preserved for diagnosis: when more than one node reports
    # FOCUSED, which one was chosen and what the alternatives were is exactly
    # what a later investigation needs.
    out = {"focused": best, "focused_count": len(hits)}
    if len(hits) > 1:
        out["focus_candidates"] = [{"role": h.get("role"), "name": h.get("name"),
                                    "doc_class": h.get("doc_class"), "doc_uri": h.get("doc_uri")}
                                   for h in hits]
    return out



def list_images_action(app, offset_x, offset_y, cap=64, min_px=0):
    """rev 18 — READ-ONLY inventory of the page's image nodes for the
    supervisor's trusted-image selection: document order, role "image" only,
    SHOWING and VISIBLE, with the node's own `src`/`tag` object attributes
    (Chromium exposes the element's resolved source there), its accessible
    name (the alt text), description (aria), bounds, and ref identity. No
    click, scroll, focus or navigation ever happens here; the caller applies
    the https/title-binding/size rules. Capped at `cap` nodes.

    `min_px` (default 0 = off, unchanged behaviour) skips images whose rendered
    box is smaller than min_px on either side BEFORE they count against `cap`.
    The catalog harvester passes it so a results grid's node budget fills with
    product hero images instead of the ~48px colour swatches that otherwise
    crowd them out; the supervisor keeps the default and sees every node."""
    out = []

    def visit(acc, depth):
        if depth > 45 or len(out) >= cap:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        if role == "image":
            try:
                ss = acc.get_state_set()
                showing = ss.contains(Atspi.StateType.SHOWING) and ss.contains(Atspi.StateType.VISIBLE)
            except Exception:
                showing = False
            try:
                attrs = dict(acc.get_attributes() or {})
            except Exception:
                attrs = {}
            b = get_bounds(acc, offset_x, offset_y)
            if min_px and b and (b["w"] < min_px or b["h"] < min_px):
                pass  # too small to be a product thumbnail (swatch / pixel) — skip before it counts against cap
            else:
              try:
                desc = acc.get_description() or ""
              except Exception:
                desc = ""
              out.append({
                "name": (acc.get_name() or "")[:200],
                "description": desc[:200],
                "src": str(attrs.get("src") or "")[:2048],
                "tag": str(attrs.get("tag") or "")[:16],
                "showing": bool(showing),
                "b": [b["x"], b["y"], b["w"], b["h"]] if b else None,
                "obj_path": obj_path(acc),
                "doc_gen": doc_gen_of(acc),
            })
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            if len(out) >= cap:
                return
            child = acc.get_child_at_index(i)
            if child is not None:
                visit(child, depth + 1)

    visit(app, 0)
    return {"images": out, "capped": len(out) >= cap}


def focus_editable_at_action(app, offset_x, offset_y, x, y):
    """Grab keyboard focus on the EDITABLE node under a click point (screen
    coords). A synthetic pointer click can land on a store's search box
    without its inner <input> ever taking DOM focus (a wrapper/overlay
    swallows it), so typed text then goes to <body> and nowhere visible
    (measured live 2026-09-03: Best Buy search box, click lands, box stays
    empty). grab_focus() is the same mechanism a screen reader uses and
    focuses the field even when the click did not. Best-effort: if no
    editable is at/near the point this is a no-op the caller ignores, so a
    click on a link or button is unaffected."""
    px, py = int(x), int(y)
    best = None  # (containment_rank, distance, node, bounds) — the best EDITABLE node under the point
    best_combo = None  # the best combobox/searchbox under the point whose editable input is a DESCENDANT
    # An input the customer types into. Best Buy wraps its search <input> in an ARIA combobox: the click lands
    # on the combobox (which is not itself EDITABLE), so the editable-only search above finds nothing and typing
    # goes nowhere. These roles mark such a wrapper; the descent below focuses the inner input.
    input_like = {"combo box", "entry", "password text", "search box", "text"}
    def visit(acc, depth):
        nonlocal best, best_combo
        if depth > 45:
            return
        try:
            ss = acc.get_state_set()
        except Exception:
            return
        try:
            if (ss.contains(Atspi.StateType.EDITABLE) and ss.contains(Atspi.StateType.SHOWING)
                    and ss.contains(Atspi.StateType.ENABLED)):
                b = get_bounds(acc, offset_x, offset_y)
                if b:
                    inside = b["x"] <= px <= b["x"] + b["w"] and b["y"] <= py <= b["y"] + b["h"]
                    dist = abs(b["cx"] - px) + abs(b["cy"] - py)
                    rank = 0 if inside else 1
                    if best is None or (rank, dist) < (best[0], best[1]):
                        best = (rank, dist, acc, b)
        except Exception:
            pass
        # An input-like wrapper (combobox/searchbox) under the point, whether or not it is itself EDITABLE:
        # the fallback when no editable is directly under the click descends into it for the inner input.
        try:
            if (normalize_role(acc.get_role_name()) in input_like and ss.contains(Atspi.StateType.SHOWING)
                    and ss.contains(Atspi.StateType.ENABLED)):
                b = get_bounds(acc, offset_x, offset_y)
                if b:
                    inside = b["x"] <= px <= b["x"] + b["w"] and b["y"] <= py <= b["y"] + b["h"]
                    dist = abs(b["cx"] - px) + abs(b["cy"] - py)
                    rank = 0 if inside else 1
                    if best_combo is None or (rank, dist) < (best_combo[0], best_combo[1]):
                        best_combo = (rank, dist, acc, b)
        except Exception:
            pass
        try:
            n = acc.get_child_count()
        except Exception:
            n = 0
        for i in range(min(n, 200)):
            try:
                ch = acc.get_child_at_index(i)
            except Exception:
                ch = None
            if ch is not None:
                visit(ch, depth + 1)
    visit(app, 0)
    # Usable = the point is INSIDE the candidate, or within a tight radius of its centre.
    def usable(cand):
        return cand is not None and not (cand[0] == 1 and cand[1] > 60)
    # The descendant of `node` the customer can type into: an EDITABLE one first, else any input-like control.
    def inner_input(node):
        stack, editable_hit, input_hit = [(node, 0)], None, None
        while stack:
            acc2, d = stack.pop()
            if d > 12:
                continue
            try:
                ss2 = acc2.get_state_set()
                showing = ss2.contains(Atspi.StateType.SHOWING) and ss2.contains(Atspi.StateType.ENABLED)
            except Exception:
                continue
            if showing and acc2 is not node:
                try:
                    if editable_hit is None and ss2.contains(Atspi.StateType.EDITABLE):
                        editable_hit = acc2
                except Exception:
                    pass
                try:
                    if input_hit is None and normalize_role(acc2.get_role_name()) in input_like:
                        input_hit = acc2
                except Exception:
                    pass
            if editable_hit is not None:
                break
            try:
                cc = acc2.get_child_count()
            except Exception:
                cc = 0
            for i in range(min(cc, 200)):
                try:
                    ch2 = acc2.get_child_at_index(i)
                except Exception:
                    ch2 = None
                if ch2 is not None:
                    stack.append((ch2, d + 1))
        return editable_hit or input_hit
    # Primary: an editable directly under the point (Target, New Balance: the click lands on the <input>).
    if usable(best):
        target, path, chosen = best[2], "editable", best
    # Fallback: a combobox/searchbox wrapper under the point whose editable input is a descendant the click
    # never focused (Best Buy). Descend to that inner input; if there is none, focus the wrapper itself.
    elif usable(best_combo):
        inner = inner_input(best_combo[2])
        target = inner if inner is not None else best_combo[2]
        path = "combobox_inner" if inner is not None else "combobox_self"
        chosen = best_combo
    else:
        return {"found": False}
    grabbed = False
    try:
        comp = target.get_component_iface()
        grabbed = bool(comp.grab_focus())
    except Exception:
        grabbed = False
    time.sleep(0.12)
    try:
        focused = "focused" in get_states(target)
    except Exception:
        focused = False
    return {"found": True, "grab_focus_called": grabbed, "focused": focused,
            "role": target.get_role_name(), "name": (target.get_name() or "")[:80],
            "inside": chosen[0] == 0, "cx": chosen[3]["cx"], "cy": chosen[3]["cy"], "path": path}


def list_editables_action(app, offset_x, offset_y):
    """Return every SHOWING + ENABLED + EDITABLE node of ANY role (entry,
    password text, combo box, or a contenteditable under an unexpected
    role), with role/name/states/bounds/parent-role-chain. This is the
    corrected 'candidate editable' definition — not restricted to
    entry/password. Used to detect an input that mounts (or already exists
    under a non-entry role) after activating a search trigger."""
    out = []

    def parent_chain(acc):
        chain = []
        cur = acc
        d = 0
        while cur is not None and d < 12:
            try:
                cur = cur.get_parent()
                if cur is None:
                    break
                chain.append(cur.get_role_name())
            except Exception:
                break
            d += 1
        return chain

    def visit(acc, depth):
        if depth > 45 or len(out) >= 40:
            return
        try:
            role = acc.get_role_name()
            ss = acc.get_state_set()
        except Exception:
            return
        try:
            if (ss.contains(Atspi.StateType.EDITABLE) and ss.contains(Atspi.StateType.SHOWING)
                    and ss.contains(Atspi.StateType.ENABLED)):
                b = get_bounds(acc, offset_x, offset_y)
                out.append({
                    "role": role,
                    "name": (acc.get_name() or "")[:80],
                    "focused": ss.contains(Atspi.StateType.FOCUSED),
                    "b": [b["x"], b["y"], b["w"], b["h"]] if b else None,
                    "cx": b["cx"] if b else None,
                    "cy": b["cy"] if b else None,
                    "parents": parent_chain(acc),
                })
        except Exception:
            pass
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            if len(out) >= 40:
                return
            try:
                child = acc.get_child_at_index(i)
            except Exception:
                continue
            if child is not None:
                visit(child, depth + 1)

    visit(app, 0)
    return {"editables": out, "count": len(out)}


# "jump" is Chromium's action name for FOLLOWING A LINK. It is included so a
# ref-based link click activates the identity-resolved node itself (issue #5)
# instead of a coordinate click on cached coordinates, which after a rerender
# could follow a DIFFERENT duplicate link. Following a link is exactly what
# click_element already did for links, so this adds no new semantics.
# DELIBERATELY EXCLUDED FROM THIS SET: "check"/"uncheck" (check box, radio
# button) and "doDefault" (ARIA div-role widgets, combo box). Checkable controls
# are handled by semantic_set_checkable_action below, which verifies a required
# post-state instead of merely invoking; "doDefault" remains refused everywhere
# because it is Chromium's generic default action for arbitrary ARIA widgets.
ACTIVATION_ACTIONS = {"press", "click", "activate", "jump"}
DISCLOSURE_ACTIONS = {"open"}
SELECT_ACTIONS = {"select"}
SELECTABLE_ITEM_ROLES = {"menu item", "option", "list item", "radio menu item", "check menu item"}

# --- Checkable controls (issue #6) -----------------------------------------
# MEASURED on Chromium 151.0.7922.173 (recorded in verification ACTION_MATRIX):
# the action a checkable control exposes FOLLOWS ITS CURRENT STATE --
#   unchecked check box / radio button -> ["check", "showContextMenu"]
#   checked   check box / radio button -> ["uncheck", "showContextMenu"]
# So an already-selected radio offers NO "check" action at all: invoking "the"
# action on it would invoke "uncheck" and DESELECT it, the opposite of what a
# caller asking to select it wants. That is why the already-satisfied case must
# short-circuit BEFORE any action is chosen.
# This is measured browser behaviour, not an AT-SPI guarantee; treat it as such.
CHECKABLE_ROLES = {"check box", "radio button"}
CHECK_ACTION = "check"
UNCHECK_ACTION = "uncheck"


def choose_action(actions, role=None):
    """PURE selection rule (unit-tested in test_choose_action.py). Input:
    list of {index,name,...}. Rule (Codex-approved, no priority tiers):
    allowed = actions whose normalized name is in {press,click,activate,jump},
    plus `open` only for button-like disclosure roles;
    invoke ONLY if EXACTLY ONE allowed action exists total; 0 -> no
    activation; >1 (even across names) -> ambiguous. Never pick by array
    order."""
    # A malformed entry (missing/blank name) is NOT treated as safe — it is
    # neither counted as allowed nor ignored: its presence makes the set
    # unclassifiable, so we refuse (fail closed). Well-formed non-activation
    # names (e.g. showContextMenu) are simply not allowed.
    if any(not (a.get("name") or "").strip() for a in actions):
        return {"decision": "ambiguous_action"}
    # Chromium exposes `open` on some ordinary navbar buttons (measured live on
    # Owala). It is a disclosure action, not a universal activation synonym:
    # accept it only for button-like menu controls. This deliberately does not
    # broaden dialog-close classification or arbitrary roles.
    allowed_names = ACTIVATION_ACTIONS | (DISCLOSURE_ACTIONS if (role or "").strip().lower() in {"button", "toggle button", "menu item"} else set())
    allowed = [a for a in actions if a["name"].strip().lower() in allowed_names]
    # A selectable item that offers ONLY "select" (live Glossier 2026-09-28: its country menu's "United States / USD"
    # menu item advertised ["select"]; the coordinate fallback missed, the country never changed and the run was
    # lost). For an item of a list or menu, selecting IS what a click on it does. Never when a real activation
    # action exists (that one is used), never for other roles.
    if len(allowed) == 0 and (role or "").strip().lower() in SELECTABLE_ITEM_ROLES:
        allowed = [a for a in actions if a["name"].strip().lower() in SELECT_ACTIONS]
    if len(allowed) == 0:
        return {"decision": "no_activation_action"}
    if len(allowed) > 1:
        return {"decision": "ambiguous_action"}
    return {"decision": "invoke", "index": allowed[0]["index"], "name": allowed[0]["name"]}


# --- Stateful toggles (aria-pressed) ----------------------------------------
# A toggle button is NOT a check box wearing a different name, and it is
# deliberately kept out of CHECKABLE_ROLES so it cannot inherit that path's peer
# policy. Two differences drive the separation:
#   STATE. It carries PRESSED, not CHECKED -- MEASURED: <button aria-pressed>
#     surfaces as role "toggle button" with PRESSED set and CHECKED clear.
#   GROUPS. aria-pressed declares NOTHING about grouping. Bold and Italic are
#     legitimately pressed at once, so "another pressed toggle exists" is not a
#     fault and must never be reported as one. Conversely a variant picker that
#     BEHAVES exclusively (measured live: checking one option unpresses the
#     previous) declares no exclusivity in the tree, so its correctness cannot be
#     verified and must not be claimed.
# The verdict is therefore about the requested control and nothing else.
STATE_KEY_BY_ROLE = {
    "check box": "checked",
    "radio button": "checked",
    "toggle button": "pressed",
}
TOGGLE_ROLES = frozenset({"toggle button"})


def state_key_for_role(role):
    """The ONE state that means "this control is on", per role. Central so a
    reader and a writer can never disagree about which state is being set.
    None for a role this path does not understand -- callers must refuse."""
    return STATE_KEY_BY_ROLE.get(role)


def choose_toggle_action(actions, role, pre_pressed):
    """PURE selection for a stateful toggle (unit-tested).

    A click on a toggle is a CLICK, not an idempotent "select": it follows the
    control's own single advertised action, so an already-pressed toggle becomes
    unpressed. That is what the control says it will do, and inventing "you
    probably meant to keep it on" would be guessing intent.

    The advertised action must AGREE with the observed state. A control that is
    pressed while offering only `check`, or unpressed while offering only
    `uncheck`, contradicts itself -- we do not understand its state model, so it
    is refused rather than invoked on the strength of the action name.
    Returns {"decision": "invoke"|"unsupported_role"|"unreadable_state"
    |"ambiguous_action"|"no_activation_action"|"state_action_contradiction"}."""
    if role not in TOGGLE_ROLES:
        return {"decision": "unsupported_role"}
    if pre_pressed is None:
        return {"decision": "unreadable_state"}
    desired = not pre_pressed
    if any(not (a.get("name") or "").strip() for a in actions):
        return {"decision": "ambiguous_action", "desired": desired}
    names = [a["name"].strip().lower() for a in actions]
    # Both directions at once: the state model is not what we measured, so we
    # refuse rather than pick the direction we happen to want.
    if CHECK_ACTION in names and UNCHECK_ACTION in names:
        return {"decision": "ambiguous_action", "desired": desired}
    want = CHECK_ACTION if desired else UNCHECK_ACTION
    other = UNCHECK_ACTION if desired else CHECK_ACTION
    matches = [a for a in actions if a["name"].strip().lower() == want]
    if len(matches) > 1:
        return {"decision": "ambiguous_action", "desired": desired}
    if not matches:
        if other in names:
            # It advertises the direction OPPOSITE to its own reported state.
            return {"decision": "state_action_contradiction", "desired": desired,
                    "want": want, "offered": other, "pre_pressed": pre_pressed}
        return {"decision": "no_activation_action", "desired": desired, "want": want}
    return {"decision": "invoke", "index": matches[0]["index"],
            "name": matches[0]["name"], "desired": desired}


def choose_checkable_action(actions, role, pre_checked):
    """PURE selection for checkable controls (unit-tested). The desired state is
    derived, never guessed:
      radio button -> desired checked=True ALWAYS. A radio is a selection, not a
        toggle; deselecting one by clicking it is not a thing a caller asks for,
        and "uncheck" on a radio is refused outright.
      check box    -> a click toggles, so desired = NOT pre_checked.
    The chosen action must be the one whose name matches the desired direction
    ("check" to become checked, "uncheck" to become unchecked). A control whose
    exposed action contradicts the derived desire (e.g. unchecked but only
    offering "uncheck") is refused rather than invoked -- that mismatch means we
    do not understand the control's state.
    Returns one of: {"decision": "already_satisfied"|"invoke"|"no_activation_action"
    |"ambiguous_action"|"unsupported_role"}."""
    if role not in CHECKABLE_ROLES:
        return {"decision": "unsupported_role"}
    desired = True if role == "radio button" else (not pre_checked)
    # SHORT-CIRCUIT BEFORE CHOOSING: on an already-selected radio the only
    # exposed action is "uncheck"; choosing anything here would deselect it.
    if pre_checked == desired:
        return {"decision": "already_satisfied", "desired": desired}
    # A malformed entry makes the action set unclassifiable -> refuse (as choose_action).
    if any(not (a.get("name") or "").strip() for a in actions):
        return {"decision": "ambiguous_action", "desired": desired}
    names = [a["name"].strip().lower() for a in actions]
    # BOTH directions offered at once contradicts the measured contract (a
    # control exposes the one action matching its current state). We do not
    # understand such a control's state model, so we refuse rather than pick the
    # direction we happen to want -- picking would be guessing.
    if CHECK_ACTION in names and UNCHECK_ACTION in names:
        return {"decision": "ambiguous_action", "desired": desired}
    want = CHECK_ACTION if desired else UNCHECK_ACTION
    matches = [a for a in actions if a["name"].strip().lower() == want]
    if len(matches) == 0:
        return {"decision": "no_activation_action", "desired": desired, "want": want}
    if len(matches) > 1:
        return {"decision": "ambiguous_action", "desired": desired}
    return {"decision": "invoke", "index": matches[0]["index"], "name": matches[0]["name"], "desired": desired}


def _obj_attrs(acc):
    try:
        return dict(acc.get_attributes() or {})
    except Exception:
        return {}


def _ancestor_where(acc, pred, max_depth=12):
    """Nearest ancestor satisfying pred, or None."""
    try:
        cur = acc.get_parent()
    except Exception:
        return None
    depth = 0
    while cur is not None and depth < max_depth:
        try:
            if pred(cur):
                return cur
        except Exception:
            pass
        try:
            cur = cur.get_parent()
        except Exception:
            return None
        depth += 1
    return None


def _radios_in(scope, out, depth=0, stop_at_nested_group=False):
    """Radio buttons in a subtree. With stop_at_nested_group, a NESTED
    xml-roles=radiogroup is not descended into: its options belong to that inner
    group, not to the outer one, and counting them as peers of an outer option
    would be a false association (measured: Chromium nests such groups without
    any role change -- both surface as generic panels)."""
    if depth > 25:
        return
    try:
        if scope.get_role_name() == "radio button":
            out.append(scope)
        n = scope.get_child_count()
    except Exception:
        return
    for i in range(n):
        try:
            c = scope.get_child_at_index(i)
        except Exception:
            continue
        if c is None:
            continue
        if stop_at_nested_group and _obj_attrs(c).get("xml-roles") == "radiogroup":
            continue
        _radios_in(c, out, depth + 1, stop_at_nested_group)


def _setsize_of(acc):
    """The browser's OWN count of the radio group this control belongs to
    (object attribute `setsize`), or None. MEASURED: Chromium computes this from
    real group membership -- including radios attached to a form through the
    HTML `form=` attribute, whose owning form is NOT otherwise observable (their
    accessible ancestor is the document, and no attribute names the form). We
    cannot read the form owner, but we CAN check our candidate set against this
    count, which is what makes a wrong association detectable instead of silent."""
    try:
        v = _obj_attrs(acc).get("setsize")
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def find_prior_peer(app, target):
    """The checked peers of a radio, established ONLY from a defensible group
    association in the accessibility model (review ruling), never from
    proximity, accessible name, or child order.

    MEASURED on this Chromium: radio buttons expose NO relations at all (no
    MEMBER_OF), and neither an ARIA radiogroup nor a <fieldset> produces a
    "radio group" ROLE ancestor -- both surface as a generic "panel". A generic
    panel is not evidence of grouping, since panels wrap arbitrary content.
    Two real associations ARE exposed as object attributes:
      1. xml-roles="radiogroup" on an ancestor -> an author-declared ARIA group.
         Nested radiogroups are NOT descended into; their options are not peers.
      2. html-input-name on the radio itself -> the HTML form-control name the
         browser groups native radios by.
    Association 2 alone is NOT sufficient: a radio can be attached to a form via
    the HTML `form=` attribute, and MEASURED, that owner is invisible in the
    accessibility model (such a radio's ancestor is the document, and no
    attribute names its form). Two same-named radios owned by DIFFERENT forms
    would otherwise be treated as peers. So the candidate set is cross-checked
    against the browser's own group count (`setsize`): if our set does not have
    exactly that many members, our association is wrong and we say so instead of
    acting on it.
    Returns (checked_peers, association) where association is
    "aria_radiogroup" | "html_input_name" | "no_verifiable_group"."""
    try:
        if target.get_role_name() != "radio button":
            return [], "no_verifiable_group"
        t_path = obj_path(target)
    except Exception:
        return [], "no_verifiable_group"

    def checked(a):
        try:
            return a.get_state_set().contains(_STATE_MAP["checked"])
        except Exception:
            return False

    def checked_peers(members):
        return [m for m in members if obj_path(m) != t_path and checked(m)]

    # 1. author-declared ARIA radiogroup ancestor (not descending into nested ones).
    # NOTE the deliberate asymmetry with branch 2: no setsize cross-check here.
    # An ARIA radiogroup is the author SAYING these options form one group, and
    # that declaration is what we honour; if it disagrees with the browser's
    # native name-grouping the group is malformed, and a malformed group with
    # two selected options must be REFUSED by the caller rather than quietly
    # downgraded to target-only, which is exactly what a cross-check here would
    # cause.
    grp = _ancestor_where(target, lambda a: _obj_attrs(a).get("xml-roles") == "radiogroup")
    if grp is not None:
        members = []
        _radios_in(grp, members, stop_at_nested_group=True)
        return checked_peers(members), "aria_radiogroup"

    # 2. native form-control grouping by html-input-name
    iname = _obj_attrs(target).get("html-input-name")
    if iname:
        is_form = lambda a: _obj_attrs(a).get("tag") == "form"
        t_form = _ancestor_where(target, is_form)
        t_form_path = obj_path(t_form) if t_form is not None else None
        doc = _ancestor_where(target, lambda a: a.get_role_name() in ("document web", "document frame"))
        scope = doc if doc is not None else app
        found = []
        _radios_in(scope, found)
        members = []
        for m in found:
            if _obj_attrs(m).get("html-input-name") != iname:
                continue
            m_form = _ancestor_where(m, is_form)
            if (obj_path(m_form) if m_form is not None else None) == t_form_path:
                members.append(m)
        # The browser's own group count must agree with the set we assembled --
        # this is what catches a radio whose form owner is invisible to us.
        # BOTH directions matter. Checking only the total is one-directional:
        # with an externally-owned radio as the TARGET (setsize 2, real peer
        # inside the form we cannot see) the leftover same-name candidates can
        # coincidentally total 2 and pass, falsely adopting an unrelated radio as
        # its peer. So every candidate must ALSO report the same group count
        # before the total is compared; a candidate whose own setsize differs is
        # provably in a different group.
        want = _setsize_of(target)
        if want is None:
            return [], "no_verifiable_group"
        members = [m for m in members if _setsize_of(m) == want]
        if len(members) != want:
            return [], "no_verifiable_group"
        return checked_peers(members), "html_input_name"

    return [], "no_verifiable_group"


# --- Dialog dismissal (layer 2) ----------------------------------------------
# AT-SPI exposes NO "this is the close control" property. There is role, the
# accessible name, and ancestry -- nothing else. So this rule is name-based, and
# it is constrained hard rather than dressed up as something stronger:
#   DENY wins, checked first, on SUBSTRING. Over-matching is safe here;
#   under-matching is not, because the cost of a false allow is making a consent
#   or subscription choice on the user's behalf.
#   ALLOW is EXACT whole-name only, so "close and accept all" can never
#   normalize into "close".
# Anything not positively a close affordance is refused; click_element stays the
# explicit path for a deliberate substantive choice.
DISMISS_DENY_TERMS = (
    "accept", "agree", "allow", "consent", "reject", "decline", "deny", "opt",
    "preference", "setting", "manage", "subscribe", "sign up", "signup",
    "submit", "continue", "confirm", "save", "yes", "no thanks", "not now",
    "maybe later", "unsubscribe", "email", "notify",
)
CLOSE_AFFORDANCE_NAMES = frozenset({
    "close", "close dialog", "close modal", "close popup", "close banner",
    "close this dialog", "dismiss", "dismiss dialog", "dismiss popup", "dismiss this popup",
    "\u00d7", "\u2715", "\u2716", "\u2a2f", "x",
    # Cart drawers name their close button for what they close (benchmark 2026-09-25: a Gymshark minicart
    # that ignored Escape stalled the add). Still close-only: DISMISS_DENY_TERMS is checked first.
    "close cart", "close bag", "close mini cart", "close minicart", "close drawer", "close panel",
    "close cart drawer", "close bag drawer", "close shopping bag", "close shopping cart", "close overlay",
})
CLOSE_ROLES = frozenset({"button", "push button", "toggle button"})


# Chromium's generic fallbacks for an ARIA role it does not map to a native one
# (MEASURED: div[role=radiogroup] arrives as "panel"). is_dialog_node runs on
# EVERY node of EVERY read_page walk, and an attribute read is a D-Bus round
# trip, so the lookup is confined to the roles where it can actually decide
# something: these generic containers, plus `alert`, which is ambiguous and must
# be positively disambiguated (see is_dialog_node).
# Deliberate consequence: a build reporting a dialog under some OTHER specific
# role while declaring xml-roles="dialog" would be missed.
GENERIC_CONTAINER_ROLES = frozenset({
    "panel", "section", "filler", "grouping", "generic", "unknown", "redundant object",
})


def is_dialog_node(acc, role=None):
    """Is this node the ROOT of a modal the caller could be asked to dismiss?

    The hard part is `alert`, which is AMBIGUOUS: ARIA role=alertdialog is a
    modal, while ARIA role=alert is an ordinary live-region notification ("Item
    added to cart") that is neither modal nor dismissible, and a build is free
    to surface either through the same AT-SPI role. Treating every `alert` as a
    dialog would hide ordinary page content behind a "modal" that is not one and
    make a toast's Close button eligible for dismiss_dialog. So `alert` requires
    a POSITIVE xml-roles=alertdialog declaration, and missing or unreadable
    metadata fails closed as NOT a dialog.

    MEASURED on this Chromium (151.0.7922.173), which happens to separate them
    itself -- but the rule does not depend on that, since another build need not:
        <dialog>                 -> role "dialog",      xml-roles absent
        div[role=alertdialog]    -> role "alert",       xml-roles "alertdialog"
        div[role=alert]          -> role "notification", xml-roles "alert"
        div[role=status]         -> role "status bar",  xml-roles "status"
        div[role=radiogroup]     -> role "panel",       xml-roles "radiogroup"
    The last line is why the generic-container branch exists at all: an ARIA role
    Chromium declines to map natively still surfaces in the attributes. That
    branch is defence for a build that treats dialog the way this one treats
    radiogroup; it is proven against a mock, not claimed as live behaviour.

    ACCEPTED COST of failing closed on `alert`: a build that reported an
    alertdialog WITHOUT the xml-roles declaration would be missed. Missing a
    modal degrades to "the caller re-reads"; inventing one lets this tool press a
    button inside an ordinary notification."""
    # (role: the caller's own read of it, when it has one — a walk already read every node's role; reading it again
    # was one more round trip to the browser per node, 2026-10-08)
    if role is None:
        try:
            role = acc.get_role_name()
        except Exception:
            return False
    if role == "dialog":
        return True
    if role == "alert":
        # AMBIGUOUS role -- positive declaration required, never assumed.
        return _obj_attrs(acc).get("xml-roles") == "alertdialog"
    if role not in GENERIC_CONTAINER_ROLES:
        return False
    return _obj_attrs(acc).get("xml-roles") in ("dialog", "alertdialog")


def normalize_control_name(name):
    return " ".join((name or "").split()).strip().lower()


def classify_close_affordance(name, role, actions):
    """PURE (unit-tested). Is this control positively a close affordance that may
    be activated to dismiss a dialog? Returns {"ok": bool, "reason": str}."""
    norm = normalize_control_name(name)
    if not norm:
        return {"ok": False, "reason": "control_has_no_name"}
    # DENY FIRST, and on substring.
    for term in DISMISS_DENY_TERMS:
        if term in norm:
            return {"ok": False, "reason": "substantive_choice_refused"}
    if norm not in CLOSE_AFFORDANCE_NAMES:
        return {"ok": False, "reason": "not_a_close_affordance"}
    if (role or "").strip().lower() not in CLOSE_ROLES:
        return {"ok": False, "reason": "role_not_a_button"}
    if any(not (a.get("name") or "").strip() for a in actions):
        return {"ok": False, "reason": "ambiguous_action"}
    allowed = [a for a in actions if a["name"].strip().lower() in ACTIVATION_ACTIONS]
    if not allowed:
        return {"ok": False, "reason": "no_activation_action"}
    # More than one allowlisted action whose equivalence we cannot prove.
    if len(allowed) > 1:
        return {"ok": False, "reason": "ambiguous_action"}
    return {"ok": True, "reason": "close_affordance", "index": allowed[0]["index"], "action": allowed[0]["name"]}


def _dialog_ancestors(acc):
    out = []
    cur = acc
    depth = 0
    while cur is not None and depth < 60:
        try:
            if is_dialog_node(cur):
                out.append(cur)
            cur = cur.get_parent()
        except Exception:
            break
        depth += 1
    return out


def _page_survey(app):
    """ONE structural walk producing every number the dismissal postcondition
    needs, so BEFORE and AFTER are measured by the SAME instrument:
      links/content  - OUTSIDE every dialog/alert subtree, in page documents only
      dialogs        - dialog ROOTS in page documents (native role AND
                       xml-roles-declared ones Chromium maps to a panel)
      page_docs      - the live page documents as {doc_gen, uri}
    `dialogs` is counted at the ROOT, never per descendant, so a modal with 40
    children counts once. `page_docs` carries object-path GENERATIONS, not URL
    text: a same-URL reload replaces the document node and therefore changes the
    generation, which is the only way to tell a reload from a still-standing
    page."""
    links = [0]
    content = [0]
    dialogs = [0]
    page_docs = []

    def visit(a, d, in_doc, in_dialog, doc_ok):
        if d > 45:
            return
        try:
            role = a.get_role_name()
        except Exception:
            return
        if role in ("document web", "document frame"):
            in_doc = True
            doc_ok = is_page_document(a)
            if doc_ok:
                page_docs.append({"doc_gen": obj_path(a), "uri": document_uri(a)})
        is_root = is_dialog_node(a)
        if is_root:
            # Count the root only, and only in a page document -- browser UI
            # dialogs are never this tool's business.
            if in_doc and doc_ok:
                dialogs[0] += 1
            in_dialog = True
        if in_doc and doc_ok and not in_dialog:
            if role == "link":
                links[0] += 1
            if role in ("link", "heading", "static", "image", "paragraph", "button", "entry"):
                content[0] += 1
        try:
            n = a.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                c = a.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                visit(c, d + 1, in_doc, in_dialog, doc_ok)

    visit(app, 0, False, False, False)
    return {"links": links[0], "content": content[0], "dialogs": dialogs[0],
            "page_docs": page_docs}


def dialog_survey_action(app):
    """READ-ONLY. The same survey the dismissal captures as `before`, so the
    caller's AFTER measurement is taken with the identical instrument rather
    than derived from a capped read_page snapshot."""
    return _page_survey(app)


def dialog_escape_context_action(app, obj_path_arg, doc_gen_arg):
    """READ-ONLY. Everything the Escape-dismissal gate needs, captured in ONE
    walk so the observations describe a single moment rather than a smear across
    several round trips.

    Nothing here focuses, activates or moves anything. Focus is OBSERVED as a
    safety gate and never manipulated: the site and the browser have already
    established the operative modal context, and grabbing focus would change the
    very state we are about to reason about.

    MODAL is the positive signal that the target really is a modal — MEASURED to
    be set both by a native <dialog>.showModal() and by a scripted div carrying
    aria-modal (YoungLA's consent overlay is the latter: tag "div",
    xml-roles "dialog"). It proves MODALITY. It does NOT prove that the page will
    ACT on Escape: for a scripted overlay that is the site's own keydown handler,
    unknowable in advance, which is why the caller must verify afterwards."""
    out = {"target": None, "page_dialog_roots": 0, "focus": None, "page_docs": [],
           "survey": None}
    node, status = resolve_by_objpath(app, doc_gen_arg, obj_path_arg, None, None)
    out["resolve_status"] = status
    if node is not None:
        try:
            ss = node.get_state_set()
            attrs = _obj_attrs(node)
            doc = enclosing_document(node)
            out["target"] = {
                "role": node.get_role_name(),
                "name": node.get_name() or "",
                "obj_path": obj_path(node),
                "doc_gen": doc_gen_of(node),
                "is_dialog_root": is_dialog_node(node),
                "modal": ss.contains(Atspi.StateType.MODAL),
                "in_page_document": is_page_document(doc),
                # Recorded for evidence and diagnostics only. tag is NOT required
                # to be "dialog": demanding a native element would exclude the
                # scripted aria-modal overlays this exists to dismiss.
                "tag": attrs.get("tag"),
                "xml_roles": attrs.get("xml-roles"),
            }
        except Exception as e:
            out["target_error"] = str(e)

    survey = _page_survey(app)
    out["survey"] = {k: survey[k] for k in ("links", "content", "dialogs")}
    out["page_docs"] = survey["page_docs"]
    out["page_dialog_roots"] = survey["dialogs"]

    foc = get_focused_action(app).get("focused")
    if foc:
        out["focus"] = {"role": foc.get("role"), "doc_class": foc.get("doc_class"),
                        "doc_uri": foc.get("doc_uri"), "obj_path": foc.get("obj_path"),
                        "doc_gen": None}
        # Which document generation is focus actually in? Needed to prove focus
        # is in the SAME page document as the dialog, by identity rather than URI.
        try:
            fnode, fstatus = resolve_by_objpath(app, None, foc.get("obj_path"), None, None)
            if fnode is not None:
                out["focus"]["doc_gen"] = doc_gen_of(fnode)
                # Strictly stronger than same-document: focus INSIDE the target.
                cur, depth = fnode, 0
                while cur is not None and depth < 60:
                    if obj_path(cur) == obj_path_arg:
                        out["focus"]["inside_target"] = True
                        break
                    try:
                        cur = cur.get_parent()
                    except Exception:
                        break
                    depth += 1
        except Exception:
            pass
    return out


def count_dialogs_fast(app, offset_x, offset_y):
    """How many visible `dialog` elements the app shows — the number collect(role "dialog") would return — in a
    few ms instead of a whole-tree walk (~0.1-0.8 s on product pages; benchmark 2026-09-25). Browser chrome is
    walked (it is small) and each page document is asked ONE AT-SPI Collection query. Returns None when a
    document cannot answer, so the caller falls back to the walk."""
    rule = Atspi.MatchRule.new(Atspi.StateSet.new([]), Atspi.CollectionMatchType.ALL, None, Atspi.CollectionMatchType.ALL,
                               [Atspi.Role.DIALOG], Atspi.CollectionMatchType.ANY, None, Atspi.CollectionMatchType.ALL, False)
    dialog_role = normalize_role("dialog")
    count = [0]

    def visible(acc):
        b = get_bounds(acc, offset_x, offset_y)
        return bool(b) and not (b["x"] < -1000 or b["y"] < -1000)  # the same rule as collect()

    def walk(acc, depth):
        if acc is None or depth > 40:
            return True
        role = acc.get_role_name()
        if role in ("document web", "document frame"):
            coll = acc.get_collection_iface()
            if not coll:
                return False
            matches = Atspi.Collection.get_matches(coll, rule, Atspi.CollectionSortOrder.CANONICAL, 0, True)
            count[0] += sum(1 for m in matches if visible(m))
            return True
        if role == dialog_role and visible(acc):
            count[0] += 1
        for i in range(acc.get_child_count()):
            if not walk(acc.get_child_at_index(i), depth + 1):
                return False
        return True

    try:
        return count[0] if walk(app, 0) else None
    except Exception:
        return None


def dialog_close_controls_action(app, obj_path_arg, doc_gen_arg):
    """The close affordances INSIDE one dialog (for the dismiss fallback when Escape did nothing — what a person
    does next: press the popup's own X). Read-only: returns candidates, activates nothing. Only showing controls
    whose name and role pass classify_close_affordance's name/role rules (deny terms first)."""
    dialog, status = resolve_by_objpath(app, doc_gen_arg, obj_path_arg, None, None)
    if dialog is None:
        return {"error": "stale_ref", "status": status}
    found, seen = [], [0]

    def walk(acc, depth):
        if acc is None or depth > 30 or seen[0] > 4000 or len(found) >= 8:
            return
        seen[0] += 1
        try:
            role = (acc.get_role_name() or "").strip().lower()
            if role in CLOSE_ROLES:
                name = acc.get_name() or ""
                norm = normalize_control_name(name)
                showing = acc.get_state_set().contains(Atspi.StateType.SHOWING)
                if showing and norm in CLOSE_AFFORDANCE_NAMES and not any(t in norm for t in DISMISS_DENY_TERMS):
                    found.append({"obj_path": obj_path(acc), "doc_gen": doc_gen_of(acc), "role": role, "name": name})
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(min(n, 400)):
            try:
                walk(acc.get_child_at_index(i), depth + 1)
            except Exception:
                continue

    walk(dialog, 0)
    return {"controls": found}


def dismiss_dialog_action(app, obj_path_arg, doc_gen_arg, role_filter=None,
                          expected_dialog_obj_path=None, expected_dialog_doc_gen=None):
    """Resolve ONE control by identity, prove it is a close affordance inside
    exactly one page dialog, and invoke its own action ONCE. Every refusal path
    performs zero actions. The caller verifies the outcome from a FRESH read."""
    node, status = resolve_by_objpath(app, doc_gen_arg, obj_path_arg, role_filter, None)
    if node is None:
        return {"refused": True, "invocation_count": 0, "reason": "stale_ref", "status": status}
    try:
        role = node.get_role_name()
        name = node.get_name() or ""
    except Exception:
        return {"refused": True, "invocation_count": 0, "reason": "control_unreadable"}

    dialogs = _dialog_ancestors(node)
    if not dialogs:
        return {"refused": True, "invocation_count": 0, "reason": "not_inside_a_dialog", "role": role, "name": name}
    if len(dialogs) > 1:
        # Nested dialogs: which one this control closes is genuinely ambiguous.
        return {"refused": True, "invocation_count": 0, "reason": "ambiguous_dialog_ancestry", "role": role, "name": name,
                "dialog_count": len(dialogs)}
    dialog = dialogs[0]
    if expected_dialog_obj_path:
        expected, expected_status = resolve_by_objpath(
            app, expected_dialog_doc_gen, expected_dialog_obj_path, None, None)
        if expected is None:
            return {"refused": True, "invocation_count": 0,
                    "reason": "expected_dialog_stale", "status": expected_status,
                    "role": role, "name": name}
        if not is_dialog_node(expected) or obj_path(dialog) != obj_path(expected):
            return {"refused": True, "invocation_count": 0,
                    "reason": "expected_dialog_mismatch", "role": role, "name": name}
    dlg_doc = enclosing_document(dialog)
    if not is_page_document(dlg_doc):
        return {"refused": True, "invocation_count": 0, "reason": "dialog_not_in_a_page_document", "role": role, "name": name}

    actions = []
    try:
        ai = node.get_action_iface()
        if ai:
            n = Atspi.Action.get_n_actions(ai)
            for i in range(n):
                try:
                    aname = Atspi.Action.get_action_name(ai, i)
                except Exception as e:
                    return {"refused": True, "invocation_count": 0, "reason": f"action_enumeration_failed: {e}", "role": role, "name": name}
                if aname is None:
                    return {"refused": True, "invocation_count": 0, "reason": "action_without_name", "role": role, "name": name}
                actions.append({"index": i, "name": aname})
    except Exception as e:
        return {"refused": True, "invocation_count": 0, "reason": f"action_iface: {e}", "role": role, "name": name}

    verdict = classify_close_affordance(name, role, actions)
    before = {
        "control": {"name": name, "role": role, "obj_path": obj_path(node), "doc_gen": doc_gen_of(node),
                    "actions": [a["name"] for a in actions]},
        "dialog": {"name": dialog.get_name(), "obj_path": obj_path(dialog), "doc_gen": doc_gen_of(dialog)},
        # The GENERATION of the page document this dialog lives in. The caller
        # compares this against the page documents present afterwards: a
        # same-URL reload keeps the URL identical but replaces the document
        # node, so URL text cannot detect it and this can.
        "page_doc_gen": obj_path(dlg_doc),
        "page_uri": document_uri(dlg_doc),
        "survey": _page_survey(app),
    }
    if not verdict["ok"]:
        return {"refused": True, "invocation_count": 0, "reason": verdict["reason"], "before": before}

    try:
        ok = bool(Atspi.Action.do_action(ai, verdict["index"]))
    except Exception as e:
        # The call was MADE and then raised. The counter reports do_action calls
        # ISSUED, not calls that succeeded, so this is 1: understating it would
        # let a partially-applied activation look like an untouched page.
        return {"refused": True, "invocation_count": 1, "reason": f"do_action_failed: {e}", "before": before}
    return {"invoked": True, "invocation_count": 1, "invoked_name": verdict["action"],
            "invoked_index": verdict["index"], "do_action_returned": ok, "before": before}


def semantic_toggle_action(app, text_filter, role_filter, obj_path_arg=None, doc_gen_arg=None, keep_pressed=False):
    """ATOMIC pre -> choose -> invoke -> post verdict for a STATEFUL TOGGLE, all
    on ONE identity-resolved node in ONE process.

    Shares the checkable path's mechanics -- identity resolution, one action, a
    post-state re-read on the exact node, calls-ISSUED accounting -- and shares
    none of its peer policy, deliberately: aria-pressed declares no group, so
    there is no peer to verify and no exclusivity that could be claimed.

    The verdict is ONLY about the requested control: did THIS node reach the
    state its own advertised action said it would. do_action's boolean is
    evidence and never proof; the action name flipping check <-> uncheck is
    recorded as corroboration, never as the verdict."""
    target, match_count, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
    if stale:
        return {**stale, "invocation_count": 0}
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}",
                "invocation_count": 0}
    role = target.get_role_name()
    name = target.get_name()
    if match_count > 1:
        return {"ambiguous_target": True, "match_count": match_count, "role": role, "name": name,
                "invocation_count": 0}
    key = state_key_for_role(role)
    if role not in TOGGLE_ROLES or key is None:
        return {"unsupported_role": True, "role": role, "name": name, "match_count": 1,
                "invocation_count": 0}

    pre = _state_snapshot(target)
    if not pre:
        return {"error": "could not read the control's state before acting", "role": role, "name": name,
                "invocation_count": 0}
    pre_on = pre.get(key)

    actions = []
    try:
        ai = target.get_action_iface()
        if ai:
            n = Atspi.Action.get_n_actions(ai)
            for i in range(n):
                try:
                    aname = Atspi.Action.get_action_name(ai, i)
                except Exception as e:
                    return {"error": f"action enumeration failed at index {i}/{n}: {e}",
                            "role": role, "name": name, "invocation_count": 0}
                if aname is None:
                    return {"error": f"action index {i}/{n} has no name (cannot classify safely)",
                            "role": role, "name": name, "invocation_count": 0}
                actions.append({"index": i, "name": aname})
    except Exception as e:
        return {"error": f"action iface: {e}", "role": role, "name": name, "invocation_count": 0}

    dec = choose_toggle_action(actions, role, pre_on)
    base = {"role": role, "name": name, "match_count": 1, "actions": actions, "state_key": key,
            "pre_states": pre, "pre_on": pre_on,
            "obj_path": obj_path(target), "doc_gen": doc_gen_of(target)}
    # An option that is already chosen is left alone when asked (a person does not click the selected colour):
    # clicking a pressed toggle unpresses it (live Owala: the default "Plaid and Simple" was unpressed, 7 s).
    if keep_pressed and pre_on is True:
        return {**base, "already_pressed": True, "invocation_count": 0}
    if dec["decision"] != "invoke":
        return {**base, dec["decision"]: True, "decision": dec["decision"],
                "desired": dec.get("desired"), "want": dec.get("want"), "offered": dec.get("offered"),
                "invocation_count": 0}

    desired = dec["desired"]
    tgt_path, tgt_gen = obj_path(target), doc_gen_of(target)
    try:
        ok = bool(Atspi.Action.do_action(ai, dec["index"]))
    except Exception as e:
        # The call was ISSUED and then raised: it may have partially applied.
        return {**base, "invoked": True, "invocation_count": 1, "invoked_name": dec["name"],
                "desired": desired, "verified": False, "failure": "action_raised",
                "raised": str(e)}

    # POSTCONDITION on the EXACT node, re-resolved by identity every poll: a
    # name lookup here could answer about a different node that the activation
    # caused to appear under the same name (measured live -- a variant selection
    # adds new same-named nodes, and a name re-lookup reported a stranger's
    # state as the target's).
    post, post_actions, post_status = None, None, "unresolved"
    gone = 0
    for _ in range(12):
        time.sleep(0.15)
        node, status = resolve_by_objpath(app, tgt_gen, tgt_path, role, None)
        post_status = status
        if node is None:
            # Two misses in a row: the page replaced the control (Owala re-renders its size buttons on a pick). The
            # caller reads the fresh copy; ten more lookups of the old one only cost ~5 s (live 2026-09-26).
            gone += 1
            if gone >= 2:
                break
            continue
        gone = 0
        snap = _state_snapshot(node)
        if not snap:
            continue
        post, post_actions = snap, _action_names(node)
        if snap.get(key) == desired:
            break

    result = {**base, "invoked": True, "invocation_count": 1, "invoked_name": dec["name"],
              "do_action_returned": ok, "desired": desired, "post_states": post,
              "post_status": post_status, "post_actions": post_actions}
    if post is None:
        return {**result, "verified": False, "failure": "post_state_unavailable"}
    if post.get(key) != desired:
        return {**result, "verified": False, "failure": "state_unchanged"}
    return {**result, "verified": True}


def _action_names(acc):
    """Action names on a live node, or None if unreadable. Corroboration only."""
    try:
        ai = acc.get_action_iface()
        if not ai:
            return []
        return [Atspi.Action.get_action_name(ai, i) for i in range(Atspi.Action.get_n_actions(ai))]
    except Exception:
        return None


def semantic_set_checkable_action(app, text_filter, role_filter, obj_path_arg=None, doc_gen_arg=None):
    """ATOMIC pre -> choose -> invoke -> post VERDICT for a checkable control
    (issue #6), all in ONE process on ONE identity-resolved Accessible. The
    verdict is decided HERE, not inferred by the caller from a page-level
    transition summary.
    do_action's boolean is evidence only and is NEVER success. Success requires
    the exact node's own post-state to equal the derived desired state; an
    unchanged, unreadable or stale post-state is FAILED-UNVERIFIED. A radio's
    previously-checked peer, when a defensible group association exists, must
    also be observed to have become unchecked."""
    target, match_count, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
    if stale:
        return stale
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}"}
    role = target.get_role_name()
    name = target.get_name()
    if match_count > 1:
        return {"ambiguous_target": True, "match_count": match_count, "role": role, "name": name}
    if role not in CHECKABLE_ROLES:
        return {"unsupported_role": True, "role": role, "name": name, "match_count": 1}

    pre = _state_snapshot(target)
    if not pre:
        return {"error": "could not read the control's state before acting", "role": role, "name": name}

    actions = []
    try:
        ai = target.get_action_iface()
        if ai:
            n = Atspi.Action.get_n_actions(ai)
            for i in range(n):
                try:
                    aname = Atspi.Action.get_action_name(ai, i)
                    adesc = Atspi.Action.get_action_description(ai, i) or ""
                except Exception as e:
                    return {"error": f"action enumeration failed at index {i}/{n}: {e}", "role": role, "name": name}
                if aname is None:
                    return {"error": f"action index {i}/{n} has no name (cannot classify safely)", "role": role, "name": name}
                actions.append({"index": i, "name": aname, "description": adesc})
    except Exception as e:
        return {"error": f"action iface: {e}", "role": role, "name": name}

    dec = choose_checkable_action(actions, role, bool(pre.get("checked")))
    base = {"role": role, "name": name, "match_count": 1, "actions": actions,
            "pre_states": pre, "obj_path": obj_path(target), "doc_gen": doc_gen_of(target)}
    if dec["decision"] == "already_satisfied":
        # Verified WITHOUT invoking: the desired state is independently observed
        # on the exact node. Nothing ran, so there is nothing to attribute.
        # BUT a radio that is already selected still has to be the ONLY selected
        # option: if a second one is also checked the group is malformed, and
        # reporting plain success here would hide exactly the broken state the
        # invoking path refuses to act into. Any other checked peer at this point
        # is one too many (the target itself is already checked).
        if role == "radio button":
            other_checked, association = find_prior_peer(app, target)
            if other_checked:
                return {**base, "ambiguous_group": True, "peer_association": association,
                        "checked_peer_count": len(other_checked) + 1,
                        "checked_peer_names": [p.get_name() for p in other_checked],
                        "already_checked_target": True}
            return {**base, "already_satisfied": True, "verified": True, "invoked": False,
                    "desired_checked": dec["desired"], "post_states": pre,
                    "peer_association": association,
                    "peer_verified": association in ("aria_radiogroup", "html_input_name")}
        return {**base, "already_satisfied": True, "verified": True, "invoked": False,
                "desired_checked": dec["desired"], "post_states": pre,
                "peer_association": "not_applicable"}
    if dec["decision"] == "no_activation_action":
        return {**base, "no_activation_action": True, "desired_checked": dec["desired"], "wanted_action": dec["want"]}
    if dec["decision"] == "ambiguous_action":
        return {**base, "ambiguous_action": True, "desired_checked": dec.get("desired")}
    if dec["decision"] == "unsupported_role":
        return {**base, "unsupported_role": True}

    desired = dec["desired"]
    # Capture the target's OWN identity before acting: every post-read below
    # re-resolves through it, so the verdict can never come from a stale handle.
    t_path = obj_path(target)
    t_doc = doc_gen_of(target)

    # Capture the prior peers BEFORE invoking, by identity (radio only).
    peers, association = find_prior_peer(app, target) if role == "radio button" else ([], "not_applicable")
    if len(peers) > 1:
        # A defensible group with TWO already-selected options is a broken state
        # model, not something to act into: verifying "the" peer would leave the
        # other one selected and still look like success. Refuse BEFORE invoking.
        return {**base, "ambiguous_group": True, "peer_association": association,
                "checked_peer_count": len(peers),
                "checked_peer_names": [p.get_name() for p in peers]}
    peer_node = peers[0] if peers else None
    peer_path = obj_path(peer_node) if peer_node is not None else None
    peer_doc = doc_gen_of(peer_node) if peer_node is not None else None
    peer_name = peer_node.get_name() if peer_node is not None else None

    try:
        ok = bool(Atspi.Action.do_action(ai, dec["index"]))
    except Exception as e:
        return {**base, "error": f"do_action failed: {e}", "invoked_index": dec["index"], "invoked_name": dec["name"]}

    # Bounded in-process settle. Each poll RE-RESOLVES the target by its own
    # (doc_gen, obj_path) identity with the expected ROLE -- never by reading the
    # pre-action handle, which would happily report the state of a node that has
    # since been detached, replaced, or role-morphed. Name is deliberately not
    # gated: a control may relabel itself as a result of being set.
    post, post_status = {}, "stale_none"
    deadline = time.time() + 1.5
    while True:
        live, post_status = resolve_by_objpath(app, t_doc, t_path, role, None)
        post = _state_snapshot(live) if live is not None else {}
        if post and bool(post.get("checked")) == desired:
            break
        if time.time() >= deadline:
            break
        time.sleep(0.1)

    out = {**base, "invoked": True, "invoked_index": dec["index"], "invoked_name": dec["name"],
           "do_action_returned": ok, "desired_checked": desired, "post_states": post,
           "peer_association": association}
    if not post:
        # Replaced, removed, or now a different role: the control we acted on is
        # not there to be verified, so there is no success to report.
        out["verified"] = False
        out["failure"] = "post_state_unavailable"
        out["post_status"] = post_status
        return out
    if bool(post.get("checked")) != desired:
        out["verified"] = False
        out["failure"] = "state_unchanged"
        return out

    # Target's own postcondition holds. Now the peer, when one was captured.
    if peer_path:
        out["peer_name"] = peer_name
        # Re-resolved by identity AND expected role, same as the target.
        peer_live, status = resolve_by_objpath(app, peer_doc, peer_path, "radio button", None)
        if peer_live is None:
            # It WAS capturable before the action, so failing to re-read it now
            # is a hole in the evidence, not a pass (review ruling).
            out["verified"] = False
            out["failure"] = "peer_unreadable"
            out["peer_status"] = status
            return out
        peer_post = _state_snapshot(peer_live)
        out["peer_post_states"] = peer_post
        if not peer_post or bool(peer_post.get("checked")):
            out["verified"] = False
            out["failure"] = "peer_still_checked" if peer_post else "peer_unreadable"
            return out
        out["verified"] = True
        out["peer_verified"] = True
        return out

    # No peer captured: say WHY, so target-only verification is never mistaken
    # for group-wide verification.
    out["verified"] = True
    out["peer_verified"] = False
    out["peer_reason"] = "no_prior_peer" if association in ("aria_radiogroup", "html_input_name") else association
    return out


def _state_snapshot(acc):  # uses the shared _STATE_MAP defined above
    out = {}
    try:
        ss = acc.get_state_set()
        for name, enum_val in _STATE_MAP.items():
            out[name] = ss.contains(enum_val)
    except Exception:
        return {}
    return out


def element_states_action(app, text_filter, role_filter, obj_path_arg=None, doc_gen_arg=None):
    """READ-ONLY state snapshot of ONE node, used by click_element's transition
    evidence (issue #6). When obj_path_arg is given, the node is the UNIQUE one
    carrying that (doc_gen, obj_path) D-Bus identity: the SAME control the
    caller acted on, even among duplicate-named siblings (a size radio group is
    exactly this shape), and even after the tree restructures around it. On any
    identity failure this returns a fail-CLOSED stale_ref -- it NEVER falls back
    to a name/role match, so a state delta can never be attributed to a
    different node than the one that was activated.
    The two halves of _resolve_target's SANITY gate are treated differently here
    (review ruling, issue #6):
      - NAME is NOT checked. A control that relabels itself as a direct result of
        the activation ("Show" -> "Hide") is the normal case, and refusing it
        would blind the very transition detector this feeds. The live name is
        returned instead, so the relabel stays visible as evidence.
      - ROLE IS checked. A node whose role changed underneath a stable object
        path is not the control the caller reasoned about, and its states are no
        longer comparable to the baseline; that is reported as stale_mismatch
        (fail closed) rather than silently diffed against a different kind of
        control.
    Without obj_path_arg the legacy name/role resolution is UNCHANGED (callers
    with no identity -- e.g. the gated no-objpath test mode -- keep the old
    match_count semantics)."""
    if obj_path_arg:
        node, status = resolve_by_objpath(app, doc_gen_arg, obj_path_arg, role_filter, None)
        if status != "ok":
            return {"found": False, "identity": "obj_path", "stale_ref": True, "status": status,
                    "reason": "this ref no longer identifies a live element (" + status +
                              ") -- the page changed; call read_page again and use a fresh ref"}
        return {"found": True, "identity": "obj_path", "match_count": 1,
                "states": _state_snapshot(node),
                "role": node.get_role_name(), "name": node.get_name(),
                "obj_path": obj_path(node), "doc_gen": doc_gen_of(node)}
    t, mc = find_first_live(app, text_filter, role_filter)
    if t is None:
        return {"found": False, "identity": "name"}
    return {"found": True, "identity": "name", "match_count": mc, "states": _state_snapshot(t),
            "role": t.get_role_name(), "name": t.get_name()}


def semantic_activate_action(app, text_filter, role_filter, obj_path_arg=None, doc_gen_arg=None):
    """ATOMIC: resolve -> enumerate actions -> choose -> invoke -> capture,
    all on the SAME live Accessible in ONE process (no A/B identity race).
    Refuses on any duplication or ambiguity; do_action's bool is returned
    as-is and is NEVER treated as success (caller verifies a fresh
    postcondition). See SEMANTIC_ACTIVATE_PLAN.md. When obj_path_arg is given
    (ref call), the target is the UNIQUE node with that D-Bus object-path
    identity (issue #5) — no name/geometry match, and a stale identity refuses."""
    target, match_count, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
    if stale:
        return stale
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}"}
    role = target.get_role_name()
    name = target.get_name()
    # Duplicate targets are NOT unique identity (exact names/refs included) -> refuse.
    if match_count > 1:
        return {"ambiguous_target": True, "match_count": match_count, "role": role, "name": name}
    # Enumerate on the SAME object. FAIL CLOSED if any action index can't be
    # read: silently omitting it could hide a second (possibly dangerous)
    # action and make choose_action wrongly conclude exactly one safe action
    # exists (gh issue #4 review v2). A missing name is also fail-closed.
    actions = []
    try:
        ai = target.get_action_iface()
        if ai:
            n = Atspi.Action.get_n_actions(ai)
            for i in range(n):
                try:
                    aname = Atspi.Action.get_action_name(ai, i)
                    adesc = Atspi.Action.get_action_description(ai, i) or ""
                except Exception as e:
                    return {"error": f"action enumeration failed at index {i}/{n}: {e}", "role": role, "name": name}
                if aname is None:
                    return {"error": f"action index {i}/{n} has no name (cannot classify safely)", "role": role, "name": name}
                actions.append({"index": i, "name": aname, "description": adesc})
    except Exception as e:
        return {"error": f"action iface: {e}", "role": role, "name": name}
    dec = choose_action(actions, role)
    if dec["decision"] == "no_activation_action":
        return {"no_activation_action": True, "actions": actions, "role": role, "name": name, "match_count": 1}
    if dec["decision"] == "ambiguous_action":
        return {"ambiguous_action": True, "actions": actions, "role": role, "name": name, "match_count": 1}
    # Invoke on the SAME object; capture immediate post-state (evidence only).
    try:
        ok = bool(Atspi.Action.do_action(ai, dec["index"]))
    except Exception as e:
        return {"error": f"do_action failed: {e}", "role": role, "name": name, "invoked_index": dec["index"], "invoked_name": dec["name"]}
    return {
        "invoked": True, "invoked_index": dec["index"], "invoked_name": dec["name"],
        "do_action_returned": ok, "role": role, "name": name, "match_count": 1,
        "actions": actions, "post_states": _state_snapshot(target),
    }


def list_actions_action(app, text_filter, role_filter):
    """Enumerate the AT-SPI Action interface of a resolved element: exact
    action names, indices, and descriptions. Used to activate controls
    semantically (do_action by index) instead of via the unreliable
    coordinate-click path. Read-only."""
    target, match_count = find_first_live(app, text_filter, role_filter)
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}"}
    out = {"role": target.get_role_name(), "name": target.get_name(), "match_count": match_count, "actions": []}
    try:
        ai = target.get_action_iface()
        if ai:
            n = Atspi.Action.get_n_actions(ai)
            for i in range(n):
                try:
                    out["actions"].append({
                        "index": i,
                        "name": Atspi.Action.get_action_name(ai, i),
                        "description": Atspi.Action.get_action_description(ai, i) or "",
                    })
                except Exception as e:
                    out["actions"].append({"index": i, "error": str(e)})
    except Exception as e:
        out["error"] = f"action iface: {e}"
    return out


def do_action_action(app, text_filter, role_filter, index, obj_path_arg=None, doc_gen_arg=None):
    """Invoke ONE AT-SPI Action by validated index on a resolved element.
    Returns do_action's boolean. Never guesses — the caller chose the index
    from list_actions via an allowlist. do_action's bool is NOT proof of a
    real transition; the caller re-polls the tree afterward."""
    target, _mc, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
    if stale:
        return stale
    if target is None:
        return {"error": f"no element found matching text={text_filter!r} role={role_filter!r}"}
    try:
        ai = target.get_action_iface()
        if not ai:
            return {"error": "element exposes no Action interface"}
        n = Atspi.Action.get_n_actions(ai)
        if index is None or index < 0 or index >= n:
            return {"error": f"index {index} out of range (n_actions={n})"}
        name = Atspi.Action.get_action_name(ai, index)
        ok = bool(Atspi.Action.do_action(ai, index))
        return {"role": target.get_role_name(), "name": target.get_name(), "invoked_index": index, "invoked_name": name, "do_action_returned": ok}
    except Exception as e:
        return {"error": str(e)}


def hit_point_action(app, offset_x, offset_y, text_filter, role_filter, obj_path_arg=None, doc_gen_arg=None):
    """Find a screen point that provably belongs to ONE resolved element, for a
    control that exposes no AT-SPI action (live On: size options and address
    suggestions are bare <li> nodes). The ref is resolved by identity exactly as
    for activation; then, in this same process, candidate points inside its
    CURRENT extents are hit-tested top-down from its document with
    Component.get_accessible_at_point. A point counts only when the descent
    passes through the target itself (the deepest hit is the target or one of
    its descendants); a point owned by an overlay, a sibling or nothing is
    rejected. Returns {"status": "owned", "x", "y"} in screen coordinates, or a
    refusal with what was hit instead. Never clicks."""
    target, _mc, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
    if stale:
        return stale
    if target is None:
        return {"status": "not_found"}
    b = get_bounds(target, offset_x, offset_y)
    if not b:
        return {"status": "no_bounds"}
    try:
        ss = target.get_state_set()
        if not ss.contains(Atspi.StateType.SHOWING):
            return {"status": "not_showing"}
    except Exception:
        return {"status": "not_showing"}
    t_path = obj_path(target)
    doc = target
    try:
        while doc is not None and doc.get_role_name() not in ("document web", "document frame"):
            doc = doc.get_parent()
    except Exception:
        doc = None
    if doc is None:
        return {"status": "no_document"}
    # Window coordinates for the hit test; the centre first, then inner points
    # (a centred child label is fine, a badge over the centre is not).
    wx, wy, w, h = b["x"] - offset_x, b["y"] - offset_y, b["w"], b["h"]
    fractions = [(0.5, 0.5), (0.3, 0.5), (0.7, 0.5), (0.5, 0.3), (0.5, 0.7)]
    last_hit = None
    for fx, fy in fractions:
        px, py = int(wx + w * fx), int(wy + h * fy)
        cur, owned = doc, False
        for _ in range(60):
            try:
                comp = cur.get_component_iface()
                nxt = comp.get_accessible_at_point(px, py, Atspi.CoordType.WINDOW) if comp else None
            except Exception:
                nxt = None
            if nxt is None or obj_path(nxt) == obj_path(cur):
                break
            cur = nxt
            if obj_path(cur) == t_path:
                owned = True
                break
        if owned:
            return {"status": "owned", "x": px + offset_x, "y": py + offset_y,
                    "role": target.get_role_name(), "name": (target.get_name() or "")[:120]}
        try:
            # The point that was tested rides along: a covering pop-up BACKDROP ("Close Dialog" spanning the screen)
            # is closed by a real click on it, and this point is provably the backdrop's.
            last_hit = {"role": cur.get_role_name(), "name": (cur.get_name() or "")[:80], "x": px + offset_x, "y": py + offset_y}
        except Exception:
            last_hit = None
    return {"status": "not_owned", "hit": last_hit}


_OPTION_ROLES = {"menu item", "list item", "option", "check menu item", "radio menu item"}


def choose_option_action(app, text_filter, role_filter, option_text, obj_path_arg=None, doc_gen_arg=None):
    """Choose a dropdown option SEMANTICALLY, without opening it or typing: the
    option node among the dropdown's own descendants (a native <select> keeps
    them in the tree while closed), chosen through its own 'select'/'click'
    action, or else through the list's Selection interface. Live On/Coach/Bath
    & Body Works: options advertise 'select', which nothing routed, and
    type-ahead left State unset. Exactly ONE option may match. The caller reads
    the dropdown back; this only reports what it invoked."""
    target, _mc, stale = _resolve_target(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)
    if stale:
        return stale
    if target is None:
        return {"status": "not_found"}
    want = " ".join(str(option_text or "").split()).lower()
    matches = []

    def walk(acc, depth):
        if depth > 4 or len(matches) > 3:
            return
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(min(n, 400)):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is None:
                continue
            try:
                if normalize_role(c.get_role_name()) in _OPTION_ROLES and " ".join((c.get_name() or "").split()).lower() == want:
                    matches.append((c, acc, i))
            except Exception:
                pass
            walk(c, depth + 1)

    walk(target, 0)
    if not matches:
        return {"status": "no_option"}
    if len(matches) > 1:
        return {"status": "ambiguous_option", "count": len(matches)}
    node, parent, index = matches[0]
    try:
        ai = node.get_action_iface()
        if ai:
            names = [Atspi.Action.get_action_name(ai, k) for k in range(Atspi.Action.get_n_actions(ai))]
            for wanted in ("select", "click", "press"):
                if wanted in names:
                    ok = bool(Atspi.Action.do_action(ai, names.index(wanted)))
                    return {"status": "invoked", "via": f"action:{wanted}", "do_action_returned": ok}
    except Exception:
        pass
    try:
        sel = parent.get_selection_iface()
        if sel:
            ok = bool(sel.select_child(index))
            return {"status": "invoked", "via": "selection", "do_action_returned": ok}
    except Exception:
        pass
    return {"status": "no_semantic_route"}


def element_at_action(app, offset_x, offset_y, x, y):
    """What the page has under a screen point, outermost to innermost (role + name), found with the same
    accessibility hit-test as hit_point. Used by the customer-control guard (C4): a click that would land on
    "Place order", a wallet button or a card field is refused before it is sent. Never acts."""
    docs = []

    def find(acc, depth=0):
        if depth > 20 or len(docs) > 12:
            return
        try:
            role = acc.get_role_name()
        except Exception:
            return
        if role in ("document web", "document frame"):
            docs.append(acc)
        try:
            for i in range(acc.get_child_count()):
                c = acc.get_child_at_index(i)
                if c is not None:
                    find(c, depth + 1)
        except Exception:
            pass

    find(app)
    doc = next((d for d in docs if is_page_document(d)), None)
    if doc is None:
        return {"chain": [], "status": "no_document"}
    wx, wy = int(x) - int(offset_x), int(y) - int(offset_y)
    chain, cur = [], doc
    for _ in range(60):
        try:
            comp = cur.get_component_iface()
            nxt = comp.get_accessible_at_point(wx, wy, Atspi.CoordType.WINDOW) if comp else None
        except Exception:
            nxt = None
        if nxt is None or obj_path(nxt) == obj_path(cur):
            break
        cur = nxt
        try:
            chain.append({"role": normalize_role(cur.get_role_name()), "name": (cur.get_name() or "")[:80]})
        except Exception:
            break
    return {"chain": chain[-8:], "status": "ok"}


_LANDMARK_ROLES = {"dialog", "alert", "form", "landmark", "article"}


def _direct_text_capable(acc):
    """A node that is ITSELF a usable text destination: SHOWING+ENABLED+
    EDITABLE AND exposes its OWN working Text interface (not merely an
    editable-looking role, and not a wrapper whose editable child holds the
    text). Returns (capable, char_count) — focus-recovery review point 2."""
    try:
        ss = acc.get_state_set()
        if not (ss.contains(Atspi.StateType.SHOWING) and ss.contains(Atspi.StateType.ENABLED)
                and ss.contains(Atspi.StateType.EDITABLE)):
            return (False, None)
        ti = acc.get_text_iface()
        if ti is None:
            return (False, None)
        n = Atspi.Text.get_character_count(ti)  # raises if no real text iface
        return (True, n)
    except Exception:
        return (False, None)


def _editable_text_node(acc):
    """SCROLL-INDEPENDENT variant of _direct_text_capable for the S0/S1 NEWNESS
    baseline (review v6): identical EXCEPT it does NOT require SHOWING. SHOWING
    tracks on-screen/scroll position, so a baseline that required it would omit a
    pre-existing field that happened to be scrolled off — and that field would
    then look "new" once the interaction scrolled it into view. The baseline must
    be a scroll-independent SUPERSET of the (SHOWING) recovery candidates, so any
    candidate that pre-existed is always found in it. ENABLED+EDITABLE+own Text
    interface only."""
    try:
        ss = acc.get_state_set()
        if not (ss.contains(Atspi.StateType.ENABLED) and ss.contains(Atspi.StateType.EDITABLE)):
            return False
        ti = acc.get_text_iface()
        if ti is None:
            return False
        Atspi.Text.get_character_count(ti)  # raises if no real text iface
        return True
    except Exception:
        return False


def _nearest_landmark(acc):
    cur = acc
    d = 0
    while cur is not None and d < 20:
        try:
            r = cur.get_role_name()
            if r in _LANDMARK_ROLES:
                return {"role": r, "name": (cur.get_name() or "")[:60]}
            cur = cur.get_parent()
        except Exception:
            return None
        d += 1
    return None


def _ancestor_roles(acc):
    chain = []
    cur = acc
    d = 0
    while cur is not None and d < 20:
        try:
            cur = cur.get_parent()
            if cur is None:
                break
            chain.append(cur.get_role_name())
        except Exception:
            break
        d += 1
    return chain


def _sig(acc, path, offset_x, offset_y):
    """Stable-ish signature (identity tolerant of small layout changes):
    path + ancestor roles + nearest landmark + name + role; bounds are
    EVIDENCE only (review #8)."""
    b = get_bounds(acc, offset_x, offset_y)
    cap, n = _direct_text_capable(acc)
    return {
        "path": path,
        "role": acc.get_role_name(),
        "name": (acc.get_name() or "")[:80],
        "landmark": _nearest_landmark(acc),
        "ancestors": _ancestor_roles(acc)[:8],
        "b": [b["x"], b["y"], b["w"], b["h"]] if b else None,
        "cx": b["cx"] if b else None,
        "cy": b["cy"] if b else None,
        "direct_text": cap,
        "direct_text_len": n,
        "in_doc": None,  # filled by the traversal (which tracks the document boundary)
    }


# SHARED budget contract (review v6): the S0/S1 baseline walk and the recovery
# traversal MUST use the SAME limits and DFS order, or a recovery candidate could
# be judged "new" against a baseline that was structurally incapable of observing
# it. Both cap stored editables at _EDIT_CAP and total visited nodes at
# _NODE_BUDGET, both DFS from root, and both report `truncated` when a limit is
# hit. A truncated baseline forces recovery to fail closed.
_NODE_BUDGET = 8000
_EDIT_CAP = 400


def _walk_text_editables(app):
    """Return (out, truncated, nodes). out = [(live_obj, signature)] for every
    DIRECT-TEXT-CAPABLE node, in DFS order, up to the shared budget. `truncated`
    is True if either limit was hit (the list is then INCOMPLETE)."""
    out = []
    state = {"nodes": 0, "trunc": False}

    def visit(acc, path, in_doc):
        if state["nodes"] >= _NODE_BUDGET:
            state["trunc"] = True
            return
        state["nodes"] += 1
        try:
            role = acc.get_role_name()
        except Exception:
            return
        in_doc = in_doc or role in ("document web", "document frame")
        if _editable_text_node(acc):  # scroll-independent baseline (review v6)
            if len(out) < _EDIT_CAP:
                s = _sig(acc, path, 0, 0)
                s["in_doc"] = in_doc
                out.append((acc, s))
            else:
                state["trunc"] = True
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                visit(c, f"{path}.{i}", in_doc)

    visit(app, "0", False)
    return out, state["trunc"], state["nodes"]


def list_text_editables_action(app):
    """Read-only: DIRECT-TEXT-CAPABLE nodes + signatures, with a COMPLETENESS
    signal. The caller captures S0 (pre-focus) and S1 (post-focus) with this and
    passes them (WITH `truncated`) to recover_focus. A truncated baseline can no
    longer observe every editable, so recovery must fail closed on it."""
    out, truncated, nodes = _walk_text_editables(app)
    return {"editables": [s for (_a, s) in out], "truncated": truncated, "nodes_visited": nodes}


def _overlaps(a, b):
    if not a or not b:
        return False
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return not (ax + aw < bx or bx + bw < ax or ay + ah < by or by + bh < ay)


def recover_focus_action(app, orig_name, orig_role, s0, s1, orig_landmark=None, orig_match_count=1,
                         s0_truncated=False, s1_truncated=False):
    """ATOMIC (ONE process, ONE fresh tree traversal, ONE live focus target):
    find the real DIRECT-TEXT editable for a wrapper/replacement search widget,
    focus it, and return fresh metadata plus a structured decision trace.
    Association-safe, direct-text-only, no pointer, no A/B identity race.

    ANCHOR: association is measured against the original widget. When the live
    original still exists we anchor on its live path+landmark. When it has been
    UNMOUNTED by the interaction (a true replacement widget — the live node is
    gone), we fall back to the TRUSTED PRE-FOCUS signature the caller captured
    at S0: orig_landmark (and orig_match_count). This is what lets a replacement
    that mounts ELSEWHERE and is left unfocused still be recovered.

    Refuses (ambiguous_original) when the original target name+role was already
    ambiguous PRE-FOCUS (orig_match_count > 1) OR is ambiguous live now — the
    duplicate-identity hazard (issue #5 class) — rather than guessing.

    Newness/transition are measured vs S0 (pre-focus) / S1 (post-focus)
    baselines. Browser-chrome direct-text nodes (in_doc=false, e.g. the omnibox)
    are collected into the evidence trace but can NEVER be eligible.

    (Dynamic wrapper/replacement input recovery; relates to issues #1/#2 — NOT
    the issue #4 coordinate-click-doesn't-focus defect, which is unrelated.)"""
    # Fail closed FIRST on a pre-focus duplicate original: if the caller already
    # matched >1 widget by this name+role BEFORE focus, we can't know which one
    # was activated — any anchor would be a guess. Focus nothing.
    if orig_match_count and orig_match_count > 1:
        return {"ambiguous_original": True, "orig_match_count": orig_match_count,
                "reason": "original target name+role matched multiple widgets pre-focus — refusing to guess which to recover from"}

    # BASELINE COMPLETENESS (review v6): S0/S1 come from the SAME budgeted walker
    # as this traversal. If either was truncated, it could not observe every
    # editable, so a PRE-EXISTING field beyond the cap would look "new" here.
    # Newness is then unprovable — fail closed before focusing anything.
    if s0_truncated or s1_truncated:
        return {"none": True, "truncated": True, "baseline_incomplete": True,
                "orig_gone": None,
                "reason": "the S0/S1 baseline was truncated (too many editables to enumerate completely) — newness cannot be proven, refusing to guess"}

    orig_norm = (orig_name or "").strip().lower()
    orig = {"acc": None, "path": None, "b": None, "landmark": None, "count": 0}
    editables = []  # {live, sig} — ALL direct-text nodes, in_doc tagged per-node
    landmarks = []  # {path, role, name} — every landmark node, for a PATH anchor
    # Traversal budget (review v4): the OLD code aborted the whole descent once
    # 80 editables were stored, which could MISS a duplicate original/landmark
    # after the 80th editable and defeat fail-closed duplicate detection. Now we
    # NEVER stop descending for the sake of the editable list — originals and
    # landmarks are always counted completely. We bound only total node visits
    # (cost) and stored candidates (memory) via the SHARED budget the baseline
    # walker uses; exceeding EITHER sets `trunc`, and a truncated traversal fails
    # CLOSED (we can't prove uniqueness), never guesses.
    state = {"nodes": 0, "trunc": False}

    # SINGLE traversal: locate the LIVE original widget (by exact name+role over
    # ALL SHOWING matches — path tracked here, NOT via broken object identity;
    # every match COUNTED so a live duplicate can be refused) AND collect every
    # direct-text-capable node (in-doc and chrome alike), together.
    def visit(acc, path, in_doc):
        if state["nodes"] >= _NODE_BUDGET:
            state["trunc"] = True
            return
        state["nodes"] += 1
        try:
            role = acc.get_role_name()
            name = acc.get_name() or ""
        except Exception:
            return
        in_doc = in_doc or role in ("document web", "document frame")
        if role == orig_role and name.strip().lower() == orig_norm:
            try:
                showing = acc.get_state_set().contains(Atspi.StateType.SHOWING)
            except Exception:
                showing = False
            if showing:
                orig["count"] += 1
                if orig["acc"] is None:  # keep the FIRST for path/landmark; count the rest
                    b = get_bounds(acc, 0, 0)
                    orig["acc"] = acc
                    orig["path"] = path
                    orig["b"] = [b["x"], b["y"], b["w"], b["h"]] if b else None
                    orig["landmark"] = _nearest_landmark(acc)
        if role in _LANDMARK_ROLES:
            # Landmark PATH is the unique structural anchor — {role,name} alone
            # can collide across two same-named regions/forms (review v3).
            landmarks.append({"path": path, "role": role, "name": (name or "").strip().lower()})
        cap, _n = _direct_text_capable(acc)
        if cap:
            if len(editables) < _EDIT_CAP:
                s = _sig(acc, path, 0, 0)
                s["in_doc"] = in_doc
                editables.append({"live": acc, "sig": s})
            else:
                state["trunc"] = True  # more candidates than we can safely reason about
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                c = acc.get_child_at_index(i)
            except Exception:
                continue
            if c is not None:
                visit(c, f"{path}.{i}", in_doc)

    visit(app, "0", False)
    if state["trunc"]:
        # Traversal hit the node/candidate budget — duplicate-original and
        # duplicate-landmark uniqueness can no longer be PROVEN, so recovery
        # could associate unsafely. Fail closed. (review v4 #3)
        return {"none": True, "truncated": True, "orig_gone": orig["acc"] is None,
                "nodes_visited": state["nodes"],
                "reason": "accessibility tree too large to prove association safety within budget — refusing to guess"}
    if orig["count"] > 1:
        # Live duplicate original (issue #5 class): cannot know which instance.
        return {"ambiguous_original": True, "orig_match_count": orig["count"],
                "reason": "original target name+role matches multiple SHOWING widgets live — refusing to guess which to recover from"}

    def is_desc_of(base, sp):
        return bool(base and sp and base != "0" and sp.startswith(base + "."))

    # ANCHOR selection — a UNIQUE STRUCTURAL landmark PATH, never a generic
    # {role,name} (which collides across two same-named regions; review v3).
    #   LIVE original: anchor on the original's own path (descendant-of-orig) AND
    #     on the NEAREST landmark ancestor of that path (the deepest landmark
    #     whose path is a prefix of the original's) — both are unique/structural.
    #   GONE original: the live path is meaningless, so anchor on the PRE-FOCUS
    #     landmark {role,name}, resolved to a path — but ONLY if that landmark is
    #     UNIQUE in the current tree. If 0 match -> no anchor; if >1 -> refuse
    #     (fail closed) rather than associate across same-named landmarks.
    if orig["acc"] is not None:
        orig_gone = False
        anchor_path = orig["path"]
        anchor_lm_path = None
        for lm in landmarks:
            if (lm["path"] == orig["path"] or is_desc_of(lm["path"], orig["path"])) \
               and (anchor_lm_path is None or len(lm["path"]) > len(anchor_lm_path)):
                anchor_lm_path = lm["path"]
    else:
        orig_gone = True
        anchor_path = None
        want = ((orig_landmark or {}).get("role"), ((orig_landmark or {}).get("name") or "").strip().lower())
        matched = [lm["path"] for lm in landmarks
                   if orig_landmark and lm["role"] == want[0] and lm["name"] == want[1]]
        if not want[0] or len(matched) == 0:
            return {"none": True, "orig_gone": True,
                    "reason": "original target is gone and its pre-focus landmark is not present to anchor association"}
        if len(matched) > 1:
            return {"none": True, "orig_gone": True, "ambiguous_landmark": True, "anchor_landmark_count": len(matched),
                    "reason": "original target is gone and its landmark name is duplicated — refusing to associate across same-named landmarks"}
        anchor_lm_path = matched[0]

    # "appeared" == present now but NOT before we touched the widget (S0 is the
    # PRE-focus baseline). A replacement input mounts during focusin, so it is
    # already in S1 — newness MUST be measured vs S0 only, never vs S0∪S1, or a
    # replacement never counts as new. (recovery review, case2.)
    #
    # PATH-INDEPENDENT newness (review v4 #1): AT-SPI paths are child-index paths
    # that SHIFT when the unmounting trigger changes a sibling's index — so a
    # path-based key would falsely mark a pre-existing field "new" once its index
    # moved, and (being focused + in-landmark) it could win. Identity is instead
    # a SEMANTIC fingerprint: role + accessible name + nearest-landmark {role,name}
    # + ancestor-role chain — none of which a sibling removal changes. A candidate
    # whose fingerprint matches ANY S0 editable is pre-existing (appeared=False),
    # even if its path moved. If a genuine replacement is semantically
    # indistinguishable from an S0 field, it stays appeared=False and we safely
    # fail closed rather than risk typing into the wrong field.
    def fp(s):
        lm = s.get("landmark") or {}
        return (s.get("role"), s.get("name"), lm.get("role"), lm.get("name"), tuple(s.get("ancestors") or []))
    s0_fps = set(fp(s) for s in (s0 or []))
    s1_fps = set(fp(s) for s in (s1 or []))

    # Enrich every direct-text node with the INDEPENDENT association signals. We
    # deliberately do NOT blend them into one score: a flat ranking produced
    # cross-signal ties, and geometric containment (center-in-bounds) was
    # non-deterministic and is gone entirely. Decision is by strict stages below.
    recs = []
    for e in editables:
        s = e["sig"]
        f = fp(s)
        appeared = f not in s0_fps
        try:
            focused = e["live"].get_state_set().contains(Atspi.StateType.FOCUSED)
        except Exception:
            focused = False
        descendant = is_desc_of(anchor_path, s.get("path"))
        in_lm = is_desc_of(anchor_lm_path, s.get("path"))
        in_doc = bool(s.get("in_doc"))
        # GONE-original safety (review v3): a gone anchor can only ever legitimize
        # a NEWLY-APPEARED input in the (unique) landmark. A pre-existing field —
        # even a focused one in that landmark — was NOT mounted by this
        # interaction and must NEVER be grabbed. Live originals keep the looser
        # gate (a pre-existing descendant like an inner <input> is the real target).
        eligible = in_doc and (descendant or in_lm) and (appeared or not orig_gone)
        recs.append({
            "live": e["live"], "sig": s, "focused": focused, "appeared": appeared,
            "descendant": descendant, "same_lm": in_lm, "in_doc": in_doc, "eligible": eligible,
            "transition": ("s0_to_s1" if f in s1_fps else "s1_to_s2") if appeared else None,
        })

    # Structured evidence (issue #5-review): per-candidate signals for the whole
    # direct-text set — including chrome nodes (in_doc=false, eligible=false) so
    # the caller can PROVE they were present but excluded. Only control
    # identifiers (accessible name/role/path) and boolean signals — no page text,
    # no field VALUES.
    def ev(r):
        s = r["sig"]
        return {"name": s.get("name"), "role": s.get("role"), "path": s.get("path"),
                "in_doc": r["in_doc"], "direct_text": s.get("direct_text"),
                "descendant": r["descendant"], "same_landmark": r["same_lm"],
                "focused": r["focused"], "appeared": r["appeared"],
                "transition": r["transition"], "eligible": r["eligible"]}
    evidence = [ev(r) for r in recs]
    excluded_chrome = [r["sig"]["name"] for r in recs if not r["in_doc"]]

    # Eligibility GATE: only IN-DOCUMENT editables STRUCTURALLY tied to the
    # widget we activated may ever be chosen. This keeps an unrelated field —
    # even a focused one (an autofocused newsletter box), and any chrome field
    # (the omnibox) — from being grabbed.
    pool = [r for r in recs if r["eligible"]]
    if not pool:
        return {"none": True, "reason": "no associated in-document direct-text candidate",
                "orig_gone": orig_gone, "evidence": evidence, "excluded_chrome": excluded_chrome}

    # Stage ladder — each stage is ONE strong signal, evaluated over the gated
    # pool. Exactly one candidate at a stage wins; more than one at that
    # strength is a genuine ambiguity -> safe-stop; zero falls through.
    #   A: focused        — the browser moved real focus into the input
    #   B: descendant     — the real input lives inside the activated widget
    #   C: appeared+shared-landmark — a replacement mounted beside the trigger
    stages = (
        ("focused", [r for r in pool if r["focused"]]),
        ("descendant", [r for r in pool if r["descendant"]]),
        ("appeared_in_landmark", [r for r in pool if r["appeared"] and r["same_lm"]]),
    )
    chosen = None
    stage_name = None
    for name, group in stages:
        if len(group) == 1:
            chosen, stage_name = group[0], name
            break
        if len(group) > 1:
            return {"ambiguous": True, "stage": name,
                    "candidates": [r["sig"]["name"] for r in group],
                    "orig_gone": orig_gone, "evidence": evidence, "excluded_chrome": excluded_chrome}
    if chosen is None:
        return {"none": True, "reason": "associated editables exist but none matched a decisive stage",
                "orig_gone": orig_gone, "evidence": evidence, "excluded_chrome": excluded_chrome}

    # Focus THIS live object in the same process (no pointer, no A/B identity race).
    grabbed = False
    try:
        grabbed = bool(chosen["live"].get_component_iface().grab_focus())
    except Exception:
        grabbed = False
    time.sleep(0.15)
    try:
        focused_now = chosen["live"].get_state_set().contains(Atspi.StateType.FOCUSED)
    except Exception:
        focused_now = False
    return {
        "recovered": True, "grab_focus_called": grabbed, "focused": focused_now,
        "chosen": chosen["sig"], "stage": stage_name, "transition": chosen["transition"],
        "orig_gone": orig_gone, "candidate_count": len(pool),
        "evidence": evidence, "excluded_chrome": excluded_chrome,
    }


def main():
    cmd = json.loads(sys.stdin.read())
    pid = cmd["pid"]
    offset_x = cmd.get("offset_x", 0)
    offset_y = cmd.get("offset_y", 0)
    include_text = cmd.get("include_text", False)
    text_filter = cmd.get("text_filter")
    state_filter = cmd.get("state_filter")
    role_filter = normalize_role(cmd.get("role_filter"))
    limit = cmd.get("limit", 150)
    want_info = cmd.get("page_info", False)
    action = cmd.get("action", "snapshot")
    obj_path_arg = cmd.get("obj_path")  # ref identity (issue #5): D-Bus object path
    doc_gen_arg = cmd.get("doc_gen")    # ref identity: document generation token

    # The stats dict is passed ONLY so that a MISS can explain itself; it is
    # filled during the same single pass and is dropped on the success path.
    lookup_stats = {}
    app = find_app_by_pid(pid, lookup_stats)
    if app is None:
        lookup_stats["target_pid_alive"] = target_pid_alive(pid)
        print(json.dumps({
            "error": f"no AT-SPI application found for pid {pid}",
            "app_lookup": lookup_stats,
            "elements": [],
        }))
        return

    if action == "scroll_to":
        print(json.dumps(scroll_to_action(app, offset_x, offset_y, text_filter, role_filter, obj_path_arg, doc_gen_arg)))
        return

    if action == "focus":
        print(json.dumps(focus_action(app, offset_x, offset_y, text_filter, role_filter, obj_path_arg, doc_gen_arg)))
        return

    if action == "get_selected":
        print(json.dumps(get_selected_action(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)))
        return

    if action == "read_text":
        print(json.dumps(read_text_action(app, text_filter, role_filter)))
        return

    if action == "autofill_popup":
        print(json.dumps(autofill_popup_action(app)))
        return

    if action == "field_checks":
        print(json.dumps(field_checks_action(app, cmd.get("checks"))))
        return

    if action == "verify_text":
        print(json.dumps(verify_text_action(app, cmd.get("value"))))
        return

    if action == "navigation_focus":
        print(json.dumps(navigation_focus_action(app)))
        return

    if action == "focus_placeholder_document":
        # ONLY for our own headless instances (lead guardrail): never raise or steal focus on the real desktop
        if not cmd.get("headless"):
            print(json.dumps({"placeholder": None, "grabbed": False, "why": "not a headless instance"}))
            return
        print(json.dumps(focus_placeholder_document_action(app, cmd.get("skip_title"))))
        return

    if action == "wait_settled":
        print(json.dumps(wait_settled_action(app, cmd.get("pid"), int(cmd.get("quiet_ms") or 800), int(cmd.get("max_ms") or 15000), cmd.get("url_contains"), cmd.get("title_contains"), cmd.get("not_doc"), bool(cmd.get("placeholder_focus_ok")))))
        return

    if action == "document_text":
        print(json.dumps(document_text_action(app, int(cmd.get("max_chars") or 4000000), reverse=bool(cmd.get("reverse")))))
        return

    if action == "page_document_uri":
        print(json.dumps(page_document_uri_action(app)))
        return

    if action == "get_focused":
        print(json.dumps(get_focused_action(app)))
        return

    if action == "list_actions":
        print(json.dumps(list_actions_action(app, text_filter, role_filter)))
        return

    if action == "choose_option":
        print(json.dumps(choose_option_action(app, text_filter, role_filter, cmd.get("option_text"), obj_path_arg, doc_gen_arg)))
        return

    if action == "element_at":
        print(json.dumps(element_at_action(app, offset_x, offset_y, cmd.get("x", 0), cmd.get("y", 0))))
        return

    if action == "hit_point":
        print(json.dumps(hit_point_action(app, offset_x, offset_y, text_filter, role_filter, obj_path_arg, doc_gen_arg)))
        return

    if action == "do_action":
        print(json.dumps(do_action_action(app, text_filter, role_filter, cmd.get("index"), obj_path_arg, doc_gen_arg)))
        return

    if action == "list_images":
        print(json.dumps(list_images_action(app, offset_x, offset_y, int(cmd.get("cap", 64)), int(cmd.get("min_px", 0)))))
        return

    if action == "list_editables":
        print(json.dumps(list_editables_action(app, offset_x, offset_y)))
        return

    if action == "focus_editable_at":
        print(json.dumps(focus_editable_at_action(app, offset_x, offset_y, cmd.get("x", 0), cmd.get("y", 0))))
        return

    if action == "list_text_editables":
        # TEST-ONLY fault injection (gated, review v7): simulate a failed/malformed
        # baseline capture so the fail-CLOSED path can be exercised end-to-end.
        fault = os.environ.get("COMPUTER_USE_TEST_FAULT_LTE")
        if fault == "error":
            print(json.dumps({"error": "injected baseline fault"}))
            return
        if fault == "malformed":
            print(json.dumps({"editables": "not-an-array"}))
            return
        print(json.dumps(list_text_editables_action(app)))
        return

    if action == "recover_focus":
        print(json.dumps(recover_focus_action(app, text_filter, role_filter, cmd.get("s0") or [], cmd.get("s1") or [],
                                               cmd.get("orig_landmark"), cmd.get("orig_match_count", 1),
                                               bool(cmd.get("s0_truncated")), bool(cmd.get("s1_truncated")))))
        return

    if action == "semantic_activate":
        print(json.dumps(semantic_activate_action(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)))
        return

    if action == "dialog_escape_context":
        print(json.dumps(dialog_escape_context_action(app, obj_path_arg, doc_gen_arg)))
        return

    if action == "dialog_survey":
        print(json.dumps(dialog_survey_action(app)))
        return

    if action == "dialog_close_controls":
        print(json.dumps(dialog_close_controls_action(app, obj_path_arg, doc_gen_arg)))
        return

    if action == "dismiss_dialog":
        print(json.dumps(dismiss_dialog_action(
            app, obj_path_arg, doc_gen_arg, role_filter,
            cmd.get("expected_dialog_obj_path"), cmd.get("expected_dialog_doc_gen"))))
        return

    if action == "semantic_toggle":
        print(json.dumps(semantic_toggle_action(app, text_filter, role_filter, obj_path_arg, doc_gen_arg, bool(cmd.get("keep_pressed")))))
        return

    if action == "semantic_set_checkable":
        print(json.dumps(semantic_set_checkable_action(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)))
        return

    if action == "element_states":
        print(json.dumps(element_states_action(app, text_filter, role_filter, obj_path_arg, doc_gen_arg)))
        return

    # ONE process for a transition probe (benchmark 2026-09-25: a click's before/after probes were three bridge
    # processes each — a dialog snapshot, the focus and the target's states — and a click took ~5 s). The same
    # three functions, called in the same order, so the evidence is identical; each part fails on its own.
    if action == "capture_signals":
        target = cmd.get("target") or {}
        out = {}
        try:
            fast = count_dialogs_fast(app, offset_x, offset_y)
            if fast is not None:
                out["snapshot"] = {"elements": [], "dialog_count": fast, "page": get_page_info(app)}
            else:
                out["snapshot"] = {"elements": collect(app, offset_x, offset_y, False, None, normalize_role("dialog"), 50, None, False), "page": get_page_info(app)}
        except Exception as e:
            out["snapshot"] = {"error": str(e)}
        try:
            out["focused"] = get_focused_action(app)
        except Exception as e:
            out["focused"] = {"error": str(e)}
        try:
            out["states"] = element_states_action(app, target.get("text_filter"), normalize_role(target.get("role_filter")), target.get("obj_path"), target.get("doc_gen"))
        except Exception as e:
            out["states"] = {"error": str(e)}
        print(json.dumps(out))
        return

    start_path = cmd.get("start_path")
    anchor = {"found": False}
    page_info = get_page_info(app) if want_info else None
    out = {"elements": collect(app, offset_x, offset_y, include_text, text_filter, role_filter, limit, state_filter, bool(cmd.get("dialog_contents")), bool(cmd.get("loose_roles")), start_path, anchor, page_url_known=(page_info.get("url") or "") if page_info is not None else None)}
    if start_path:
        out["anchor_found"] = anchor["found"]
    if want_info:
        out["page"] = page_info
    print(json.dumps(out))


if __name__ == "__main__":
    # BRIDGE_PROFILE=<file>: profile this call (cProfile) into <file> — for measuring where a read's time goes. Off by default.
    if os.environ.get("BRIDGE_PROFILE"):
        import cProfile
        cProfile.run("main()", f"{os.environ['BRIDGE_PROFILE']}.{os.getpid()}")
    else:
        main()
