# The macOS accessibility side of the "ax" backend: one long-lived process per browser, JSON lines on stdin/stdout.
#
# It reads a REAL Chrome window (the person's kind of browser: own persistent profile, GPU, no DevTools port) through
# the macOS accessibility API, the same tree Chromium gives AT-SPI on Linux, and acts on it without the mouse:
# AXPress for clicks, AXFocused + key events posted to Chrome's process (CGEventPostToPid) for typing and keys,
# AXScrollToVisible for scrolling to an element, the omnibox's AXValue + Return for opening a URL. The person's
# own pointer and keyboard focus are never moved. An AXObserver counts the page's change notifications: that is
# the mutation clock the Node side uses for transitions and "settled".
#
#   request  {"id": 1, "cmd": "snapshot", "include_text": false}
#   response {"id": 1, "ok": true, "result": {...}}   or   {"id": 1, "ok": false, "error": "..."}
#
# Needs the Accessibility permission for this python (System Settings > Privacy & Security > Accessibility).
import json, sys, threading, queue, time
import objc, Quartz
from ApplicationServices import (
    AXUIElementCreateApplication, AXUIElementCopyAttributeValue, AXUIElementCopyMultipleAttributeValues,
    AXUIElementSetAttributeValue, AXUIElementPerformAction, AXUIElementCopyActionNames, AXValueGetValue, AXValueCreate, AXValueGetType, kAXValueAXErrorType,
    AXObserverCreate, AXObserverAddNotification, AXUIElementCopyElementAtPosition, AXUIElementSetMessagingTimeout, AXObserverGetRunLoopSource, AXIsProcessTrusted,
    kAXErrorSuccess, kAXValueCGPointType, kAXValueCGSizeType, kAXValueCFRangeType)
from CoreFoundation import CFRunLoopGetCurrent, CFRunLoopAddSource, kCFRunLoopDefaultMode, CFRunLoopRunInMode

PID = int(sys.argv[1])
APP = AXUIElementCreateApplication(PID)
AXUIElementSetAttributeValue(APP, "AXManualAccessibility", True)  # Chrome builds its web tree for AX clients
# a busy Chrome (a heavy page loading) can hold ONE accessibility call for the system default (~6 s): cap each call
AX_TIMEOUT = 1.5
AXUIElementSetMessagingTimeout(APP, AX_TIMEOUT)

# ---- the page's change clock ----------------------------------------------------------------------------------------
CLOCK = {"n": 0, "at": time.time(), "load": 0, "dialogs": 0}
@objc.callbackFor(AXObserverCreate)
def _on_change(observer, element, notification, refcon):
    CLOCK["n"] += 1; CLOCK["at"] = time.time()
    if notification == "AXLoadComplete": CLOCK["load"] += 1
OBS = None
def start_observer():
    # on the application handle that sees the windows (made after Chrome finished starting)
    global OBS
    err, OBS = AXObserverCreate(PID, _on_change, None)
    if err != kAXErrorSuccess: return
    for n in ["AXFocusedUIElementChanged", "AXValueChanged", "AXLayoutComplete", "AXLoadComplete", "AXLiveRegionChanged",
              "AXSelectedChildrenChanged", "AXExpandedChanged", "AXRowCountChanged", "AXUIElementDestroyed", "AXCreated",
              "AXMenuOpened", "AXMenuClosed", "AXTitleChanged", "AXSelectedTextChanged", "AXElementBusyChanged"]:
        AXObserverAddNotification(OBS, APP, n, None)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(OBS), kCFRunLoopDefaultMode)

def attr(e, a):
    if e is None: return None
    err, v = AXUIElementCopyAttributeValue(e, a, None)
    return v if err == kAXErrorSuccess else None

def point(v):
    if v is None: return None
    ok, p = AXValueGetValue(v, kAXValueCGPointType, None)
    return (p.x, p.y) if ok else None
def size(v):
    if v is None: return None
    ok, s = AXValueGetValue(v, kAXValueCGSizeType, None)
    return (s.width, s.height) if ok else None

