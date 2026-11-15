"""Setup must preserve other servers and never replace customized settings."""
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest

SCRIPT = Path(__file__).with_name("setup_codex.py")


class SetupTests(unittest.TestCase):
    def test_preserves_existing_settings_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.toml"
            original = '# Keep this comment\n[mcp_servers.other]\ncommand = "other-server"\n'
            config.write_text(original)
            env = {**os.environ, "CODEX_HOME": directory}
            for _ in range(2):
                result = subprocess.run(["python3", str(SCRIPT), "--install"], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(config.read_text().startswith(original))
            parsed = tomllib.loads(config.read_text())
            self.assertEqual(parsed["mcp_servers"]["other"]["command"], "other-server")
            self.assertEqual(parsed["mcp_servers"]["fm-match-analyst"]["tool_timeout_sec"], 90)
            self.assertEqual(config.with_name("config.toml.fm-match-analyst.bak").read_text(), original)

    def test_refuses_existing_custom_server_and_invalid_toml(self):
        for original in ['[mcp_servers."fm-match-analyst"]\ncommand = "custom"\n', 'invalid = [']:
            with self.subTest(original=original), tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / "config.toml"
                config.write_text(original)
                result = subprocess.run(["python3", str(SCRIPT), "--install"], env={**os.environ, "CODEX_HOME": directory}, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(config.read_text(), original)


if __name__ == "__main__":
    unittest.main()
