// Attributes, natural positions and the bench, with made-up values (real FM database
// values are not committed) attached to the Chicago 1-0 LAFC archive's metadata.
import { existsSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import { briefing } from "../src/briefing"
import type { MatchModel } from "../src/model"
import { loadArchive } from "../src/sources"
import * as views from "../src/views"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"

describe.skipIf(!existsSync(archive))("attributes", () => {
  let model: MatchModel
  beforeAll(async () => {
    model = await loadArchive({ file: "attributes-test.fmlens", path: archive, finished: true, modified: `attributes-${Date.now()}`, sizeKb: 0 })
    for (const player of model.metadata!.players) {
      if (player.team !== "home") continue
      player.positionFamiliarities = { DL: 20, WBL: 16, ML: 10 }
      player.attributes = {
        technical: { Crossing: 70, Finishing: 31 },
        mental: { Decisions: 62, "Work Rate": 88 },
        physical: { Pace: 85, Acceleration: 78, Stamina: 92 },
        goalkeeping: { Handling: 10 },
      }
      player.profile = { ...player.profile, heightCm: 178, currentAbility: 140, potentialAbility: 160 }
    }
  })

  it("shows FM's 1-20 values and natural positions, never ability", () => {
    const result = views.players(model, "home", {}, false, true) as Record<string, Array<Record<string, any>>>
    const row = result.Chicago[1]
    expect(row.naturalPositions).toBe("DL, WBL (accomplished)")
    expect(row.attributes.physical).toEqual({ Pace: 17, Acceleration: 16, Stamina: 18 })
    expect(row.attributes.goalkeeping).toBeUndefined()
    expect(row.attributes.heightCm).toBe(178)
    expect(JSON.stringify(result)).not.toMatch(/currentAbility|potentialAbility|140|160/)
  })

  it("lists the bench with what matters for a substitution", () => {
    const result = briefing(model, { kind: "archive", detail: "test" }, { ok: true, problems: [] }) as Record<string, any>
    const bench = result.bench.Chicago as Array<Record<string, unknown>>
    expect(bench.length).toBeGreaterThan(0)
    expect(bench[0]).toMatchObject({ naturalPositions: "DL, WBL (accomplished)", attributes: "Pace 17, Acceleration 16, Stamina 18, Work Rate 18, Decisions 12" })
  })
})
