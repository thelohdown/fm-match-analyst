// get_sequences on the Chicago 1-0 LAFC archive: the goal (Lewandowski 18', a
// counter from Gutman winning it deep) and LAFC's big chance (Hollingshead 55',
// off target from a corner). The stories must match what the frames show.
import { existsSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import { briefing } from "../src/briefing"
import { checkData } from "../src/checks"
import type { MatchModel } from "../src/model"
import { chanceStories, patterns } from "../src/sequences"
import { loadArchive } from "../src/sources"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const source = { kind: "archive" as const, detail: "2025-12-30-Chicago-vs-LAFC-1-0.fmlens" }

type Story = {
  minute: string
  team: string
  shooter: string
  source: string
  summary: string
  start: { how: string; wonBy?: string; lostBy?: string; secondsToShot: number }
  route: { passes: number; fastBreak?: boolean }
  chain: string[]
  atTheShot?: { nearestDefenderM?: number; defendersInTheWay?: number; defendingShape?: string[] }
}
const stories = (result: Record<string, unknown>) => result.chances as Story[]

describe.skipIf(!existsSync(archive))("how the chances came about", () => {
  let model: MatchModel
  beforeAll(async () => {
    model = await loadArchive({ file: source.detail, path: archive, finished: true, modified: "sequences", sizeKb: 0 })
  }, 120_000)

  it("traces the goal back to the regain that started it", () => {
    const [goal] = stories(chanceStories(model, ["home", "away"], model.select({}), "goals"))
    expect(goal).toMatchObject({ minute: "18'", team: "Chicago", shooter: "Robert Lewandowski", source: "transition" })
    expect(goal.start).toMatchObject({ how: "won the ball in open play", wonBy: "Andrew Gutman", lostBy: "Thayllon" })
    expect(goal.start.secondsToShot).toBeGreaterThan(5)
    expect(goal.start.secondsToShot).toBeLessThanOrEqual(15)
    expect(goal.chain[0]).toMatch(/^Andrew Gutman \(own third/)
    expect(goal.atTheShot?.nearestDefenderM).toBeGreaterThan(0)
    expect(goal.summary).toMatch(/^18' Chicago, Robert Lewandowski \(0\.26 xG, goal, .*\): Andrew Gutman won it off Thayllon in Chicago's own third/)
  })

  it("tells a set-piece chance from the restart, not the possession before it", () => {
    const [chance] = stories(chanceStories(model, ["away"], model.select({}), "big_chances"))
    expect(chance).toMatchObject({ minute: "55'", team: "LAFC", shooter: "Ryan Hollingshead", source: "set piece" })
    expect(chance.start.how).toBe("corner")
    expect(chance.start.secondsToShot).toBeLessThanOrEqual(5)
    expect(chance.chain.at(-1)).toMatch(/^Ryan Hollingshead \(box/)
    // Ten Chicago players back for the corner: the line was on the goal line.
    expect(chance.atTheShot?.defendingShape?.join(" ")).toMatch(/Chicago's line \d+ m from goal/)
  })

  it("filters by team, window and kind", () => {
    expect(stories(chanceStories(model, ["home", "away"], model.select({ half: "second" }), "both")).map((story) => story.minute)).toEqual(["55'"])
    expect(stories(chanceStories(model, ["home"], model.select({}), "big_chances"))).toEqual([])
    expect(chanceStories(model, ["home"], model.select({}), "big_chances")).toMatchObject({ summary: expect.stringContaining("No goals or big chances") })
  })

  it("records who had the ball within each possession", () => {
    const spells = model.possession.spells
    const withHolders = spells.filter((spell) => spell.holders.length > 0)
    expect(withHolders.length / spells.length).toBeGreaterThan(0.8)
    for (const spell of withHolders) {
      for (const holder of spell.holders) {
        expect(holder.tick).toBeGreaterThanOrEqual(spell.startTick)
        expect(holder.tick).toBeLessThanOrEqual(spell.endTick)
      }
    }
  })

  it("keeps everyone's position only with the ball near a goal", () => {
    const frames = model.goalAreaFrames
    expect(frames.length).toBeGreaterThan(1000)
    for (const frame of frames.slice(0, 200)) expect(frame.xy.length).toBe(frame.ids.length * 2)
    // Kick-off: the ball is on the centre spot.
    expect(model.positionsAt(model.buckets[0].startTick + 2)).toBeUndefined()
  })

  it("puts one line per goal in the briefing", () => {
    const result = briefing(model, source, checkData(model)) as { howTheGoalsCame?: string[] }
    expect(result.howTheGoalsCame).toHaveLength(1)
    expect(result.howTheGoalsCame?.[0]).toMatch(/^18' Chicago, Robert Lewandowski/)
  })

  it("pulls out what conceded chances have in common", () => {
    const pattern = (overrides: Record<string, unknown>) => ({
      pattern: { attacking: "away" as const, kind: "regain", lossThird: "middle third" as const, lossChannel: "left" as const, throughDefenders: "left" as const, quick: true, looseMarking: false, openGoal: false, ...overrides },
    })
    const lines = patterns(model, [pattern({}), pattern({}), pattern({ kind: "corner", lossThird: undefined, throughDefenders: undefined, quick: false })], "home")
    expect(lines).toEqual(
      expect.arrayContaining([
        "2 of 3 came after Chicago lost the ball in open play",
        "2 of 3 came after Chicago lost it in its middle third",
        "2 of 3 came within 15 s of Chicago losing the ball",
        "2 of 3 got into the final third through Chicago's left flank",
      ])
    )
    expect(patterns(model, [pattern({})], "home")).toBeUndefined()
  })
})
