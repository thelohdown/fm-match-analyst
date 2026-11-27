# FMMatchLens on macOS (local port)

This branch (`macos-port`) is a local attempt to run FMMatchLens on FM27 on
Apple Silicon Macs. Upstream FMMatchLens supports Windows only.

## Status

On macOS the plugin now runs **FMMatchLens's normal capture** with a macOS offset table
(`[macOS] Mode = capture`, the default; `./mac/dev.sh install` sets it). The local API on
`127.0.0.1:16726` and the dashboard work as on Windows for what is mapped.

**FM 27.1** (checked live on 26 Nov 2026, Steam, Apple Silicon): the match offsets, tactics and
attributes below are the 27.1 ones, in `Memory/Offsets.Mac.cs`. Against FM's own screens in a
Chicago v LAFC friendly, the tactic (style, mentality, both formations, all 22 roles) and one
player's 38 attributes matched, and a full match archived with substitutions and tactical changes.
The `macOS tactics check` and `macOS player record check` log lines say, per match, whether those
blocks sit where expected and where tactic- or player-shaped data sits if not. The offsets noted
further down this file are the 27.0 ones the mapping started from.

| Part | Status |
| --- | --- |
| Hook, memory checks, Mach-O parsing, detours | Working in game (FM27 demo and full release, Steam, BepInEx be.788 macOS package) |
| Match clock, period, full-time flag, ball, possession, ball holder | Mapped; verified live and against snapshots |
| Player positions, per-player stats, ratings, team stats, momentum events, xG | Mapped; FMMatchLens's own read code reproduces every number FM showed at full time (offline check below) |
| Player IDs, shirt numbers, birth dates, nationality, contract (wage, squad number) | Mapped; verified against snapshots |
| Competition ID and colours, team IDs and kit colours | Mapped; verified against snapshots |
| Player, club and competition names; managers; match date | Mapped; verified live (Chicago v LAFC: "Chicago", "LAFC", "Friendly", "test test", "Xavier Tamarit", 2025-12-30, every player's name). The capture logs a `macOS metadata check` line per match |
| Human v AI manager | Mapped: Itanium "offset to top" of the manager's person is 0x548 for a human manager and 0x208 for an AI one (Windows RTTI: 0x440 / 0x100) |
| Capture session (picking the animated match, archive, API, dashboard) | Working live: a whole match locked with no missing ticks and was archived; the dashboard shows names, ratings, stats, goals and substitutions |
| Momentum chart, shot map, xG timeline, heatmaps | Captured and archived. Replaying that match into the plugin's own API server (`./mac/dev.sh serve`) fills every panel in Chrome, both from kickoff and when the dashboard opens after full time. They were empty in the first live run, most likely because a dashboard opened late reads the whole match (about 1 GB of JSON) before drawing anything. The dashboard now draws each page as it arrives and logs history errors to the browser console instead of hiding them |
| In-match condition and sharpness | Captured (from the per-match stats object, laid out as on Windows) |
| Match clock shown by the dashboard in the second half | **Off by up to a couple of minutes**: the macOS `DisplayTick` field (0x15454) does not restart at 45:00. FM's own event records show its clock is engine tick minus first-half stoppage; the MCP server (`mcp/`) computes it that way |
| Attributes, position familiarity, height, body type, value, condition, sharpness, morale, ability, reputation | Mapped from graph snapshots: the ActualPlayer part sits 0x390 before the person record (Windows 0x288) and is laid out as on Windows from there. Checked across 50 players (heights such as Lewandowski 185 cm and Elliott 199 cm, every player 20 in his natural position, keepers alone with goalkeeping attributes). Each read is refused unless the familiarities are 1-20 with a natural position and every attribute 1-100 |
| Season stats | **Off on macOS**: the season stats object is not mapped |
| Tactics: formations in and out of possession, roles and duties, mentality, style, name, team instructions, the phase slot map, opposition instructions, each player's formation slot and opposition key | Mapped from graph snapshots of two matches: Chicago's "Wing Play" decodes to 4-2-3-1 / 4-3-3 DM Wide with FM's own role names and a coherent set of wing-play instructions (layout below). The command copy and the player-instruction lists are confirmed by the `macOS tactics check` log line on the first live match; until then the analyst and dashboard use the applied ("processing") copy |
| Rating research (rating engine internals) | **Off on macOS**: not mapped |

`Memory/Offsets.cs` keeps one table: fields that differ on macOS are `static readonly`
and chosen at start-up (`Offsets.IsMac`); everything still `const` is the same on both.

The read-only **probe** (`MODE=probe ./mac/dev.sh install`) is still there for mapping:
it hooks `GAME_MATCH` Advance, calls the original, then only reads. Every 5 seconds per
match object it logs candidate fields; it saves "graph" snapshots (`*-graph.bin`) of the
match, both teams, their players, the players' records and names, stats objects and the
momentum events to `BepInEx/plugins/FMMatchLens/data/mac-probe/`, automatically at a few
points and whenever a match stops for 5 seconds, or on request (`./mac/dev.sh snap`).
`./mac/dev.sh logs` copies them to `local/probe/`; `mac/read_graph.py` reads them.

### AI analyst (`mcp/`, `./mac/dev.sh mcp`)

`mcp/` is a read-only MCP server that lets Claude or Codex analyse the match from
FMMatchLens's capture, organised by the moments of the game (in possession, out of
possession, transitions, set pieces); see `mcp/README.md`. `./mac/dev.sh mcp` opens its
Claude Desktop bundle; `./mac/dev.sh mcp config` prints the Claude Code and Codex setup.
`./mac/dev.sh mcp codex` builds the shared server and adds Codex configuration
without modifying Claude settings (Node.js and Python 3.11+ required).
`./mac/dev.sh mcp codex-config` only prints the suggested configuration.

