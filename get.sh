#!/usr/bin/env bash
# One-line install of omarchy-computer-use:
#
#   curl -fsSL https://raw.githubusercontent.com/martoast/omarchy-computer-use/main/get.sh | bash
#
# Clones (or updates) the repo into ~/.local/share/omarchy-computer-use, then runs install.sh.
# Set OMARCHY_CU_DIR to install somewhere else.
set -euo pipefail
REPO=https://github.com/martoast/omarchy-computer-use.git
DIR="${OMARCHY_CU_DIR:-$HOME/.local/share/omarchy-computer-use}"

command -v pacman >/dev/null || { echo "omarchy-computer-use needs Arch / Omarchy (pacman not found)." >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "Run this as your normal user, not root." >&2; exit 1; }
command -v git >/dev/null || sudo pacman -S --needed --noconfirm git

if [ -d "$DIR/.git" ]; then
    echo "› Updating $DIR"
    git -C "$DIR" pull --ff-only --quiet
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    echo "$DIR exists and is not a git checkout; move it away or set OMARCHY_CU_DIR." >&2; exit 1
else
    echo "› Downloading omarchy-computer-use into $DIR"
    git clone --quiet --depth 1 "$REPO" "$DIR"
fi
# Under `curl | bash` stdin is the script itself; give the installer the terminal when there is one.
if { : </dev/tty; } 2>/dev/null; then exec "$DIR/install.sh" </dev/tty; else exec "$DIR/install.sh"; fi
