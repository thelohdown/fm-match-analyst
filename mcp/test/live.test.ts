// LiveSource against a stand-in for FMMatchLens's local API serving the start of the
// Chicago 1-0 LAFC archive: it reads the frames, and it notices when the API is
// ./mac/dev.sh serve replaying a saved match rather than the game.
import { existsSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseArchiveFile } from "@/api/archiveParser"
import type { RealtimeFrame } from "@/api/realtimeMatch"

import { LiveSource } from "../src/sources"
import * as views from "../src/views"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"

describe.skipIf(!existsSync(archive))("live source", () => {
  let server: Server
  let url: string
  let replayOf: string | null = null

  beforeAll(async () => {
    const bytes = readFileSync(archive)
    const parsed = await parseArchiveFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "test.fmlens")
    const frames = parsed.frames.slice(0, 3000) as RealtimeFrame[]
    const matchId = parsed.archive.matchId
    const lastTick = frames.at(-1)!.tick
    server = createServer((request, response) => {
      const address = new URL(request.url ?? "/", "http://localhost")
      const send = (body: unknown) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(body))
      }
      switch (address.pathname) {
        case "/api/health":
          return send({ status: "live", name: "FMMatchLens", replayOf })
        case "/api/match/status":
          return send({ status: "live", matchId, frameCount: frames.length, lastTick, period: 1 })
        case "/api/match/meta":
          return send(parsed.metadata)
        case "/api/match/frames": {
          const from = Number(address.searchParams.get("fromTick") ?? 0)
          const limit = Number(address.searchParams.get("limit") ?? 1200)
          return send({ matchId, status: "live", totalFrameCount: frames.length, frames: frames.filter((frame) => frame.tick >= from).slice(0, limit) })
        }
        default:
          response.statusCode = 404
          response.end()
      }
    })
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server?.close()
  })

  it("reads the match from the game's API", async () => {
    replayOf = null
    const live = new LiveSource(url)
    await live.sync()
    expect(live.model?.lastTick).toBeGreaterThan(2900)
    expect(live.replayOf).toBeUndefined()
    const state = views.matchState(live.model!, { kind: "live", detail: "live" })
    expect(state.source).toBe("live from FMMatchLens (live)")
  })

  it("says so when the API is the replay tool", async () => {
    replayOf = "2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
    const live = new LiveSource(url)
    await live.sync()
    expect(live.replayOf).toBe("2025-12-30-Chicago-vs-LAFC-1-0.fmlens")
    const state = views.matchState(live.model!, { kind: "live", detail: "live", replayOf: live.replayOf })
    expect(state.source).toMatch(/^replay of the saved match 2025-12-30-Chicago-vs-LAFC-1-0\.fmlens .* not the game$/)
  })
})
