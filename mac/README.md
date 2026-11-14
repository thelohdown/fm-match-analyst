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
| `GAME_MATCH` Advance hook in the arm64 build | **Not found yet** (`PatternArm64` is empty, so capture stays off) |
| Native memory offsets (`Memory/Offsets.cs`) on macOS | **Unverified** |

Until the hook is found, the plugin should load, start its local API and log
what it finds about the game library under `[macOS]` lines, but it will not
capture matches.

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

## Finding the hook

`mac/find_hook.py` ranks functions in the arm64 game library by how closely
their opening matches the Windows `GAME_MATCH` Advance entry: FPCR changes plus
byte checks at match+0x1556E, +0x15570 and +0x15575. It needs
`pip install lief capstone`. After `./mac/dev.sh setup`:

```
python3 mac/find_hook.py local/game/<arm64 game_plugin binary>
```

`local/` is git-ignored. It holds copies of Sports Interactive's game files and
your logs, so keep it on this Mac.
