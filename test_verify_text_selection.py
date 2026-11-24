#!/usr/bin/env python3
"""Pure unit tests for text_selection_span (no AT-SPI session): the verify_text
selection evidence behind rev 30b's one-Delete autocomplete removal.
Run: python3 test_verify_text_selection.py"""
import sys
import atspi_bridge
from atspi_bridge import text_selection_span


class FakeRange:
    def __init__(self, start, end):
        self.start_offset = start
        self.end_offset = end


class FakeText:
    def __init__(self, selections):
        self.selections = selections


class FakeAtspiText:
    @staticmethod
    def get_n_selections(ti):
        if isinstance(ti.selections, Exception):
            raise ti.selections
        return len(ti.selections)

    @staticmethod
    def get_selection(ti, i):
        sel = ti.selections[i]
        if isinstance(sel, Exception):
            raise sel
        return sel


class FakeAtspi:
    Text = FakeAtspiText


real = atspi_bridge.Atspi
atspi_bridge.Atspi = FakeAtspi
try:
    cases = [
        ("no selection → None", FakeText([]), None),
        ("one selection (the inline-autocomplete suffix) → [start, end]", FakeText([FakeRange(20, 47)]), [20, 47]),
        ("a tuple-shaped range is accepted", FakeText([(20, 47)]), [20, 47]),
        ("only the first selection counts", FakeText([FakeRange(3, 9), FakeRange(10, 12)]), [3, 9]),
        ("a collapsed selection is still reported (the JS side rejects it)", FakeText([FakeRange(47, 47)]), [47, 47]),
        ("a negative or inverted range → None", FakeText([FakeRange(5, 2)]), None),
        ("a non-integer range → None", FakeText([FakeRange("a", "b")]), None),
        ("get_n_selections raising → None", FakeText(RuntimeError("no text iface")), None),
        ("get_selection raising → None", FakeText([RuntimeError("gone")]), None),
    ]
    fails = 0
    for label, ti, want in cases:
        got = text_selection_span(ti)
        ok = got == want
        print(("ok   " if ok else "FAIL ") + label + ("" if ok else f"  <<< got {got!r}, want {want!r}"))
        fails += 0 if ok else 1
finally:
    atspi_bridge.Atspi = real
print(("PASS" if fails == 0 else "FAIL") + f" — {len(cases) - fails} passed, {fails} failed")
sys.exit(1 if fails else 0)
