#!/usr/bin/env bash
# Dev loop for the FMMatchLens macOS port. Run from Terminal on the Mac:
#
#   ./mac/dev.sh bepinex [zip]  put the FM27 macOS BepInEx package (newest one in
#                          ~/Downloads by default) into FM27's folder, and copy the
#                          Steam launch option to the clipboard
#   ./mac/dev.sh setup     copy FM27's native game library into local/ for analysis,
#                          and BepInEx's reference DLLs into the build once installed
#   ./mac/dev.sh build     build the plugin (needs the .NET SDK, 10 or newer)
#   ./mac/dev.sh install   build, then copy the plugin into FM27's BepInEx folder
#   ./mac/dev.sh logs      copy BepInEx's log into local/logs and show plugin lines
#   ./mac/dev.sh snap      ask the probe for a snapshot of every live match right now
#                          (take it while the game shows the numbers you want to compare)
#   ./mac/dev.sh health    ask the running plugin's local API whether it is up
#   ./mac/dev.sh dump      save the local API's answers, the log and the newest match
#                          archive under local/ (for debugging the capture)
#   ./mac/dev.sh dashboard open the FMMatchLens dashboard (local/dashboard, rebuilt from
#                          frontend/ with npm when frontend/ has changed) in Chrome, Firefox
#                          or Edge, whichever is installed first; BROWSER="Safari" picks one
#   ./mac/dev.sh serve [archive] [speed]   (or: serve 30, for the newest archive at 30x)
#                          replay a match archive into the local API without FM27, for
#                          trying the dashboard: speed 0 (default) loads the whole match at
#                          once, as if the dashboard were opened at full time; 1 is real
#                          time, 30 is 30x. The archive defaults to the newest one FM27 saved
#   ./mac/dev.sh mcp [build|install|config]
#                          the FM match analyst MCP server (mcp/): install opens its
#                          Claude Desktop bundle (the default), config prints the setup
#                          for Claude Code and Codex, build rebuilds it (needs npm)
#   ./mac/dev.sh where     show where FM27 and BepInEx were found
#
# Paths can be overridden with FM27_DIR and BEPINEX_DIR.
# Everything under local/ stays on this Mac: it is git-ignored, because it
# holds copies of Sports Interactive's files and your own logs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GAME="${FM27_DIR:-}"
BEPINEX="${BEPINEX_DIR:-}"
LOCAL="$REPO/local"
PROJECT="$REPO/src/FMMatchLens.Plugin/FMMatchLens.Plugin.csproj"
PLUGIN_DLL="$REPO/src/FMMatchLens.Plugin/bin/Release/net6.0/FMMatchLens.Plugin.dll"
API="http://127.0.0.1:16726/api/health"

app_version() {
  defaults read "$1/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown"
}

# Every fm.app in the usual places: the default Steam library, any other Steam
# library listed in libraryfolders.vdf, Epic's shared folder, the Applications
# folders, and whatever Spotlight knows about.
list_fm_apps() {
  {
    for root in "$HOME/Library/Application Support/Steam/steamapps/common" \
                "/Users/Shared/Epic Games" "/Applications" "$HOME/Applications"; do
      if [ -d "$root" ]; then find "$root" -maxdepth 3 -name 'fm.app' -type d 2>/dev/null || true; fi
    done
    local vdf="$HOME/Library/Application Support/Steam/steamapps/libraryfolders.vdf"
    if [ -f "$vdf" ]; then
      sed -n 's/.*"path"[[:space:]]*"\(.*\)".*/\1/p' "$vdf" | while IFS= read -r lib; do
        if [ -d "$lib/steamapps/common" ]; then
          find "$lib/steamapps/common" -maxdepth 3 -name 'fm.app' -type d 2>/dev/null || true
        fi
      done || true
    fi
    if command -v mdfind >/dev/null 2>&1; then mdfind 'kMDItemFSName == "fm.app"' 2>/dev/null || true; fi
  } | sort -u || true
}

