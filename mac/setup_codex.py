#!/usr/bin/env python3
"""Print/install Codex MCP configuration without changing other clients or servers."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
try:
    import tomllib
except ModuleNotFoundError:
    sys.exit("Codex setup requires Python 3.11 or newer (for TOML configuration validation).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    node = shutil.which("node")
    if not node:
        parser.error("Node.js 18.17+ is required on PATH")
    node = subprocess.check_output([node, "-p", "process.execPath"], text=True).strip()
    server = {
        "command": node,
        "args": [str(repo / "mcp/dist/server.mjs")],
        "tool_timeout_sec": 90,
        "env": {
            "FMMATCHLENS_API": os.environ.get("FMMATCHLENS_API") or "http://127.0.0.1:16726",
            "FMMATCHLENS_ARCHIVE_DIR": os.environ.get("FMMATCHLENS_ARCHIVE_DIR") or str(repo / "local/archives"),
            "FM_ANALYST_DATA_DIR": os.environ.get("FM_ANALYST_DATA_DIR") or str(Path.home() / "Documents/FM Match Analyst"),
            "FM_ANALYST_DETAIL": os.environ.get("FM_ANALYST_DETAIL") or "coach",
        },
    }
    # JSON string escaping is also valid for these TOML basic strings.
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    snippet = "\n".join([
        "[mcp_servers.fm-match-analyst]",
        f"command = {quote(server['command'])}",
        f"args = {quote(server['args'])}",
        "tool_timeout_sec = 90",
        "",
        "[mcp_servers.fm-match-analyst.env]",
        *[f"{key} = {quote(value)}" for key, value in server["env"].items()],
        "",
    ])
    if not args.install:
        print(snippet, end="")
        return
    if not Path(server["args"][0]).is_file():
        parser.error("Build the server first: ./mac/dev.sh mcp build-server")
    config = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"
    original = config.read_text() if config.exists() else ""
    parsed = tomllib.loads(original)
    existing = parsed.get("mcp_servers", {}).get("fm-match-analyst")
    if existing is not None:
        if existing == server:
            print(f"FM Match Analyst is already configured in {config}")
            return
        parser.error(f"{config} already defines fm-match-analyst; left unchanged. Use './mac/dev.sh mcp codex-config' to compare the suggested settings.")
    updated = original.rstrip() + "\n\n" + snippet
    # Validate before writing, including unusual existing TOML layouts.
    assert tomllib.loads(updated)["mcp_servers"]["fm-match-analyst"] == server
    config.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=config.parent, prefix=".fm-match-analyst-", delete=False) as pending:
        temporary = Path(pending.name)
        try:
            pending.write(updated)
            pending.flush()
            if config.exists():
                backup = config.with_name("config.toml.fm-match-analyst.bak")
                with backup.open("xb") as output:
                    output.write(original.encode())
                backup.chmod(0o600)
            os.replace(temporary, config)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"Added FM Match Analyst to {config}. Open a new local Codex session to load it. Managed Work chats do not load this local configuration.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        sys.exit(f"Codex setup failed: {error}")
