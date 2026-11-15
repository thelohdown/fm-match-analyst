// get_opponent_read: how the other team is actually playing, read the way a
// scout would from the stands: its shape with and without the ball (matched to
// FM's formations from where its players stand), how high it defends and how
// hard it presses, how it builds up (goal kicks short or long), where it attacks
// and through whom, its transitions, and the individual matchups against our
// players that favour one side. Everything comes from what happened on the pitch,
// not from the opponent's tactic screen, which the player cannot see in FM.

import formationTemplates from "@/components/formation/data/formationTemplates"
import { decodeFormation, decodePosition } from "@/components/formation/formationDecoder"

import { type MatchModel, other, playerCounterIndex, type Side, type WindowSelection } from "./model"
import { PhaseContext } from "./phases"
import { windowPhases } from "./phaseViews"
import { type PlayerEvidence, playerEvidence } from "./roles"
import { attributeSheet, playerName, round, sideLabel, teamName, tickRange, windowInfo } from "./views"

/** Players need this many minutes in the window to count towards the shape. */
const SHAPE_MINUTES = 8

// ---------------------------------------------------------------------------
// Observed formation: match where the players stand to FM's formations

type GridPoint = { row: number; col: number; position: string }

/** FM's position code on a grid: rows from the back, columns from the team's left. */
function gridOf(code: string): GridPoint | undefined {
  const match = /^(GK|DM|D|WB|M|AM|ST)(C)?(L|R)?$/.exec(code)
  if (!match) return undefined
  const [, line, , side] = match
  const row = { GK: 0, D: 1, WB: 2, DM: 2, M: 3, AM: 4, ST: 5 }[line as "GK"]
  const centre = code.includes("C") || line === "DM" || line === "ST"
  const col = side ? (centre ? (side === "L" ? -1 : 1) : side === "L" ? -2 : 2) : 0
  return { row, col, position: code }
}

type Template = { name: string; displayName: string; slots: GridPoint[] }
let templates: Template[] | undefined
function allTemplates(): Template[] {
  if (templates) return templates
  templates = []
  const seen = new Set<string>()
  for (const template of formationTemplates.templates as ReadonlyArray<{ name: string; positions: number[] }>) {
    const slots = template.positions.map((mask) => gridOf(decodePosition(mask))).filter((slot): slot is GridPoint => slot != null && slot.row > 0)
    if (slots.length !== 10) continue
    const decoded = decodeFormation(template.positions)
    const displayName = decoded.matched ? decoded.displayName : template.name
    // Some native templates decode to names FM never shows (a trailing "-0"); skip them.
    if (seen.has(displayName) || /-0\b/.test(displayName)) continue
    seen.add(displayName)
    templates.push({ name: template.name, displayName, slots })
  }
  return templates
}

const zScores = (values: number[]) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1
  return values.map((value) => (value - mean) / spread)
}

