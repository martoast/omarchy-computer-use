#!/usr/bin/env bash
# omarchy-computer-use installer: one command on a fresh Omarchy machine.
#
#   curl -fsSL https://raw.githubusercontent.com/martoast/omarchy-computer-use/main/get.sh | bash
#   (or from a clone: ./install.sh)
#
# Safe to run again (it only adds what is missing). What it does:
#   1. packages: ydotool, sway, npm, python-gobject, at-spi2-core, grim, wtype (+ wlrctl from the AUR, optional)
#   2. input: a udev rule so ydotool can use /dev/uinput, and the ydotoold user service
#   3. accessibility: GNOME toolkit-accessibility + Chromium's --force-renderer-accessibility
#   4. node deps (npm ci)
#   5. registers the MCP server "omarchy-desktop" with Claude Code and Codex (whichever are installed)
#   6. installs the `omarchy-computer-use` command (status | doctor | update | uninstall) and runs the doctor
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME=omarchy-desktop
BIN="$HOME/.local/bin"
FLAGS="$HOME/.config/chromium-flags.conf"
RULE=/etc/udev/rules.d/60-ydotoold.rules

say()  { printf '\033[1;35m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v pacman >/dev/null || die "This needs Arch / Omarchy (pacman not found)."
command -v hyprctl >/dev/null || warn "hyprctl not found: the desktop backend needs Hyprland (Omarchy). Continuing."
[ "$(id -u)" -ne 0 ] || die "Run as your normal user, not root (it uses sudo where needed)."

# A CLI that may live behind mise shims (Omarchy installs claude/codex that way).
find_cli() { command -v "$1" 2>/dev/null || { command -v mise >/dev/null && mise which "$1" 2>/dev/null; } || true; }

say "Packages"
sudo pacman -S --needed --noconfirm ydotool sway npm nodejs python-gobject at-spi2-core grim wtype gcc pkgconf wayland libxkbcommon >/dev/null
ok "ydotool sway npm nodejs python-gobject at-spi2-core grim wtype"
if ! command -v wlrctl >/dev/null; then
    if command -v yay >/dev/null && yay -S --needed --noconfirm --answerdiff None --answerclean None wlrctl >/dev/null 2>&1; then
        ok "wlrctl (AUR)"
    else
        warn "wlrctl not installed (only the headless backend needs it): yay -S wlrctl"
    fi
fi

say "Input (ydotool)"
# uaccess gives the person at the seat /dev/uinput right away; the input group covers a re-login.
echo 'KERNEL=="uinput", GROUP="input", MODE="0660", TAG+="uaccess", OPTIONS+="static_node=uinput"' | sudo tee "$RULE" >/dev/null
sudo usermod -aG input "$USER"
sudo modprobe uinput 2>/dev/null || true
sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=uinput 2>/dev/null || true
[ -w /dev/uinput ] || sudo setfacl -m "u:$USER:rw" /dev/uinput 2>/dev/null || true
if [ ! -f /usr/lib/systemd/user/ydotool.service ] && [ ! -f "$HOME/.config/systemd/user/ydotool.service" ]; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/ydotool.service" <<UNIT
[Unit]
Description=ydotoold (omarchy-computer-use)

[Service]
ExecStart=/usr/bin/ydotoold
Restart=always

[Install]
WantedBy=default.target
UNIT
fi
systemctl --user daemon-reload
systemctl --user enable --now ydotool.service >/dev/null 2>&1 || warn "ydotool.service did not start (see: systemctl --user status ydotool)"
systemctl --user restart ydotool.service 2>/dev/null || true
ok "udev rule, input group, ydotoold user service"

say "Accessibility"
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || warn "gsettings failed (set org.gnome.desktop.interface toolkit-accessibility true by hand)"
# The a11y bus reads that setting only when the session starts; flip it now so no re-login is needed.
busctl --user set-property org.a11y.Bus /org/a11y/bus org.a11y.Status IsEnabled b true 2>/dev/null || warn "could not switch the accessibility bus on (log out and back in once)"
touch "$FLAGS"
grep -qx -- '--force-renderer-accessibility' "$FLAGS" || echo '--force-renderer-accessibility' >> "$FLAGS"
ok "toolkit-accessibility on; Chromium flag in $FLAGS (restart Chromium once)"

say "Node dependencies"
(cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error)
ok "npm ci"
# The headless mode's virtual keyboard/pointer helpers (optional: without them it falls back to a slower path).
if (cd "$DIR" && node headless_keyboard_build.mjs >/dev/null 2>&1 && node headless_pointer_build.mjs >/dev/null 2>&1); then
    ok "headless input helpers built"
else
    warn "headless input helpers not built (only the headless mode uses them)"
fi

say "Register the MCP server ($NAME)"
CLAUDE=$(find_cli claude); CODEX=$(find_cli codex)
if [ -n "$CLAUDE" ]; then
    "$CLAUDE" mcp remove -s user "$NAME" >/dev/null 2>&1 || true
    "$CLAUDE" mcp add -s user "$NAME" -- node "$DIR/index.js" >/dev/null
    ok "Claude Code (user scope)"
fi
if [ -n "$CODEX" ]; then
    "$CODEX" mcp remove "$NAME" >/dev/null 2>&1 || true
    "$CODEX" mcp add "$NAME" -- node "$DIR/index.js" >/dev/null 2>&1 && ok "Codex" || warn "Codex: could not register (codex mcp add $NAME -- node $DIR/index.js)"
fi
[ -n "$CLAUDE$CODEX" ] || warn "No Claude Code or Codex found. Install one, then run: omarchy-computer-use register"

say "Plugins"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-computer-use"
mkdir -p "$CFG"
[ -f "$CFG/plugins.json" ] || echo '{ "plugins": [] }' > "$CFG/plugins.json"
ok "plugin list: $CFG/plugins.json (empty until you add one)"

say "Command"
mkdir -p "$BIN"
ln -sf "$DIR/bin/omarchy-computer-use" "$BIN/omarchy-computer-use"
ok "omarchy-computer-use → $BIN"

echo
"$DIR/bin/omarchy-computer-use" doctor || true
echo
ok "Done. Open Claude Code (or Codex): the omarchy-desktop tools are there. Restart Chromium once so it exposes its accessibility tree."