### Dashboard without the game (`./mac/dev.sh serve`)

`./mac/dev.sh serve` replays a match archive through the plugin's own timeline and local
API server, so the dashboard (`./mac/dev.sh dashboard`, in another Terminal tab) can be
tried without FM27: `serve` loads the newest archive at once, as if the dashboard were
opened at full time; `serve 30` replays it at 30x, as if it were open from kickoff;
`serve FILE.fmlens 1` replays a given archive in real time. FM27 must not be running,
since both use port 16726. While it runs, `/api/health` carries `replayOf` with the
archive's name, so `./mac/dev.sh health` and the AI analyst say it is a replay and not
the game; stop it with Ctrl+C before playing.

### Offline check (`mac/offline`)

`mac/offline --archive MATCH.fmlens` summarises an archive the capture wrote (frames,
momentum events, momentum points, pitch size), and `--archive-json MATCH.fmlens OUT`
writes its frames as the API sends them. `./mac/dev.sh dump` copies the newest archive
to `local/archives/`.

`mac/offline` runs the plugin's own capture code against a graph snapshot on Linux: it
maps the snapshot's objects back at their original addresses, forces the macOS offsets
(`FMMATCHLENS_MAC_OFFSETS=1`), and calls the capture's read paths directly (tick record,
team stats, event source, player frames, team/player/competition metadata). Given a
`local/truth/*.json` file of what FM showed, it checks the results. For the full-time
snapshot of Chicago 1-0 Atlanta United 2 every check passes: score, shots, shots on
target, xG, passes, passes completed, tackles won, fouls, distance, and all 22 ratings.

### Tactics layout (macOS, FM27 27.0.1)

The tactic lives in each team's manager context (`Team.Manager`, 0x640), as on
Windows, in two configuration blocks: "processing" (applied in the match) and
"command" (set by the manager). Differences from Windows:

