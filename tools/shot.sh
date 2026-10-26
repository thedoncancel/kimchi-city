#!/bin/bash
# Screenshot the running game (python3 serve.py on :5173) in headless Chrome, for looking at map and renderer work.
#   tools/shot.sh '<query>' out.png [width] [height] [wait_ms]
#   tools/shot.sh 'map=2&shot=pass_crest&hour=17' /tmp/pass.png
#   tools/shot.sh 'map=2&shot=villa_terrace&cam=900,120,700,1100,0,600' /tmp/aerial.png 1600 900
# <query> is added to http://localhost:5173/?gfx=high&... ; shot=<bench view> starts a throwaway game that never
# saves (src/3d/main3d.js), hour= holds the clock, cam= fixes the camera (metres), hud=1 shows the HUD.
# Only one capture runs at a time (a lock in /tmp), because each Chrome takes ~0.5 GB on an 8 GB Mac.
# Chrome runs on its own throwaway profile, never the user's.
set -e
Q="$1"; OUT="$2"; W="${3:-1280}"; H="${4:-720}"; WAIT="${5:-22000}"
[ -z "$Q" ] || [ -z "$OUT" ] && { echo "usage: tools/shot.sh '<query>' out.png [w h wait_ms]"; exit 2; }
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
LOCK=/tmp/kc-shot.lock
for i in $(seq 1 240); do mkdir "$LOCK" 2>/dev/null && break; sleep 1; done
trap 'rm -rf "$LOCK" "$PROFILE"' EXIT
PROFILE=$(mktemp -d /tmp/kc-shot-profile.XXXXXX)
OUTABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
"$CHROME" --headless=new --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --hide-scrollbars \
  --window-size="$W,$H" --virtual-time-budget="$WAIT" --screenshot="$OUTABS" \
  "http://localhost:5173/?gfx=high&$Q" > "$PROFILE/chrome.log" 2>&1 &
PID=$!
for i in $(seq 1 120); do sleep 1; kill -0 $PID 2>/dev/null || break; done
kill $PID 2>/dev/null || true
if [ -s "$OUTABS" ]; then echo "$OUTABS"; else echo "no screenshot (see Chrome output below)"; tail -5 "$PROFILE/chrome.log"; exit 1; fi
