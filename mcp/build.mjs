// Bundles the server, the dashboard code it reuses (../frontend/src) and its
// dependencies into one file, dist/server.mjs, that needs only Node 18.17+.
// With --mcpb it also packs dist/fm-match-analyst.mcpb for Claude Desktop.
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { build } from "esbuild"

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  alias: { "@": "../frontend/src" },
  loader: { ".md": "text" },
  define: { __VERSION__: JSON.stringify(version) },
  // Some bundled CommonJS packages call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: "eof",
  logLevel: "warning",
})
console.log(`built dist/server.mjs (fm-match-analyst ${version})`)

if (process.argv.includes("--mcpb")) {
  const stage = "dist/mcpb"
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(`${stage}/server`, { recursive: true })
  const manifest = JSON.parse(readFileSync("mcpb/manifest.json", "utf8"))
  manifest.version = version
  writeFileSync(`${stage}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n")
  copyFileSync("dist/server.mjs", `${stage}/server/server.mjs`)
  copyFileSync("../LICENSE", `${stage}/LICENSE`)
  const mcpb = new URL("./node_modules/@anthropic-ai/mcpb/dist/cli/cli.js", import.meta.url).pathname
  execFileSync(process.execPath, [mcpb, "validate", `${stage}/manifest.json`], { stdio: "inherit" })
  execFileSync(process.execPath, [mcpb, "pack", stage, "dist/fm-match-analyst.mcpb"], { stdio: "inherit" })
}
