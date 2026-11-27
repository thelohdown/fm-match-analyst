#!/bin/bash
# FM Tinkerman installer for alpha testers (macOS, Apple Silicon, FM27 on Steam).
#
# Double-click this file. It:
#   1. checks this Mac can run it, and that FM27 is closed;
#   2. finds FM27 in your Steam libraries;
#   3. installs the FM27 macOS BepInEx package from your Downloads folder, if it
#      is not installed yet (download it from sortitoutsi first);
#   4. installs the FMMatchLens capture plugin;
#   5. puts the Steam launch option on your clipboard, if it is not set yet;
#   6. opens the FM Tinkerman extension, so Claude Desktop installs it.
# Run it again to update. Nothing in fm.app is changed.
#
#   "Install FM Tinkerman.command" --uninstall   removes the plugin again
#
# FM27_DIR=/path/to/folder/with/fm.app overrides where FM27 is looked for.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FILES="$HERE/files"
VERSION="$(cat "$FILES/VERSION" 2>/dev/null || echo "unknown")"
GAME="${FM27_DIR:-}"
DOWNLOADS="${FM_DOWNLOADS_DIR:-$HOME/Downloads}"
SORTITOUTSI="https://sortitoutsi.net"
CLAUDE_DOWNLOAD="https://claude.ai/download"
INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '  • %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
finish() {
  echo
  if [ "$INTERACTIVE" = 1 ]; then read -r -p "Press Return to close this window. " _ || true; fi
  exit "${1:-0}"
}
fail() {
  printf '\n  \033[31m✗\033[0m %s\n' "$1"
  shift
  for line in "$@"; do echo "    $line"; done
  echo
  echo "    Nothing else was changed. Fix the above and double-click the installer again."
  echo "    Stuck? Send a screenshot of this window to whoever sent you the installer."
  finish 1
}
ask() {
  # ask "question" -> reply in $REPLY; empty when not interactive
  REPLY=""
  if [ "$INTERACTIVE" = 1 ]; then read -r -p "  $1 " REPLY || true; fi
}

# ---------------------------------------------------------------------------
# Finding FM27 (the same search as mac/dev.sh)

app_version() { defaults read "$1/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown"; }

list_fm_apps() {
  {
    for root in "$HOME/Library/Application Support/Steam/steamapps/common" "/Applications" "$HOME/Applications"; do
      [ -d "$root" ] && find "$root" -maxdepth 3 -name 'fm.app' -type d 2>/dev/null
    done
    local vdf="$HOME/Library/Application Support/Steam/steamapps/libraryfolders.vdf"
    if [ -f "$vdf" ]; then
      sed -n 's/.*"path"[[:space:]]*"\(.*\)".*/\1/p' "$vdf" | while IFS= read -r lib; do
        [ -d "$lib/steamapps/common" ] && find "$lib/steamapps/common" -maxdepth 3 -name 'fm.app' -type d 2>/dev/null
      done
    fi
    command -v mdfind >/dev/null 2>&1 && mdfind 'kMDItemFSName == "fm.app"' 2>/dev/null
  } | sort -u
}

find_game() {
  [ -n "$GAME" ] && return 0
  local app pass apps
  apps="$(list_fm_apps)"
  for pass in full demo; do
    while IFS= read -r app; do
      [ -n "$app" ] || continue
      case "$(dirname "$app")" in *[Dd]emo*) [ "$pass" = demo ] || continue ;; esac
      case "$(dirname "$app")|$(app_version "$app")" in
        *27*) GAME="$(dirname "$app")"; return 0 ;;
      esac
    done <<< "$apps"
  done
  return 1
}

# ---------------------------------------------------------------------------

