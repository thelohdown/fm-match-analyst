// Client-neutral protocol check of the same bundle used by Codex and Claude.
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const client = new Client({ name: "fm-cross-client-smoke", version: "1" })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/server.mjs", import.meta.url))],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  stderr: "inherit",
})
try {
  await client.connect(transport)
  assert.equal(client.getServerVersion().version, version, "Rebuild the stale server bundle")
  assert.match(client.getInstructions(), /get_briefing/)
  const { tools } = await client.listTools()
  for (const name of ["get_match_state", "get_briefing", "get_sub_plan", "build_report", "note_feedback"]) {
    assert.ok(tools.some((tool) => tool.name === name), `Missing tool: ${name}`)
  }
  const { prompts } = await client.listPrompts()
  assert.equal(prompts.length, 5)
  for (const { name } of prompts) {
    assert.ok((await client.getPrompt({ name })).messages.length)
  }
  const guide = await client.readResource({ uri: "fm-match-analyst://guide" })
  assert.match(guide.contents[0].text, /get_briefing/)
  const matches = await client.callTool({ name: "list_matches", arguments: {} })
  assert.ok(!matches.isError)
  const result = JSON.parse(matches.content[0].text)
  assert.ok(Array.isArray(result.archives))
  console.log(`PASS: v${version}; ${tools.length} tools; ${prompts.length} prompts; analyst instructions/resource; ${result.archives.length} archives`)
  // Optional exact archive name exercises real tool calls without selecting live data.
  if (process.argv[2]) {
    for (const [name, args] of [
      ["load_match", { match: process.argv[2] }],
      ["get_briefing", {}],
      ["get_sub_plan", {}],
    ]) {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 })
      assert.ok(!response.isError, `${name}: ${JSON.stringify(response.content)}`)
      const data = JSON.parse(response.content[0].text)
      assert.ok(!data.error, `${name}: ${data.error}`)
      assert.ok(Object.keys(data).length > 0)
      console.log(`PASS: ${name}`)
    }
  }
} finally {
  await client.close()
}
