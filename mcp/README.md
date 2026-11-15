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
ask in a chat. The server's instructions tell the model how to work the way
match analysts do: frame everything by the game state, go through the moments of
the game (in possession, out of possession, transitions, set pieces) for both
teams, compare with the opponent, with earlier and with what the tactic asked
for, cite numbers and minutes, and suggest only changes FM lets you make.
There are also five prompts: `half_time_briefing`, `who_to_sub`,
`match_review`, and the two printable reports, `post_match_report` and
`half_time_report`.

### Printable reports

Ask for a report (or use the prompts) and the analyst builds the page analysts
hand a manager: the post-match one-pager after full time (verdict, match flow
with xG and momentum, shot maps, the moments of the game for both teams, both
teams' plans against what happened, average positions with passing links, the
player table) or the half-time sheet at the break (three decisions for the second
half, how the half turned, what the opponent is doing, the plan so far, players
to watch with bench options). Every number and chart is worked out from the
match by `build_report`; the analyst writes only the verdict, the decisions and
the plan checks. The page is saved as one HTML file in
`~/Documents/FM Match Analyst/reports` (or `FM_ANALYST_DATA_DIR/reports`), sized
for landscape US Letter: open it in a browser and print it or save a PDF. The
user's team is blue and the opponent orange throughout, and no status relies on
red and green.

Without the game, `./mac/dev.sh serve` replays an archive into the local API (as
if the match were live; the analyst says it is a replay), and the server falls
back to the newest archive when nothing is live.

## Tools

| Tool | What it returns |
| --- | --- |
| `get_briefing` | Everything for "what should I do?" in one call, by moment of the game: the game state (score, time left, momentum, mentalities); what stands out (problems and what is working, against the opponent and earlier); in possession, out of possession and transitions for both teams, the last 15 minutes against earlier in the half; set pieces; each measurable team instruction against what happened; recent shots with how each came about; who is tiring, fading, struggling or standing out; both tactics with recent changes; your latest tactical change, before against after; the last 10 minutes' events; and the bench with condition, sharpness and key attributes |
| `get_phases` | The moments of the game for any stretch: in possession (time in build-up, progression and final third; possessions reaching the final third and box; entries by channel; shot quality; crossing; long passing; width), out of possession (block and line height per opponent phase, compactness, where the opponent gets in, box entries conceded, pressing, duels), transitions (open-play regains, fast breaks, losses, losses in your own third, won back within 5 s, shots within 15 s either way) and set pieces |
| `get_changes` | Did the change work? Each tactical change during the match (mentality, shape, roles, team instructions): up to 15 minutes before against up to 15 minutes after, per 10 minutes, for attacking, pressing, the defensive line, ball losses and what was conceded; what got better, worse or moved, and what else happened in those stretches (goals, red cards, substitutions, the other side changing). Defaults to your team |
| `get_match_state` | Score, clock, which team you manage, xG, shots, possession (match and last 10'), FM's momentum by five minutes and lately, goals, cards, substitutions, data gaps |
| `get_team_stats` | Per half, per 15 minutes or one window: goals, xG, shots, clear-cut chances, possession, territory by third, passing, crosses, corners, aerials, tackles, fouls, offsides, cards |
| `get_players` | Per player: position and role (from the tactic, or inferred), natural positions, started/came on/went off, minutes, rating and its change, condition and sharpness and their change, and stats over the window; with `include_attributes`, FM's 1-20 attributes and height (never current or potential ability, which the game does not show) |
| `get_events` | Goals, shots (xG, outcome, location), cards, subs; on request big chances, corners, fouls, offsides, saves, key passes, turnovers |
| `get_shape` | Average positions in and out of possession, defensive line, length, width, territory, pass network, where the ball is won and lost |
| `get_tactic` | The applied tactic: formations in and out of possession, each player's role and duty, mentality, team, transition, player and opposition instructions, and changes during the match |
| `list_matches`, `load_match` | The live match and the archives; switch between them |
| `build_report` | A printable post-match one-pager or half-time sheet, saved as an HTML page: every number and chart from the match, with the analyst's verdict, decisions and plan checks (only when the user asks for one) |
| `note_feedback` | Saves your verdict on an answer (with your words, the question, the advice and the match situation) to `feedback.jsonl` in `~/Documents/FM Match Analyst` or `FM_ANALYST_DATA_DIR` |

Every answer is checked first: team totals must equal the sum of the players'
(shots, shots on target, passes, fouls, xG, goals), the pitch, player counts,
ratings and condition must be sane. If not, the answer opens with "DATA CHECK
FAILED" and the analyst is told not to advise from those numbers; this is what
an FM update that moves FMMatchLens's memory reads looks like.

Every tool that covers a stretch of play takes `half` (first, second, extra),
`from_minute`/`to_minute`, or `last_minutes`.

## How it works

- Frames from the API or an archive go through FMMatchLens's dashboard code
  (`../frontend/src`, bundled in): its archive reader and its history
  derivations (shots with xG, goals, cards, momentum, on-ball events).
- On top of that the server keeps cumulative team and player stats at the end of
  every match minute, so any window is a difference of two of them, and samples
  positions once a second for shape and average positions.
- Possession is followed frame by frame (4 a second) into spells, each labelled
  as won in open play or given by a restart (the ball out of play, a foul or
  offside, a kick-off). With the shape samples and the event stream that gives
  the phases of play: time in build-up, progression and final third, the block
  and line height for each opponent phase, final-third and box entries by
  channel, fast breaks, counter-pressing, and shots by how they came about
  (settled, within 15 s of a regain, set piece). Checked against FM: every shot
  falls in exactly one phase, and open-play crosses plus corner deliveries add up
  to FM's crosses.
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
40000) and `FM_ANALYST_DATA_DIR` (where feedback is saved).

## Known gaps

- On macOS FMMatchLens does not capture morale or season stats yet. Tactics and
  attributes are captured from FM27 27.0.1 on (matches recorded before that have
  neither, and zones are inferred from where players stood).
- Pressing is measured from events (ppda, high regains), not from how close
  players get to the ball, so it is a comparison between teams and spells rather
  than an absolute.
- The analyst guidance (`analyst/fm-analyst.md`) has not yet been through the
  blind test of match situations in the product plan.