uninstall() {
  bold "Removing the FM Tinkerman capture plugin"
  find_game || fail "FM27 was not found." "Run it as: FM27_DIR=\"/path/to/Football Manager 27\" \"$0\" --uninstall"
  local plugin="$GAME/FM27-BepInEx/BepInEx/plugins/FMMatchLens"
  if [ -f "$plugin/FMMatchLens.Plugin.dll" ]; then
    rm -f "$plugin/FMMatchLens.Plugin.dll" && ok "Removed the plugin from $plugin"
  else
    ok "The plugin was not installed."
  fi
  echo
  note "Your saved matches stay in $plugin/data; delete that folder too if you do not want them."
  note "BepInEx stays, in case you use it for other mods. To stop using it, clear FM27's Launch Options in Steam (Properties > General)."
  note "To remove the extension: Claude Desktop > Settings > Extensions > FM Tinkerman > Uninstall."
  finish 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

clear 2>/dev/null || true
bold "FM Tinkerman installer (alpha $VERSION)"
echo

# 1. This Mac -----------------------------------------------------------------
bold "1. Checking this Mac"
[ -f "$FILES/FMMatchLens.Plugin.dll" ] && [ -f "$FILES/fm-match-analyst.mcpb" ] ||
  fail "The installer's files are missing." "Keep \"Install FM Tinkerman.command\" next to the \"files\" folder it came with, then try again."
[ "$(uname -m)" = "arm64" ] ||
  fail "This Mac has an Intel processor." "The FM27 BepInEx package for macOS only runs on Apple Silicon (M1 or later)."
ok "Apple Silicon"
macos="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if [ "${macos%%.*}" -lt 26 ] 2>/dev/null; then
  warn "macOS $macos: the BepInEx package is built for the latest macOS. If FM will not start with it, update macOS first."
else
  ok "macOS $macos"
fi
if pgrep -xq fm 2>/dev/null; then
  fail "Football Manager is running." "Quit FM27 (not just to the menu), then double-click the installer again."
fi
ok "Football Manager is closed"

# 2. FM27 ---------------------------------------------------------------------
echo
bold "2. Finding FM27"
if ! find_game; then
  warn "FM27 was not found automatically."
  note "In Steam: right-click Football Manager 27 > Manage > Browse local files."
  ask "Drag that folder into this window, then press Return:"
  GAME="$(printf '%s' "$REPLY" | sed -e "s/^[[:space:]'\"]*//" -e "s/[[:space:]'\"]*$//" -e 's/\\ / /g')"
fi
[ -n "$GAME" ] && [ -d "$GAME/fm.app" ] ||
  fail "No fm.app in \"${GAME:-the folder given}\"." "Use the folder Steam opens from Manage > Browse local files."
case "$GAME" in
  *steamapps*) ;;
  *) warn "This copy of FM is not in a Steam library. Only the Steam version is supported; carrying on anyway." ;;
esac
ok "$GAME (version $(app_version "$GAME/fm.app"))"
BEPINEX_HOME="$GAME/FM27-BepInEx"
LAUNCHER="$BEPINEX_HOME/run_fm27_bepinex.sh"

