#!/usr/bin/env bash

set -eo pipefail # exit on error, error on any fail in pipe (not just last cmd); add -x to print each cmd; see gist bash_strict_mode.md

echo "Version: https://github.com/vogler/free-games-claimer/tree/${COMMIT}"
[ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && echo "Branch: ${BRANCH}"
echo "Build: $NOW"

BROWSER="${BROWSER_DIR:-/fgc/data/browser}"
mkdir -p "$BROWSER" /fgc/data

# Remove chromium profile lock.
# When running in docker and then killing it, on the next run chromium displayed a dialog to unlock the profile which made the script time out.
# https://bugs.chromium.org/p/chromium/issues/detail?id=367048
rm -f "$BROWSER/SingletonLock" "$BROWSER/SingletonCookie" "$BROWSER/SingletonSocket"

# Remove X server display lock, fix for `docker compose up` which reuses container which made it fail after initial run, https://github.com/vogler/free-games-claimer/issues/31
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1

export DISPLAY=:1 # need to export this, otherwise playwright complains with 'Looks like you launched a headed browser without having a XServer running.'
if [ -z "$VNC_PASSWORD" ]; then
  pw="-SecurityTypes None"
  pwt="no password!"
else
  mkdir -p ~/.vnc/
  echo "$VNC_PASSWORD" | /opt/TurboVNC/bin/vncpasswd -f > ~/.vnc/passwd
  chmod 600 ~/.vnc/passwd
  pw="-rfbauth $HOME/.vnc/passwd"
  pwt="with password"
fi
# TurboVNC server replaces Xvfb+x11vnc; ratpoison is a minimal window manager so Chromium gets a proper (maximized) window.
# shellcheck disable=SC2086
/opt/TurboVNC/bin/vncserver "$DISPLAY" -geometry "${WIDTH}x${HEIGHT}" -depth "${DEPTH}" -rfbport "${VNC_PORT}" $pw -vgl -log /fgc/data/TurboVNC.log -xstartup /usr/bin/ratpoison 2>/dev/null
echo "TurboVNC is running on port $VNC_PORT ($pwt) with resolution ${WIDTH}x${HEIGHT}"
websockify -D --web "/usr/share/novnc/" "$NOVNC_PORT" "localhost:$VNC_PORT" 2>/dev/null 1>&2 &
echo "noVNC (VNC via browser) is running on http://localhost:$NOVNC_PORT/?autoconnect=true"
echo
exec tini -g -- "$@" # https://github.com/krallin/tini/issues/8 node/playwright respond to signals like ctrl-c, but unsure about zombie processes
