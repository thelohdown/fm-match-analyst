// get_opponent_read on the Chicago 1-0 LAFC archive, and the formation matcher on
// made-up shapes. Chicago's shape without the ball must come out as the 4-3-3 DM
// Wide its captured tactic says it was set up in, though the read never looks at
// the tactic.
import { existsSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import type { MatchModel } from "../src/model"
import { assign, briefingRead, observedFormation, opponentRead } from "../src/opponent"
import { loadArchive } from "../src/sources"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"

describe("formation matcher", () => {
  it("assigns at minimum cost", () => {
    expect(assign([[4, 1, 3], [2, 0, 5], [3, 2, 2]])).toEqual([1, 0, 2])
  })

  const team = (rows: Array<Array<[number, number]>>) =>
    rows.flatMap((line, row) => line.map(([lateralM, depthM], index) => ({ name: `L${row}P${index}`, spot: { depthM, lateralM } })))

  it("recognises a flat 4-4-2", () => {
    const shape = observedFormation(
      team([
        [[-24, 30], [-8, 28], [8, 28], [24, 30]],
        [[-25, 50], [-8, 47], [8, 47], [25, 50]],
        [[-7, 68], [7, 68]],
      ])
    )
    expect(shape?.formation).toMatch(/^4-4-2/)
    expect(shape?.positions[0]).toBe("DL L0P0")
  })

  it("recognises a back three with wing-backs", () => {
    const shape = observedFormation(
      team([
        [[-14, 28], [0, 26], [14, 28]],
        [[-30, 45], [-8, 44], [0, 48], [8, 44], [30, 45]],
        [[-8, 66], [8, 66]],
      ])
    )
    expect(shape?.formation).toMatch(/^(3-5-2|5-3-2|3-4-1-2)/)
  })
})

describe.skipIf(!existsSync(archive))("reading the opponent", () => {
  let model: MatchModel
  beforeAll(async () => {
    model = await loadArchive({ file: "opponent", path: archive, finished: true, modified: "opponent", sizeKb: 0 })
  }, 120_000)

  it("reads Chicago's shape without the ball as the tactic it was set up in", () => {
    const read = opponentRead(model, "home", model.select({ half: "first" })!)
    const shape = read.shape.withoutTheBall as { formation: string; positions: string[] }
    expect(shape.formation).toBe("4-3-3 DM Wide")
    expect(shape.positions).toEqual(expect.arrayContaining(["ST Robert Lewandowski", "AML Jonathan Bamba", "AMR Philip Zinckernagel", "DM Djé D'Avilla"]))
  })

  it("adds up where they attack and how they restart", () => {
    const read = opponentRead(model, "away", model.select({ half: "first" })!)
    const entries = /^(\d+) final-third entries: (\d+) down Chicago's left, (\d+) through the middle, (\d+) down Chicago's right$/.exec(read.withTheBall.whereTheyAttack)
    expect(entries).not.toBeNull()
    expect(Number(entries![2]) + Number(entries![3]) + Number(entries![4])).toBe(Number(entries![1]))
    expect(read.withTheBall.goalKicksAndKeeperRestarts).toMatch(/^\d+ short to the defence, \d+ long$/)
    expect(read.withTheBall.throughWhom).toHaveLength(3)
    expect(read.matchups).toHaveLength(4)
  })

  it("flags a matchup where their attacker is clearly quicker", () => {
    const players = model.metadata!.players
    const set = (name: string, pace: number) => {
      const player = players.find((candidate) => candidate.displayName === name)!
      Object.assign(player, { attributes: { physical: { Pace: pace, Acceleration: pace, Strength: 60, "Jumping Reach": 60 } } })
    }
    const read = opponentRead(model, "away", model.select({ half: "first" })!)
    const pair = read.matchups!.find((row) => row.theirPlayer === "Denis Bouanga")!
    set(pair.theirPlayer, 90)
    set(pair.againstOurs, 60)
    const again = opponentRead(model, "away", model.select({ half: "first" })!).matchups!.find((row) => row.theirPlayer === "Denis Bouanga")!
    expect(again.watch).toBe(true)
    expect(again.attributes).toEqual(expect.arrayContaining(["Denis Bouanga has the edge on pace (18 v 12)"]))
    const brief = briefingRead(model, "home", model.select({ half: "first" })!)
    expect(brief.matchupsToWatch).toEqual(expect.arrayContaining([expect.stringMatching(/^Denis Bouanga v /)]))
    expect(brief.shapesAsPlayed.Chicago.withoutTheBall).toBe("4-3-3 DM Wide")
  })
})
