// FM 27.1 on macOS: Chicago 1-2 LAFC, captured on 2026-11-21 before the Mac
// tactic offsets were remapped. The archive is in the newer 2.12 format; its
// match data is right, but the tactic was read from the wrong place, and after
// full time FM 27.1 keeps a team in possession while the players walk off.
// Point FM_ANALYST_TEST_ARCHIVE_271 at the .fmlens file; skipped when it is not there.
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { TacticalSnapshot } from "@/types/match"

import { briefing } from "../src/briefing"
import { type MatchModel, unreadableTactic } from "../src/model"
import { archiveProblem, listArchives, loadArchive } from "../src/sources"
import * as views from "../src/views"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE_271 ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-2_1.fmlens"
const healthy = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"

describe.skipIf(!existsSync(archive))("FM 27.1 capture with an unmapped tactic", () => {
  let model: MatchModel
  const source: views.SourceInfo = { kind: "archive", detail: "test" }
  beforeAll(async () => {
    model = await loadArchive({ file: "2025-12-30-Chicago-vs-LAFC-1-2_1.fmlens", path: archive, finished: true, modified: "capture271", sizeKb: 0 })
  })

  it("reads the 2.12 archive", () => {
    const state = views.matchState(model, source)
    expect(state.score).toBe("Chicago 1-2 LAFC")
    expect(state.status).toBe("full time")
  })

  it("ends in the second half: the walk-off after full time is not extra time", () => {
    const state = views.matchState(model, source)
    expect(state.period).toBe("second half")
    expect(model.buckets.every((bucket) => bucket.period <= 2)).toBe(true)
  })

  it("sets the unreadable tactic aside and says why", () => {
    expect(model.tactics).toBeUndefined()
    expect(model.tacticVersions).toHaveLength(0)
    expect(model.tacticProblem).toMatch(/not ones FM has/)
    const tactic = views.tactic(model, "both") as { available: boolean; reason: string }
    expect(tactic.available).toBe(false)
    expect(tactic.reason).toMatch(/doesn't fit this version of FM/)
    expect(views.matchState(model, source).dataNotes.join(" ")).toMatch(/tactic couldn't be read/)
  })

  it("never shows undecoded roles or instructions the user didn't set", () => {
    const text = JSON.stringify(briefing(model, source, { ok: true, problems: [] }, "full"))
    expect(text).not.toMatch(/Unknown \(0x/)
    expect(text).not.toMatch(/pressing intensity much higher/)
  })
})

// Chicago 1-1 LAFC, captured on 2026-11-26 by the plugin synced with upstream 0.8.0. The ball
// rolled on for six seconds after the final whistle, with LAFC still marked in possession.
const rolledOn = process.env.FM_ANALYST_TEST_ARCHIVE_271_DRAW ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-1.fmlens"

describe.skipIf(!existsSync(rolledOn))("FM 27.1 capture where the ball rolls on after full time", () => {
  it("still ends in the second half", async () => {
    const model = await loadArchive({ file: "2025-12-30-Chicago-vs-LAFC-1-1.fmlens", path: rolledOn, finished: true, modified: "rolledOn", sizeKb: 0 })
    const state = views.matchState(model, { kind: "archive", detail: "test" })
    expect(state.score).toBe("Chicago 1-1 LAFC")
    expect(state.status).toBe("full time")
    expect(state.period).toBe("second half")
    expect(model.buckets.every((bucket) => bucket.period <= 2)).toBe(true)
  })
})

describe("a tactic captured from the right place", () => {
  it("is trusted", async () => {
    // The block the macOS plugin read on FM 27.0 (also used by tactics.test.ts).
    const fixture = JSON.parse(await readFile(new URL("./fixtures/tactics-macos-chicago.json", import.meta.url), "utf8")) as TacticalSnapshot
    expect(unreadableTactic(fixture)).toBeUndefined()
  })
})

describe("archives the analyst can't read", () => {
  let folder: string
  const previous = process.env.FMMATCHLENS_ARCHIVE_DIR
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "fm-archives-"))
    process.env.FMMATCHLENS_ARCHIVE_DIR = folder
  })
  afterAll(async () => {
    if (previous === undefined) delete process.env.FMMATCHLENS_ARCHIVE_DIR
    else process.env.FMMATCHLENS_ARCHIVE_DIR = previous
    await rm(folder, { recursive: true, force: true })
  })

  it("explains a newer archive format in words a player can act on", async () => {
    const path = join(folder, "match-1.fmlens")
    const header = Buffer.alloc(64)
    header.write("FMLENS2\0", 0, "ascii")
    header.writeUInt16LE(2, 8)
    header.writeUInt16LE(99, 10)
    await writeFile(path, header)
    const entry = (await listArchives()).find((candidate) => candidate.file === "match-1.fmlens")!
    await expect(loadArchive(entry)).rejects.toThrow(/newer archive format \(2\.99\).*Updating the FM Match Analyst extension/)
    // Remembered, so the file isn't parsed again on every question.
    await expect(loadArchive(entry)).rejects.toThrow(/newer archive format/)
  })

  it("explains a match with no data in it", () => {
    expect(archiveProblem(new Error("Archive contains no complete match frames"))).toMatch(/no complete match data/)
  })

  it("names a replayed fixture's archive (\"_1\") like any other finished match", async () => {
    const path = join(folder, "2025-12-30-Chicago-vs-LAFC-1-2_1.fmlens")
    await writeFile(path, "")
    await utimes(path, new Date(), new Date())
    const entry = (await listArchives()).find((candidate) => candidate.file.endsWith("_1.fmlens"))!
    expect(entry).toMatchObject({ date: "2025-12-30", home: "Chicago", away: "LAFC", score: "1-2", finished: true })
  })

  it("reads a healthy archive normally", async () => {
    if (!existsSync(healthy)) return
    await writeFile(join(folder, "healthy.fmlens"), await readFile(healthy))
    const entry = (await listArchives()).find((candidate) => candidate.file === "healthy.fmlens")!
    const model = await loadArchive(entry)
    expect(model.frameCount).toBeGreaterThan(0)
  })
})