# ---- window, web area, omnibox --------------------------------------------------------------------------------------
def window():
    # the browser window: a standard window that holds a web page or the toolbar. Not whatever has focus: a permission
    # bubble ("www.homedepot.com wants to: Know your location") is a window of its own and takes focus.
    global APP
    def pick():
        cands = []
        f = attr(APP, "AXFocusedWindow")
        if f is not None: cands.append(f)
        cands += attr(APP, "AXWindows") or []
        for w in cands:
            if attr(w, "AXSubrole") == "AXStandardWindow" and "wants to" not in text_of(attr(w, "AXTitle")):
                return w
        return None
    w = pick()
    if w is None and not (attr(APP, "AXWindows") or []):
        # an application handle made while Chrome was still starting never sees its windows: make a new one
        APP = AXUIElementCreateApplication(PID)
        AXUIElementSetAttributeValue(APP, "AXManualAccessibility", True)
        AXUIElementSetMessagingTimeout(APP, AX_TIMEOUT)
        w = pick()
    return w

def first(e, pred, depth=0, max_depth=40):
    if e is None or depth > max_depth: return None
    if pred(e): return e
    for c in attr(e, "AXChildren") or []:
        r = first(c, pred, depth + 1, max_depth)
        if r is not None: return r
    return None

def web_area():
    return first(window(), lambda e: attr(e, "AXRole") == "AXWebArea")

_OMNI = {"el": None}
def omnibox():
    # the toolbar's address field: cached while it lives, and the search never descends into web content (a depth-first
    # walk that met the page first walked the WHOLE page, no budget: 20 s reads on big pages)
    e = _OMNI["el"]
    if e is not None and attr(e, "AXRole") == "AXTextField": return e
    def find(x, d=0):
        if x is None or d > 25: return None
        r = attr(x, "AXRole")
        if r == "AXWebArea": return None
        if r == "AXTextField" and "address" in str(attr(x, "AXDescription") or "").lower(): return x
        for c in attr(x, "AXChildren") or []:
            hit = find(c, d + 1)
            if hit is not None: return hit
        return None
    _OMNI["el"] = find(window())
    return _OMNI["el"]

# ---- refs: one per element, stable while the element lives (element handles compare by identity) ------------------
REFS, ELEMS, NEXT = {}, {}, [1]
def ref_for(e):
    r = REFS.get(e)
    if r is None:
        r = f"e{NEXT[0]}"; NEXT[0] += 1; REFS[e] = r; ELEMS[r] = e
    return r
def elem(ref):
    e = ELEMS.get(ref)
    if e is None: raise LookupError(f'ref "{ref}" not found (read_page again: refs come from a read of this page)')
    return e

# ---- snapshot -------------------------------------------------------------------------------------------------------
import re as _re
CMP_HOSTS = _re.compile(r"sourcepoint|privacy-mgmt|consent|onetrust|cookielaw|cookiebot|trustarc|truste|didomi|usercentrics|quantcast|cmp\.|clarip|termly|iubenda", _re.I)
# macOS accessibility roles -> the AT-SPI names observation.mjs maps
ROLE = {"AXButton": "push button", "AXLink": "link", "AXTextField": "entry", "AXTextArea": "entry", "AXSearchField": "entry",
        "AXComboBox": "combo box", "AXPopUpButton": "combo box", "AXCheckBox": "check box", "AXRadioButton": "radio button",
        "AXMenuItem": "menu item", "AXMenuButton": "push button", "AXSlider": "slider", "AXIncrementor": "spin button",
        "AXHeading": "heading", "AXImage": "image", "AXStaticText": "static", "AXDisclosureTriangle": "push button"}
SUBROLE = {"AXSecureTextField": "password text", "AXToggle": "toggle button", "AXSwitch": "toggle button", "AXTabButton": "page tab",
           "AXApplicationDialog": "dialog", "AXApplicationAlertDialog": "dialog"}
LANDMARK = {"AXLandmarkBanner": "banner", "AXLandmarkNavigation": "navigation", "AXLandmarkSearch": "search", "AXLandmarkMain": "main",
            "AXLandmarkContentInfo": "contentinfo", "AXLandmarkComplementary": "complementary", "AXLandmarkForm": "form", "AXLandmarkRegion": "region"}
ACTIONABLE = {"push button", "toggle button", "link", "entry", "password text", "combo box", "check box", "radio button", "menu item", "page tab", "slider", "spin button"}
NAMES = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXChildren", "AXPosition", "AXSize", "AXEnabled",
         "AXFocused", "AXExpanded", "AXSelected", "AXURL", "AXPlaceholderValue", "AXRoleDescription"]

