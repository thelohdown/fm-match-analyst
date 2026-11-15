// Calls fm-match-analyst tools over stdio, like an MCP client would, and prints
// the answers. Usage:
//   node scripts/call.mjs '[["get_match_state"],["sleep",5000],["get_players",{"team":"home"}]]'
// Environment (FMMATCHLENS_API, FMMATCHLENS_ARCHIVE_DIR, ...) is passed through.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const calls = JSON.parse(process.argv[2] ?? '[["get_match_state"]]')
const server = spawn(process.execPath, [fileURLToPath(new URL("../dist/server.mjs", import.meta.url))], {
  stdio: ["pipe", "pipe", "inherit"],
})
let buffer = ""
const pending = new Map()
server.stdout.on("data", (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    pending.get(message.id)?.(message)
  }
})
let nextId = 1
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "call.mjs", version: "1" } })
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
for (const [name, args = {}] of calls) {
  if (name === "sleep") {
    await new Promise((resolve) => setTimeout(resolve, Number(args)))
    continue
  }
  const started = Date.now()
  const response = await request("tools/call", { name, arguments: args })
  const text = response.result?.content?.[0]?.text ?? JSON.stringify(response.error ?? response.result)
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - started} ms, ${text.length} chars${response.result?.isError ? ", ERROR" : ""})`)
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 1))
  } catch {
    console.log(text)
  }
}
server.kill()