# FM27 is the fm.app whose folder name or version says 27. The full game wins over the
# demo when both are installed ("Football Manager 27 Demo" sorts first otherwise).
find_game() {
  [ -n "$GAME" ] && return 0
  local app pass apps
  apps="$(list_fm_apps)"
  for pass in full demo; do
    while IFS= read -r app; do
      [ -n "$app" ] || continue
      case "$(dirname "$app")" in
        *[Dd]emo*) [ "$pass" = demo ] || continue ;;
      esac
      case "$(dirname "$app")|$(app_version "$app")" in
        *27*) GAME="$(dirname "$app")"; return 0 ;;
      esac
    done <<APPS
$apps
APPS
  done
  return 1
}

need_game() {
  if ! find_game || [ ! -d "$GAME" ]; then
    echo "FM27 was not found automatically. Football Manager apps found on this Mac:"
    list_fm_apps | while IFS= read -r app; do
      [ -n "$app" ] && echo "  $app  (version $(app_version "$app"))"
    done
    echo "Set FM27_DIR to the folder that contains FM27's fm.app (Steam > FM27 > Manage > Browse local files), e.g.:"
    echo "  FM27_DIR=\"/path/to/Football Manager 27\" ./mac/dev.sh setup"
    exit 1
  fi
  [ -n "$BEPINEX" ] || BEPINEX="$GAME/FM27-BepInEx/BepInEx"
  echo "FM27: $GAME"
}

need_bepinex() {
  need_game
  if [ ! -d "$BEPINEX/core" ]; then
    echo "BepInEx was not found at: $BEPINEX"
    echo "Install the FM27 macOS BepInEx package first (see mac/README.md), launch FM27 once, then retry."
    exit 1
  fi
}

cmd_setup() {
  need_game
  mkdir -p "$LOCAL/game"

  # FM's match engine lives in a native library. Its exact name and location on
  # macOS are not confirmed yet, so copy every match and record what each one is.
  : > "$LOCAL/game/FOUND.txt"
  find "$GAME" -path "$GAME/FM27-BepInEx" -prune -o -iname '*game_plugin*' -print -prune | while IFS= read -r path; do
    echo "$path" >> "$LOCAL/game/FOUND.txt"
    if [ -d "$path/Contents/MacOS" ]; then
      # A bundle: copy only its executable and Info.plist, not its multi-GB Resources.
      local dest="$LOCAL/game/$(basename "$path")/Contents"
      mkdir -p "$dest/MacOS"
      cp "$path/Contents/MacOS/"* "$dest/MacOS/"
      [ -f "$path/Contents/Info.plist" ] && cp "$path/Contents/Info.plist" "$dest/"
    else
      cp -R "$path" "$LOCAL/game/"
    fi
  done
  if [ ! -s "$LOCAL/game/FOUND.txt" ]; then
    echo "WARNING: no file named like game_plugin was found under $GAME"
  else
    echo "native game library candidates:"
    cat "$LOCAL/game/FOUND.txt"
    find "$LOCAL/game" -type f ! -name '*.txt' -exec file {} \; > "$LOCAL/game/FILE-TYPES.txt"
    find "$LOCAL/game" -type f ! -name '*.txt' -exec shasum -a 256 {} \; > "$LOCAL/game/SHA256SUMS.txt"
    cat "$LOCAL/game/FILE-TYPES.txt"
  fi

  # The BepInEx reference DLLs are only needed to build the plugin.
  if [ ! -d "$BEPINEX/core" ]; then
    echo "BepInEx is not installed yet (expected $BEPINEX), so the build references were not copied."
    echo "Install the FM27 macOS BepInEx package, launch FM27 once, then run setup again."
    return 0
  fi
  local lib="$REPO/src/FMMatchLens.Plugin/lib"
  mkdir -p "$lib"
  for name in BepInEx.Core.dll BepInEx.Unity.IL2CPP.dll MonoMod.RuntimeDetour.dll MonoMod.Utils.dll; do
    if [ -f "$BEPINEX/core/$name" ]; then
      cp "$BEPINEX/core/$name" "$lib/"
      echo "copied $name"
    else
      echo "WARNING: $name is missing from $BEPINEX/core"
    fi
  done
}