| Field | Windows | macOS |
| --- | --- | --- |
| Processing configuration in the context | 0x1818 | 0x1800 |
| Command configuration | 0x2768 | 0x1800 + 2 x 0x7C0 (to confirm) |
| Personal opposition (26 x 3 bytes) | 0x16F8 | 0x16E0 |
| Position opposition count / entries | 0x1748 / 0x174C | 0x1730 / 0x1734 |
| Configuration size | 0x7A8 | 0x7C0 |
| In / out of possession positions (11 x 0x48) | 0x118 / 0x438 | 0x120 / 0x440 |
| Player override maps | 0x758 / 0x768 (MSVC map, 16 bytes) | 0x760 / 0x778 (libc++ map, 24 bytes) |
| Phase slot mapping (11 bytes) | 0x79C | 0x7B4 |
| `MatchPlayer.OppositionPositionKey` | 0xCE0 | 0xCD8 |

Team instructions (0xE0), name (0xF8), style key (0x100), mentality (0x105), the
position record (mask, role/duty, instruction vectors) and the player's roster
and formation slots (0x1E27 / 0x1E51) are as on Windows. libc++ maps are
{ begin, root, size } with nodes { left, right, parent, colour, key, value }.
The plugin refuses a block whose formations do not decode (goalkeeper first,
known positions), and walks override maps with the same bounds as on Windows.

## Alpha testers (`./mac/dev.sh release`)

`./mac/dev.sh release` builds the plugin and the analyst extension and packages
them with `mac/release/install.command` and `mac/release/README.txt` as
`local/release/FM-Match-Analyst-<version>.zip`. Testers need neither the repo, .NET nor
Node: they download the sortitoutsi BepInEx package, double-click
"Install FM Match Analyst.command", paste the launch option it copies into Steam, and
click Install in Claude Desktop. The installer finds FM27 in any Steam library,
installs BepInEx from Downloads (a zip, or the folder Safari unzipped), clears
macOS's quarantine flag, copies the plugin, and opens the extension. Run again,
it updates the plugin and, after an FM update, swaps in a newer BepInEx package
while keeping the plugins, settings and saved matches. `--uninstall` removes the
plugin and keeps the saved matches.

The installer is not signed, so macOS asks testers to allow it once (Privacy &
Security > Open Anyway); the README says how. A signed, notarized package needs
an Apple Developer account.

## One-time setup

1. Install the FM27 macOS BepInEx package from sortitoutsi. Put the
   `FM27-BepInEx` folder next to `fm.app`, add its `run_fm27_bepinex.sh` path
   plus `%command%` to Steam's Launch Options for FM27, launch once, and check
   `FM27-BepInEx/BepInEx/LogOutput.log` for "Chainloader startup complete".
   - The package needs Apple Silicon and the latest macOS. The first launch
     takes a few minutes while it makes an APFS clone of the game in
     `FM27-BepInEx/shadow/` and re-signs it with JIT entitlements; `fm.app`
     itself is never changed.
   - Because the clone is re-signed, `game_plugin`'s file hash differs from the
     Steam file, so the probe finds the hook by the arm64 signature instead.
   - Demo: the launcher looks up the AppID from an appmanifest whose
     `installdir` is exactly "Football Manager 27", which the demo's isn't. If
     `launch.log` shows `AppID   : not found` and the game will not start,
     write the demo's AppID to `steam_appid.txt` in the demo folder.
2. Install the .NET SDK: `brew install --cask dotnet-sdk`, or the macOS Arm64
   installer from dotnet.microsoft.com.
3. From this folder: `./mac/dev.sh setup`.

`./mac/dev.sh bepinex` does the unzip and `chmod` of step 1 from the newest
package in `~/Downloads` and puts the launch option on the clipboard; only the
Steam step is left to do by hand.

## Each iteration

```
./mac/dev.sh install   # build and copy the plugin into FM27-BepInEx
# launch FM27 from Steam, load a save, enter a match
./mac/dev.sh logs      # saves local/logs/latest.log and shows plugin lines
./mac/dev.sh health    # checks http://127.0.0.1:16726/api/health
./mac/dev.sh dashboard # opens the dashboard (best opened before kickoff)
```

## Findings (FM27 demo, Steam, macOS)

