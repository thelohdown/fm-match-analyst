// Sanity checks on the captured data, run before every answer. FMMatchLens reads
// FM's memory at fixed positions; after an FM update those positions can move and
// the numbers turn to nonsense without anything failing. The checks below hold for
// every frame of real matches (team totals equal the sum of the players', the
// structures are read from different objects), so a failure almost always means
// the capture is reading the wrong memory.

import { PLAYER_COUNTERS, type PlayerCounter, type MatchModel, type Side, type StatState, SIDES, TEAM_COUNTERS, type TeamCounter, other } from "./model"

export type DataCheck = {
  ok: boolean
  problems: string[]
}

const TOTALS: Array<{ team: TeamCounter; player: PlayerCounter; label: string; tolerance: number }> = [
  { team: "shots", player: "shots", label: "shots", tolerance: 0 },
  { team: "shotsOnTarget", player: "shotsOnTarget", label: "shots on target", tolerance: 0 },
  { team: "passes", player: "passes", label: "passes", tolerance: 0 },
  { team: "passesCompleted", player: "passesCompleted", label: "completed passes", tolerance: 0 },
  { team: "fouls", player: "fouls", label: "fouls", tolerance: 0 },
  { team: "xg", player: "xg", label: "xG", tolerance: 0.02 },
]

function totalProblems(state: StatState): string[] {
  const problems: string[] = []
  const teamValue = (side: Side, name: TeamCounter) => state.team[side][TEAM_COUNTERS.indexOf(name)]
  const playerSum = (side: Side, name: PlayerCounter) => {
    const index = PLAYER_COUNTERS.indexOf(name)
    let sum = 0
    for (const player of state.players.values()) if (player.team === side) sum += player.counters[index]
    return sum
  }
  for (const side of SIDES) {
    for (const total of TOTALS) {
      const team = teamValue(side, total.team)
      const players = playerSum(side, total.player)
      if (Math.abs(team - players) > total.tolerance) {
        problems.push(`${side} ${total.label}: team total ${round(team)} but the players add up to ${round(players)}`)
      }
    }
    const goals = teamValue(side, "goals")
    const scored = playerSum(side, "goals") + playerSum(other(side), "ownGoals")
    if (goals !== scored) problems.push(`${side} goals: team has ${goals} but player goals and opponent own goals add up to ${scored}`)
  }
  return problems
}

const round = (value: number) => Math.round(value * 100) / 100

export function checkData(model: MatchModel): DataCheck {
  const problems: string[] = []
  const end = model.endState()
  const last = model.last
  if (!end || !last) return { ok: true, problems }

  // Totals must agree now and at the end of the last complete minute, so a frame
  // read while FM was mid-update does not raise a false alarm.
  const lastClosed = [...model.buckets].reverse().find((bucket) => bucket.end)?.end
  const now = totalProblems(end)
  if (now.length > 0 && (!lastClosed || totalProblems(lastClosed).length > 0)) problems.push(...now)

  if (!(model.halfLength >= 44 && model.halfLength <= 57 && model.halfWidth >= 29 && model.halfWidth <= 41)) {
    problems.push(`pitch size ${round(model.halfLength * 2)} x ${round(model.halfWidth * 2)} m is not a football pitch`)
  }
  const inPlay = last.possessionTeam != null && last.period >= 1 && last.period <= 4
  if (inPlay) {
    for (const side of SIDES) {
      const onPitch = last.players.filter((player) => player.team === side && player.isOnPitch)
      if (onPitch.length < 7 || onPitch.length > 11) problems.push(`${side} has ${onPitch.length} players on the pitch`)
      const badRating = onPitch.find((player) => !(player.rating >= 1 && player.rating <= 10))
      if (badRating) problems.push(`${side} has a player rated ${badRating.rating}`)
      const badCondition = onPitch.find((player) => {
        const condition = (player as { overallPhysicalCondition?: number }).overallPhysicalCondition
        return condition != null && (condition < 0 || condition > 100)
      })
      if (badCondition) problems.push(`${side} has a player with condition outside 0-100%`)
    }
  }
  if (last.period < 1 || last.period > 6) problems.push(`the match period reads ${last.period}`)
  return { ok: problems.length === 0, problems }
}

/** The note added to answers when the checks fail. */
export function dataWarning(check: DataCheck): string | undefined {
  if (check.ok) return undefined
  return (
    "DATA CHECK FAILED: the captured numbers are inconsistent (" +
    check.problems.slice(0, 4).join("; ") +
    "). This usually means an FM update moved what FMMatchLens reads. Tell the user the figures cannot be trusted and do not give advice from them."
  )
}