def text_of(v):
    if v is None: return ""
    if isinstance(v, (str, int, float, bool)): return str(v)
    try: return str(v)
    except Exception: return ""

def snapshot(include_text=False):
    web = web_area()
    omni = omnibox()
    omni_el = [{"ref": ref_for(omni), "role": "entry", "name": "Address and search bar", "in_doc": False,
                "text_value": text_of(attr(omni, "AXValue")), "cy": 0, "states": []}] if omni is not None else []
    # a blank tab has no web area yet: the address bar is all there is (and all a planner needs to open a page)
    if web is None: return {"page": page_info(), "elements": omni_el, "viewport": {"top": 0, "bottom": 0, "width": 0}}
    origin = point(attr(web, "AXPosition")) or (0, 0)
    vw, vh = size(attr(web, "AXSize")) or (0, 0)
    host = (text_of(attr(web, "AXURL")).split("/") + ["", "", ""])[2]
    out = []
    below = [0]  # the lowest y seen so far: where an element without a position is placed (after it, in page order)
    # TIME BUDGET (2026-11-25): a giant table page (Basketball Reference) took 18 s to walk. Past the budget the walk
    # stops and returns what it has, in document order (header, search, top of the page first). Same rule as the Linux
    # bridge's COMPUTER_USE_READ_BUDGET_S.
    import os as _os
    budget = float(_os.environ.get("COMPUTER_USE_READ_BUDGET_S", "4") or 0)
    deadline = time.time() + budget if budget > 0 else None
    over = [False]
    def walk(e, region, in_dialog, in_control, depth, in_listbox=False):
        if depth > 120 or over[0]: return
        if deadline is not None and time.time() > deadline:
            over[0] = True; sys.stderr.write(f"[axhelper] read stopped at its {budget:g} s budget after {len(out)} elements\n"); return
        err, v = AXUIElementCopyMultipleAttributeValues(e, NAMES, 0, None)
        if err != kAXErrorSuccess or not v: return
        role_ax, sub = v[0], v[1]
        def g(i):
            x = v[i]
            if x is None or type(x).__name__ == "NSNull": return None
            # a missing attribute comes back as an AXValue holding an error, not as None
            if "AXValue" in type(x).__name__:
                try:
                    if AXValueGetType(x) == kAXValueAXErrorType: return None
                except Exception: pass
            return x
        # nested web areas are frames: same-site frames are part of the page, ad frames (other hosts) are not
        if role_ax == "AXWebArea" and e != web:
            fh = (text_of(g(12)).split("/") + ["", "", ""])[2]
            # other-site frames are ads, EXCEPT the consent managers whose banner IS a frame (Formula 1's Sourcepoint
            # "SP Consent Message" showed no buttons at all): those are part of what a person has to deal with
            if fh and host and fh != host and not CMP_HOSTS.search(fh): return
        role = SUBROLE.get(sub) or ROLE.get(role_ax)
        # a custom listbox (aria-haspopup=listbox popovers: Newegg's sort) lists its choices as bare text: those ARE options
        if in_listbox and role_ax == "AXStaticText": role = "menu item"
        this_listbox = role_ax == "AXList" and str(g(14) or "") == "list box"
        if sub in LANDMARK: region = region or LANDMARK[sub]
        if role == "dialog": in_dialog = True
        kids = g(5)
        # Chrome may refuse AXChildren INSIDE a batched read for some containers (an error value instead of the list):
        # that pruned whole subtrees (filters, later results). Ask for the children on their own when it does.
        if kids is None or not isinstance(kids, (list, tuple)) and not hasattr(kids, "__len__"):
            kids = attr(e, "AXChildren")
        keep = role is not None
        if role in ("static",) and (not include_text or in_control): keep = False
        if keep:
            name = text_of(g(2)) or text_of(g(3))
            if role == "static" or role_ax == "AXStaticText": name = text_of(g(4))
            if not name and role in ("link", "push button", "heading", "menu item", "page tab"):
                # Chrome leaves many link/button titles empty and puts the text in children
                parts = []
                def gather(c, d=0):
                    if d > 6 or len(parts) > 8 or over[0]: return
                    for k in attr(c, "AXChildren") or []:
                        if attr(k, "AXRole") == "AXStaticText": parts.append(text_of(attr(k, "AXValue")))
                        else: gather(k, d + 1)
                gather(e)
                name = " ".join(p for p in parts if p).strip()
            # an option of a native <select> carries its text in AXValue (or nowhere while the menu is closed): pilot c0,
            # 793 of 801 menu items on the stored Mac pages read menuitem "" (the planner could not see one option)
            if not name and role == "menu item": name = text_of(g(4))
            name = " ".join(name.split())
            # still nameless: the closed dropdown's own line already shows its value; an empty option line says nothing
            nameless_option = not name and role == "menu item"
            pos, sz = point(g(6)), size(g(7))
            # Chrome gives an element BELOW THE FOLD no position at all: it is still on the page (acting on it scrolls it
            # into view). Dropping those left only the first screen — 86 of 639 controls on a Newegg results page, no
            # filters, no later results. Place it after the last positioned element, below the viewport, in page order.
            # (Chrome reports them either with no position or with a ZERO size; display:none nodes are not in the tree)
            skip = False
            if pos and (not sz or sz[0] <= 1 or sz[1] <= 1):
                # no size: below (or above) the fold it is a real element not laid out yet -> keep where it is; INSIDE the
                # viewport it is collapsed (Academy's closed "Big Fun Deals" drawer, 1 px wide: Colibrí took it for an open
                # dialog and saw nothing else) -> not on the page for a person
                # Chrome PINS an off-screen element to the viewport's top or bottom edge with zero height (Newegg: y = 813
                # = vh, h 0); the drawer is 1 px wide but full height, mid-viewport
                # Clipped items in a scrolling list (Academy's brand list past "ASICS") are pinned the same way to the
                # LIST's edge, mid-viewport: zero HEIGHT = off-screen somewhere -> keep; zero WIDTH = collapsed -> drop
                ry = pos[1] - origin[1]
                collapsed = sz and sz[0] <= 1 and sz[1] > 1
                if vh and collapsed and 0 <= ry <= vh: skip = True
                sz = (1, 1)
            if not pos:
                below[0] = max(below[0], vh) + 24             # no position at all: after the last one, below the fold
                pos, sz = (origin[0], origin[1] + below[0]), (1, 1)
            elif pos[1] - origin[1] > below[0]:
                below[0] = pos[1] - origin[1]
            if not skip and not nameless_option and sz[0] > 0 and sz[1] > 0 and (role != "static" or name):
                x, y = pos[0] - origin[0], pos[1] - origin[1]
                states = []
                val = g(4)
                if role in ("check box", "radio button", "toggle button") and val in (1, 2, True): states.append("checked" if role != "toggle button" else "pressed")
                if g(11) is True: states.append("selected")
                if g(10) is True: states.append("expanded")
                if g(8) is False: states.append("disabled")
                if g(9) is True: states.append("focused")
                el = {"ref": ref_for(e), "role": role, "name": name, "states": states, "cy": y + sz[1] / 2, "cx": x + sz[0] / 2, "w": sz[0], "h": sz[1]}
                if region: el["region"] = region
                if in_dialog: el["in_dialog"] = True
                if role == "dialog": el["dialog_root"] = True
                if role in ("entry", "password text"):
                    el["text_value"] = "" if role == "password text" else text_of(val)
                    ph = text_of(g(13))
                    if not el["name"] and ph: el["name"] = ph
                elif role in ("combo box", "slider", "spin button") and val not in (None, ""): el["value"] = text_of(val)
                if role_ax == "AXPopUpButton": el["native_select"] = True
                if role == "link" and g(12) is not None: el["href"] = text_of(g(12))
                out.append(el)
        child_in_control = in_control or (role in ACTIONABLE) or role == "heading"
        if kids:
            for c in kids: walk(c, region, in_dialog, child_in_control and not this_listbox, depth + 1, this_listbox or (in_listbox and role_ax == "AXGroup"))
    walk(web, None, False, False, 0)
    elements = omni_el + out
    return {"page": page_info(web), "elements": elements, "viewport": {"top": 0, "bottom": vh, "width": vw}}

