// get_roles: on the Chicago 1-0 LAFC archive with the macOS tactic fixture
// attached (Chicago's 4-2-3-1 "Wing Play"), and on made-up players for the rules.
import { existsSync, readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import { parseArchiveFile } from "@/api/archiveParser"
import type { PlayerTacticalAssignment, TacticalSnapshot } from "@/types/match"

import { MatchModel } from "../src/model"
import { checksFor, type PlayerEvidence, roleReport, teamContext } from "../src/roles"
import { loadArchive } from "../src/sources"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const fixture = new URL("./fixtures/tactics-macos-chicago.json", import.meta.url)

type Row = { player: string; role?: string; checks?: Array<{ asks: string; seen: string; verdict: string }>; note?: string }

async function withTactics(): Promise<MatchModel> {
  const bytes = readFileSync(archive)
  const parsed = await parseArchiveFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "test.fmlens")
  const tactics = JSON.parse(readFileSync(fixture, "utf8")) as TacticalSnapshot
  const first = parsed.frames[0]
  for (const side of ["home", "away"] as const) {
    const players = first.players.filter((player) => player.team === side)
    for (const binding of tactics[side].players) {
      const match = players[binding.rosterSlot ?? -1]
      if (match) Object.assign(binding, { slot: match.slot, playerId: match.playerId })
    }
  }
  for (const frame of parsed.frames) frame.tactics = tactics
  const model = new MatchModel(parsed.archive.matchId)
  model.setMetadata(parsed.metadata!)
  model.ingest(parsed.frames)
  return model
}

describe.skipIf(!existsSync(archive))("are the players doing their jobs", () => {
  let model: MatchModel
  let rows: Row[]
  let report: Record<string, unknown>
  beforeAll(async () => {
    model = await withTactics()
    report = roleReport(model, "home", model.select({})!) as Record<string, unknown>
    rows = report.players as Row[]
  }, 120_000)

  const check = (player: string, asks: string) => rows.find((row) => row.player === player)?.checks?.find((candidate) => candidate.asks === asks)

  it("reads each role from the tactic and checks what can be measured", () => {
    expect(rows.find((row) => row.player === "Robert Lewandowski")?.role).toBe("ST Channel Forward (Attack); out of possession ST Centre-Forward (Support)")
    expect(check("Robert Lewandowski", "play on the last line")?.verdict).toBe("yes")
    expect(check("Philip Zinckernagel", "hold the width when we have the ball")?.verdict).toBe("yes")
    expect(check("Djé D'Avilla", "sit in front of the defence")?.verdict).toBe("yes")
    // The wing-back is compared with the full-back on the other flank.
    expect(check("Leonardo Barroso", "push on down the flank when we have the ball")?.seen).toMatch(/Andrew Gutman \(Full-Back\) on the other side: \d+ m from own goal/)
    expect(rows.find((row) => row.player === "Chris Brady")?.note).toMatch(/goalkeeper/)
    expect(report.notHappening).toBeUndefined()
  })

  it("reports positions in metres within the pitch", () => {
    for (const row of rows) {
      for (const item of row.checks ?? []) {
        for (const [, metres] of item.seen.matchAll(/(\d+) m from own goal/g)) {
          expect(Number(metres)).toBeGreaterThan(0)
          expect(Number(metres)).toBeLessThan(model.halfLength * 2)
        }
      }
    }
  })

  it("says so when no tactic was captured", async () => {
    const plain = await loadArchive({ file: "plain", path: archive, finished: true, modified: "roles", sizeKb: 0 })
    expect(roleReport(plain, "home", plain.select({})!)).toMatchObject({ note: expect.stringContaining("not captured") })
  })
})

describe("role and instruction rules", () => {
  const assignment = (position: string, role: string, duty?: string): PlayerTacticalAssignment => ({ positionMask: 0, position, roleDuty: "", role, roleAbbreviation: "", duty })
  let nextId = 1
  const player = (overrides: Partial<PlayerEvidence>): PlayerEvidence => ({
    playerId: nextId++,
    name: `P${nextId}`,
    minutes: 90,
    instructions: [],
    per90: { shots: 1, dribbles: 1, crosses: 1, keyPasses: 1, progressivePasses: 3, passes: 40, ballWinning: 3, aerials: 2, fouls: 1 },
    ...overrides,
  })
  const centreBacks = [
    player({ inPossession: assignment("DCL", "Centre-Back", "Defend"), withBall: { depthM: 35, lateralM: -8 } }),
    player({ inPossession: assignment("DCR", "Centre-Back", "Defend"), withBall: { depthM: 35, lateralM: 8 } }),
  ]
  const striker = player({ inPossession: assignment("ST", "Poacher", "Attack"), withBall: { depthM: 70, lateralM: 0 } })
  const winger = player({ inPossession: assignment("AMR", "Winger", "Support"), withBall: { depthM: 62, lateralM: 24 } })

  it("an inverted full-back who stays wide is not inverting", () => {
    const wide = player({ inPossession: assignment("DL", "Inverted Full-Back", "Support"), withBall: { depthM: 45, lateralM: -23 }, withoutBall: { depthM: 33, lateralM: -22 } })
    const tucked = player({ inPossession: assignment("DR", "Inverted Full-Back", "Support"), withBall: { depthM: 45, lateralM: 9 }, withoutBall: { depthM: 33, lateralM: 20 } })
    const team = teamContext([...centreBacks, striker, winger, wide, tucked])
    expect(checksFor(wide, team).checks[0]).toMatchObject({ asks: "come inside into midfield when we have the ball", verdict: "no" })
    expect(checksFor(tucked, team).checks[0]).toMatchObject({ verdict: "yes" })
  })

  it("a false nine at the top of the team is not dropping off", () => {
    const nine = player({ inPossession: assignment("ST", "False Nine", "Support"), withBall: { depthM: 72, lateralM: 1 } })
    const team = teamContext([...centreBacks, winger, nine])
    expect(checksFor(nine, team).checks[0]).toMatchObject({ asks: "drop off the front line to link play", verdict: "no" })
  })

  it("player instructions: counts are ranked within the team, and the rest are listed", () => {
    const shooter = player({ inPossession: assignment("AML", "Inside Forward", "Attack"), instructions: ["PI_SHOOT_LESS", "PI_MARK_TIGHTER"], withBall: { depthM: 63, lateralM: -10 }, per90: { ...striker.per90, shots: 6 } })
    const team = teamContext([...centreBacks, striker, winger, shooter])
    const { checks, unmeasured } = checksFor(shooter, team)
    expect(checks.find((item) => item.asks === "shoot less often")).toMatchObject({ verdict: "no", seen: expect.stringContaining("1st of 5") })
    expect(checks.find((item) => item.asks === "come inside from the flank")?.verdict).toBe("yes")
    expect(unmeasured).toEqual(["mark tighter"])
  })

  it("too little play is unclear, not a verdict", () => {
    const wingBack = player({ inPossession: assignment("WBR", "Wing-Back", "Support"), withBall: undefined })
    const team = teamContext([...centreBacks, striker, wingBack])
    expect(checksFor(wingBack, team).checks[0]).toMatchObject({ verdict: "unclear", seen: expect.stringContaining("not enough") })
  })
})
