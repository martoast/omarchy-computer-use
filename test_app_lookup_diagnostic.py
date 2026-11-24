#!/usr/bin/env python3
"""Deterministic tests for the AT-SPI app-lookup MISS diagnostic.

No browser, no registry, no D-Bus: Atspi.get_desktop is replaced with a fake
desktop so every branch is exercised directly.

Why this exists: a miss used to report only "no AT-SPI application found for
pid N", which cannot distinguish the three things that produce it — the
window's owning process changed and the frozen pid no longer matches anything,
the application deregistered while its process lives, or the registry itself
lost apps. Those need different fixes, and one live run could not tell them
apart because the harness recorded nothing about what WAS there.
"""
import os
import sys

import atspi_bridge

# find_app_by_pid resolves `Atspi` from module globals at call time, so a fake
# desktop can be injected without a live registry or any D-Bus traffic.
_real_atspi = atspi_bridge.Atspi


class _Atspi:
    _desktop = None

    @staticmethod
    def get_desktop(_index):
        return _Atspi._desktop


atspi_bridge.Atspi = _Atspi

passed = failed = 0


def check(label, got, want):
    global passed, failed
    ok = got == want
    print(("ok   " if ok else "FAIL ") + label + ("" if ok else f"  got={got!r} want={want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


class FakeApp:
    """One registry entry. pid=RAISE makes get_process_id throw; name=RAISE
    makes get_name throw, which must not abort the pass. Every probe is COUNTED
    so the hot path can be asserted by call count rather than by reading it."""

    RAISE = object()

    def __init__(self, pid, name="app"):
        self._pid, self._name = pid, name
        self.pid_calls = 0
        self.name_calls = 0

    def get_process_id(self):
        self.pid_calls += 1
        if self._pid is FakeApp.RAISE:
            raise RuntimeError("pid probe failed")
        return self._pid

    def get_name(self):
        self.name_calls += 1
        if self._name is FakeApp.RAISE:
            raise RuntimeError("name probe failed")
        return self._name


class FakeDesktop:
    def __init__(self, apps):
        self._apps = apps
        self.visits = []

    def get_child_count(self):
        return len(self._apps)

    def get_child_at_index(self, i):
        self.visits.append(i)
        return self._apps[i]


def lookup(apps, pid):
    _Atspi._desktop = FakeDesktop(apps)
    stats = {}
    app = atspi_bridge.find_app_by_pid(pid, stats)
    return app, stats


# --- THE HOT PATH: a successful lookup must cost exactly what it always did ---
# This runs on EVERY tool call. An earlier version of this diagnostic passed a
# stats dict from main() unconditionally, which defeated the short-circuit and
# made every successful call walk the whole registry and probe get_name on each
# app — added latency and added failure surface on a shared session bus. The
# assertions below are call COUNTS, so that regression cannot return quietly.
target = FakeApp(100, "Chromium")
app, stats = lookup([FakeApp(1, "gnome-shell"), target], 100)
check("a present app is still found", app is target, True)

# The decisive case: the target sits BEFORE a child that would explode if
# touched. A correct lookup returns at the match and never reaches it.
def hot_path_case(with_stats):
    landmine = FakeApp(FakeApp.RAISE, FakeApp.RAISE)
    hit = FakeApp(100, "Chromium")
    desktop = FakeDesktop([FakeApp(1, "gnome-shell"), hit, landmine])
    _Atspi._desktop = desktop
    stats_arg = {} if with_stats else None
    found = atspi_bridge.find_app_by_pid(100, stats_arg) if with_stats else atspi_bridge.find_app_by_pid(100)
    label = "with stats (the shape main() uses)" if with_stats else "without stats"
    check(f"{label}: the target is returned", found is hit, True)
    check(f"{label}: the later child is NEVER visited", desktop.visits, [0, 1])
    check(f"{label}: its pid probe is never called", landmine.pid_calls, 0)
    check(f"{label}: its name probe is never called", landmine.name_calls, 0)
    check(f"{label}: NO get_name on any app", sum(a.name_calls for a in desktop._apps), 0)
    check(f"{label}: one pid probe per visited app, no more", [a.pid_calls for a in desktop._apps], [1, 1, 0])


hot_path_case(with_stats=True)
hot_path_case(with_stats=False)

# --- MISS: the window's owning process changed (an alternate Chromium) --------
app, stats = lookup([FakeApp(1, "gnome-shell"), FakeApp(678999, "Chromium")], 678233)
check("miss returns None", app, None)
check("  desktop_child_count", stats["desktop_child_count"], 2)
check("  readable_pid_count", stats["readable_pid_count"], 2)
check("  pid_probe_error_count", stats["pid_probe_error_count"], 0)
check("  the ALTERNATE chromium pid is reported", stats["chromium_like_pids"], [678999])

# --- MISS: no chromium app at all (deregistered) -----------------------------
app, stats = lookup([FakeApp(1, "gnome-shell"), FakeApp(2, "Files")], 678233)
check("no chromium-like app is reported when none is present", stats["chromium_like_pids"], [])
check("  and the registry was still readable", stats["readable_pid_count"], 2)

# --- MISS: the registry itself is empty --------------------------------------
app, stats = lookup([], 678233)
check("empty desktop reports zero children", stats["desktop_child_count"], 0)
check("  zero readable pids", stats["readable_pid_count"], 0)

# --- MISS: pid probes throwing are COUNTED, not silently skipped --------------
app, stats = lookup([FakeApp(FakeApp.RAISE), FakeApp(FakeApp.RAISE), FakeApp(5, "Files")], 678233)
check("probe exceptions are counted", stats["pid_probe_error_count"], 2)
check("  readable pids counted separately", stats["readable_pid_count"], 1)
check("  child count still covers all of them", stats["desktop_child_count"], 3)
# A None child is a failed read too, not an absent app.
app, stats = lookup([None, FakeApp(5, "Files")], 678233)
check("a None child counts as a probe failure", stats["pid_probe_error_count"], 1)

# A throwing get_name must not abort the pass or leak a name. Names are probed
# ONLY here, after the miss is proven.
app, stats = lookup([FakeApp(42, FakeApp.RAISE), FakeApp(678999, "Chromium")], 678233)
check("a throwing get_name does not abort the pass", stats["readable_pid_count"], 2)
check("  and the chromium pid is still reported", stats["chromium_like_pids"], [678999])
# A name probe that throws is NOT counted as a pid-probe failure: the two
# counters describe different halves of the registry.
check("  a name failure does not inflate pid_probe_error_count", stats["pid_probe_error_count"], 0)

# On a MISS the names are paid for, once per cached app — the cost the hot path
# refuses to pay.
missed = FakeDesktop([FakeApp(1, "gnome-shell"), FakeApp(678999, "Chromium")])
_Atspi._desktop = missed
atspi_bridge.find_app_by_pid(678233, {})
check("a miss probes each cached app's name exactly once", [a.name_calls for a in missed._apps], [1, 1])

# --- the reported pid list is BOUNDED and deduped ----------------------------
many = [FakeApp(1000 + i, "Chromium") for i in range(20)]
app, stats = lookup(many, 678233)
check("chromium pid list is bounded", len(stats["chromium_like_pids"]), atspi_bridge.MAX_REPORTED_PIDS)
dupes = [FakeApp(1234, "Chromium"), FakeApp(1234, "Chromium"), FakeApp(1235, "Google Chrome")]
app, stats = lookup(dupes, 678233)
check("duplicate pids are deduped", stats["chromium_like_pids"], [1234, 1235])
check("  'chrome' also matches", 1235 in stats["chromium_like_pids"], True)

# --- ONLY pids are exposed, never application names --------------------------
app, stats = lookup([FakeApp(7, "Chromium — SECRET DOCUMENT TITLE")], 678233)
check("no application name appears anywhere in the stats",
      "SECRET" in repr(stats), False)
check("  only the pid is reported", stats["chromium_like_pids"], [7])

# --- target_pid_alive is honest about what it can prove ----------------------

check("our own pid is alive", atspi_bridge.target_pid_alive(os.getpid()), True)
check("an impossible pid is not alive", atspi_bridge.target_pid_alive(2 ** 31 - 1), False)

print(f"\n{'PASS' if failed == 0 else 'FAIL'} — {passed}/{passed + failed}")
sys.exit(0 if failed == 0 else 1)
