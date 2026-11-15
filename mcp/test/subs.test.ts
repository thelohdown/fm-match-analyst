// get_sub_plan on the Chicago 1-0 LAFC archive, read as if live at 76' (Chicago)
// and at full time (LAFC's ten changes). D'Avilla was booked at 70'.
import { existsSync, readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import { parseArchiveFile } from "@/api/archiveParser"

import { MatchModel } from "../src/model"
import { familiarityKey, subCandidates, subPlan } from "../src/subs"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"

type Row = { player: string; why: string[]; condition?: number; dropPer10?: number; conditionAtWhistle?: number; booked?: string; benchOptions?: string[] }
type Plan = { minute: string; minutesToTheWhistle: number; substitutionsMade: number; windowsUsed: number; candidates: Row[]; firstToTire: string[]; bench: Array<{ name: string }> }

describe("familiarity keys", () => {
  it("maps tactic positions to FM's familiarity positions", () => {
    expect(["DCL", "DMR", "MCR", "AMCL", "STL", "DR", "WBL", "AML", "GK"].map(familiarityKey)).toEqual(["DC", "DM", "MC", "AMC", "ST", "DR", "WBL", "AML", "GK"])
  })
})

describe.skipIf(!existsSync(archive))("who to take off", () => {
  let live: MatchModel
  let full: MatchModel
  beforeAll(async () => {
    const bytes = readFileSync(archive)
    const parsed = await parseArchiveFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "test.fmlens")
    full = new MatchModel("full")
    full.setMetadata(parsed.metadata!)
    full.ingest(parsed.frames)
    const cut = full.buckets.find((bucket) => bucket.period === 2 && bucket.windowMinute === 76)!.startTick
    // Give two players positions and a bench player familiarities, as current captures have.
    const metadata = structuredClone(parsed.metadata!)
    const set = (name: string, values: Record<string, unknown>) => Object.assign(metadata.players.find((player) => player.displayName === name)!, values)
    set("Jonathan Bamba", { position: "AML" })
    set("Robin Lod", { positionFamiliarities: { AML: 18, AMC: 15, MC: 12 } })
    set("Noah Allen", { positionFamiliarities: { DL: 20, WBL: 17 } })
    live = new MatchModel("live")
    live.setMetadata(metadata)
    live.ingest(parsed.frames.filter((frame) => frame.tick <= cut))
  }, 120_000)

  it("forecasts condition to the whistle from this half's drop", () => {
    const plan = subPlan(live, "home") as Plan
    expect(plan.minute).toBe("76'")
    expect(plan.minutesToTheWhistle).toBe(18)
    for (const row of plan.candidates) {
      if (row.condition == null || row.dropPer10 == null || row.conditionAtWhistle == null) continue
      expect(Math.abs(row.condition - (row.dropPer10 / 10) * plan.minutesToTheWhistle - row.conditionAtWhistle)).toBeLessThanOrEqual(2)
    }
    expect(plan.firstToTire[0]).toMatch(/^Jonathan Bamba: \d+% now, about 6\d% at the whistle/)
  })

  it("puts the booked defensive midfielder and the tiring winger up for a change", () => {
    const plan = subPlan(live, "home") as Plan
    const davilla = plan.candidates.find((row) => row.player === "Djé D'Avilla")
    expect(davilla?.booked).toBe("booked 70'")
    const bamba = plan.candidates.find((row) => row.player === "Jonathan Bamba")
    expect(bamba?.why.join(" ")).toMatch(/tiring now \(70% condition\)/)
    expect(bamba?.benchOptions).toEqual(["Robin Lod"])
    expect(subCandidates(live, "home")?.some((line) => line.startsWith("Jonathan Bamba:") && line.includes("could come on: Robin Lod"))).toBe(true)
  })

  it("counts substitutions and windows, with half-time free", () => {
    const plan = subPlan(full, "away") as Plan
    expect(plan.substitutionsMade).toBe(10)
    expect(plan.windowsUsed).toBe(2)
    expect((subPlan(live, "home") as Plan).bench.length).toBeGreaterThan(5)
  })
})
