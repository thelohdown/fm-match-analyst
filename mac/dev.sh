#!/usr/bin/env bash
# Dev loop for the FMMatchLens macOS port. Run from Terminal on the Mac:
#
#   ./mac/dev.sh setup     copy BepInEx reference DLLs into the build, and copy
#                          FM27's native game library into local/ for analysis
#   ./mac/dev.sh build     build the plugin (needs the .NET 10 SDK)
#   ./mac/dev.sh install   build, then copy the plugin into FM27's BepInEx folder
#   ./mac/dev.sh logs      copy BepInEx's log into local/logs and show plugin lines
#   ./mac/dev.sh health    ask the running plugin's local API whether it is up
#
# Paths can be overridden with FM27_DIR and BEPINEX_DIR.
# Everything under local/ stays on this Mac: it is git-ignored, because it
# holds copies of Sports Interactive's files and your own logs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GAME="${FM27_DIR:-$HOME/Library/Application Support/Steam/steamapps/common/Football Manager 27}"
BEPINEX="${BEPINEX_DIR:-$GAME/FM27-BepInEx/BepInEx}"
LOCAL="$REPO/local"
PROJECT="$REPO/src/FMMatchLens.Plugin/FMMatchLens.Plugin.csproj"
PLUGIN_DLL="$REPO/src/FMMatchLens.Plugin/bin/Release/net6.0/FMMatchLens.Plugin.dll"
API="http://127.0.0.1:16726/api/health"

need_game() {
  if [ ! -d "$GAME" ]; then
    echo "FM27 was not found at: $GAME"
    echo "Set FM27_DIR to the folder that contains fm.app (Steam > FM27 > Manage > Browse local files)."
    exit 1
  fi
}

need_bepinex() {
  if [ ! -d "$BEPINEX/core" ]; then
    echo "BepInEx was not found at: $BEPINEX"
    echo "Install the FM27 macOS BepInEx package first (see mac/README.md), launch FM27 once, then retry."
    exit 1
  fi
}

cmd_setup() {
  need_game
  need_bepinex
  local lib="$REPO/src/FMMatchLens.Plugin/lib"
  mkdir -p "$lib" "$LOCAL/game"
  for name in BepInEx.Core.dll BepInEx.Unity.IL2CPP.dll MonoMod.RuntimeDetour.dll MonoMod.Utils.dll; do
    if [ -f "$BEPINEX/core/$name" ]; then
      cp "$BEPINEX/core/$name" "$lib/"
      echo "copied $name"
    else
      echo "WARNING: $name is missing from $BEPINEX/core"
    fi
  done

  # FM's match engine lives in a native library. Its exact name and location on
  # macOS are not confirmed yet, so copy every match and record what each one is.
  : > "$LOCAL/game/FOUND.txt"
  find "$GAME" -path "$GAME/FM27-BepInEx" -prune -o -iname '*game_plugin*' -print -prune | while IFS= read -r path; do
    echo "$path" >> "$LOCAL/game/FOUND.txt"
    cp -R "$path" "$LOCAL/game/"
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
}

cmd_build() {
  if ! command -v dotnet >/dev/null 2>&1; then
    echo "The .NET SDK is not installed. Install it with:  brew install --cask dotnet-sdk"
    exit 1
  fi
  if [ ! -f "$REPO/src/FMMatchLens.Plugin/lib/BepInEx.Core.dll" ]; then
    echo "Run ./mac/dev.sh setup first, so the BepInEx reference DLLs are in place."
    exit 1
  fi
  dotnet build "$PROJECT" --configuration Release -nologo
  echo "built: $PLUGIN_DLL"
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
  echo "installed to: $target"
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
  grep -n -i "Chainloader\|FMMatchLens\|\[macOS\]\|GAME_MATCH\|game_plugin" "$log" | tail -60 || true
}

cmd_health() {
  curl -sS --max-time 3 "$API" && echo || echo "No answer from $API (is FM27 running with the plugin loaded?)"
}

case "${1:-}" in
  setup) cmd_setup ;;
  build) cmd_build ;;
  install) cmd_install ;;
  logs) cmd_logs ;;
  health) cmd_health ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
