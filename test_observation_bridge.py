#!/usr/bin/env python3
"""Bridge side of observation.mjs: landmark -> region, and a text box's contents (never a secret field).
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


class Landmark:
    def __init__(self, xml_roles, raises=False):
        self.x, self.raises = xml_roles, raises

    def get_attributes(self):
        if self.raises:
            raise RuntimeError("gone")
        return {"xml-roles": self.x} if self.x is not None else {}


for xr, want in [("banner", "header"), ("navigation", "nav"), ("main", "main"), ("contentinfo", "footer"),
                 ("complementary", "aside"), ("search", "search"), ("region", None), ("form", None), (None, None)]:
    check(f"landmark xml-roles={xr!r} -> region {want!r}", ab._landmark_region(Landmark(xr)), want)
check("an unreadable landmark has no region", ab._landmark_region(Landmark("main", raises=True)), None)


class Text:
    def __init__(self, s):
        self.s = s

    def get_character_count(self):
        return len(self.s)

    def get_text(self, a, b):
        return self.s[a:b]


class Entry:
    def __init__(self, s, iface=True):
        self.t = Text(s) if iface else None

    def get_text_iface(self):
        return self.t


check("a search box's contents are read", ab.field_text_value(Entry("  moondog  "), "Search Bandcamp"), "moondog")
check("an empty box reads as None", ab.field_text_value(Entry(""), "Search"), None)
check("no text interface reads as None", ab.field_text_value(Entry("x", iface=False), "Search"), None)
check("long contents are capped at 120", len(ab.field_text_value(Entry("a" * 500), "Notes")), 120)
for secret in ["Card number", "CVV", "Security code", "Expiration date", "Password", "PIN", "SSN", "Account number", "Routing number"]:
    check(f"a {secret!r} field is never read", ab.field_text_value(Entry("4111111111111111"), secret), None)

print(f"\n{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
