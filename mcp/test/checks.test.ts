// The data checks pass on a real capture and catch the kind of damage a moved
// memory layout causes (team totals no longer matching the players').
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { parseArchiveFile } from "@/api/archiveParser"

import { checkData, dataWarning } from "../src/checks"
import { MatchModel } from "../src/model"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"

async function load(tamper?: (frame: any) => void) {
  const bytes = readFileSync(archive)
  const parsed = await parseArchiveFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "t.fmlens")
  const frames = parsed.frames.slice(0, 12_000)
  if (tamper) frames.forEach(tamper)
  const model = new MatchModel("t")
  model.setMetadata(parsed.metadata ?? null)
  model.ingest(frames)
  return model
}

describe.skipIf(!existsSync(archive))("data checks", () => {
  it("pass on a real capture", async () => {
    const check = checkData(await load())
    expect(check.problems).toEqual([])
    expect(dataWarning(check)).toBeUndefined()
  })

  it("flag team totals that no longer match the players", async () => {
    const check = checkData(await load((frame) => (frame.home = { ...frame.home, shots: frame.home.shots + 3, passes: frame.home.passes * 2 })))
    expect(check.ok).toBe(false)
    expect(check.problems.join(" ")).toMatch(/home shots/)
    expect(dataWarning(check)).toMatch(/DATA CHECK FAILED/)
  })

  it("flag impossible ratings and pitch sizes", async () => {
    const check = checkData(
      await load((frame) => {
        frame.halfPitchLength = 3
        frame.players = frame.players.map((player: any) => ({ ...player, rating: player.isOnPitch ? 42 : player.rating }))
      })
    )
    expect(check.problems.some((problem) => /pitch size/.test(problem))).toBe(true)
    expect(check.problems.some((problem) => /rated 42/.test(problem))).toBe(true)
  })
})