/** Minimum-cost assignment of rows to columns of a square matrix (Hungarian algorithm). */
export function assign(cost: number[][]): number[] {
  const n = cost.length
  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0)
  const way = new Array(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(Number.POSITIVE_INFINITY)
    const used = new Array(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Number.POSITIVE_INFINITY
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (current < minv[j]) {
          minv[j] = current
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }
  const result = new Array(n).fill(-1)
  for (let j = 1; j <= n; j++) if (p[j] > 0) result[p[j] - 1] = j - 1
  return result
}

type Spot = { depthM: number; lateralM: number }

/** The FM formation closest to where ten outfield players stood, and who played where. */
export function observedFormation(players: ReadonlyArray<{ name: string; spot: Spot }>) {
  if (players.length !== 10) return undefined
  const depth = zScores(players.map((player) => player.spot.depthM))
  const lateral = zScores(players.map((player) => player.spot.lateralM))
  let best: { template: Template; cost: number; slots: number[] } | undefined
  let second: { template: Template; cost: number } | undefined
  for (const template of allTemplates()) {
    const rows = zScores(template.slots.map((slot) => slot.row))
    const cols = zScores(template.slots.map((slot) => slot.col))
    const cost = players.map((_, i) => template.slots.map((_, j) => (depth[i] - rows[j]) ** 2 + (lateral[i] - cols[j]) ** 2))
    const slots = assign(cost)
    const total = slots.reduce((sum, j, i) => sum + cost[i][j], 0)
    if (!best || total < best.cost) {
      if (best) second = { template: best.template, cost: best.cost }
      best = { template, cost: total, slots }
    } else if (!second || total < second.cost) second = { template, cost: total }
  }
  if (!best) return undefined
  const result = best
  return {
    formation: result.template.displayName,
    fit: result.cost / players.length < 0.25 ? "clear" : result.cost / players.length < 0.5 ? "fair" : "loose",
    closeTo: second && second.cost - result.cost < 0.1 * result.cost ? second.template.displayName : undefined,
    positions: players
      .map((player, i) => ({ player: player.name, position: result.template.slots[result.slots[i]].position, slot: result.template.slots[result.slots[i]] }))
      .sort((left, right) => left.slot.row - right.slot.row || left.slot.col - right.slot.col)
      .map(({ player, position }) => `${position} ${player}`),
  }
}

/** The ten outfield players on the pitch at the end of the window, with enough minutes. */
function outfield(model: MatchModel, evidence: PlayerEvidence[], selection: WindowSelection, phase: "withBall" | "withoutBall") {
  const onPitch = evidence.filter((player) => selection.end.players.get(player.playerId)?.onPitch !== false && player.minutes >= SHAPE_MINUTES && player[phase])
  if (onPitch.length < 10) return undefined
  // The deepest player is the goalkeeper.
  const sorted = [...onPitch].sort((left, right) => left[phase]!.depthM - right[phase]!.depthM)
  const rest = sorted.slice(1)
  return rest.length === 10 ? rest.map((player) => ({ name: player.name, spot: player[phase]!, playerId: player.playerId })) : undefined
}

// ---------------------------------------------------------------------------
// Matchups

const ATTRIBUTE = (model: MatchModel, playerId: number) => {
  const sheet = attributeSheet(model, playerId)
  const physical = (sheet?.physical ?? {}) as Record<string, number>
  return { pace: physical.Pace, acceleration: physical.Acceleration, strength: physical.Strength, jumping: physical["Jumping Reach"], heightCm: sheet?.heightCm }
}

function matchups(model: MatchModel, them: PlayerEvidence[], us: PlayerEvidence[], selection: WindowSelection) {
  const L2 = model.halfLength * 2
  const theirOutfield = outfield(model, them, selection, "withBall")
  const ourOutfield = outfield(model, us, selection, "withoutBall")
  if (!theirOutfield || !ourOutfield) return undefined
  // Their four most advanced players with the ball, against whoever of ours stood nearest them without it.
  const attackers = [...theirOutfield].sort((left, right) => right.spot.depthM - left.spot.depthM).slice(0, 4)
  const rows = []
  for (const attacker of attackers) {
    const mirrored = { depthM: L2 - attacker.spot.depthM, lateralM: -attacker.spot.lateralM }
    const defender = ourOutfield.reduce((best, candidate) => {
      const distance = Math.hypot(candidate.spot.depthM - mirrored.depthM, candidate.spot.lateralM - mirrored.lateralM)
      return !best || distance < best.distance ? { candidate, distance } : best
    }, undefined as { candidate: (typeof ourOutfield)[number]; distance: number } | undefined)
    if (!defender) continue
    const a = ATTRIBUTE(model, attacker.playerId)
    const d = ATTRIBUTE(model, defender.candidate.playerId)
    const notes: string[] = []
    const edge = (label: string, theirs: number | undefined, ours: number | undefined, unit = "") => {
      if (theirs == null || ours == null) return
      if (theirs - ours >= 3) notes.push(`${attacker.name} has the edge on ${label} (${theirs}${unit} v ${ours}${unit})`)
      else if (ours - theirs >= 3) notes.push(`${defender.candidate.name} has the edge on ${label} (${ours}${unit} v ${theirs}${unit})`)
    }
    edge("pace", a.pace, d.pace)
    edge("acceleration", a.acceleration, d.acceleration)
    edge("strength", a.strength, d.strength)
    edge("jumping reach", a.jumping, d.jumping)
    if (a.heightCm && d.heightCm && Math.abs(a.heightCm - d.heightCm) >= 8) {
      notes.push(`${a.heightCm > d.heightCm ? attacker.name : defender.candidate.name} is ${Math.abs(a.heightCm - d.heightCm)} cm taller`)
    }
    const attackerRow = them.find((player) => player.playerId === attacker.playerId)!
    const defenderRow = us.find((player) => player.playerId === defender.candidate.playerId)!
    rows.push({
      theirPlayer: attacker.name,
      againstOurs: defender.candidate.name,
      attributes: notes.length > 0 ? notes : a.pace == null ? "attributes not captured" : "no clear edge in pace, strength or the air",
      onThePitch: `${attacker.name}: ${round(attackerRow.per90.dribbles, 1)} dribbles, ${round(attackerRow.per90.shots, 1)} shots per 90; ${defender.candidate.name}: ${round(defenderRow.per90.ballWinning, 1)} tackles won + interceptions per 90`,
      watch: notes.some((note) => note.startsWith(attacker.name)) || undefined,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// The read

const channelText = (entries: { left: number; centre: number; right: number }, ours: string) => {
  const total = entries.left + entries.centre + entries.right
  if (total === 0) return "no final-third entries yet"
  // Their left is our right.
  return `${total} final-third entries: ${entries.right} down ${ours}'s left, ${entries.centre} through the middle, ${entries.left} down ${ours}'s right`
}

export function opponentRead(model: MatchModel, side: Side, selection: WindowSelection) {
  const us = other(side)
  const ourName = teamName(model, us)
  const context = new PhaseContext(model)
  const window = windowPhases(context, selection)
  const team = window.teams[side]
  const theirEvidence = playerEvidence(model, side, selection)
  const ourEvidence = playerEvidence(model, us, selection)

  const shape = (phase: "withBall" | "withoutBall") => {
    const players = outfield(model, theirEvidence, selection, phase)
    return players ? observedFormation(players) : undefined
  }

  // Goal kicks and keeper restarts: short to the defence, or long.
  const range = tickRange(selection)
  let short = 0
  let long = 0
  for (const spell of context.spells) {
    if (spell.side !== side || spell.kind !== "restart" || spell.startTick < range.from || spell.startTick > range.to) continue
    if ((spell.startDepth ?? 50) >= 17 || Math.abs(spell.startX) > 20.16 || !spell.direction) continue
    const receiver = spell.holders.find((holder, index) => index > 0 && model.teamOf(holder.playerId) === side)
    const depth = receiver ? context.depth(receiver.y, spell.direction) : undefined
    if (depth == null) {
      long++ // lost before anyone of theirs had it: a long ball contested, usually
      continue
    }
    if (depth < 100 / 3) short++
    else long++
  }

  // Who they go through, and who threatens.
  const involvement = new Map<number, number>()
  for (const spell of context.spells) {
    if (spell.side !== side || spell.startTick < range.from || spell.startTick > range.to) continue
    for (const holder of spell.holders) if (model.teamOf(holder.playerId) === side) involvement.set(holder.playerId, (involvement.get(holder.playerId) ?? 0) + 1)
  }
  const totalTouches = [...involvement.values()].reduce((sum, value) => sum + value, 0)
  const throughWhom = [...involvement.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([playerId, count]) => `${playerName(model, playerId)} (${Math.round((count / Math.max(1, totalTouches)) * 100)}% of their touches)`)
  const threat = [...selection.end.players.entries()]
    .filter(([, state]) => state.team === side)
    .map(([playerId, state]) => {
      const start = selection.start?.players.get(playerId)
      const value = (name: "xg" | "xa" | "keyPasses" | "shots") => state.counters[playerCounterIndex(name)] - (start?.counters[playerCounterIndex(name)] ?? 0)
      return { name: playerName(model, playerId), xg: value("xg"), xa: value("xa"), keyPasses: value("keyPasses"), shots: value("shots") }
    })
    .filter((row) => row.xg + row.xa > 0.05 || row.keyPasses > 0)
    .sort((left, right) => right.xg + right.xa - (left.xg + left.xa))
    .slice(0, 3)
    .map((row) => `${row.name}: ${round(row.xg)} xG from ${row.shots} shot${row.shots === 1 ? "" : "s"}, ${round(row.xa)} xA from ${row.keyPasses} key pass${row.keyPasses === 1 ? "" : "es"}`)

  const crosses = team.inPossession.openPlayCrosses
  const withBall = shape("withBall")
  const withoutBall = shape("withoutBall")
  return {
    team: sideLabel(model, side),
    window: windowInfo(model, selection),
    shape: {
      withTheBall: withBall ?? "too few minutes or players to tell",
      withoutTheBall: withoutBall ?? "too few minutes or players to tell",
    },
    withoutTheBall: {
      block: team.outOfPossession.block,
      lineWhenWeBuildUp: team.outOfPossession.defensiveLineM.whenTheyBuildUp != null ? `${team.outOfPossession.defensiveLineM.whenTheyBuildUp} m from their goal` : undefined,
      lineWhenWeAreInMidfield: team.outOfPossession.defensiveLineM.whenTheyProgress != null ? `${team.outOfPossession.defensiveLineM.whenTheyProgress} m from their goal` : undefined,
      pressing: team.outOfPossession.ppda == null ? "hardly any defensive actions high up" : `ppda ${team.outOfPossession.ppda} (${ourName}: ${window.teams[us].outOfPossession.ppda ?? "n/a"}); lower = more pressing`,
      highRegains: team.outOfPossession.highRegains,
      wonBackWithin5sAfterLosingIt: `${team.defensiveTransition.regainedWithin5s} of ${team.defensiveTransition.openPlayLosses}`,
    },
    withTheBall: {
      buildUp: `long passes ${team.inPossession.longPassPct ?? "n/a"}% of passes; ${team.inPossession.buildUpPct ?? "n/a"}% of their time on the ball in build-up`,
      goalKicksAndKeeperRestarts: short + long > 0 ? `${short} short to the defence, ${long} long` : "none in this stretch",
      whereTheyAttack: channelText(team.inPossession.finalThirdEntries, ourName),
      crosses: `from ${ourName}'s left ${crosses.right.attempted} (${crosses.right.completed} found a teammate), from ${ourName}'s right ${crosses.left.attempted} (${crosses.left.completed})`,
      boxEntries: team.inPossession.boxEntries,
      shots: `settled ${team.inPossession.shots.settled.shots}, transition ${team.inPossession.shots.transition.shots}, set pieces ${team.inPossession.shots.setPiece.shots}`,
      throughWhom: throughWhom.length > 0 ? throughWhom : undefined,
      mostDangerous: threat.length > 0 ? threat : undefined,
    },
    transitions: {
      fastBreaks: team.attackingTransition.counters,
      fromRegains: team.attackingTransition.openPlayRegains,
      shotsWithin15sOfWinningIt: team.attackingTransition.shots.shots,
    },
    matchups: matchups(model, theirEvidence, ourEvidence, selection),
    legend:
      "Read from what happened on the pitch, not from the opponent's tactic. shape matches where their ten outfield players stood on average (with and without the ball) " +
      "to the nearest FM formation; fit says how close (clear, fair, loose) and closeTo names a near alternative. Line heights are metres from their own goal. " +
      "Channels are from your point of view (their attacks down your left or right). matchups pair their four most advanced players with whoever of yours stood nearest them, " +
      "and compare FM's 1-20 attributes where the gap is 3 or more; watch marks the ones that favour them. Early in a match, a few minutes of play make every figure noisy.",
  }
}

/** For the briefing: both teams' shapes as seen, and the matchups that favour the opponent. */
export function briefingRead(model: MatchModel, user: Side, selection: WindowSelection) {
  const read = opponentRead(model, other(user), selection)
  const name = (value: unknown) => (typeof value === "object" && value && "formation" in value ? (value as { formation: string }).formation : undefined)
  const ours = playerEvidence(model, user, selection)
  const ourShape = (phase: "withBall" | "withoutBall") => {
    const players = outfield(model, ours, selection, phase)
    return players ? observedFormation(players)?.formation : undefined
  }
  return {
    shapesAsPlayed: {
      [sideLabel(model, user)]: { withTheBall: ourShape("withBall"), withoutTheBall: ourShape("withoutBall") },
      [read.team]: { withTheBall: name(read.shape.withTheBall), withoutTheBall: name(read.shape.withoutTheBall) },
    },
    matchupsToWatch: read.matchups?.filter((row) => row.watch).map((row) => `${row.theirPlayer} v ${row.againstOurs}: ${(row.attributes as string[]).join("; ")}`),
  }
}
