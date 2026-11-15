# Codex integration change record

Date: 2026-11-15. Baseline: `de8f536` (`Analyst 0.5.0`).

## Scope

Add local Codex setup and verification alongside the existing Claude clients.
Keep the shared MCP tool definitions and analyst guide unchanged. Preserve the
Claude Desktop bundle and the default `./mac/dev.sh mcp` installation workflow.

| Files | Change |
| --- | --- |
| `mac/setup_codex.py`, `mac/test_setup_codex.py` | Add validated Codex configuration with absolute paths and a 90-second tool timeout; preserve existing servers and refuse conflicting entries; test safe installation. |
| `mac/dev.sh` | Add `codex`, `codex-config`, and `build-server`; retain Claude's default install and bundled build. |
| `mcp/scripts/smoke.mjs`, `mcp/package.json` | Test the actual stdio bundle, instructions, tools, prompts, guide and optional archive analysis. |
| `mac/check_codex.py` | Exercise Codex's native MCP client: discover tools and call `list_matches`, using temporary configuration and an ephemeral thread without a model turn. |
| `AGENTS.md`, `mac/README.md`, `mcp/README.md` | Document development, setup, testing, and the local Codex versus managed Work distinction. |

## Verified

- Rebuilt the v0.5.0 shared server and validated/packed the Claude Desktop bundle.
- TypeScript typecheck and shell syntax checks passed.
- Installer tests passed, including preservation, repeat installation, conflicting
  settings and malformed TOML.
- MCP smoke test passed: 17 tools, five prompts, analyst instructions/resource,
  archive selection, briefing and substitution advice.
- Native Codex app-server discovered all 17 tools with no tool discovery error
  and executed `list_matches`, returning three archives.
- 60 match-analysis tests passed across the initial run and sequential retries.
  The two simulated-live tests could not run: this session denies binding a
  loopback HTTP server (`listen EPERM`). Parallel Rosetta runs also exceeded
  default fixture setup timeouts; sequential retries resolved the archive suites.

Native discovery was tested with the desktop CLI shipped in ChatGPT
26.1111.21308. The check uses an experimental app-server API.

## Remaining manual verification

Open a local Codex session for this repository and confirm `/mcp` lists
`fm-match-analyst`; ask it to list saved matches. This conversation runs in
managed Work mode, which does not read the local Codex configuration.

The live FM API on port 16726 was not reachable during verification. Test live
analysis with FM and the plugin running; a successful archive check does not
establish live capture connectivity.

## Git checkpoint

These integration changes are on disk but **not committed**. This session's
filesystem permissions deny creating `.git/index.lock`, so staging and commit
must be run from the user's Terminal (or a session with Git write access).

The following pre-existing report edits are deliberately excluded:

- `mcp/src/report.ts`
- `mcp/src/reportPage.ts`
- `mcp/test/report.test.ts`

From the repository root, inspect any already-staged changes with
`git diff --cached --stat`, then stage only the integration files:

```sh
git add AGENTS.md mac/README.md mac/dev.sh mac/setup_codex.py mac/test_setup_codex.py mac/check_codex.py mcp/README.md mcp/package.json mcp/scripts/smoke.mjs docs/codex-integration.md
git diff --cached --stat
git commit -m "Add Codex setup alongside Claude and verify native MCP compatibility"
```

Generated `mcp/dist/` files remain ignored. Do not add game captures, local
configuration, dependency directories or credentials to the commit.
