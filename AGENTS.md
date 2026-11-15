# FMMatchLens development

## Layout

- `src/FMMatchLens.Plugin/`: C# BepInEx capture, local HTTP/WebSocket API, archives.
- `mac/`: macOS FM27 port, build/install helpers and offline replay.
- `frontend/`: React/TypeScript dashboard and shared archive/derivation code.
- `mcp/`: client-neutral MCP match analyst for Claude Desktop, Claude Code and Codex.
- `local/`: ignored game files, captures, archives and logs; do not commit these.

Read `mac/README.md` for the port's status and `mcp/README.md` for analyst setup.
The root README describes the upstream Windows installation.

## Working rules

Keep tools and analyst behavior shared between clients. The analyst guide lives
in `mcp/analyst/fm-analyst.md` and is bundled into MCP instructions and a resource.
Claude Desktop additionally uses `mcp/mcpb/manifest.json`; preserve that packaging.
The analyst reads game state; it must not change the game. Reports and feedback
are explicit local file-writing tools. Never invent data missing from a capture.

Preserve uncommitted work. Do not install into the game, launch FM, or change its
capture configuration merely to validate an analyst or dashboard change.

## Checks

Use Node.js 22.12+ for MCP development, and Python 3.11+ for Codex setup.

```sh
cd mcp
npm ci
npm run build
npm run typecheck
npm test
npm run test:smoke
```

`npm test` uses `local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens` if present;
archive-dependent tests otherwise skip. `FM_ANALYST_TEST_ARCHIVE` can override
its location but expected match assertions require that same fixture.
On constrained machines or under Rosetta, use
`npm test -- --maxWorkers=1 --no-file-parallelism --hookTimeout=120000` to avoid
parallel archive parsing exhausting the default setup timeout. Live-source
tests also require permission to bind a temporary loopback HTTP server.
`npm run test:smoke` checks the actual built stdio server without requiring FM.
Use `node build.mjs --mcpb` to validate and package Claude Desktop as well.
From the root, run `python3 mac/test_setup_codex.py` and `bash -n mac/dev.sh`
after setup-script changes. Installer tests use temporary Codex configuration.
`python3 mac/check_codex.py` checks native Codex tool discovery and calls
`list_matches` using a disposable configuration and ephemeral thread. It starts
no model turn. Managed Work chats do not load local `~/.codex/config.toml`;
native-client success must not be presented as proof of tools loading in Work.

Frontend changes: run `npm run typecheck`, `npm run lint`, `npm test`, and
`npm run build` in `frontend/` with its supported Node version (22.12+).
Plugin changes: use `./mac/dev.sh build`; game/BepInEx reference assemblies are
local prerequisites. `./mac/dev.sh serve` is an optional archive replay API and
shares port 16726 with FM, so never run both at once.