def page_info(web=None):
    web = web if web is not None else web_area()
    if web is None: return {"url": "", "title": "", "busy": False, "clock": CLOCK["n"], "quiet_ms": int((time.time() - CLOCK["at"]) * 1000), "loads": CLOCK["load"]}
    loaded = attr(web, "AXLoaded")
    prog = attr(web, "AXLoadingProgress")
    return {"url": text_of(attr(web, "AXURL")), "title": text_of(attr(web, "AXTitle")),
            "busy": (loaded is False) or (prog is not None and float(prog) < 1.0),
            "clock": CLOCK["n"], "quiet_ms": int((time.time() - CLOCK["at"]) * 1000), "loads": CLOCK["load"]}

def page_text(max_chars=4000000, budget_s=3.0):
    web = web_area(); parts = []; n = [0]
    deadline = time.time() + budget_s
    def walk(e, d=0):
        if d > 120 or n[0] > max_chars or time.time() > deadline: return
        err, v = AXUIElementCopyMultipleAttributeValues(e, ["AXRole", "AXValue", "AXChildren", "AXURL"], 0, None)
        if err != kAXErrorSuccess or not v: return
        if v[0] == "AXWebArea" and e != web:
            return
        if v[0] == "AXStaticText" and v[1]:
            s = text_of(v[1]); parts.append(s); n[0] += len(s)
        for c in v[2] or []: walk(c, d + 1)
    if web is not None: walk(web)
    return "\n".join(parts)[:max_chars]

