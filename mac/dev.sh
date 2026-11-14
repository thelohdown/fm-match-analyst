#!/usr/bin/env bash
# Dev loop for the FMMatchLens macOS port. Run from Terminal on the Mac:
#
#   ./mac/dev.sh setup     copy FM27's native game library into local/ for analysis,
#                          and BepInEx's reference DLLs into the build once installed
#   ./mac/dev.sh build     build the plugin (needs the .NET 10 SDK)
#   ./mac/dev.sh install   build, then copy the plugin into FM27's BepInEx folder
#   ./mac/dev.sh logs      copy BepInEx's log into local/logs and show plugin lines
#   ./mac/dev.sh health    ask the running plugin's local API whether it is up
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

# FM27 is the fm.app whose folder name or version says 27.
find_game() {
  [ -n "$GAME" ] && return 0
  local app
  while IFS= read -r app; do
    [ -n "$app" ] || continue
    case "$(dirname "$app")|$(app_version "$app")" in
      *27*) GAME="$(dirname "$app")"; return 0 ;;
    esac
  done <<APPS
$(list_fm_apps)
APPS
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
# for new Terminal windows, so look in the usual places too.
find_dotnet() {
  local candidate
  for candidate in "$(command -v dotnet 2>/dev/null || true)" \
                   /usr/local/share/dotnet/dotnet /opt/homebrew/bin/dotnet "$HOME/.dotnet/dotnet"; do
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
  local probe="$BEPINEX/plugins/FMMatchLens/data/mac-probe"
  if [ -d "$probe" ]; then
    mkdir -p "$LOCAL/probe"
    cp "$probe"/*.bin "$LOCAL/probe/" 2>/dev/null || true
    echo "probe snapshots in local/probe: $(ls "$LOCAL/probe" | wc -l | tr -d ' ')"
  fi
  grep -n -i "Chainloader\|FMMatchLens\|\[macOS\|GAME_MATCH\|game_plugin" "$log" | tail -60 || true
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
  where) need_game; echo "BepInEx: $BEPINEX" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