The native library is `fm.app/Contents/PlugIns/game_plugin.bundle/Contents/MacOS/game_plugin`,
a universal binary with x86_64 and arm64 slices (SHA-256 `c1298708d883972529621746f3e91dd90254a5ebd3569d388322be38f0b0107a`).

- **x86_64 slice, RVA `0x49985C0`:** the only function besides one sibling that opens
  with the Windows hook's MXCSR setup (`and 0xFFFF9FFF`, then `or 0x8000`). It then makes
  the Windows checks 0x10 lower: `[0x15560]==1`, `[0x1555E]==1`, `[0x15565]==0`.
- **arm64 slice, RVA `0x4499CC0`:** saves the third argument like the x86_64 version, makes
  the same three checks in the same order, is the same size (1,408 vs 1,376 bytes), and
  every one of its 13 large match-object offsets also appears in the x86_64 version.
  Other arm64 functions with the same guard share 3–4 offsets.

Offsets seen in both slices that line up with `Offsets.GameMatch` minus 0x10:

| Field (Windows) | Windows | macOS demo |
| --- | --- | --- |
| BallPosition | 0x12A40 | 0x12A30 |
| DisplayTick | 0x15464 | 0x15454 |
| Tick | 0x154EC | 0x154DC |
| RatingBaseCondition | 0x15500 | 0x154F0 |
| LifecycleStateA–D | 0x15568–0x1556B | 0x15558–0x1555B |
| hook checks | 0x1556E / 0x15570 / 0x15575 | 0x1555E / 0x15560 / 0x15565 |

Fields below 0x12A30 (for example `Competition` at 0x678) are not checked yet.

## Findings (FM27 full release, Steam, macOS)

The full game's `game_plugin` (SHA-256 `68adfde2…12a4` as shipped; the BepInEx
launcher's re-signed copy hashes differently) has the hook at arm64 RVA `0x44A6450`,
found by the same signature. Matches play live there, and the match clock, period and
ball position read correctly at the demo's offsets above. From live graph snapshots:

| Structure.Field | Windows | macOS | Evidence |
| --- | --- | --- | --- |
| Team.UniqueId | 0x2C | 0x2C | team IDs |
| Team.Background/Foreground/OutlineColour | 0x30/0x34/0x38 | same | ARGB kit colours |
| Team.PlayerTable | 0x138 | 0x140 | pointers to match players, starters first |
| Team.PlayerTableCount / PlayerCount | 0x72D / 0x72E | 0x73D / 0x73E | 24 for a 24-man matchday squad |
| MatchPlayer.Match | 0x160 | 0x160 | every player points back to the match |
| MatchPlayer.PositionX / PositionY | 0x140 / 0x144 | same | inside the pitch; substitutes lined up at x = -39.25 |
| MatchPlayer.PositionXAlt / YAlt | 0x80 / 0x84 | same | near PositionX/Y for players on the pitch |
| (match) player list | ? | 0x14ED0 | the same player pointers, both teams |

Match player objects are 0x1E60 bytes apart in memory. Each team object is 0x750 bytes.

Names and the player record (FM strings: int32 byte length, then UTF-8 text):

| Field | Windows | macOS | Evidence |
| --- | --- | --- | --- |
| MatchPlayer full name (string) | ? | 0x28 | "Chris Brady" |
| MatchPlayer surname (string) | ? | 0x30 | "Brady" |
| MatchPlayer.ShirtName (string) | 0x38 | 0x38 | "Brady, C" |
| MatchPlayer.Person | 0x28 | 0x20 | points into the player record, P below |
| Person.Uid | 0x0C | P+0x0C | same 32-bit ID also at MatchPlayer+0x48 |
| Person.FirstName / SecondName / CommonName / Nation | 0x50 / 0x58 / 0x60 / 0x68 | P-0xF0 / -0xE8 / -0xE0 / -0xD8 | pointers; CommonName empty for most |
| Person.City / DateOfBirth / FullContract / Traits | 0x80 / 0x88 / 0xA8 / 0xC0 | P-0xC0 / -0xB8 / -0x98 / -0x80 | DOB 2004, day 63 for Chris Brady |