# The .NET installer puts dotnet in /usr/local/share/dotnet and only adds it to PATH
# for new Terminal windows, so look in the usual places too. The Intel (x64) SDK, which an
# Intel Homebrew running under Rosetta installs, goes to /usr/local/share/dotnet/x64 on
# Apple Silicon; it builds the plugin just as well, since the DLL is architecture-neutral.
find_dotnet() {
  local candidate
  for candidate in "$(command -v dotnet 2>/dev/null || true)" \
                   /usr/local/share/dotnet/dotnet /usr/local/share/dotnet/x64/dotnet \
                   /opt/homebrew/bin/dotnet "$HOME/.dotnet/dotnet"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && [ -n "$("$candidate" --list-sdks 2>/dev/null || true)" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

cmd_build() {
  local dotnet
  if ! dotnet="$(find_dotnet)"; then
    echo "The .NET SDK is not installed. Install it with:  brew install --cask dotnet-sdk"
    echo "(or download the macOS Arm64 SDK installer from https://dotnet.microsoft.com/download)"
    exit 1
  fi
  if [ ! -f "$REPO/src/FMMatchLens.Plugin/lib/BepInEx.Core.dll" ]; then
    echo "Run ./mac/dev.sh setup first, so the BepInEx reference DLLs are in place."
    exit 1
  fi
  echo "dotnet: $dotnet ($("$dotnet" --version))"
  "$dotnet" build "$PROJECT" --configuration Release -nologo
  echo "built: $PLUGIN_DLL"
}

# Sets [macOS] Mode in the plugin's BepInEx config, adding the section if needed.
set_mac_mode() {
  local cfg="$1" mode="$2" tmp
  tmp="$(mktemp)"
  if grep -q '^\[macOS\]' "$cfg"; then
    awk -v mode="$mode" '
      /^\[/ { if (section == "[macOS]" && !done) { print "Mode = " mode; print ""; done = 1 } section = $0 }
      section == "[macOS]" && /^Mode[ ]*=/ { if (!done) print "Mode = " mode; done = 1; next }
      { print }
      END { if (section == "[macOS]" && !done) print "Mode = " mode }' "$cfg" > "$tmp"
  else
    cat "$cfg" > "$tmp"
    printf '\n[macOS]\n\nMode = %s\n' "$mode" >> "$tmp"
  fi
  cat "$tmp" > "$cfg"
  rm -f "$tmp"
}

cmd_install() {
  need_bepinex
  cmd_build
  local target="$BEPINEX/plugins/FMMatchLens"
  mkdir -p "$target" "$BEPINEX/config"
  cp "$PLUGIN_DLL" "$target/"
  # Debug logging while porting. BepInEx adds the other settings on first run.
  local cfg="$BEPINEX/config/com.fmmatchlens.plugin.cfg"
  if [ ! -f "$cfg" ]; then
    printf '[Logging]\n\nMode = debug\n' > "$cfg"
  fi
  # capture (default) runs FMMatchLens itself; MODE=probe ./mac/dev.sh install runs the probe.
  set_mac_mode "$cfg" "${MODE:-capture}"
  echo "installed to: $target (macOS mode: ${MODE:-capture})"
  echo "Now launch FM27 from Steam (with the BepInEx launch option), enter a match, then run: ./mac/dev.sh logs"
}

cmd_logs() {
  need_bepinex
  local log="$BEPINEX/LogOutput.log"
  if [ ! -f "$log" ]; then
    echo "No log yet at $log. Launch FM27 with the BepInEx launch option first."
    exit 1
  fi
  mkdir -p "$LOCAL/logs"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp "$log" "$LOCAL/logs/LogOutput-$stamp.log"
  cp "$log" "$LOCAL/logs/latest.log"
  echo "saved: local/logs/LogOutput-$stamp.log"
  if [ ! -f "$BEPINEX/plugins/FMMatchLens/FMMatchLens.Plugin.dll" ]; then
    echo "NOTE: the plugin is not installed. Run ./mac/dev.sh install, then relaunch FM27."
  elif ! grep -q "Loading \[FMMatchLens" "$log"; then
    echo "NOTE: FMMatchLens did not load in this launch. If you just installed it, relaunch FM27."
  fi
  local probe="$BEPINEX/plugins/FMMatchLens/data/mac-probe"
  if [ -d "$probe" ]; then
    mkdir -p "$LOCAL/probe"
    cp "$probe"/*.bin "$LOCAL/probe/" 2>/dev/null || true
    echo "probe snapshots in local/probe: $(ls "$LOCAL/probe" | wc -l | tr -d ' ')"
  fi
  grep -n -i "Chainloader\|FMMatchLens\|\[macOS\|GAME_MATCH\|game_plugin" "$log" | tail -60 || true
}

cmd_bepinex() {
  need_game
  local zip="${1:-}"
  if [ -z "$zip" ]; then
    zip="$(ls -t "$HOME"/Downloads/FM27-BepInEx-macOS-arm64-*.zip 2>/dev/null | head -1 || true)"
  fi
  if [ -z "$zip" ] || [ ! -f "$zip" ]; then
    echo "The FM27 BepInEx package was not found in ~/Downloads."
    echo "Download it from sortitoutsi, or pass its path:  ./mac/dev.sh bepinex /path/to/FM27-BepInEx-....zip"
    exit 1
  fi
  local dir="$GAME/FM27-BepInEx"
  if [ -d "$dir/BepInEx/core" ]; then
    echo "BepInEx is already in $dir (left as it is)."
  else
    echo "unzipping $(basename "$zip") into $GAME"
    unzip -q "$zip" -d "$GAME"
  fi
  if [ ! -f "$dir/run_fm27_bepinex.sh" ]; then
    echo "Expected $dir/run_fm27_bepinex.sh after unzipping; is this the FM27 macOS BepInEx package?"
    exit 1
  fi
  chmod +x "$dir/run_fm27_bepinex.sh"
  local option="\"$dir/run_fm27_bepinex.sh\" %command%"
  echo "Steam launch option for $(basename "$GAME"):"
  echo "  $option"
  if command -v pbcopy >/dev/null 2>&1 && printf '%s' "$option" | pbcopy; then
    echo "It is on the clipboard: Steam > $(basename "$GAME") > Properties > General > Launch Options, then paste."
  fi
}

cmd_snap() {
  need_bepinex
  local dir="$BEPINEX/plugins/FMMatchLens/data/mac-probe" log="$BEPINEX/LogOutput.log"
  local before now i
  mkdir -p "$dir"
  before="$(grep -c "Graph snapshot (manual)" "$log" 2>/dev/null || true)"
  touch "$dir/snapshot-now"
  echo "Snapshot requested; it is taken within a few seconds, paused or not."
  for i in $(seq 1 20); do
    sleep 1
    now="$(grep -c "Graph snapshot (manual)" "$log" 2>/dev/null || true)"
    if [ "${now:-0}" -gt "${before:-0}" ]; then
      sleep 2
      now="$(grep -c "Graph snapshot (manual)" "$log" 2>/dev/null || true)"
      echo "Saved $(( now - before )) snapshot(s) at $(date +%H:%M:%S)."
      cmd_logs >/dev/null
      echo "Copied to local/probe."
      return 0
    fi
  done
  echo "No snapshot after 20 seconds. Is a match open in FM27 with the plugin loaded? Check ./mac/dev.sh logs."
}

# The dashboard is tested upstream in Chrome, Firefox and Edge, so prefer those to the
# default browser. Prints the app name, or nothing to use the default browser.
pick_browser() {
  if [ -n "${BROWSER:-}" ]; then
    echo "$BROWSER"
    return
  fi
  local name
  for name in "Google Chrome" "Firefox" "Microsoft Edge"; do
    if [ -d "/Applications/$name.app" ] || [ -d "$HOME/Applications/$name.app" ]; then
      echo "$name"
      return
    fi
  done
}

cmd_dashboard() {
  local index="$LOCAL/dashboard/index.html" stale="" browser
  if [ ! -f "$index" ]; then
    stale="missing"
  elif [ -n "$(find "$REPO/frontend/src" "$REPO/frontend/index.html" "$REPO/frontend/public" -newer "$index" -print -quit 2>/dev/null)" ]; then
    stale="older than frontend/"
  fi
  if [ -n "$stale" ]; then
    if command -v npm >/dev/null 2>&1; then
      echo "Building the dashboard (local/dashboard is $stale)..."
      (cd "$REPO/frontend" && npm ci --no-audit --no-fund && npm run build)
      rm -rf "$LOCAL/dashboard"
      mkdir -p "$LOCAL/dashboard"
      cp -R "$REPO/frontend/dist/." "$LOCAL/dashboard/"
    elif [ "$stale" = "missing" ]; then
      echo "There is no dashboard in local/dashboard yet, and npm is not installed to build one."
      exit 1
    else
      echo "local/dashboard is older than frontend/, but npm is not installed to rebuild it; opening it anyway."
    fi
  fi
  browser="$(pick_browser)"
  if [ -n "$browser" ]; then
    open -a "$browser" "$index"
    echo "Dashboard opened in $browser."
  else
    open "$index"
    echo "Dashboard opened in the default browser (upstream tests Chrome, Firefox and Edge)."
  fi
  echo "It connects to http://127.0.0.1:16726 while FM27 runs with the plugin, or while ./mac/dev.sh serve runs."
}

cmd_serve() {
  need_bepinex
  local archive="${1:-}" speed="${2:-0}" dotnet tool fps
  # "serve 30" means the newest archive at 30x.
  case "$archive" in
    *[!0-9]*|'') ;;
    *) if [ -z "${2:-}" ]; then speed="$archive"; archive=""; fi ;;
  esac
  if ! dotnet="$(find_dotnet)"; then
    echo "The .NET SDK is not installed (see ./mac/dev.sh build)."
    exit 1
  fi
  if [ -z "$archive" ]; then
    archive="$(ls -t "$BEPINEX/plugins/FMMatchLens/data/matches"/*.fmlens "$LOCAL/archives"/*.fmlens 2>/dev/null | head -1 || true)"
    if [ -z "$archive" ]; then
      echo "No match archive found. Play a match with the plugin installed, or pass an .fmlens file."
      exit 1
    fi
  fi
  if [ ! -f "$archive" ]; then
    echo "No such archive: $archive"
    exit 1
  fi
  case "$speed" in
    ''|*[!0-9]*) echo "speed must be a whole number: 0 for all at once, 1 for real time, 30 for 30x"; exit 1 ;;
  esac
  fps=$((speed * 4))
  local running
  if running="$(curl -s --max-time 2 "$API" 2>/dev/null)"; then
    case "$running" in
      *'"replayOf":"'*) echo "A replay is already running on 127.0.0.1:16726. Stop it with Ctrl+C in its Terminal tab first." ;;
      *) echo "Something already answers on 127.0.0.1:16726, probably FM27 with the plugin. Quit it first." ;;
    esac
    exit 1
  fi
  # The replay tool runs the plugin's own code, so rebuild the plugin if its source changed.
  if [ ! -f "$PLUGIN_DLL" ] || [ -n "$(find "$REPO/src/FMMatchLens.Plugin" -name '*.cs' -newer "$PLUGIN_DLL" -print -quit)" ]; then
    cmd_build
  fi
  "$dotnet" build "$REPO/mac/offline" -nologo -v q
  tool="$REPO/mac/offline/bin/Debug/net8.0/FMMatchLens.MacOffline.dll"
  echo "Open the dashboard in another Terminal tab with ./mac/dev.sh dashboard."
  FMMATCHLENS_BEPINEX_CORE="$BEPINEX/core" "$dotnet" "$tool" --serve "$archive" "$fps"
}

cmd_dump() {
  need_bepinex
  local out ep name
  out="$LOCAL/api/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$out"
  for ep in health match/status match/meta match/current match/momentum/events \
            "match/momentum/updates?after=0&limit=400" "match/frames?fromTick=0&stride=1200&limit=40" archives; do
    name="$(printf '%s' "$ep" | tr '/?&=' '____')"
    curl -sS --max-time 15 "http://127.0.0.1:16726/api/$ep" -o "$out/$name.json" || echo "no answer for /api/$ep"
  done
  local archive
  archive="$(ls -t "$BEPINEX/plugins/FMMatchLens/data/matches"/*.fmlens 2>/dev/null | head -1 || true)"
  if [ -n "$archive" ]; then
    mkdir -p "$LOCAL/archives"
    cp "$archive" "$LOCAL/archives/"
    echo "newest archive: local/archives/$(basename "$archive")"
  fi
  cmd_logs >/dev/null
  echo "saved the API's answers to ${out#"$REPO"/} and the log to local/logs/latest.log"
}

mcp_build() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed, so the MCP server cannot be rebuilt here. Install Node.js (nodejs.org) or use the bundle in mcp/dist."
    return 1
  fi
  (cd "$REPO/mcp" && npm ci --no-audit --no-fund && node build.mjs --mcpb)
}

cmd_mcp() {
  local bundle="$REPO/mcp/dist/fm-match-analyst.mcpb" server="$REPO/mcp/dist/server.mjs"
  local stale=""
  if [ ! -f "$bundle" ] || [ ! -f "$server" ]; then
    stale="missing"
  elif [ -n "$(find "$REPO/mcp/src" "$REPO/mcp/analyst" "$REPO/mcp/mcpb" "$REPO/frontend/src" -newer "$bundle" -print -quit 2>/dev/null)" ]; then
    stale="older than its sources"
  fi
  case "${1:-install}" in
    build)
      mcp_build
      ;;
    install)
      if [ -n "$stale" ]; then
        echo "The MCP bundle is $stale; rebuilding..."
        mcp_build || [ "$stale" != "missing" ] || exit 1
      fi
      open "$bundle"
      echo "Opened $(basename "$bundle"): Claude Desktop should ask to install \"FM Match Analyst\"."
      echo "Then, in a chat, ask about your match (with FM running and a match on), e.g. \"how is my match going?\""
      ;;
    config)
      echo "Claude Code (needs Node.js 18+ on your PATH):"
      echo "  claude mcp add --scope user fm-match-analyst -- node \"$server\""
      echo
      echo "Codex: add to ~/.codex/config.toml (needs Node.js 18+):"
      echo "  [mcp_servers.fm-match-analyst]"
      echo "  command = \"node\""
      echo "  args = [\"$server\"]"
      echo "  tool_timeout_sec = 90"
      ;;
    *)
      echo "usage: ./mac/dev.sh mcp [install|config|build]"
      exit 1
      ;;
  esac
}

cmd_health() {
  local body replay
  if ! body="$(curl -sS --max-time 3 "$API")"; then
    echo "No answer from $API (is FM27 running with the plugin loaded?)"
    return
  fi
  echo "$body"
  replay="$(printf '%s' "$body" | sed -n 's/.*"replayOf":"\([^"]*\)".*/\1/p')"
  if [ -n "$replay" ]; then
    echo "This is ./mac/dev.sh serve replaying $replay, not the game. Stop it with Ctrl+C in its Terminal tab."
  fi
}

case "${1:-}" in
  bepinex) cmd_bepinex "${2:-}" ;;
  setup) cmd_setup ;;
  build) cmd_build ;;
  install) cmd_install ;;
  logs) cmd_logs ;;
  snap) cmd_snap ;;
  health) cmd_health ;;
  dashboard) cmd_dashboard ;;
  dump) cmd_dump ;;
  serve) cmd_serve "${2:-}" "${3:-}" ;;
  mcp) cmd_mcp "${2:-}" ;;
  where) need_game; echo "BepInEx: $BEPINEX" ;;
  *) sed -n '2,33p' "$0"; exit 1 ;;
esac
