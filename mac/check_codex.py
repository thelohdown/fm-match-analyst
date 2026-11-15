#!/usr/bin/env python3
"""Check the shared MCP server through Codex's native client, without a model turn.

Uses disposable Codex configuration; never changes the user's configuration or
Claude installation. The app-server API is experimental; this diagnostic was
validated against the desktop CLI shipped with ChatGPT 26.1111.21308.
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", help="Path to the Codex CLI")
    args = parser.parse_args()
    bundled = Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")
    cli = args.codex or shutil.which("codex") or (str(bundled) if bundled.is_file() else None)
    if not cli:
        parser.error("Codex CLI not found; supply --codex /path/to/codex")
    repo = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="fm-codex-check-") as directory:
        env = {**os.environ, "CODEX_HOME": directory}
        subprocess.run([sys.executable, str(repo / "mac/setup_codex.py"), "--install"],
                       env=env, check=True, capture_output=True, text=True)
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen([cli, "app-server", "--stdio"], env=env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            buffer = b""
            request_id = 0

            def send(message):
                process.stdin.write((json.dumps(message) + "\n").encode())
                process.stdin.flush()

            def call(method, params):
                nonlocal buffer, request_id
                request_id += 1
                send({"id": request_id, "method": method, "params": params})
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if b"\n" not in buffer:
                        if not selector.select(timeout=1):
                            continue
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk:
                            raise RuntimeError("Codex app-server closed the connection")
                        buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        message = json.loads(line)
                        if "method" in message and "id" in message:
                            # No approval/auth flow should be needed for read-only diagnostics.
                            send({"id": message["id"], "error": {"code": -32601, "message": "Interactive requests are not supported by this diagnostic"}})
                            continue
                        if message.get("id") == request_id:
                            if "error" in message:
                                raise RuntimeError(f"{method}: {message['error']}")
                            return message["result"]
                raise RuntimeError(f"Timed out waiting for {method}")

            try:
                call("initialize", {"clientInfo": {"name": "fm-mcp-check", "version": "1.0"},
                                    "capabilities": {"experimentalApi": True, "requestAttestation": False}})
                send({"method": "initialized"})
                status = call("mcpServerStatus/list", {"serverName": "fm-match-analyst", "detail": "full"})
                server = next((item for item in status["data"] if item["name"] == "fm-match-analyst"), None)
                if not server or server.get("toolsError") or "list_matches" not in server.get("tools", {}):
                    raise RuntimeError("Codex did not discover the match analyst tools")
                print(f"PASS: native Codex discovery; {len(server['tools'])} tools; server v{server['serverInfo']['version']}", flush=True)
                thread = call("thread/start", {"cwd": str(repo), "ephemeral": True, "sandbox": "read-only"})
                result = call("mcpServer/tool/call", {"threadId": thread["thread"]["id"],
                              "server": "fm-match-analyst", "tool": "list_matches", "arguments": {}})
                if result.get("isError"):
                    raise RuntimeError(f"list_matches failed: {result}")
                payload = next((item["text"] for item in result.get("content", []) if item.get("type") == "text"), None)
                if payload is None:
                    raise RuntimeError("list_matches returned no text payload")
                matches = json.loads(payload)
                if not isinstance(matches.get("archives"), list):
                    raise RuntimeError("list_matches did not return an archive list")
                print(f"PASS: native Codex list_matches call; {matches['totalArchives']} archives", flush=True)
                for archive in matches["archives"]:
                    print(f"  {archive['file']}")
                if isinstance(matches.get("live"), str):
                    print(f"Live status: {matches['live']}")
            finally:
                selector.close()
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(f"Codex check failed: {error}")
