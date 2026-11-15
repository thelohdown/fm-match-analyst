# FM Match Analyst (MCP server)

A read-only [MCP](https://modelcontextprotocol.io) server that lets Claude
(Desktop or Code) and Codex analyse a Football Manager 27 match from
FMMatchLens's capture. Pause a match and ask "why are we losing the midfield?",
"who should come off?", or "how did the second half go?": the answer comes from
the match's own numbers. It never changes anything in the game.

It reads the match FMMatchLens is capturing through its local API
(`127.0.0.1:16726`), or, when FM is not running, the `.fmlens` archives
FMMatchLens saves after each match.

## Install

**Claude Desktop** (no Node.js needed; Claude Desktop runs it):

```
./mac/dev.sh mcp          # opens mcp/dist/fm-match-analyst.mcpb; Claude Desktop asks to install it
```

or double-click `mcp/dist/fm-match-analyst.mcpb`. Settings (optional): the API
address and the archive folder.

**Claude Code and Codex** need Node.js 18+ on the PATH. `./mac/dev.sh mcp config`
prints the exact lines:

```
claude mcp add --scope user fm-match-analyst -- node /path/to/mcp/dist/server.mjs
```

```toml
# ~/.codex/config.toml
[mcp_servers.fm-match-analyst]
command = "node"
args = ["/path/to/mcp/dist/server.mjs"]
tool_timeout_sec = 90
```

## Use

With FM27 running (BepInEx and the FMMatchLens plugin installed) and a match on,
ask in a chat. The server's instructions tell the model how to work: start with
the match state, cite numbers and minutes, suggest only changes FM lets you make.
There are also three prompts: `half_time_briefing`, `who_to_sub` and
`match_review`.

Without the game, `./mac/dev.sh serve` replays an archive into the local API (as
if the match were live), and the server falls back to the newest archive when
nothing is live.

## Tools

| Tool | What it returns |
| --- | --- |
| `get_match_state` | Score, clock, which team you manage, xG, shots, possession (match and last 10'), FM's momentum by five minutes and lately, goals, cards, substitutions, data gaps |
| `get_team_stats` | Per half, per 15 minutes or one window: goals, xG, shots, clear-cut chances, possession, territory by third, passing, crosses, corners, aerials, tackles, fouls, offsides, cards |
| `get_players` | Per player: zone, started/came on/went off, minutes, rating and its change, condition and sharpness and their change, and stats over the window |
| `get_events` | Goals, shots (xG, outcome, location), cards, subs; on request big chances, corners, fouls, offsides, saves, key passes, turnovers |
| `get_shape` | Average positions in and out of possession, defensive line, length, width, territory, pass network, where the ball is won and lost |
| `get_tactic` | The captured tactic (not captured on macOS yet) |
| `list_matches`, `load_match` | The live match and the archives; switch between them |

Every tool that covers a stretch of play takes `half` (first, second, extra),
`from_minute`/`to_minute`, or `last_minutes`.

## How it works

- Frames from the API or an archive go through FMMatchLens's dashboard code
  (`../frontend/src`, bundled in): its archive reader and its history
  derivations (shots with xG, goals, cards, momentum, on-ball events).
- On top of that the server keeps cumulative team and player stats at the end of
  every match minute, so any window is a difference of two of them, and samples
  positions once a second for shape and average positions.
- Positions are turned into each team's own point of view: which end a team
  defends in each period comes from where its goalkeeper stands; left and right
  are as the team attacks. Checked on a real match: Chicago's Gutman and Bamba
  on the left, Zinckernagel and Barroso on the right, LAFC's Palencia on the right.
- Times are FM's match clock, worked out from engine ticks (4 a second): the
  second half restarts at 45:00, and minutes are labelled as FM does (18',
  45+2'). FM's own event records confirmed it: a penalty at 81:38 that FM listed
  at 82'.
- Live, it catches up on the match at start-up and then follows it every 3
  seconds, so a question while paused is answered from data that is already in.

## Develop

```
npm ci
node build.mjs            # dist/server.mjs
node build.mjs --mcpb     # also dist/fm-match-analyst.mcpb
npm run typecheck
FM_ANALYST_TEST_ARCHIVE=../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens npm test
node scripts/call.mjs '[["get_match_state"],["get_players",{"team":"mine","last_minutes":15}]]'
```

`scripts/call.mjs` talks to the built server over stdio like a client would.
Environment: `FMMATCHLENS_API` (default `http://127.0.0.1:16726`),
`FMMATCHLENS_ARCHIVE_DIR` (extra archive folders, `:`-separated), and
`FM_ANALYST_LIVE_WAIT_MS` (how long a tool waits for the live catch-up, default
40000).

## Known gaps

- On macOS FMMatchLens does not capture tactics, positions/roles, attributes,
  morale or season stats yet, so zones are inferred and `get_tactic` says so.
- The analyst guidance (`analyst/fm-analyst.md`) is a first draft: it has not
  been through the blind test of match situations in the product plan.
