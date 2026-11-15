// get_roles: is each player doing what his role, duty and instructions ask? From
// the applied tactic, each player's role in and out of possession (and the player
// instructions, where captured) is turned into what can be measured: where he
// stands with and without the ball (average positions, in metres for his team),
// and what he does (per-90 counts, ranked within the team). Each check says what
// the role asks, what happened, and a verdict only where the evidence is clear.

import { decodeTacticalSnapshot } from "@/components/formation/tactics"
import type { PlayerTacticalAssignment } from "@/types/match"

import { type MatchModel, playerCounterIndex, type PlayerCounter, type Side, type WindowSelection } from "./model"
import { averagePositions, playerName, playerRoles, round, sideLabel, tickRange, windowInfo } from "./views"

/** Players with fewer minutes than this in the window are listed but not judged. */
const MIN_MINUTES = 20
/** Seconds of position samples needed in a phase to judge where a player stood in it. */
const MIN_PHASE_SECONDS = 120

export type Verdict = "yes" | "no" | "unclear"
export type Check = { asks: string; seen: string; verdict: Verdict }

type Spot = { depthM: number; lateralM: number }
export type PlayerEvidence = {
  playerId: number
  name: string
  minutes: number
  /** In-possession and out-of-possession assignment, from the tactic. */
  inPossession?: PlayerTacticalAssignment
  outOfPossession?: PlayerTacticalAssignment
  instructions: string[]
  /** Average spot with and without the ball: metres from own goal line, and from the centre line (negative = own left). */
  withBall?: Spot
  withoutBall?: Spot
  per90: Record<StatName, number>
}

type StatName = "shots" | "dribbles" | "crosses" | "keyPasses" | "progressivePasses" | "passes" | "ballWinning" | "aerials" | "fouls"
const STAT_LABEL: Record<StatName, string> = {
  shots: "shots",
  dribbles: "dribbles",
  crosses: "crosses",
  keyPasses: "key passes",
  progressivePasses: "progressive passes",
  passes: "passes",
  ballWinning: "tackles won + interceptions",
  aerials: "aerial duels",
  fouls: "fouls",
}

/** The team the checks compare against: everyone judged, with ranks and the team's own spread of positions. */
export type TeamContext = {
  judged: PlayerEvidence[]
  rank: (player: PlayerEvidence, stat: StatName) => { rank: number; of: number }
  /** Average depth of the centre-backs (players whose in-possession position is DC*), with and without the ball. */
  centreBackDepthM?: number
  centreBackDepthOutM?: number
  /** Depth of the most advanced outfield player, with and without the ball. */
  highestDepthM?: number
  highestDepthOutM?: number
  /** Distance from the centre line of the widest outfield player with the ball. */
  widestM?: number
}

/** Where a player stands between the centre-backs (0) and the most advanced teammate (1), with the ball. */
const depthScale = (team: TeamContext, spot: Spot) =>
  team.centreBackDepthM != null && team.highestDepthM != null && team.highestDepthM - team.centreBackDepthM > 5
    ? (spot.depthM - team.centreBackDepthM) / (team.highestDepthM - team.centreBackDepthM)
    : undefined
const depthScaleOut = (team: TeamContext, spot: Spot) =>
  team.centreBackDepthOutM != null && team.highestDepthOutM != null && team.highestDepthOutM - team.centreBackDepthOutM > 5
    ? (spot.depthM - team.centreBackDepthOutM) / (team.highestDepthOutM - team.centreBackDepthOutM)
    : undefined
/** How wide a player is with the ball, as a share of the team's widest player. */
const widthScale = (team: TeamContext, spot: Spot) => (team.widestM && team.widestM > 5 ? Math.abs(spot.lateralM) / team.widestM : undefined)

const m = (value: number) => `${Math.round(value)} m`
const fromCentre = (spot: Spot) => Math.abs(spot.lateralM)
const where = (spot: Spot | undefined) => (spot ? `${m(spot.depthM)} from own goal, ${m(fromCentre(spot))} from the centre line` : "not enough samples")

const roleIs = (assignment: PlayerTacticalAssignment | undefined, ...names: string[]) => {
  const role = assignment?.role.toLowerCase() ?? ""
  return names.some((name) => role === name || role.includes(name))
}
const dutyIs = (assignment: PlayerTacticalAssignment | undefined, duty: string) => assignment?.duty?.toLowerCase() === duty