# 3. BepInEx --------------------------------------------------------------------
echo
bold "3. BepInEx (lets FM load the capture plugin)"
find_package() {
  # Newest zip, or a folder Safari already unzipped.
  local zip dir
  zip="$(ls -t "$DOWNLOADS"/FM27-BepInEx*.zip 2>/dev/null | head -1)"
  dir="$(find "$DOWNLOADS" -maxdepth 4 -name run_fm27_bepinex.sh -not -path "$GAME/*" 2>/dev/null | head -1)"
  if [ -n "$zip" ]; then echo "zip:$zip"; elif [ -n "$dir" ]; then echo "dir:$(dirname "$dir")"; fi
}
package_name() { basename "${1#*:}"; }
install_package() {
  local package="$1" tmp found src
  case "$package" in
    zip:*)
      note "Unzipping $(package_name "$package")"
      tmp="$(mktemp -d)"
      unzip -q "${package#zip:}" -d "$tmp" || fail "Could not unzip $(package_name "$package")." "Download it again; it may be incomplete."
      found="$(find "$tmp" -maxdepth 3 -name run_fm27_bepinex.sh | head -1)"
      [ -n "$found" ] || fail "$(package_name "$package") does not look like the FM27 macOS BepInEx package." "It should contain run_fm27_bepinex.sh."
      rm -rf "$BEPINEX_HOME.partial"
      mv "$(dirname "$found")" "$BEPINEX_HOME.partial" && rm -rf "$tmp"
      ;;
    dir:*)
      src="${package#dir:}"
      note "Copying $src"
      rm -rf "$BEPINEX_HOME.partial"
      cp -R "$src" "$BEPINEX_HOME.partial" || fail "Could not copy $src."
      ;;
  esac
  [ -f "$BEPINEX_HOME.partial/run_fm27_bepinex.sh" ] || fail "The package has no run_fm27_bepinex.sh." "Download it again from sortitoutsi."
  if [ -e "$BEPINEX_HOME" ]; then
    # An update: keep the plugins (with the match archives) and their settings.
    mkdir -p "$BEPINEX_HOME.partial/BepInEx"
    for keep in plugins config; do
      [ -d "$BEPINEX_HOME/BepInEx/$keep" ] && cp -R "$BEPINEX_HOME/BepInEx/$keep" "$BEPINEX_HOME.partial/BepInEx/"
    done
    local old="$BEPINEX_HOME.old-$(date +%Y%m%d%H%M%S)"
    mv "$BEPINEX_HOME" "$old" && note "The previous BepInEx folder is kept as $(basename "$old"); delete it once FM starts fine."
  fi
  mv "$BEPINEX_HOME.partial" "$BEPINEX_HOME"
  package_name "$package" > "$BEPINEX_HOME/.installed-package"
  [ -d "$BEPINEX_HOME/BepInEx/core" ] || warn "No BepInEx/core folder in the package; if FM does not start with it, download the package again."
}

package="$(find_package)"
if [ -f "$LAUNCHER" ] && [ -d "$BEPINEX_HOME/BepInEx/core" ]; then
  installed_from="$(cat "$BEPINEX_HOME/.installed-package" 2>/dev/null)"
  if [ -n "$package" ] && [ "$(package_name "$package")" != "$installed_from" ]; then
    default="n"; [ -n "$installed_from" ] && default="y"
    note "Installed: ${installed_from:-not recorded}. In Downloads: $(package_name "$package")."
    ask "Install the one from Downloads (do this after an FM update)? [y/n, Return = $default]"
    case "${REPLY:-$default}" in
      [Yy]*) install_package "$package"; ok "Updated" ;;
      *) ok "Kept the installed BepInEx" ;;
    esac
  else
    ok "Already installed"
  fi
else
  while [ -z "$package" ]; do
    warn "The FM27 macOS BepInEx package is not in your Downloads folder."
    note "On sortitoutsi, download \"FM27 BepInEx 6 IL2CPP for macOS (Apple Silicon)\" into Downloads."
    [ "$INTERACTIVE" = 1 ] && open "$SORTITOUTSI" 2>/dev/null
    ask "Press Return once it has downloaded (or type q to stop):"
    [ "$INTERACTIVE" = 1 ] && [ "$REPLY" != "q" ] || fail "BepInEx is needed." "Download the package, then double-click the installer again."
    package="$(find_package)"
  done
  install_package "$package"
  ok "Installed in $BEPINEX_HOME"
fi
# Downloaded files are quarantined, and macOS refuses to load quarantined libraries.
xattr -dr com.apple.quarantine "$BEPINEX_HOME" 2>/dev/null || true
chmod +x "$LAUNCHER" 2>/dev/null || true

# 4. Capture plugin ---------------------------------------------------------------
echo
bold "4. FMMatchLens capture plugin"
plugin_dir="$BEPINEX_HOME/BepInEx/plugins/FMMatchLens"
mkdir -p "$plugin_dir" || fail "Could not create $plugin_dir."
had="$( [ -f "$plugin_dir/FMMatchLens.Plugin.dll" ] && echo updated || echo installed)"
cp "$FILES/FMMatchLens.Plugin.dll" "$plugin_dir/" || fail "Could not copy the plugin into $plugin_dir."
xattr -dr com.apple.quarantine "$plugin_dir" 2>/dev/null || true
cfg="$BEPINEX_HOME/BepInEx/config/com.fmmatchlens.plugin.cfg"
if [ -f "$cfg" ] && grep -q '^Mode = probe' "$cfg"; then
  sed -i '' -e 's/^Mode = probe/Mode = capture/' "$cfg" 2>/dev/null || sed -i -e 's/^Mode = probe/Mode = capture/' "$cfg"
  note "Switched the plugin from probe to capture mode"
fi
ok "Plugin $had ($(cat "$FILES/PLUGIN_VERSION" 2>/dev/null || echo "version unknown"))"

# 5. Steam launch option -------------------------------------------------------------
echo
bold "5. Steam launch option"
option="\"$LAUNCHER\" %command%"
if grep -qs "run_fm27_bepinex.sh" "$HOME/Library/Application Support/Steam/userdata/"*/config/localconfig.vdf; then
  ok "Already set"
  LAUNCH_SET=1
else
  LAUNCH_SET=0
  printf '%s' "$option" | pbcopy 2>/dev/null && ok "Copied to your clipboard:" || note "Copy this line:"
  echo "      $option"
  note "In Steam: right-click Football Manager 27 > Properties > General > Launch Options, paste it in, close the window."
fi

# 6. Claude Desktop extension -------------------------------------------------------
echo
bold "6. FM Tinkerman extension for Claude Desktop"
if [ -d "/Applications/Claude.app" ] || [ -d "$HOME/Applications/Claude.app" ] || mdfind 'kMDItemCFBundleIdentifier == "com.anthropic.claudefordesktop"' 2>/dev/null | grep -q .; then
  open "$FILES/fm-match-analyst.mcpb" 2>/dev/null && ok "Opened: click Install in Claude Desktop (choose your Level of help there if you like)" ||
    warn "Could not open it: double-click files/fm-match-analyst.mcpb yourself."
else
  warn "Claude Desktop is not installed. Get it from $CLAUDE_DOWNLOAD, then double-click files/fm-match-analyst.mcpb."
  [ "$INTERACTIVE" = 1 ] && open "$CLAUDE_DOWNLOAD" 2>/dev/null
fi

# Done ------------------------------------------------------------------------------
echo
bold "Done. Next:"
step=1
if [ "$LAUNCH_SET" = 0 ]; then echo "  $step. Paste the launch option into Steam (step 5)."; step=$((step + 1)); fi
if [ ! -d "$BEPINEX_HOME/shadow" ]; then
  echo "  $step. Launch FM27 from Steam. The first launch takes a few minutes while BepInEx prepares its copy of the game; later launches are normal."
else
  echo "  $step. Launch FM27 from Steam."
fi
step=$((step + 1))
echo "  $step. Start a match, pause it, and ask Claude: \"how is my match going?\""
echo
note "To update FM Tinkerman, run the new installer. If an FM update stops the game starting, download the new BepInEx package from sortitoutsi (usually out within a day) and run this installer again: it swaps it in and keeps your matches."
finish 0