# ---- input to Chrome's process only ---------------------------------------------------------------------------------
KEYCODE = {"Return": 36, "Enter": 36, "KP_Enter": 76, "Tab": 48, "Escape": 53, "BackSpace": 51, "Backspace": 51, "Delete": 117,
           "Left": 123, "Right": 124, "Down": 125, "Up": 126, "Page_Down": 121, "Next": 121, "PageDown": 121, "Page_Up": 116,
           "Prior": 116, "PageUp": 116, "Home": 115, "End": 119, "space": 49}
LETTER = {"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
          "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46}
MODS = {"ctrl": Quartz.kCGEventFlagMaskControl, "shift": Quartz.kCGEventFlagMaskShift, "alt": Quartz.kCGEventFlagMaskAlternate,
        "meta": Quartz.kCGEventFlagMaskCommand, "logo": Quartz.kCGEventFlagMaskCommand, "cmd": Quartz.kCGEventFlagMaskCommand}

def post_key(code, flags=0, char=None):
    for down in (True, False):
        ev = Quartz.CGEventCreateKeyboardEvent(None, code, down)
        if char is not None: Quartz.CGEventKeyboardSetUnicodeString(ev, len(char), char)
        Quartz.CGEventSetFlags(ev, flags)
        Quartz.CGEventPostToPid(PID, ev)
        time.sleep(0.004)

def key(name, modifiers=()):
    flags = 0
    for m in modifiers: flags |= MODS.get(m, 0)
    if name in KEYCODE: post_key(KEYCODE[name], flags); return True
    if len(name) == 1:
        low = name.lower()
        if flags and low in LETTER: post_key(LETTER[low], flags); return True
        post_key(LETTER.get(low, 0), flags, name); return True
    return False

DIGIT = {"1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29}

def type_text(s, ref=None):
    # Paced by CONFIRMATION: each character goes with its own key code, and with a field to watch we wait (up to 250 ms)
    # until its value changed before the next one. Every character as key code 0, 4 ms apart, was dropped by sites with
    # a heavy input handler ("basketballshoes", "Mllennium Falcon"; a 40 ms handler kept only "bas" of "basketball shoes").
    e = None
    if ref:
        try: e = elem(ref)
        except Exception: e = None
    def cur():
        try: return text_of(attr(e, "AXValue")) if e is not None else None
        except Exception: return None
    for ch in str(s):
        if ch == "\n": post_key(36); continue
        before = cur()
        code = 49 if ch == " " else LETTER.get(ch.lower(), DIGIT.get(ch, 0))
        post_key(code, 0, ch)
        if before is None: time.sleep(0.012); continue
        t0 = time.time()
        while time.time() - t0 < 0.25:
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.005, False)
            if cur() != before: break
    return True

def act(ref, action):
    e = elem(ref)
    names = AXUIElementCopyActionNames(e, None)[1] or []
    if action not in names:
        # a link's or button's text child: the control is an ancestor
        p = attr(e, "AXParent")
        for _ in range(4):
            if p is None: break
            if action in (AXUIElementCopyActionNames(p, None)[1] or []): e = p; break
            p = attr(p, "AXParent")
        else:
            return {"err": f"no {action} on this element"}
    r = AXUIElementPerformAction(e, action)
    return {"err": None if r == kAXErrorSuccess else f"AX error {r}"}

def focus(ref):
    e = elem(ref)
    r = AXUIElementSetAttributeValue(e, "AXFocused", True)
    return {"err": None if r == kAXErrorSuccess else f"AX error {r}", "focused": attr(e, "AXFocused") is True}

def select_all_text(ref):
    e = elem(ref)
    n = len(text_of(attr(e, "AXValue")))
    rng = AXValueCreate(kAXValueCFRangeType, (0, n))
    r = AXUIElementSetAttributeValue(e, "AXSelectedTextRange", rng)
    return {"err": None if r == kAXErrorSuccess else f"AX error {r}", "len": n}

def value(ref):
    return {"value": text_of(attr(elem(ref), "AXValue"))}

def focused_value():
    # the field that has keyboard focus now (a site may swap the field for a new one when it gets focus)
    f = attr(APP, "AXFocusedUIElement")
    return {"value": text_of(attr(f, "AXValue")), "role": text_of(attr(f, "AXRole")), "ref": ref_for(f) if f is not None else None}

def set_value(ref, v):
    r = AXUIElementSetAttributeValue(elem(ref), "AXValue", v)
    return {"err": None if r == kAXErrorSuccess else f"AX error {r}"}

def navigate(url):
    o = omnibox()
    if o is None: return {"err": "the address bar was not found"}
    AXUIElementSetAttributeValue(o, "AXFocused", True)
    AXUIElementSetAttributeValue(o, "AXValue", url)
    post_key(36)
    return {"err": None}

def info_of(ref):
    e = elem(ref)
    web = web_area()
    origin = point(attr(web, "AXPosition")) or (0, 0)
    pos, sz = point(attr(e, "AXPosition")), size(attr(e, "AXSize"))
    vw, vh = size(attr(web, "AXSize")) or (0, 0)
    alive = attr(e, "AXRole") is not None
    return {"alive": alive, "x": pos[0] - origin[0] if pos else None, "y": pos[1] - origin[1] if pos else None,
            "w": sz[0] if sz else 0, "h": sz[1] if sz else 0, "vh": vh, "vw": vw,
            "expanded": attr(e, "AXExpanded"), "selected": attr(e, "AXSelected"), "value": text_of(attr(e, "AXValue")),
            "focused": attr(e, "AXFocused"), "name": text_of(attr(e, "AXTitle")) or text_of(attr(e, "AXDescription"))}

def children_named(ref, role="AXMenuItem"):
    # the options of an open native <select> or menu: [(ref, title)]
    e = elem(ref); out = []
    def walk(x, d=0):
        if d > 8: return
        for c in attr(x, "AXChildren") or []:
            if attr(c, "AXRole") == role: out.append({"ref": ref_for(c), "name": text_of(attr(c, "AXTitle")) or text_of(attr(c, "AXValue"))})
            walk(c, d + 1)
    walk(e)
    return out

def windows():
    return [{"title": text_of(attr(w, "AXTitle"))} for w in (attr(APP, "AXWindows") or [])]

def web_origin():
    web = web_area()
    return web, (point(attr(web, "AXPosition")) or (0, 0))

def press_at(x, y):
    # the element under a window point, pressed through accessibility (the person's pointer stays where it is)
    web, (ox, oy) = web_origin()
    err, e = AXUIElementCopyElementAtPosition(APP, ox + float(x), oy + float(y), None)
    if err != kAXErrorSuccess or e is None: return {"err": f"nothing at ({x}, {y})"}
    for _ in range(6):
        if e is None: break
        names = AXUIElementCopyActionNames(e, None)[1] or []
        if "AXPress" in names:
            r = AXUIElementPerformAction(e, "AXPress")
            return {"err": None if r == kAXErrorSuccess else f"AX error {r}", "role": text_of(attr(e, "AXRole")), "name": text_of(attr(e, "AXTitle")) or text_of(attr(e, "AXDescription"))}
        if attr(e, "AXRole") in ("AXTextField", "AXTextArea", "AXComboBox"):
            AXUIElementSetAttributeValue(e, "AXFocused", True); return {"err": None, "role": text_of(attr(e, "AXRole")), "name": "", "focused": True}
        e = attr(e, "AXParent")
    return {"err": f"nothing pressable at ({x}, {y})"}

def focus_page():
    # keys like Page_Down go to the focused element: give focus to the page itself, not a text field or the omnibox
    web = web_area()
    f = attr(APP, "AXFocusedUIElement")
    if f is not None and attr(f, "AXRole") in ("AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"):
        AXUIElementSetAttributeValue(web, "AXFocused", True)
    return {"err": None}

def scroll_pos():
    # how far the page has scrolled, as a signature: where the first dozen texts sit relative to the viewport top.
    # (one element is not enough: a fixed header never moves; any scroll moves most of the rest)
    web, (ox, oy) = web_origin()
    ys = []
    def walk(e, d=0):
        if d > 40 or len(ys) >= 40: return
        for c in attr(e, "AXChildren") or []:
            if len(ys) >= 40: return
            if attr(c, "AXRole") in ("AXStaticText", "AXLink", "AXImage", "AXHeading"):
                p = point(attr(c, "AXPosition"))
                if p: ys.append(round(p[1] - oy))
            else: walk(c, d + 1)
    walk(web)
    return {"y": ",".join(map(str, ys)) if ys else None}

def wheel(x, y, dy):
    web, (ox, oy) = web_origin()
    ev = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 1, int(-dy))
    Quartz.CGEventSetLocation(ev, Quartz.CGPointMake(ox + float(x), oy + float(y)))
    Quartz.CGEventPostToPid(PID, ev)
    return {"err": None}

