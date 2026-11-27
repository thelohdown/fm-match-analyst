# FM Match Analyst

An AI match analyst for Football Manager 27. Play as normal, pause a match, and ask
Claude what is going on and what to change: "How is my match going?", "Did that change
work?", "Who should I take off?". At full time it builds a printable post-match report.

It reads the match as it is played and never changes anything in the game. Everything
stays on your computer.

**Status: alpha.** Played and checked on one Mac (Apple Silicon), on FM 27.1 from Steam.

## Start here

**[Getting started on a Mac](../mac/GETTING-STARTED.md)**: what you need, how to install,
your first match, and what to do when something is not working.

## How it fits together

| Part | What it does | Where |
| --- | --- | --- |
| Capture plugin | Sits inside FM and records the match: score, stats, ratings, shots, positions, your tactic, player attributes | `src/`, macOS notes in [mac/README.md](../mac/README.md) |
| FM Match Analyst | An extension for Claude Desktop (also Claude Code and Codex) that reads what the plugin records and answers your questions | [mcp/](../mcp/README.md) |
| Dashboard | A live match dashboard in the browser, from upstream | `frontend/` |

## What it can see on FM 27.1

- Score, clock, goals, cards and substitutions
- Team and player stats, ratings, xG and every shot
- Positions, team shape, the pass network, and where the ball is won and lost
- Your tactic (style, mentality, formations, roles, team instructions) and the changes you make during a match
- Player attributes, condition and sharpness

Season stats are not captured yet. After an FM update the plugin may need updating
before tactics and attributes read correctly again; the analyst leaves out data that
does not make sense rather than showing it wrong.

## Built on FMMatchLens

The capture plugin and the dashboard are [FMMatchLens](https://github.com/osnsyc/FMMatchLens)
by osnsyc, which supports Windows. This repository adds the macOS port and the analyst.
The original project's own README, covering the dashboard and the Windows install, is
[README.md](../README.md) ([简体中文](../README.zh-cn.md)).

## For developers

[AGENTS.md](../AGENTS.md) has the layout, working rules and checks.
[mac/README.md](../mac/README.md) covers how the macOS port works and what has been verified.

MIT licensed, as is FMMatchLens.
