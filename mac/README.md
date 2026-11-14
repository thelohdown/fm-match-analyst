# FMMatchLens on macOS (local port)

This branch (`macos-port`) is a local attempt to run FMMatchLens on FM27 on
Apple Silicon Macs. Upstream FMMatchLens supports Windows only.

## Status

| Part | Status |
| --- | --- |
| Memory region checks (`mach_vm_region` instead of `VirtualQuery`) | Written, compiles; untested in game |
| Finding the game library (dyld instead of `GetModuleHandle`) | Written, compiles; untested in game |
| Executable ranges and function entries from Mach-O load commands | Written; tested against a real arm64 Mach-O (matches LIEF) |
| Graphics folder default (`~/Library/Application Support/...`) | Written |
| `GAME_MATCH` Advance hook in the arm64 build | **Located** in the FM27 demo (see Findings); hooked by the read-only probe, not tested live yet |
| Native memory offsets (`Memory/Offsets.cs`) on macOS | **Partly mapped**: fields near the end of `GAME_MATCH` sit 0x10 lower than on Windows |

On macOS the plugin runs a **read-only probe** instead of the full capture until
the macOS offsets are verified (`[macOS] Mode = probe` in
`BepInEx/config/com.fmmatchlens.plugin.cfg`; `capture` switches back). The probe
hooks `GAME_MATCH` Advance, calls the original, then only reads: every 5 seconds
per match object it logs candidate fields (ticks, period, lifecycle and check
bytes, ball position, team pointers) at the shifted offsets, with the Windows
offsets alongside, and it saves raw snapshots of the match object and both team
objects to `BepInEx/plugins/FMMatchLens/data/mac-probe/`. `./mac/dev.sh logs`
copies them to `local/probe/`.

## One-time setup

1. Install the FM27 macOS BepInEx package from sortitoutsi. Put the
   `FM27-BepInEx` folder next to `fm.app`, add its `run_fm27_bepinex.sh` path
   plus `%command%` to Steam's Launch Options for FM27, launch once, and check
   `FM27-BepInEx/BepInEx/LogOutput.log` for "Chainloader startup complete".
2. Install the .NET SDK: `brew install --cask dotnet-sdk`.
3. From this folder: `./mac/dev.sh setup`.

## Each iteration

```
./mac/dev.sh install   # build and copy the plugin into FM27-BepInEx
# launch FM27 from Steam, load a save, enter a match
./mac/dev.sh logs      # saves local/logs/latest.log and shows plugin lines
./mac/dev.sh health    # checks http://127.0.0.1:16726/api/health
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

Fields below 0x12A30 (for example `Competition` at 0x678) and the layouts of other
objects (teams, players, tactics) are not checked yet. The demo may also differ from
the full release build.

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