def choose_native(ref, want):
    # a native <select> (AXPopUpButton): open its menu, press the matching item, read the button back
    e = elem(ref)
    want_l = str(want).strip().lower()
    def open_menus():
        m = [m for m in (attr(e, "AXChildren") or []) if attr(m, "AXRole") == "AXMenu"]
        return m or [m for m in (attr(APP, "AXChildren") or []) if attr(m, "AXRole") == "AXMenu"]
    def close(menus):
        # AXCancel reaches the menu in a background Chrome; an Escape posted to the process does not (Soriana: a
        # menu left open by a miss made the next select_option's press CLOSE it -> "did not open")
        for m in menus or open_menus(): AXUIElementPerformAction(m, "AXCancel")
        if open_menus(): post_key(53)
    # never press a dropdown whose menu is already open: the press would close it
    if not open_menus(): AXUIElementPerformAction(e, "AXPress")
    items, menus = [], []
    for _ in range(20):
        time.sleep(0.05)
        menus = open_menus()
        if menus:
            items = [i for m in menus for i in (attr(m, "AXChildren") or []) if attr(i, "AXRole") == "AXMenuItem"]
            if items: break
    if not items:
        close(menus)
        return {"err": "the dropdown's menu did not open"}
    def item_name(i):
        # Chrome's native <select> menu: AXTitle is often empty (Soriana's "Sort By" listed blanks); the text is in
        # AXDescription, AXValue or a child static text
        n = text_of(attr(i, "AXTitle")) or text_of(attr(i, "AXDescription")) or text_of(attr(i, "AXValue"))
        if not n:
            for c in attr(i, "AXChildren") or []:
                n = text_of(attr(c, "AXValue")) or text_of(attr(c, "AXTitle"))
                if n: break
        return " ".join(n.split())
    names = [item_name(i) for i in items]
    pick = None
    for test in (lambda n: n.strip().lower() == want_l, lambda n: n.strip().lower().startswith(want_l), lambda n: want_l in n.lower()):
        for i, n in zip(items, names):
            if test(n): pick = i; break
        if pick is not None: break
    if pick is None:
        close(menus)
        return {"missing": True, "options": names[:15]}
    chosen = item_name(pick)
    AXUIElementPerformAction(pick, "AXPress")
    # read the dropdown's VALUE back, waiting for it: right after the menu closes it can be empty for a moment, and the
    # title ("Sort products") was then reported as what the dropdown reads (a re-select of the same option "FAILED")
    now = ""
    for _ in range(10):
        time.sleep(0.1)
        now = text_of(attr(e, "AXValue"))
        if now: break
    return {"chosen": chosen, "now": now or text_of(attr(e, "AXTitle"))}

