// Checks the views against a real capture: Chicago 1-0 LAFC (friendly), recorded
// by FMMatchLens on macOS. Point FM_ANALYST_TEST_ARCHIVE at the .fmlens file;
// the test is skipped when it is not there.
import { existsSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import type { MatchModel } from "../src/model"
import { loadArchive } from "../src/sources"
import * as views from "../src/views"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const present = existsSync(archive)

describe.skipIf(!present)("Chicago 1-0 LAFC archive", () => {
  let model: MatchModel
  const source: views.SourceInfo = { kind: "archive", detail: "test" }
  beforeAll(async () => {
    model = await loadArchive({ file: "2025-12-30-Chicago-vs-LAFC-1-0.fmlens", path: archive, finished: true, modified: "test", sizeKb: 0 })
  })

  it("ends at FM's full-time clock, in the second half", () => {
    const state = views.matchState(model, source)
    expect(state.score).toBe("Chicago 1-0 LAFC")
    expect(state.period).toBe("second half")
    expect(state.clock).toBe("90+2:37")
    expect(state.status).toBe("full time")
    expect(state.goals).toEqual([{ minute: "18'", team: "Chicago", scorer: "Robert Lewandowski", ownGoal: undefined, assist: "Anton Salétros" }])
    expect(state.substitutions).toHaveLength(10)
  })

  it("splits team stats into halves that add up to FM's totals", () => {
    const stats = views.teamStats(model, "half", {})
    const rows = stats.segments as unknown as Array<{ segment: string; teams: Record<string, { shots: number; xg: number; goals: number }> }>
    const [first, second, total] = rows
    expect(total.teams.Chicago.shots).toBe(18)
    expect(total.teams.LAFC.shots).toBe(9)
    expect(total.teams.Chicago.xg).toBeCloseTo(1.39, 2)
    expect(first.teams.Chicago.shots).toBe(12) // FM's own first-half shot count
    expect(second.teams.Chicago.shots).toBe(6)
    expect(first.teams.Chicago.goals + second.teams.Chicago.goals).toBe(1)
  })

  it("lists every shot once, with xG", () => {
    const result = views.events(model, ["shots"], "both", {}, 500) as unknown as { events: Array<{ team: string; xg: number }> }
    expect(result.events.filter((event) => event.team === "Chicago")).toHaveLength(18)
    expect(result.events.filter((event) => event.team === "LAFC")).toHaveLength(9)
  })

  it("puts players on the side they played, from their team's point of view", () => {
    const shape = views.shape(model, "home", { half: "first" }) as unknown as Record<string, { players: Array<{ name: string; inPossession: { width: number } }> }>
    const players = shape.Chicago.players
    const width = (name: string) => players.find((player) => player.name === name)!.inPossession.width
    expect(width("Andrew Gutman")).toBeLessThan(35) // left back
    expect(width("Jonathan Bamba")).toBeLessThan(35) // left wing
    expect(width("Philip Zinckernagel")).toBeGreaterThan(65) // right wing
    expect(width("Leonardo Barroso")).toBeGreaterThan(65) // right back
  })

  it("only lists players who were on the pitch in a window", () => {
    const result = views.players(model, "away", { lastMinutes: 10 }, false) as unknown as Record<string, unknown[]>
    expect(result.LAFC).toHaveLength(11)
  })
})

describe.skipIf(!present)("briefing", () => {
  it("compares the last 15 minutes with earlier in the half and lists who is tiring", async () => {
    const model = await loadArchive({ file: "2025-12-30-Chicago-vs-LAFC-1-0.fmlens", path: archive, finished: true, modified: "test", sizeKb: 0 })
    const result = views.briefing(model, { kind: "archive", detail: "test" }, { ok: true, problems: [] }) as Record<string, any>
    expect(result.dataCheck).toBe("passed")
    const chicago = result.howItsGoing.Chicago
    expect(Object.keys(chicago)).toEqual(["last 15 (78:00-90+2:37)", "earlier in this half (45:00-77:59)"])
    expect(result.players.Chicago.tiring.map((player: { name: string }) => player.name)).toContain("Jonathan Bamba")
    expect(result.chancesAndTurnovers.LAFC.shotsLast20Minutes).toEqual([
      expect.objectContaining({ minute: "84'", player: "Jacob Shaffelburg", xg: 0.27 }),
    ])
    expect(JSON.stringify(result).length).toBeLessThan(8000)
  })
})
