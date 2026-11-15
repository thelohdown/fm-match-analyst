// The phases of play on the Chicago 1-0 LAFC archive: every figure that FM also
// counts must agree with FM, and the rest must hang together.
import { existsSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import type { MatchModel } from "../src/model"
import { PhaseContext, phases, type TeamPhases } from "../src/phases"
import { findings, windowPhases } from "../src/phaseViews"
import { loadArchive } from "../src/sources"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"

describe.skipIf(!existsSync(archive))("phases of play", () => {
  let model: MatchModel
  let context: PhaseContext
  let whole: Record<"home" | "away", TeamPhases>
  beforeAll(async () => {
    model = await loadArchive({ file: "2025-12-30-Chicago-vs-LAFC-1-0.fmlens", path: archive, finished: true, modified: "phases", sizeKb: 0 })
    context = new PhaseContext(model)
    const selection = model.select({})!
    whole = phases(context, { from: selection.buckets[0].startTick, to: selection.buckets.at(-1)!.endTick })
  })

  it("puts every shot in exactly one phase, matching FM's totals", () => {
    const total = (team: TeamPhases) => Object.values(team.inPossession.shots).reduce((sum, summary) => sum + summary.shots, 0)
    expect(total(whole.home)).toBe(18)
    expect(total(whole.away)).toBe(9)
    const goals = Object.values(whole.home.inPossession.shots).reduce((sum, summary) => sum + summary.goals, 0)
    expect(goals).toBe(1)
    // Lewandowski's goal came 15 s or less after Chicago won the ball.
    expect(whole.home.attackingTransition.shots.goals).toBe(1)
  })

  it("splits possession into spells that alternate between the teams", () => {
    const spells = context.spells
    expect(spells.length).toBeGreaterThan(140)
    expect(spells.length).toBeLessThan(200)
    for (let index = 1; index < spells.length; index++) {
      if (spells[index].period === spells[index - 1].period) expect(spells[index].side).not.toBe(spells[index - 1].side)
    }
    const regains = spells.filter((spell) => spell.kind === "regain").length
    expect(regains / spells.length).toBeGreaterThan(0.5)
    expect(regains / spells.length).toBeLessThan(0.8)
    // Each open-play regain is the other team's open-play loss.
    expect(whole.home.attackingTransition.openPlayRegains).toBe(whole.away.defensiveTransition.openPlayLosses)
  })

  it("shares time between phases and agrees with FM on crosses and corners", () => {
    for (const side of ["home", "away"] as const) {
      const team = whole[side].inPossession
      expect(team.transitionPct! + team.buildUpPct! + team.progressionPct! + team.finalThirdPct!).toBeGreaterThanOrEqual(99)
      expect(team.transitionPct! + team.buildUpPct! + team.progressionPct! + team.finalThirdPct!).toBeLessThanOrEqual(101)
      // Around a third of the time on the ball it is dead or being set, as in real football.
      expect(team.setPlayPct).toBeGreaterThan(25)
      expect(team.setPlayPct).toBeLessThan(50)
    }
    const crosses = whole.home.inPossession.openPlayCrosses
    expect(crosses.left.attempted + crosses.right.attempted).toBe(29) // 37 crosses, 8 of them corners
    const selection = model.select({})!
    const window = windowPhases(context, selection)
    expect(window.teams.home.setPieces.corners).toBe(8)
    expect(window.teams.away.setPieces.corners).toBe(9)
  })

  it("places the block where the defenders actually stood", () => {
    for (const side of ["home", "away"] as const) {
      const line = whole[side].outOfPossession.defensiveLineM
      expect(line.whenTheyBuildUp!).toBeGreaterThan(line.whenTheyProgress!)
      expect(line.whenTheyProgress!).toBeGreaterThan(line.whenInOwnThird!)
      expect(whole[side].outOfPossession.block).toBe("mid block")
    }
  })

  it("only flags what stands out against the opponent or earlier", () => {
    const recent = windowPhases(context, model.selectIndices(model.buckets.length - 15, model.buckets.length - 1, "last 15")!)
    const earlier = windowPhases(context, model.select({ half: "first" })!)
    const result = findings(model, "home", recent, earlier, windowPhases(context, model.select({})!))
    expect(result.problems.length).toBeLessThanOrEqual(7)
    for (const finding of [...result.problems, ...result.working]) expect(finding).toMatch(/^\[(in possession|out of possession|attacking transition|defensive transition|set pieces)\] /)
    // Turnovers alone are not a finding: both teams lose most possessions.
    expect(result.problems.join(" ")).not.toMatch(/Giving the ball away/)
  })
})