CMDS = {
    "snapshot": lambda a: snapshot(bool(a.get("include_text"))),
    "info": lambda a: page_info(),
    "text": lambda a: {"text": page_text(int(a.get("max_chars", 4000000)))},
    "press": lambda a: act(a["ref"], "AXPress"),
    "action": lambda a: act(a["ref"], a["action"]),
    "scroll_into_view": lambda a: act(a["ref"], "AXScrollToVisible"),
    "focus": lambda a: focus(a["ref"]),
    "select_all": lambda a: select_all_text(a["ref"]),
    "value": lambda a: value(a["ref"]),
    "focused_value": lambda a: focused_value(),
    "set_value": lambda a: set_value(a["ref"], a["value"]),
    "elem_info": lambda a: info_of(a["ref"]),
    "options": lambda a: {"options": children_named(a["ref"], a.get("role", "AXMenuItem"))},
    "key": lambda a: {"ok": key(a["name"], a.get("modifiers", []))},
    "type": lambda a: {"ok": type_text(a["text"], a.get("ref"))},
    "navigate": lambda a: navigate(a["url"]),
    "windows": lambda a: {"windows": windows()},
    "trusted": lambda a: {"trusted": bool(AXIsProcessTrusted())},
    "press_at": lambda a: press_at(a["x"], a["y"]),
    "focus_page": lambda a: focus_page(),
    "scroll_pos": lambda a: scroll_pos(),
    "wheel": lambda a: wheel(a["x"], a["y"], a["dy"]),
    "choose_native": lambda a: choose_native(a["ref"], a["option"]),
}

