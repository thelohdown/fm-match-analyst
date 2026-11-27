# FM Analyst on a Mac: getting started

This fork runs FMMatchLens on macOS and adds an AI match analyst. You play Football
Manager 27 as normal; when you pause a match you can ask Claude what is going on and
what to change. It reads the match as it is played and never changes anything in the game.

It is an alpha. It has been played and checked on one Mac, on FM 27.1.

## What you need

- A Mac with Apple Silicon (M1 or later) on the latest macOS
- Football Manager 27 on Steam, version 27.1
- [Claude Desktop](https://claude.ai/download)
- The "FM27 BepInEx 6 IL2CPP for macOS (Apple Silicon)" package from
  [sortitoutsi.net](https://sortitoutsi.net), downloaded into your Downloads folder

There are two parts. The **plugin** sits inside FM and records the match. The **analyst**
is an extension in Claude Desktop that reads what the plugin records. You need both.

## Install with the installer zip

Use this if someone sent you `FM-Analyst-<version>.zip`. You need neither this
repository nor any developer tools.

1. Quit FM27.
2. Unzip the file and double-click **Install FM Analyst.command**.
   If macOS says it cannot be opened: System Settings > Privacy & Security, scroll
   down, click **Open Anyway**. The installer is not signed, so macOS asks once.
3. Paste the launch option it copied for you into Steam: right-click Football
   Manager 27 > Properties > General > Launch Options.
4. Click **Install** when Claude Desktop shows FM Match Analyst.
5. Launch FM27 from Steam. The first launch takes a few minutes while BepInEx
   prepares its own copy of the game; later launches are normal.

## Install from this repository

Use this if you want to build it yourself. You also need the .NET SDK
(`brew install --cask dotnet-sdk`) and Node.js 22 (`nvm use` picks it up from `.nvmrc`).

```sh
./mac/dev.sh bepinex   # unpacks the BepInEx package from Downloads, copies the Steam launch option
# paste the launch option into Steam, launch FM27 once, then quit it
./mac/dev.sh setup     # fetches what the plugin needs to compile
./mac/dev.sh install   # builds the plugin and copies it into FM (FM must be closed)
./mac/dev.sh mcp       # builds the analyst and opens it in Claude Desktop; click Install
```

To build the installer zip for someone else: `./mac/dev.sh release`. It lands in
`local/release/`.

## Your first match

Start FM27 from Steam and begin a match. Nothing needs switching on. Pause, and ask
Claude in Claude Desktop:

- "How is my match going?"
- "How are they playing?"
- After a tactical change and ten minutes: "Did that work?"
- After a goal: "Why did that happen?"
- Around 65': "Who should I take off?"
- At full time: "Build my post-match report."

With FM closed, "How did my last match go?" reads the last finished match from disk.

Prefer hints over full answers? Say "just hints" in the chat, or set Level of help in
Claude Desktop > Settings > Extensions > FM Match Analyst.

## What it can see on FM 27.1

| | |
| --- | --- |
| Score, clock, goals, cards, substitutions | Yes |
| Team and player stats, ratings, xG, every shot | Yes |
| Positions, shape, pass network, where the ball is won and lost | Yes |
| Your tactic: style, mentality, formations, roles, team instructions, and changes during the match | Yes |
| Player attributes, height, condition, sharpness | Yes |
| Season stats | Not yet |

Known rough edges:

- The tactic's name shows only its last part ("Wing Play" for "4-2-3-1 DM AM Wide - Wing Play").
- The browser dashboard's clock can run a couple of minutes off in the second half. The
  analyst works the clock out separately and is not affected.
- Matches recorded before tactics were mapped for 27.1 have no tactic. The analyst says
  so and asks you for it rather than guessing.

## After an FM update

The plugin reads the game's memory at places worked out for one exact version of FM.
A game update can move them.

- **The game will not start:** download the new BepInEx package from sortitoutsi
  (usually out within a day) and run the installer, or `./mac/dev.sh bepinex`, again.
  Your saved matches are kept.
- **The game starts but the analyst has no tactic, or odd numbers:** the plugin needs
  updating for that version. The analyst sets aside data that does not make sense
  rather than showing it, so missing data is the usual sign.

## If something is not working

- **Claude says there is no live match:** check FM was started from Steam with the
  launch option set, and that a match is on screen. From the repository,
  `./mac/dev.sh health` says whether the plugin is answering.
- **Claude says the newest match could not be read:** update the analyst extension. If
  you reinstall the same version number, uninstall it in Claude Desktop > Settings >
  Extensions first, then install again and restart Claude Desktop.
- **To see what the plugin did:** `./mac/dev.sh logs` saves the game's plugin log to
  `local/logs/latest.log` and prints the FMMatchLens lines. Without the repository,
  the log is `FM27-BepInEx/BepInEx/LogOutput.log` inside the game's folder.
- Do not run `./mac/dev.sh serve` (the offline replay) while FM is open: both use
  port 16726.

## Where your data is

Everything stays on your Mac. Saved matches are `.fmlens` files in
`FM27-BepInEx/BepInEx/plugins/FMMatchLens/data/matches` inside the game's folder.
Reports and your feedback are in `Documents/FM Match Analyst`.

When an answer is right or wrong, tell Claude ("that was useful", "that's wrong, they
were pressing high"). It saves your verdict to `feedback.jsonl` in that folder.

## Updating and uninstalling

- **Update:** run the new installer, or `git pull` then `./mac/dev.sh install` and
  `./mac/dev.sh mcp`.
- **Uninstall:** in Terminal, `"<path to>/Install FM Analyst.command" --uninstall`
  removes the plugin and keeps your saved matches. Then clear FM27's Launch Options in
  Steam and remove the extension in Claude Desktop > Settings > Extensions.

## More detail

- [mac/README.md](README.md): how the macOS port works and what has been verified
- [mcp/README.md](../mcp/README.md): the analyst's tools, reports, and use from Claude Code or Codex
- [README.md](../README.md): upstream FMMatchLens, the dashboard, and the Windows install
