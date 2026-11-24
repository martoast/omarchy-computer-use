"""settle_verdict (2026-09-29): ready + quiet → settled; past the bound → not settled WITH the reason; never a guess."""
import atspi_bridge as ab
fails = 0
def check(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("ok  " if ok else "FAIL") + f" {label}: {got!r}" + ("" if ok else f" (want {want!r})"))
check("ready and quiet long enough", ab.settle_verdict("ready", 900, 2000, 800, 15000), {"settled": True, "reason": "quiet"})
check("ready but still changing: keep waiting", ab.settle_verdict("ready", 300, 2000, 800, 15000), None)
check("busy: keep waiting", ab.settle_verdict("busy", 5000, 2000, 800, 15000), None)
check("old document after a navigation: keep waiting", ab.settle_verdict("old_document", 5000, 2000, 800, 15000), None)
check("bound reached while busy → says busy", ab.settle_verdict("busy", 5000, 15000, 800, 15000), {"settled": False, "reason": "busy"})
check("bound reached while changing → still_changing", ab.settle_verdict("ready", 100, 15000, 800, 15000), {"settled": False, "reason": "still_changing"})
print("PASS" if not fails else f"FAILED {fails}")

# usable_changing (2026-11-24, CarMax: ready at 103 ms, 1,440 changes in 15 s, never quiet)
check("ready 2.5 s but never quiet -> usable_changing", ab.settle_verdict("ready", 100, 2700, 800, 15000, ready_for_ms=2600), {"settled": True, "reason": "usable_changing"})
check("ready only 1 s while changing: keep waiting", ab.settle_verdict("ready", 100, 1200, 800, 15000, ready_for_ms=1000), None)
check("quiet still wins first", ab.settle_verdict("ready", 900, 2700, 800, 15000, ready_for_ms=2600), {"settled": True, "reason": "quiet"})
check("busy never becomes usable_changing", ab.settle_verdict("busy", 100, 5000, 800, 15000, ready_for_ms=None), None)
check("an old document never becomes usable_changing", ab.settle_verdict("old_document", 100, 5000, 800, 15000, ready_for_ms=None), None)
# usable_while_loading is OPT-IN
check("busy + populated + quiet, opt-in off: keep waiting", ab.settle_verdict("busy", 900, 3000, 800, 15000, usable_while_loading=False, populated=True), None)
check("busy + populated + quiet, opt-in on -> usable_while_loading", ab.settle_verdict("busy", 900, 3000, 800, 15000, usable_while_loading=True, populated=True), {"settled": True, "reason": "usable_while_loading"})
check("busy + EMPTY + quiet, opt-in on: keep waiting", ab.settle_verdict("busy", 900, 3000, 800, 15000, usable_while_loading=True, populated=False), None)
raise SystemExit(1 if fails else 0)