def front():
    # COMPUTER_USE_FOREGROUND=1: the person lets this Chrome take the front while it works (Alex, 2026-11-25), so
    # menus, focus and keystrokes behave exactly as they do for a person at the keyboard
    from AppKit import NSRunningApplication, NSApplicationActivateIgnoringOtherApps
    ra = NSRunningApplication.runningApplicationWithProcessIdentifier_(PID)
    ok = bool(ra and ra.activateWithOptions_(NSApplicationActivateIgnoringOtherApps))
    w = window()
    if w is not None: AXUIElementPerformAction(w, "AXRaise")
    return {"ok": ok}
CMDS["front"] = lambda a: front()
import os as _os
FOREGROUND = _os.environ.get("COMPUTER_USE_FOREGROUND") == "1"

# stdin on a thread; every accessibility call on the main thread, between turns of its run loop (observer callbacks)
INQ = queue.Queue()
def reader():
    for line in sys.stdin:
        line = line.strip()
        if line: INQ.put(line)
    INQ.put(None)
threading.Thread(target=reader, daemon=True).start()

def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n"); sys.stdout.flush()

# a Chrome just launched has no window (and no web tree) for a moment: wait for both before saying ready
_t0 = time.time()
while time.time() - _t0 < 20 and window() is None:
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, False)
start_observer()
if FOREGROUND: front()
ACTING = {"press", "action", "focus", "select_all", "set_value", "key", "type", "choose_native", "press_at", "wheel", "navigate"}
def keep_front():
    # someone clicked elsewhere mid-task: take the front back before acting (only with COMPUTER_USE_FOREGROUND=1)
    from AppKit import NSWorkspace
    app = NSWorkspace.sharedWorkspace().frontmostApplication()
    if app is None or app.processIdentifier() != PID: front(); time.sleep(0.15)
reply({"id": 0, "ok": True, "result": {"ready": True, "trusted": bool(AXIsProcessTrusted()), "pid": PID, "window": window() is not None}})
while True:
    # 20 ms turns: observer callbacks still land, commands wait at most 20 ms, and an idle helper costs ~nothing
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, False)
    try: line = INQ.get_nowait()
    except queue.Empty: continue
    if line is None: break
    try:
        req = json.loads(line)
    except Exception as e:
        reply({"id": None, "ok": False, "error": f"bad request: {e}"}); continue
    try:
        if FOREGROUND and req.get("cmd") in ACTING: keep_front()
        fn = CMDS.get(req.get("cmd"))
        if fn is None: raise KeyError(f"unknown cmd {req.get('cmd')}")
        res = fn(req)
        if isinstance(res, dict) and res.get("err"): reply({"id": req.get("id"), "ok": False, "error": res["err"]})
        else: reply({"id": req.get("id"), "ok": True, "result": res})
    except LookupError as e:
        reply({"id": req.get("id"), "ok": False, "error": str(e).strip('"\'')})
    except Exception as e:
        reply({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})