/** A verdict from a measure against two thresholds; between them it is unclear. */
const judge = (value: number | undefined, yesIf: (v: number) => boolean, noIf: (v: number) => boolean): Verdict =>
  value == null ? "unclear" : yesIf(value) ? "yes" : noIf(value) ? "no" : "unclear"

const rankText = (team: TeamContext, player: PlayerEvidence, stat: StatName) => {
  const { rank, of } = team.rank(player, stat)
  return `${round(player.per90[stat], 1)} ${STAT_LABEL[stat]} per 90 (${ordinal(rank)} of ${of} in the team)`
}
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`

/** A count-based check: a top-3 rank says yes, the bottom half says no. */
function rankCheck(team: TeamContext, player: PlayerEvidence, stat: StatName, asks: string, high = true): Check {
  const { rank, of } = team.rank(player, stat)
  const top = rank <= Math.min(3, Math.ceil(of / 3))
  const bottom = rank > of / 2
  return { asks, seen: rankText(team, player, stat), verdict: high ? (top ? "yes" : bottom ? "no" : "unclear") : bottom ? "yes" : top ? "no" : "unclear" }
}

// ---------------------------------------------------------------------------
// What each role asks, as measurable checks

type RoleRule = (player: PlayerEvidence, team: TeamContext) => Check | undefined

/** The teammate in the mirrored position (DL for DR, AML for AMR), for comparison. */
function mirror(player: PlayerEvidence, team: TeamContext) {
  const position = player.inPossession?.position
  if (!position) return undefined
  const flipped = position.replace(/[LR]$/, (end) => (end === "L" ? "R" : "L"))
  if (flipped === position) return undefined
  return team.judged.find((other) => other !== player && other.inPossession?.position === flipped)
}

const withBallRule = (test: (p: PlayerEvidence) => boolean, asks: string, verdict: (spot: Spot, p: PlayerEvidence, team: TeamContext) => Verdict): RoleRule => (player, team) => {
  if (!test(player)) return undefined
  const spot = player.withBall
  if (!spot) return { asks, seen: "not enough time on the ball to tell", verdict: "unclear" }
  const peer = mirror(player, team)
  const peerText = peer?.withBall ? `; ${peer.name} (${peer.inPossession?.role}) on the other side: ${where(peer.withBall)}` : ""
  return { asks, seen: `with the ball: ${where(spot)}${player.withoutBall ? `; without: ${where(player.withoutBall)}` : ""}${peerText}`, verdict: verdict(spot, player, team) }
}

const ROLE_RULES: RoleRule[] = [
  // Full-backs and wing-backs.
  withBallRule(
    (p) => roleIs(p.inPossession, "inverted full-back", "inverted wing-back"),
    "come inside into midfield when we have the ball",
    (spot, p, team) => {
      const out = p.withoutBall ? fromCentre(p.withoutBall) : undefined
      const share = widthScale(team, spot)
      if ((share != null && share <= 0.6) || (out != null && fromCentre(spot) <= out - 5)) return "yes"
      return share != null && share >= 0.85 ? "no" : "unclear"
    }
  ),
  withBallRule(
    (p) =>
      (roleIs(p.inPossession, "wing-back") && !roleIs(p.inPossession, "inverted", "holding")) ||
      (roleIs(p.inPossession, "full-back") && !roleIs(p.inPossession, "inverted", "holding", "no-nonsense") && dutyIs(p.inPossession, "attack")),
    "push on down the flank when we have the ball",
    (spot, _p, team) => judge(depthScale(team, spot), (d) => d >= 0.45, (d) => d <= 0.2)
  ),
  withBallRule(
    (p) => roleIs(p.inPossession, "holding full-back", "holding wing-back", "no-nonsense full-back") || (roleIs(p.inPossession, "full-back") && !roleIs(p.inPossession, "inverted") && dutyIs(p.inPossession, "defend")),
    "stay back when we have the ball",
    (spot, _p, team) => judge(depthScale(team, spot), (d) => d <= 0.2, (d) => d >= 0.45)
  ),
  // Centre-backs.
  withBallRule(
    (p) => roleIs(p.inPossession, "overlapping centre-back", "wide centre-back"),
    "step out wide or forward from the back line with the ball",
    (spot, _p, team) => ((widthScale(team, spot) ?? 0) >= 0.7 || (team.centreBackDepthM != null && spot.depthM >= team.centreBackDepthM + 8) ? "yes" : "unclear")
  ),
  // Holding midfielders.
  withBallRule(
    (p) => roleIs(p.inPossession, "half-back"),
    "drop between the centre-backs when we have the ball",
    (spot, _p, team) => judge(team.centreBackDepthM == null ? undefined : Math.abs(spot.depthM - team.centreBackDepthM), (d) => d <= 4, (d) => d >= 10)
  ),
  withBallRule(
    (p) => roleIs(p.inPossession, "defensive midfielder", "anchor", "screening", "dropping defensive midfielder") && !roleIs(p.inPossession, "segundo volante"),
    "sit in front of the defence",
    (spot, _p, team) => judge(depthScale(team, spot), (d) => d <= 0.4, (d) => d >= 0.6)
  ),
  // Midfield runners.
  withBallRule(
    (p) => roleIs(p.inPossession, "box-to-box", "mezzala", "channel midfielder", "segundo volante") || (roleIs(p.inPossession, "central midfielder") && dutyIs(p.inPossession, "attack")),
    "get forward into the attacking third",
    (spot, _p, team) => judge(depthScale(team, spot), (d) => d >= 0.55, (d) => d <= 0.35)
  ),
  withBallRule(
    (p) => roleIs(p.inPossession, "shadow striker") || (roleIs(p.inPossession, "attacking midfielder") && dutyIs(p.inPossession, "attack")),
    "get up alongside the striker",
    (spot, _p, team) => judge(team.highestDepthM == null ? undefined : team.highestDepthM - spot.depthM, (gap) => gap <= 6, (gap) => gap >= 14)
  ),
  // Wide attackers.
  withBallRule(
    (p) => roleIs(p.inPossession, "winger", "wide midfielder", "wide-outlet", "defensive winger", "tracking winger") && !roleIs(p.inPossession, "inverted"),
    "hold the width when we have the ball",
    (spot, _p, team) => judge(widthScale(team, spot), (w) => w >= 0.85, (w) => w <= 0.6)
  ),
  withBallRule(
    (p) => roleIs(p.inPossession, "inside forward", "inverted winger", "wide forward", "inverting-outlet winger", "wide playmaker"),
    "come inside from the flank",
    (spot, _p, team) => judge(widthScale(team, spot), (w) => w <= 0.6, (w) => w >= 0.85)
  ),
  // Forwards.
  withBallRule(
    (p) => roleIs(p.inPossession, "false nine", "deep-lying forward", "central-outlet", "trequartista", "enganche"),
    "drop off the front line to link play",
    (spot, _p, team) => judge(team.highestDepthM == null ? undefined : team.highestDepthM - spot.depthM, (gap) => gap >= 8, (gap) => gap <= 3)
  ),
  withBallRule(
    (p) => roleIs(p.inPossession, "poacher", "channel forward", "advanced forward", "target man") || (roleIs(p.inPossession, "centre-forward", "complete forward") && dutyIs(p.inPossession, "attack")),
    "play on the last line",
    (spot, _p, team) => judge(team.highestDepthM == null ? undefined : team.highestDepthM - spot.depthM, (gap) => gap <= 3, (gap) => gap >= 10)
  ),
  // Without the ball.
  (p, team) => {
    if (!roleIs(p.outOfPossession, "tracking winger", "defensive winger", "tracking wide midfielder", "tracking attacking midfielder", "tracking centre-forward")) return undefined
    const asks = "track back without the ball"
    if (!p.withoutBall) return { asks, seen: "not enough time without the ball to tell", verdict: "unclear" }
    const peer = mirror(p, team)
    const peerText = peer?.withoutBall ? `; ${peer.name} (${peer.outOfPossession?.role ?? peer.inPossession?.role}) on the other side: ${where(peer.withoutBall)}` : ""
    return { asks, seen: `without the ball: ${where(p.withoutBall)}${peerText}`, verdict: judge(depthScaleOut(team, p.withoutBall), (d) => d <= 0.5, (d) => d >= 0.8) }
  },
  // What they do.
  (p, team) =>
    roleIs(p.inPossession, "ball-winning", "pressing", "stopping") || roleIs(p.outOfPossession, "ball-winning", "pressing", "stopping")
      ? rankCheck(team, p, "ballWinning", "win the ball back")
      : undefined,
  (p, team) => (roleIs(p.inPossession, "playmaker", "regista") ? rankCheck(team, p, "passes", "see a lot of the ball and dictate play") : undefined),
  (p, team) => (roleIs(p.inPossession, "target man", "target forward") ? rankCheck(team, p, "aerials", "win the ball in the air") : undefined),
]

// ---------------------------------------------------------------------------
// Player instructions

const INSTRUCTION_RULES: Record<string, (player: PlayerEvidence, team: TeamContext) => Check> = {
  PI_SHOOT_MORE: (p, t) => {
    const check = rankCheck(t, p, "shots", "shoot more often")
    return p.per90.shots === 0 && p.minutes >= 45 ? { ...check, verdict: "no" } : check
  },
  PI_SHOOT_LESS: (p, t) => rankCheck(t, p, "shots", "shoot less often", false),
  PI_DRIBBLE_MORE: (p, t) => rankCheck(t, p, "dribbles", "dribble more"),
  PI_DRIBBLE_LESS: (p, t) => rankCheck(t, p, "dribbles", "dribble less", false),
  PI_CROSS_OFTEN: (p, t) => rankCheck(t, p, "crosses", "cross more often"),
  PI_CROSS_LESS_OFTEN: (p, t) => rankCheck(t, p, "crosses", "cross less often", false),
  PI_TAKE_MORE_RISKS: (p, t) => ({ asks: "take more risks with his passing", seen: `${rankText(t, p, "keyPasses")}; ${rankText(t, p, "progressivePasses")}`, verdict: "unclear" }),
  PI_HIGHER_PRESSING_INTENSITY: (p, t) => rankCheck(t, p, "ballWinning", "press more"),
  PI_LOWER_PRESSING_INTENSITY: (p, t) => rankCheck(t, p, "ballWinning", "press less", false),
  PI_GET_STUCK_IN: (p, t) => ({ asks: "get stuck in", seen: `${rankText(t, p, "ballWinning")}; ${rankText(t, p, "fouls")}`, verdict: "unclear" }),
  PI_STAY_ON_FEET: (p, t) => rankCheck(t, p, "fouls", "stay on his feet", false),
  PI_GET_FORWARD_OFTEN: (p) => {
    const asks = "get forward more often"
    if (!p.withBall || !p.withoutBall) return { asks, seen: "not enough samples", verdict: "unclear" }
    const gain = p.withBall.depthM - p.withoutBall.depthM
    return { asks, seen: `${m(gain)} further forward with the ball than without (${where(p.withBall)})`, verdict: judge(gain, (g) => g >= 12, (g) => g <= 4) }
  },
  PI_HOLD_POSITION: (p) => {
    const asks = "hold his position"
    if (!p.withBall || !p.withoutBall) return { asks, seen: "not enough samples", verdict: "unclear" }
    const gain = p.withBall.depthM - p.withoutBall.depthM
    return { asks, seen: `${m(gain)} further forward with the ball than without`, verdict: judge(gain, (g) => g <= 8, (g) => g >= 15) }
  },
  PI_STAY_WIDER: (p, t) => {
    const asks = "stay wider"
    if (!p.withBall) return { asks, seen: "not enough samples", verdict: "unclear" }
    return { asks, seen: `with the ball: ${where(p.withBall)} (widest teammate ${t.widestM == null ? "?" : m(t.widestM)})`, verdict: judge(widthScale(t, p.withBall), (w) => w >= 0.85, (w) => w <= 0.6) }
  },
  PI_PLAY_NARROW: (p, t) => {
    const asks = "play narrower"
    if (!p.withBall) return { asks, seen: "not enough samples", verdict: "unclear" }
    return { asks, seen: `with the ball: ${where(p.withBall)} (widest teammate ${t.widestM == null ? "?" : m(t.widestM)})`, verdict: judge(widthScale(t, p.withBall), (w) => w <= 0.6, (w) => w >= 0.85) }
  },
}

const humanizePI = (name: string) => name.replace(/^PI_/, "").toLowerCase().replace(/_/g, " ")

export function checksFor(player: PlayerEvidence, team: TeamContext) {
  const checks: Check[] = []
  for (const rule of ROLE_RULES) {
    const check = rule(player, team)
    if (check) checks.push(check)
  }
  const unmeasured: string[] = []
  for (const name of player.instructions) {
    const rule = INSTRUCTION_RULES[name]
    if (rule) checks.push(rule(player, team))
    else unmeasured.push(humanizePI(name))
  }
  return { checks, unmeasured }
}

// ---------------------------------------------------------------------------
// Evidence from the match

/** Seconds a player was on the pitch within a tick range. */
function minutesIn(model: MatchModel, playerId: number, range: { from: number; to: number }) {
  const appearance = model.appearances.get(playerId)
  if (!appearance) return 0
  const on = appearance.startedOnPitch ? range.from : appearance.onTick
  if (on == null) return 0
  const from = Math.max(on, range.from)
  const to = Math.min(appearance.offTick ?? range.to, range.to)
  if (to <= from) return 0
  return (model.clockAtTick(to).seconds - model.clockAtTick(from).seconds) / 60
}

/** Instructions set for each player, by player id, from the latest captured tactic. */
function instructionsByPlayer(model: MatchModel, side: Side): Map<number, string[]> {
  const result = new Map<number, string[]>()
  if (!model.tactics) return result
  try {
    const decoded = decodeTacticalSnapshot(model.tactics)[side]
    const config = decoded.processing ?? decoded.command
    if (!config) return result
    for (const binding of decoded.players) {
      if (binding.tacticSlot == null || binding.tacticSlot < 0 || binding.tacticSlot >= 11) continue
      const names = config.inPossession.positions[binding.tacticSlot]?.explicit.instructions.map((instruction) => instruction.name) ?? []
      result.set(binding.playerId, names)
    }
  } catch {
    // Undecodable tactic: no instructions.
  }
  return result
}

export function playerEvidence(model: MatchModel, side: Side, selection: WindowSelection): PlayerEvidence[] {
  const range = tickRange(selection)
  const positions = averagePositions(model, selection.buckets)
  const instructions = instructionsByPlayer(model, side)
  const L2 = model.halfLength * 2
  const W2 = model.halfWidth * 2
  const spot = (point: { depth: number; width: number } | undefined, seconds: number): Spot | undefined =>
    point && seconds >= MIN_PHASE_SECONDS ? { depthM: (point.depth / 100) * L2, lateralM: (point.width / 100 - 0.5) * W2 } : undefined
  const rows: PlayerEvidence[] = []
  for (const [playerId, state] of selection.end.players) {
    if (state.team !== side) continue
    const minutes = minutesIn(model, playerId, range)
    if (minutes <= 0) continue
    const start = selection.start?.players.get(playerId)
    const count = (name: PlayerCounter) => state.counters[playerCounterIndex(name)] - (start?.counters[playerCounterIndex(name)] ?? 0)
    const per90 = (value: number) => (minutes > 0 ? (value * 90) / minutes : 0)
    const roles = playerRoles(model, playerId)
    const position = positions.get(playerId)
    rows.push({
      playerId,
      name: playerName(model, playerId) ?? `player ${playerId}`,
      minutes: Math.round(minutes),
      inPossession: roles?.inPossession,
      outOfPossession: roles?.outOfPossession,
      instructions: instructions.get(playerId) ?? [],
      withBall: spot(position?.inPossession, position?.samples.in ?? 0),
      withoutBall: spot(position?.outOfPossession, position?.samples.out ?? 0),
      per90: {
        shots: per90(count("shots")),
        dribbles: per90(count("dribbles")),
        crosses: per90(count("crosses")),
        keyPasses: per90(count("keyPasses")),
        progressivePasses: per90(count("progressivePasses")),
        passes: per90(count("passes")),
        ballWinning: per90(count("tacklesWon") + count("interceptions")),
        aerials: per90(count("aerials")),
        fouls: per90(count("fouls")),
      },
    })
  }
  return rows
}

export function teamContext(players: PlayerEvidence[]): TeamContext {
  const judged = players.filter((player) => player.minutes >= MIN_MINUTES && player.inPossession?.position !== "GK")
  const rank = (player: PlayerEvidence, stat: StatName) => {
    const higher = judged.filter((other) => other.per90[stat] > player.per90[stat]).length
    return { rank: higher + 1, of: judged.length }
  }
  const mean = (values: number[]) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined)
  const centreBacks = judged.filter((player) => player.inPossession?.position.startsWith("DC"))
  const withBall = judged.map((player) => player.withBall).filter((spot): spot is Spot => spot != null)
  const withoutBall = judged.map((player) => player.withoutBall).filter((spot): spot is Spot => spot != null)
  return {
    judged,
    rank,
    centreBackDepthM: mean(centreBacks.map((player) => player.withBall?.depthM).filter((depth): depth is number => depth != null)),
    centreBackDepthOutM: mean(centreBacks.map((player) => player.withoutBall?.depthM).filter((depth): depth is number => depth != null)),
    highestDepthM: withBall.length > 0 ? Math.max(...withBall.map((spot) => spot.depthM)) : undefined,
    highestDepthOutM: withoutBall.length > 0 ? Math.max(...withoutBall.map((spot) => spot.depthM)) : undefined,
    widestM: withBall.length > 0 ? Math.max(...withBall.map((spot) => Math.abs(spot.lateralM))) : undefined,
  }
}

const roleLabel = (assignment: PlayerTacticalAssignment | undefined) => (assignment ? `${assignment.position} ${assignment.role}${assignment.duty ? ` (${assignment.duty})` : ""}` : undefined)

/** The default window: since this team's latest tactic change, if that left enough play; else the whole match. */
export function defaultRoleWindow(model: MatchModel, side: Side): WindowSelection | undefined {
  const versions = model.tacticVersions.filter((version) => version.side === side)
  if (versions.length > 1) {
    const tick = versions.at(-1)!.tick
    const index = model.buckets.findIndex((bucket) => bucket.endTick >= tick)
    if (index >= 0 && model.buckets.length - index >= 15) return model.selectIndices(index, model.buckets.length - 1, "since your latest tactic change")
  }
  return model.select({})
}

export function roleReport(model: MatchModel, side: Side, selection: WindowSelection) {
  if (!model.tactics) {
    return { note: "The tactic was not captured for this match, so roles and instructions cannot be checked. Ask the user for the roles if it matters." }
  }
  const evidence = playerEvidence(model, side, selection)
  const team = teamContext(evidence)
  const players = []
  const notHappening: string[] = []
  for (const player of evidence) {
    if (!player.inPossession && !player.outOfPossession) continue
    const role = [roleLabel(player.inPossession), player.outOfPossession && roleLabel(player.outOfPossession) !== roleLabel(player.inPossession) ? `out of possession ${roleLabel(player.outOfPossession)}` : undefined]
      .filter(Boolean)
      .join("; ")
    if (selection.end.players.get(player.playerId)?.onPitch === false) {
      players.push({ player: player.name, role: undefined, minutes: player.minutes, note: "went off: his role came from an earlier tactic, so it is not checked" })
      continue
    }
    if (player.minutes < MIN_MINUTES || player.inPossession?.position === "GK") {
      players.push({ player: player.name, role, minutes: player.minutes, note: player.inPossession?.position === "GK" ? "goalkeeper: not checked" : `only ${player.minutes} minutes in this window: not judged` })
      continue
    }
    const { checks, unmeasured } = checksFor(player, team)
    for (const check of checks) if (check.verdict === "no") notHappening.push(`${player.name} (${role.split(";")[0]}): asked to ${check.asks}; ${check.seen}`)
    players.push({
      player: player.name,
      role,
      minutes: player.minutes,
      checks: checks.length > 0 ? checks : undefined,
      notMeasurable: unmeasured.length > 0 ? unmeasured : undefined,
      withBall: player.withBall ? where(player.withBall) : undefined,
      withoutBall: player.withoutBall ? where(player.withoutBall) : undefined,
    })
  }
  const changedInside = model.tacticVersions.some((version, index, all) => version.side === side && all.filter((v) => v.side === side).indexOf(version) > 0 && version.tick > tickRange(selection).from && version.tick <= tickRange(selection).to)
  return {
    team: sideLabel(model, side),
    window: windowInfo(model, selection),
    note: changedInside ? "The tactic changed inside this window; roles shown are the current ones, so earlier minutes may have been played to a different brief." : undefined,
    notHappening: notHappening.length > 0 ? notHappening : undefined,
    players,
    legend:
      "Roles and instructions are from the latest captured tactic. Each check says what the role or instruction asks, what happened, and a verdict: yes, no, or unclear " +
      "(the evidence sits between the thresholds, or there is too little of it). Positions are averages in metres for the player's own team: from its own goal line " +
      "(the pitch is about 105 m) and from the centre line across. Averages pull everyone towards the middle, so the verdicts compare each player with his own team " +
      "(between the centre-backs and the most advanced player; against the widest player) and with the player in the mirrored position. " +
      "Average positions also hide movement that goes both ways (a forward drifting into both channels averages central), " +
      "so treat a 'no' on width as a hint and look at the match. Counts are per 90 minutes and ranked among teammates with 20+ minutes. " +
      "FM's engine also asks things the capture cannot see (marking, movement off the ball); those are listed as notMeasurable.",
  }
}

/** For the briefing: role checks that are clearly not happening, for the user's team. */
export function rolesNotHappening(model: MatchModel, side: Side) {
  if (!model.tactics) return undefined
  const selection = defaultRoleWindow(model, side)
  if (!selection) return undefined
  const report = roleReport(model, side, selection) as { notHappening?: string[] }
  return report.notHappening
}
