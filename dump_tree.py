#!/usr/bin/env python3
"""Unfiltered AT-SPI tree dump for debugging what atspi_bridge.py's filtered
walker can't see: nameless elements, unexpected roles, modal states, and
per-node AT-SPI actions. Prints one JSON object per line for EVERY node.

Usage: dump_tree.py <pid> [max_nodes]
Env: same WAYLAND/XDG env as the target instance (see instanceEnv()).
"""
import sys
import json
import warnings

warnings.filterwarnings("ignore")

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

STATE_NAMES = [
    "STATE_SHOWING", "STATE_VISIBLE", "STATE_ENABLED", "STATE_SENSITIVE",
    "STATE_FOCUSABLE", "STATE_FOCUSED", "STATE_MODAL", "STATE_ACTIVE",
    "STATE_EXPANDED", "STATE_CHECKED", "STATE_SELECTED",
]


def states_of(acc):
    try:
        ss = acc.get_state_set()
        out = []
        for s in STATE_NAMES:
            v = getattr(Atspi.StateType, s, None)
            if v is not None and ss.contains(v):
                out.append(s.replace("STATE_", "").lower())
        return out
    except Exception:
        return []


def actions_of(acc):
    try:
        ai = acc.get_action_iface()
        if not ai:
            return []
        return [ai.get_action_name(i) for i in range(ai.get_n_actions())]
    except Exception:
        return []


def bounds_of(acc):
    try:
        comp = acc.get_component_iface()
        if not comp:
            return None
        ex = comp.get_extents(Atspi.CoordType.WINDOW)
        return [ex.x, ex.y, ex.width, ex.height]
    except Exception:
        return None


def main():
    pid = int(sys.argv[1])
    max_nodes = int(sys.argv[2]) if len(sys.argv) > 2 else 20000
    desktop = Atspi.get_desktop(0)
    app = None
    for i in range(desktop.get_child_count()):
        a = desktop.get_child_at_index(i)
        try:
            if a and a.get_process_id() == pid:
                app = a
                break
        except Exception:
            continue
    if app is None:
        print(json.dumps({"error": f"no AT-SPI app with pid {pid}"}))
        return

    count = [0]

    def visit(acc, depth, path):
        if count[0] >= max_nodes or depth > 60:
            return
        try:
            role = acc.get_role_name()
            name = acc.get_name() or ""
        except Exception:
            return
        count[0] += 1
        node = {"d": depth, "path": path, "role": role}
        if name:
            node["name"] = name[:100]
        b = bounds_of(acc)
        if b:
            node["b"] = b
        st = states_of(acc)
        if st:
            node["st"] = st
        ac = actions_of(acc)
        if ac:
            node["act"] = ac
        try:
            desc = acc.get_description()
            if desc:
                node["desc"] = desc[:80]
        except Exception:
            pass
        print(json.dumps(node))
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
                visit(child, depth + 1, f"{path}.{i}")

    visit(app, 0, "0")
    print(json.dumps({"total_nodes": count[0]}))


if __name__ == "__main__":
    main()