The record is laid out differently from Windows (Itanium rather than MSVC ABI): it is a
0x3A8-byte object whose vtables sit at P-0x110, P and P+0x20, so the Windows block that
starts at FirstName lands 0xF0 before P, while the ID stays at P+0x0C. An attribute-like
byte block (values up to ~70) sits at P+0x168..0x1AF. None of these are mapped into the
capture code yet.

Checked against the game's own match screens (Chicago Fire v LAFC, 14 Nov 2026):

| Field | Windows | macOS | Evidence |
| --- | --- | --- | --- |
| MatchPlayer.ShirtNumber | 0xC9C | 0xC94 | all 11 starters' squad numbers (1, 2, 3, 4, 15, 42, 6, 11, 37, 19, 9) |
| MatchPlayer.RawInternalRating | 0x1D58 | 0x1D58 | int32, rating x 1000. The game shows it truncated to one decimal: all 11 starters' ratings matched at a second point (6.8 … 7.4), read from the match object that lags behind |
| MatchPlayer.Stats | 0x1880 | 0x1880 | pointer to the per-match stats object (now copied by the probe) |
| GameMatch.MomentumEventSource | 0x14EA8 | 0x14E98 | +0x08/+0x10 begin/end of 147 0x38-byte events at tick 1890 |

Checked at full time against every stat on FM's match screens (Chicago 1-0 Atlanta United 2,
friendly, 14 Nov 2026; snapshot taken automatically when the match stopped, tick 22609):

- **MomentumEvent: same layout as Windows.** 1,614 events of 0x38 bytes, team at 0x28,
  type at 0x2A, flags at 0x30. Shots 20/7, on target 9/2, woodwork 0/1, blocked 4/4,
  crosses 2 of 32 / 1 of 23, tackles 3 of 6 / 12 of 13, headers 9 of 24 / 14 of 23,
  yellow cards 0/2, offsides 0/1 and corners 11/5 (crosses with flag 0x40) all match.
  Raw pass events (497 of 547) exceed FM's 481 of 529, as the Windows code expects.
- **PlayerStats (MatchPlayer+0x1880 →): same layout as Windows.** Summed over each squad,
  Goals, Shots, ShotsOnTarget, Passes, PassesCompleted, Crosses, CrossesCompleted,
  TacklesAttempted/Won, Aerials/Won, Fouls, Offsides and YellowCards equal FM's team totals
  exactly; Goals names the scorer; xG (+0x1C) sums to 1.62 / 0.46 and DistanceM (+0x68) to
  109.6 / 107.5 km (FM: 109 / 107).
- **Rating shown = PlayerStats.RatingTimes100 (+0x82), truncated to one decimal:** all 22.

So team stats come from the events, as on Windows. While
a match is shown, FM keeps two match objects with the same teams, one several hundred
ticks ahead of the other (the Windows capture code distinguishes the animated instance).
The ratings on screen match the instance that is behind, so that is the one being shown.

The probe also saves a snapshot by itself when a match that has played a while stops
stepping for 5 seconds (the final whistle, or a pause), so full-time numbers are on disk
without asking. `./mac/dev.sh snap` asks for one of every live match on its next step,
so numbers the game is showing (player stats, ratings) can be matched to memory.

## Finding the hook

`mac/find_hook.py` ranks functions in the arm64 game library by how closely
their opening matches the Windows `GAME_MATCH` Advance entry: FPCR changes plus
byte checks at match+0x1556E, +0x15570 and +0x15575. It needs
`pip install lief capstone`. After `./mac/dev.sh setup`:

```
python3 mac/find_hook.py local/game/game_plugin.bundle/Contents/MacOS/game_plugin --shift=-0x10
```

`local/` is git-ignored. It holds copies of Sports Interactive's game files and
your logs, so keep it on this Mac.
