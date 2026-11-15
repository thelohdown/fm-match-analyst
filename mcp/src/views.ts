// What each tool returns: compact, named, rounded summaries of a MatchModel.
// Everything is from the point of view of a team where it can be (own goal to
// opponent goal, left to right as that team attacks), and every time is FM's
// match clock (see clock.ts).

import type { RealtimePlayerMetadata } from "@/api/realtimeMatch"
import { decodeTacticalSnapshot } from "@/components/formation/tactics"
import type { MatchMomentumPoint, TacticalEventPoint, XgShotPoint } from "@/types/match"

import { clockLabel, minuteLabel, periodName } from "./clock"
import {
  type Bucket,
  type MatchModel,
  type MatchWindow,
  type PlayerState,
  type Side,
  type WindowSelection,
  other,
  PLAYER_COUNTERS,
  playerCounterIndex,
  SHAPE_FIELDS,
  shapeIndex,
  SIDES,
  TEAM_COUNTERS,
  teamCounterIndex,
} from "./model"

export type TeamChoice = "home" | "away" | "mine" | "opponent" | "both"

export type SourceInfo = {
  kind: "live" | "archive"
  /** live: FMMatchLens's status (live, ended, interrupted); archive: file name. */
  detail: string
}

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null)

export function teamName(model: MatchModel, side: Side): string {
  return model.metadata?.[side]?.name ?? (side === "home" ? "Home" : "Away")
}

function managerName(model: MatchModel, side: Side): string | undefined {
  const manager = model.metadata?.[side]?.manager
  if (!manager) return undefined
  return [manager.firstName, manager.secondName].filter(Boolean).join(" ") || undefined
}

function playerMeta(model: MatchModel, playerId: number): RealtimePlayerMetadata | undefined {
  return model.metadata?.players.find((player) => player.playerId === playerId)
}

export function playerName(model: MatchModel, playerId: number | undefined): string | undefined {
  if (playerId == null) return undefined
  const meta = playerMeta(model, playerId)
  return meta?.displayName ?? meta?.shirtName ?? `player ${playerId}`
}

/** Resolves a team argument to sides; "mine"/"opponent" need a human-controlled side. */
export function resolveSides(model: MatchModel, choice: TeamChoice | undefined): { sides: Side[]; note?: string } {
  const user = model.userSide()
  switch (choice ?? "both") {
    case "home":
      return { sides: ["home"] }
    case "away":
      return { sides: ["away"] }
    case "mine":
      return user
        ? { sides: [user] }
        : { sides: ["home", "away"], note: "Could not tell which team you manage; showing both." }
    case "opponent":
      return user
        ? { sides: [other(user)] }
        : { sides: ["home", "away"], note: "Could not tell which team you manage; showing both." }
    default:
      return { sides: ["home", "away"] }
  }
}

function eventTime(model: MatchModel, tick: number) {
  const { period, seconds } = model.clockAtTick(tick)
  return { minute: minuteLabel(seconds, period), period }
}

function sideLabel(model: MatchModel, side: Side): string {
  const user = model.userSide()
  return user === side ? `${teamName(model, side)} (you)` : teamName(model, side)
}

// ---------------------------------------------------------------------------
// Team-relative geometry

/** Event coordinates from the dashboard (0-100, home attacking towards x=100) for a team. */
function eventPoint(event: { team: Side; x: number; y: number }) {
  return event.team === "home" ? { depth: event.x, width: event.y } : { depth: 100 - event.x, width: 100 - event.y }
}

/** Where on the pitch, for the team that did it: third and channel. */
function areaLabel(depth: number, width: number): string {
  const third = depth < 100 / 3 ? "own third" : depth < 200 / 3 ? "middle third" : "final third"
  const channel = width < 100 / 3 ? "left" : width > 200 / 3 ? "right" : "centre"
  return `${third}, ${channel}`
}

function shotLocation(model: MatchModel, event: { team: Side; x: number; y: number }) {
  const { depth, width } = eventPoint(event)
  const fromGoalLine = ((100 - depth) / 100) * model.halfLength * 2
  const fromCentre = ((width - 50) / 100) * model.halfWidth * 2
  const distance = Math.hypot(fromGoalLine, fromCentre)
  const area =
    fromGoalLine <= 5.5 && Math.abs(fromCentre) <= 9.16
      ? "six-yard box"
      : fromGoalLine <= 16.5 && Math.abs(fromCentre) <= 20.16
        ? "inside the box"
        : "outside the box"
  const channel = Math.abs(fromCentre) < 7 ? "central" : fromCentre < 0 ? "left side" : "right side"
  return { where: `${area}, ${channel}`, distanceM: Math.round(distance) }
}

const SHOT_OUTCOME: Record<string, string> = {
  goals: "goal",
  shotsOnTarget: "saved",
  shotsOffTarget: "off target",
  hitWoodwork: "hit the woodwork",
  blockedShots: "blocked",
}

const ANNOTATION_TEXT: Record<string, string> = {
  clearCutChance: "clear-cut chance",
  penaltyKick: "penalty",
  attackingFreeKick: "from a free kick",
  corner: "from a corner",
  keyTackle: "key tackle",
  goalkeeperSaveHeld: "save held",
  goalkeeperSaveParried: "save parried",
  goalkeeperSaveTipped: "save tipped over/round",
  ownGoal: "own goal",
}

const annotationsOf = (event: { annotations?: readonly string[] }) =>
  (event.annotations ?? []).map((annotation) => ANNOTATION_TEXT[annotation]).filter(Boolean)

// ---------------------------------------------------------------------------
// Positions and shape

type PlayerPosition = {
  playerId: number
  side: Side
  samples: { in: number; out: number }
  inPossession?: { depth: number; width: number }
  outOfPossession?: { depth: number; width: number }
  overall?: { depth: number; width: number }
}

function orientationFor(model: MatchModel, period: number, side: Side): 1 | -1 | undefined {
  const own = model.orientation(period, side)
  if (own) return own
  const opponent = model.orientation(period, other(side))
  return opponent ? (opponent === 1 ? -1 : 1) : undefined
}

/** Average positions (percent of pitch length from own goal, of width from the left touchline). */
function averagePositions(model: MatchModel, buckets: readonly Bucket[]): Map<number, PlayerPosition> {
  const sums = new Map<number, { side: Side; inN: number; inD: number; inW: number; outN: number; outD: number; outW: number }>()
  const L = model.halfLength
  const W = model.halfWidth
  for (const bucket of buckets) {
    for (const [playerId, values] of bucket.positions) {
      const side = model.teamOf(playerId)
      if (!side) continue
      const orientation = orientationFor(model, bucket.period, side)
      if (!orientation) continue
      const entry = sums.get(playerId) ?? { side, inN: 0, inD: 0, inW: 0, outN: 0, outD: 0, outW: 0 }
      // depth = s*y + L, lateral = s*x + W (metres), summed over samples.
      entry.inN += values[0]
      entry.inW += orientation * values[1] + values[0] * W
      entry.inD += orientation * values[2] + values[0] * L
      entry.outN += values[3]
      entry.outW += orientation * values[4] + values[3] * W
      entry.outD += orientation * values[5] + values[3] * L
      sums.set(playerId, entry)
    }
  }
  const result = new Map<number, PlayerPosition>()
  const point = (n: number, depth: number, width: number) =>
    n > 0 ? { depth: Math.round((depth / n / (2 * L)) * 100), width: Math.round((width / n / (2 * W)) * 100) } : undefined
  for (const [playerId, entry] of sums) {
    result.set(playerId, {
      playerId,
      side: entry.side,
      samples: { in: entry.inN, out: entry.outN },
      inPossession: point(entry.inN, entry.inD, entry.inW),
      outOfPossession: point(entry.outN, entry.outD, entry.outW),
      overall: point(entry.inN + entry.outN, entry.inD + entry.outD, entry.inW + entry.outW),
    })
  }
  return result
}

/** Where a player played, from FM's position if captured, else from his average position. */
function zoneLabels(model: MatchModel, positions: Map<number, PlayerPosition>, side: Side): Map<number, string> {
  const labels = new Map<number, string>()
  const players = [...positions.values()].filter((entry) => entry.side === side && entry.overall && entry.samples.in + entry.samples.out >= 60)
  if (players.length === 0) return labels
  const keeper = players.reduce((best, entry) => (entry.overall!.depth < best.overall!.depth ? entry : best))
  const outfield = players.filter((entry) => entry !== keeper)
  const depths = outfield.map((entry) => entry.overall!.depth)
  const low = Math.min(...depths)
  const high = Math.max(...depths)
  for (const entry of players) {
    const captured = playerMeta(model, entry.playerId)?.position
    if (captured) {
      labels.set(entry.playerId, captured)
      continue
    }
    if (entry === keeper && entry.overall!.depth < 20) {
      labels.set(entry.playerId, "goalkeeper")
      continue
    }
    const relative = high > low ? (entry.overall!.depth - low) / (high - low) : 0.5
    const width = entry.overall!.width
    const channel = width < 35 ? "left" : width > 65 ? "right" : "central"
    const band =
      relative < 0.2 ? "defence" : relative < 0.45 ? "deep midfield" : relative < 0.75 ? "advanced midfield" : "attack"
    const names: Record<string, Record<string, string>> = {
      defence: { left: "left back", central: "centre-back", right: "right back" },
      "deep midfield": { left: "left wing-back / left midfield", central: "defensive / central midfield", right: "right wing-back / right midfield" },
      "advanced midfield": { left: "left midfield / left wing", central: "central / attacking midfield", right: "right midfield / right wing" },
      attack: { left: "left forward / left wing", central: "striker", right: "right forward / right wing" },
    }
    labels.set(entry.playerId, `${names[band][channel]} (inferred)`)
  }
  return labels
}

function shapeSummary(model: MatchModel, buckets: readonly Bucket[], side: Side) {
  const phases = [0, 1].map((phase) => {
    const totals = new Float64Array(SHAPE_FIELDS)
    for (const bucket of buckets) {
      const orientation = orientationFor(model, bucket.period, side)
      if (!orientation) continue
      const base = shapeIndex(phase, orientation)
      for (let field = 0; field < SHAPE_FIELDS; field++) totals[field] += bucket.shape[side][base + field]
    }
    const n = totals[0]
    if (n === 0) return undefined
    return {
      defensiveLineM: Math.round(totals[1] / n),
      highestPlayersM: Math.round(totals[2] / n),
      lengthM: Math.round(totals[3] / n),
      widthM: Math.round(totals[4] / n),
      averageHeightM: Math.round(totals[5] / n),
      seconds: n,
    }
  })
  return { inPossession: phases[0], outOfPossession: phases[1] }
}

/** Share of time the ball spent in each third, from this team's point of view. */
function territory(model: MatchModel, buckets: readonly Bucket[], side: Side) {
  let own = 0
  let middle = 0
  let attacking = 0
  for (const bucket of buckets) {
    const orientation = orientationFor(model, bucket.period, side)
    if (!orientation) continue
    const [negative, centre, positive] = bucket.ballThirds
    middle += centre
    if (orientation === 1) {
      own += negative
      attacking += positive
    } else {
      own += positive
      attacking += negative
    }
  }
  const total = own + middle + attacking
  if (total === 0) return undefined
  return { ownThirdPct: pct(own, total), middleThirdPct: pct(middle, total), attackingThirdPct: pct(attacking, total) }
}

// ---------------------------------------------------------------------------
// Windows

function tickRange(selection: WindowSelection) {
  return { from: selection.buckets[0].startTick, to: selection.buckets.at(-1)!.endTick }
}

function windowInfo(model: MatchModel, selection: WindowSelection) {
  const first = selection.buckets[0]
  const last = selection.buckets.at(-1)!
  return {
    description: selection.label,
    from: clockLabel(first.startSeconds, first.period),
    to: clockLabel(last.endSeconds, last.period),
  }
}

function inWindow(selection: WindowSelection, tick: number) {
  const range = tickRange(selection)
  return tick >= range.from && tick <= range.to
}

const teamDiff = (selection: WindowSelection, side: Side, name: (typeof TEAM_COUNTERS)[number]) => {
  const index = teamCounterIndex(name)
  return selection.end.team[side][index] - (selection.start?.team[side][index] ?? 0)
}

// ---------------------------------------------------------------------------
// Tools

export function matchState(model: MatchModel, source: SourceInfo) {
  const end = model.endState()
  const last = model.last
  const history = model.history()
  const user = model.userSide()
  // After full time FM moves on to a later period while the players walk off;
  // the clock stays on the last period actually played.
  const period = model.buckets.at(-1)?.period ?? last?.period ?? 1
  const clock = model.lastClockSeconds
  const team = (side: Side) => {
    const values = end?.team[side]
    const value = (name: (typeof TEAM_COUNTERS)[number]) => (values ? values[teamCounterIndex(name)] : 0)
    return {
      name: teamName(model, side),
      manager: managerName(model, side),
      controlledBy: model.metadata?.[side]?.manager ? (model.metadata[side].manager!.isHumanControlled ? "human (you)" : "AI") : undefined,
      goals: value("goals"),
      xg: round(value("xg")),
      shots: value("shots"),
      shotsOnTarget: value("shotsOnTarget"),
    }
  }
  const possession = (window: MatchWindow) => {
    const selection = model.select(window)
    if (!selection) return undefined
    const home = teamDiff(selection, "home", "possessionTime")
    const away = teamDiff(selection, "away", "possessionTime")
    return { [teamName(model, "home")]: pct(home, home + away), [teamName(model, "away")]: pct(away, home + away) }
  }
  const finished = source.kind === "archive" || source.detail === "ended"
  return {
    source: source.kind === "live" ? `live from FMMatchLens (${source.detail})` : `archive ${source.detail}`,
    status: finished ? "full time" : source.detail === "interrupted" ? "capture interrupted" : "in play or paused",
    competition: model.metadata?.competition?.name,
    date: model.metadata?.matchDate,
    youManage: user ? teamName(model, user) : "unknown (no human-controlled manager found)",
    score: `${teamName(model, "home")} ${team("home").goals}-${team("away").goals} ${teamName(model, "away")}`,
    clock: clockLabel(clock, period),
    minute: minuteLabel(clock, period),
    period: periodName(period),
    home: team("home"),
    away: team("away"),
    possessionPct: { wholeMatch: possession({}), last10Minutes: possession({ lastMinutes: 10 }) },
    momentum: momentumSummary(model, history.momentum, history.rollingMomentum, clock),
    goals: goalList(model, history),
    cards: cardList(model, history),
    substitutions: substitutionList(model),
    dataNotes: dataNotes(model, source),
  }
}

function momentumSummary(
  model: MatchModel,
  blocks: readonly MatchMomentumPoint[],
  rolling: readonly MatchMomentumPoint[],
  clockSeconds: number
) {
  const home = teamName(model, "home")
  const away = teamName(model, "away")
  const onTop = (value: number) => (Math.abs(value) < 0.15 ? "even" : value > 0 ? home : away)
  const nowMinute = clockSeconds / 60
  const recent = (minutes: number) => {
    const points = rolling.filter((point) => point.minute > nowMinute - minutes && point.minute <= nowMinute + 0.01)
    if (points.length === 0) return undefined
    const value = points.reduce((sum, point) => sum + point.value, 0) / points.length
    return { value: round(value), onTop: onTop(value) }
  }
  return {
    scale: `-1 to +1 from FM's match momentum; positive favours ${home}, negative ${away}`,
    last5Minutes: recent(5),
    last10Minutes: recent(10),
    last15Minutes: recent(15),
    byFiveMinutes: blocks.map((point) => ({
      upTo: `${Math.round(point.minute)}'`,
      value: round(point.value),
      onTop: onTop(point.value),
    })),
  }
}

type History = ReturnType<MatchModel["history"]>

function goalList(model: MatchModel, history: History) {
  const assists = history.events.filter((event) => event.type === "assist_candidate")
  return history.events
    .filter((event) => event.type === "goal" || event.type === "own_goal")
    .map((event) => {
      const assist = assists.find((candidate) => candidate.tick === event.tick && candidate.team === event.team)
      return {
        minute: event.tick != null ? eventTime(model, event.tick).minute : `${event.minute}'`,
        team: event.team ? teamName(model, event.team) : undefined,
        scorer: playerName(model, event.playerId),
        ownGoal: event.type === "own_goal" || undefined,
        assist: playerName(model, assist?.playerId),
      }
    })
}

function cardList(model: MatchModel, history: History) {
  return history.events
    .filter((event) => event.type === "yellow_card" || event.type === "red_card")
    .map((event) => ({
      minute: event.tick != null ? eventTime(model, event.tick).minute : `${event.minute}'`,
      card: event.type === "red_card" ? "red" : "yellow",
      team: event.team ? teamName(model, event.team) : undefined,
      player: playerName(model, event.playerId),
    }))
}

export function substitutionList(model: MatchModel) {
  const reds = new Set(model.history().events.filter((event) => event.type === "red_card").map((event) => event.playerId))
  const ons: Array<{ playerId: number; side: Side; tick: number }> = []
  const offs: Array<{ playerId: number; side: Side; tick: number }> = []
  for (const [playerId, appearance] of model.appearances) {
    if (appearance.onTick != null) ons.push({ playerId, side: appearance.team, tick: appearance.onTick })
    if (appearance.offTick != null && !reds.has(playerId)) offs.push({ playerId, side: appearance.team, tick: appearance.offTick })
  }
  ons.sort((left, right) => left.tick - right.tick)
  const used = new Set<number>()
  return ons.map((on) => {
    const off = offs
      .filter((candidate) => candidate.side === on.side && !used.has(candidate.playerId) && Math.abs(candidate.tick - on.tick) <= 240)
      .sort((left, right) => Math.abs(left.tick - on.tick) - Math.abs(right.tick - on.tick))[0]
    if (off) used.add(off.playerId)
    return {
      minute: eventTime(model, on.tick).minute,
      team: teamName(model, on.side),
      on: playerName(model, on.playerId),
      off: playerName(model, off?.playerId),
    }
  })
}

function dataNotes(model: MatchModel, source: SourceInfo): string[] {
  const notes: string[] = []
  const anyPosition = model.metadata?.players.some((player) => player.position)
  if (!anyPosition) {
    notes.push(
      "Player positions, roles and tactics were not captured (FMMatchLens on macOS does not read them yet); positions are inferred from where players actually stood."
    )
  }
  const anyAttributes = model.metadata?.players.some((player) => player.attributes)
  if (!anyAttributes) notes.push("Player attributes, morale and season stats were not captured.")
  if (source.kind === "live" && model.last) notes.push(`Data runs to ${clockLabel(model.lastClockSeconds, model.last.period)} on the match clock.`)
  if (!model.userSide()) notes.push("No human-controlled manager was found, so 'mine'/'opponent' cannot be resolved; ask which team the user manages.")
  return notes
}

export function teamStats(model: MatchModel, split: "half" | "15min" | "none", window: MatchWindow) {
  const segments: Array<{ label: string; window: MatchWindow }> = []
  if (split === "half") {
    segments.push({ label: "first half", window: { ...window, half: "first" } })
    segments.push({ label: "second half", window: { ...window, half: "second" } })
    if (model.buckets.some((bucket) => bucket.period >= 3)) segments.push({ label: "extra time", window: { ...window, half: "extra" } })
  } else if (split === "15min") {
    const lastMinute = model.buckets.at(-1)?.windowMinute ?? 90
    for (let from = 1; from <= lastMinute; from += 15) {
      const to = from + 14 >= 90 && lastMinute <= 90 ? 90 : Math.min(from + 14, lastMinute)
      segments.push({ label: `${from}'-${to === 45 || to === 90 ? `${to}+` : to}'`, window: { ...window, fromMinute: from, toMinute: to } })
      if (to === 90) break
    }
  }
  segments.push({ label: "total", window })
  const rows = segments
    .map((segment) => {
      const selection = model.select(segment.window)
      if (!selection) return undefined
      return { segment: segment.label, ...windowInfo(model, selection), teams: Object.fromEntries(SIDES.map((side) => [sideLabel(model, side), teamRow(model, selection, side)])) }
    })
    .filter(Boolean)
  return {
    note: "Counts are for the stated stretch of play. Possession is the share of time on the ball; territory is where the ball was.",
    segments: rows,
  }
}

function teamRow(model: MatchModel, selection: WindowSelection, side: Side) {
  const d = (name: (typeof TEAM_COUNTERS)[number]) => teamDiff(selection, side, name)
  const ownPossession = d("possessionTime")
  const theirPossession = teamDiff(selection, other(side), "possessionTime")
  const passes = d("passes")
  const crosses = d("crosses")
  const aerials = d("aerials")
  const tackles = d("tacklesAttempted")
  return {
    goals: d("goals"),
    xg: round(d("xg")),
    shots: d("shots"),
    onTarget: d("shotsOnTarget"),
    offTarget: d("shotsOffTarget"),
    blocked: d("blockedShots"),
    clearCutChances: d("clearCutChances"),
    possessionPct: pct(ownPossession, ownPossession + theirPossession),
    territory: territory(model, selection.buckets, side),
    passes: `${d("passesCompleted")}/${passes}`,
    passCompletionPct: pct(d("passesCompleted"), passes),
    progressivePasses: d("progressivePasses"),
    finalThirdPasses: d("finalThirdPasses"),
    crosses: `${d("crossesCompleted")}/${crosses}`,
    corners: d("corners"),
    aerialsWon: `${d("aerialsWon")}/${aerials}`,
    tacklesWon: `${d("tacklesWon")}/${tackles}`,
    fouls: d("fouls"),
    offsides: d("offsides"),
    yellowCards: d("yellowCards"),
    redCards: d("redCards"),
  }
}

export function players(model: MatchModel, choice: TeamChoice | undefined, window: MatchWindow, includeUnused: boolean) {
  const selection = model.select(window)
  if (!selection) return { error: "No match data in that window yet." }
  const { sides, note } = resolveSides(model, choice)
  const positions = averagePositions(model, model.select({})?.buckets ?? [])
  const range = tickRange(selection)
  const wholeMatch = selection.buckets.length === model.buckets.length
  const result: Record<string, unknown> = { window: windowInfo(model, selection) }
  if (note) result.note = note
  result.legend =
    "rating: FM match rating now (change over the window); condition: physical condition % now (change over the window); sharpness: match sharpness %; " +
    "pairs are completed/attempted; distanceKm covers the window."
  for (const side of sides) {
    const labels = zoneLabels(model, positions, side)
    const rows: Array<Record<string, unknown>> = []
    for (const [playerId, state] of selection.end.players) {
      if (state.team !== side) continue
      const appearance = model.appearances.get(playerId)
      const played = appearance && (appearance.startedOnPitch || appearance.onTick != null)
      if (!played && !includeUnused) continue
      if (played && !wholeMatch) {
        // Only players who were on the pitch at some point in the window.
        const on = appearance.startedOnPitch ? -1 : appearance.onTick!
        const off = appearance.offTick ?? Number.POSITIVE_INFINITY
        if (on > range.to || off < range.from) continue
      }
      rows.push(playerRow(model, playerId, state, selection.start?.players.get(playerId), labels.get(playerId)))
    }
    rows.sort((left, right) => Number(left.order) - Number(right.order))
    for (const row of rows) delete row.order
    result[sideLabel(model, side)] = rows
  }
  return result
}

function playerRow(
  model: MatchModel,
  playerId: number,
  state: PlayerState,
  start: PlayerState | undefined,
  zone: string | undefined
): Record<string, unknown> {
  const meta = playerMeta(model, playerId)
  const value = (name: (typeof PLAYER_COUNTERS)[number]) => {
    const index = playerCounterIndex(name)
    return state.counters[index] - (start?.counters[index] ?? 0)
  }
  const appearance = model.appearances.get(playerId)
  let status = "unused substitute"
  let minutesPlayed = 0
  let order = 1000
  if (appearance) {
    const onTick = appearance.startedOnPitch ? 0 : appearance.onTick
    const offTick = appearance.offTick
    if (onTick != null) {
      const from = model.clockAtTick(onTick).seconds
      const to = offTick != null ? model.clockAtTick(offTick).seconds : model.lastClockSeconds
      minutesPlayed = Math.max(0, Math.round((to - from) / 60))
      order = appearance.startedOnPitch ? 0 : 500
      status = appearance.startedOnPitch ? "started" : `came on ${eventTime(model, onTick).minute}`
      if (offTick != null) status += `, went off ${eventTime(model, offTick).minute}`
      else if (state.onPitch) status += ", on the pitch"
    }
  }
  const row: Record<string, unknown> = {
    order: order + (meta?.slot ?? 0),
    name: meta?.displayName ?? `player ${playerId}`,
    number: meta?.shirtNumber ?? meta?.squadNumber,
    zone,
    status,
    minutesPlayed,
    rating: round(state.rating, 1),
  }
  if (start && start.rating > 0 && Math.abs(state.rating - start.rating) >= 0.05) row.ratingChange = round(state.rating - start.rating, 1)
  if (state.condition > 0) row.condition = state.condition
  if (start && start.condition > 0 && state.condition !== start.condition) row.conditionChange = state.condition - start.condition
  if (state.sharpness > 0) row.sharpness = state.sharpness
  const stats: Record<string, unknown> = {}
  const add = (key: string, amount: number | string | undefined) => {
    if (amount === undefined || amount === 0 || amount === "0/0") return
    stats[key] = amount
  }
  add("goals", value("goals"))
  add("assists", value("assists"))
  add("xg", round(value("xg")))
  add("xa", round(value("xa")))
  add("shots", value("shots") ? `${value("shotsOnTarget")}/${value("shots")} on target` : 0)
  add("clearCutChances", value("clearCutChances"))
  add("keyPasses", value("keyPasses"))
  add("passes", `${value("passesCompleted")}/${value("passes")}`)
  add("progressivePasses", value("progressivePasses"))
  add("crosses", `${value("crossesCompleted")}/${value("crosses")}`)
  add("dribbles", value("dribbles"))
  add("tackles", `${value("tacklesWon")}/${value("tacklesAttempted")}`)
  add("keyTackles", value("keyTackles"))
  add("interceptions", value("interceptions"))
  add("clearances", value("clearances"))
  add("aerials", `${value("aerialsWon")}/${value("aerials")}`)
  add("foulsCommitted", value("fouls"))
  add("fouled", value("fouled"))
  add("offsides", value("offsides"))
  add("distanceKm", round(value("distanceM") / 1000, 1))
  const saves = value("savesHeld") + value("savesParried") + value("savesTipped")
  if (value("shotsFaced") > 0 || saves > 0) {
    add("shotsFaced", value("shotsFaced"))
    add("saves", saves)
  }
  add("ownGoals", value("ownGoals"))
  const cards = model
    .history()
    .events.filter((event) => event.playerId === playerId && (event.type === "yellow_card" || event.type === "red_card"))
    .map((event) => `${event.type === "red_card" ? "red" : "yellow"} ${event.tick != null ? eventTime(model, event.tick).minute : ""}`.trim())
  if (cards.length > 0) stats.cards = cards
  return { ...row, ...stats }
}

const EVENT_TYPES = ["goals", "shots", "chances", "cards", "subs", "corners", "fouls", "offsides", "saves", "key_passes", "turnovers"] as const
export type EventType = (typeof EVENT_TYPES)[number]
export const DEFAULT_EVENT_TYPES: EventType[] = ["goals", "shots", "cards", "subs"]
export const ALL_EVENT_TYPES = EVENT_TYPES

export function events(model: MatchModel, types: readonly EventType[], choice: TeamChoice | undefined, window: MatchWindow, limit: number) {
  const selection = model.select(window)
  if (!selection) return { error: "No match data in that window yet." }
  const { sides, note } = resolveSides(model, choice)
  const history = model.history()
  const wanted = new Set(types)
  type Row = { tick: number; minute: string; type: string; team: string; [key: string]: unknown }
  const rows: Row[] = []
  const keep = (tick: number | undefined, side: Side | undefined) =>
    tick != null && side != null && sides.includes(side) && inWindow(selection, tick)
  const base = (tick: number, type: string, side: Side) => ({ tick, minute: eventTime(model, tick).minute, type, team: teamName(model, side) })

  if (wanted.has("goals")) {
    const assists = history.events.filter((event) => event.type === "assist_candidate")
    for (const event of history.events) {
      if ((event.type !== "goal" && event.type !== "own_goal") || !keep(event.tick, event.team)) continue
      const assist = assists.find((candidate) => candidate.tick === event.tick && candidate.team === event.team)
      rows.push({
        ...base(event.tick!, event.type === "own_goal" ? "own goal" : "goal", event.team!),
        player: playerName(model, event.playerId),
        assist: playerName(model, assist?.playerId),
      })
    }
  }
  if (wanted.has("shots") || wanted.has("chances")) {
    for (const shot of history.xgShots as readonly XgShotPoint[]) {
      if (!keep(shot.tick, shot.team)) continue
      const notes = annotationsOf(shot)
      const bigChance = notes.includes("clear-cut chance") || shot.xg >= 0.3
      if (!wanted.has("shots") && !bigChance) continue
      rows.push({
        ...base(shot.tick, "shot", shot.team),
        player: playerName(model, shot.playerId),
        outcome: SHOT_OUTCOME[shot.metricId] ?? shot.metricId,
        xg: round(shot.xg),
        ...shotLocation(model, shot),
        notes: notes.length > 0 ? notes : undefined,
      })
    }
  }
  if (wanted.has("cards")) {
    for (const event of history.events) {
      if ((event.type !== "yellow_card" && event.type !== "red_card") || !keep(event.tick, event.team)) continue
      rows.push({ ...base(event.tick!, event.type === "red_card" ? "red card" : "yellow card", event.team!), player: playerName(model, event.playerId) })
    }
  }
  if (wanted.has("subs")) {
    const subs = substitutionList(model)
    for (const [playerId, appearance] of model.appearances) {
      if (appearance.onTick == null || !keep(appearance.onTick, appearance.team)) continue
      const name = playerName(model, playerId)
      const sub = subs.find((entry) => entry.on === name)
      rows.push({ ...base(appearance.onTick, "substitution", appearance.team), on: name, off: sub?.off })
    }
  }
  const tactical = history.tacticalEvents as readonly TacticalEventPoint[]
  const tacticalRows = (type: string, test: (event: TacticalEventPoint) => boolean, extra?: (event: TacticalEventPoint) => Record<string, unknown>) => {
    for (const event of tactical) {
      if (!test(event) || !keep(event.tick, event.team)) continue
      const { depth, width } = eventPoint(event)
      rows.push({
        ...base(event.tick, type, event.team),
        player: playerName(model, event.playerId),
        area: areaLabel(depth, width),
        ...extra?.(event),
      })
    }
  }
  const has = (event: TacticalEventPoint, annotation: string) => (event.annotations ?? []).includes(annotation as never)
  if (wanted.has("corners")) {
    // One row per corner taken: the delivery carries the corner flag.
    tacticalRows("corner", (event) => has(event, "corner") && (event.metricId.startsWith("crosses") || event.metricId.startsWith("passes")), (event) => ({
      delivery: event.metricId.endsWith("Completed") ? "found a team-mate" : "did not find a team-mate",
      to: playerName(model, event.receiverPlayerId),
    }))
  }
  if (wanted.has("fouls")) tacticalRows("foul", (event) => event.metricId === "foulsCommitted", (event) => ({ notes: annotationsOf(event).length ? annotationsOf(event) : undefined }))
  if (wanted.has("offsides")) tacticalRows("offside", (event) => event.metricId === "offsides")
  if (wanted.has("saves")) tacticalRows("save", (event) => event.metricId === "goalkeeperSavesHeld" || event.metricId === "goalkeeperSavesParried", (event) => ({ notes: annotationsOf(event) }))
  if (wanted.has("key_passes")) {
    tacticalRows("key pass", (event) => (event.metricIds ?? [event.metricId]).includes("keyPasses"), (event) => ({ to: playerName(model, event.receiverPlayerId) }))
  }
  if (wanted.has("turnovers")) tacticalRows("possession lost", (event) => event.metricId === "possessionLost")

  rows.sort((left, right) => left.tick - right.tick)
  const total = rows.length
  const trimmed = rows.length > limit ? rows.slice(-limit) : rows
  return {
    window: windowInfo(model, selection),
    note,
    shown: trimmed.length,
    total,
    truncated: total > trimmed.length ? `Only the latest ${trimmed.length} are shown; narrow the window or the types for the rest.` : undefined,
    legend:
      "areas and shot locations are from the acting team's point of view (left/right as it attacks); xg is FM's expected goals for the shot.",
    events: trimmed.map(({ tick: _tick, ...row }) => row),
  }
}

export function shape(model: MatchModel, choice: TeamChoice | undefined, window: MatchWindow) {
  const selection = model.select(window)
  if (!selection) return { error: "No match data in that window yet." }
  const { sides, note } = resolveSides(model, choice)
  const positions = averagePositions(model, selection.buckets)
  const history = model.history()
  const tactical = (history.tacticalEvents as readonly TacticalEventPoint[]).filter((event) => inWindow(selection, event.tick))
  const result: Record<string, unknown> = {
    window: windowInfo(model, selection),
    legend:
      "Positions are averages in percent: depth 0 = own goal line, 100 = opponent goal line; width 0 = left touchline, 100 = right, as the team attacks. " +
      "Shape figures are metres from the team's own goal line (defensive line = average of the four deepest outfield players; highest = the two most advanced) " +
      "and the team's length and width without the goalkeeper.",
  }
  if (note) result.note = note
  const allPositions = averagePositions(model, model.select({})?.buckets ?? [])
  for (const side of sides) {
    const labels = zoneLabels(model, allPositions, side)
    const playerRows = [...positions.values()]
      .filter((entry) => entry.side === side && entry.samples.in + entry.samples.out >= 30)
      .sort((left, right) => (left.overall?.depth ?? 0) - (right.overall?.depth ?? 0))
      .map((entry) => ({
        name: playerName(model, entry.playerId),
        zone: labels.get(entry.playerId),
        inPossession: entry.inPossession,
        outOfPossession: entry.outOfPossession,
        minutes: Math.round((entry.samples.in + entry.samples.out) / 60),
      }))
    const passes = tactical.filter((event) => event.team === side && event.metricId === "passesCompleted" && event.receiverPlayerId)
    const pairs = new Map<string, number>()
    const received = new Map<number, number>()
    for (const pass of passes) {
      const key = `${pass.playerId}>${pass.receiverPlayerId}`
      pairs.set(key, (pairs.get(key) ?? 0) + 1)
      received.set(pass.receiverPlayerId!, (received.get(pass.receiverPlayerId!) ?? 0) + 1)
    }
    const zoneCounts = (test: (event: TacticalEventPoint) => boolean) => {
      const counts: Record<string, number> = {}
      for (const event of tactical) {
        if (event.team !== side || !test(event)) continue
        const { depth, width } = eventPoint(event)
        const area = areaLabel(depth, width)
        counts[area] = (counts[area] ?? 0) + 1
      }
      return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1]))
    }
    result[sideLabel(model, side)] = {
      shape: shapeSummary(model, selection.buckets, side),
      territory: territory(model, selection.buckets, side),
      players: playerRows,
      passNetwork: {
        completedPassesWithReceiver: passes.length,
        topConnections: [...pairs.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 12)
          .map(([key, count]) => {
            const [from, to] = key.split(">").map(Number)
            return { from: playerName(model, from), to: playerName(model, to), passes: count }
          }),
        mostFoundPlayers: [...received.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 6)
          .map(([playerId, count]) => ({ player: playerName(model, playerId), passesReceived: count })),
      },
      ballLostAt: zoneCounts((event) => event.metricId === "possessionLost"),
      ballWonAt: zoneCounts((event) => event.metricId === "possessionGained" || event.metricId === "interceptions" || event.metricId === "tacklesWon"),
    }
  }
  return result
}

export function tactic(model: MatchModel, choice: TeamChoice | undefined) {
  const snapshot = model.last?.tactics
  if (!snapshot) {
    return {
      available: false,
      reason:
        "FMMatchLens did not capture tactics for this match (it does not read them on macOS yet). Ask the user for their formation, roles, mentality and instructions, or a screenshot of the tactics screen.",
      inferredShape: "get_shape shows where each player actually played.",
    }
  }
  const { sides, note } = resolveSides(model, choice)
  try {
    const decoded = decodeTacticalSnapshot(snapshot)
    const result: Record<string, unknown> = { available: true, note, observedAt: eventTime(model, snapshot.observedTick).minute }
    for (const side of sides) {
      const team = decoded[side]
      const config = team.command ?? team.processing
      if (!config) {
        result[sideLabel(model, side)] = { status: team.status }
        continue
      }
      const phase = (data: typeof config.inPossession) => ({
        formation: data.formation.displayName,
        teamInstructions: data.teamInstructions.map((instruction) => (instruction as { name?: string }).name).filter(Boolean),
        positions: data.positions.map((position) => ({
          position: position.position,
          players: position.players.map((player) => playerName(model, player.playerId)),
          instructions: position.explicit.instructions.map((instruction) => (instruction as { name?: string }).name).filter(Boolean),
        })),
      })
      result[sideLabel(model, side)] = {
        status: team.status,
        tacticName: config.style.configurationName,
        style: config.style.name,
        mentality: config.mentality.name,
        transition: config.transitionInstructions.map((instruction) => (instruction as { name?: string }).name).filter(Boolean),
        inPossession: phase(config.inPossession),
        outOfPossession: phase(config.outOfPossession),
        roles: model.metadata?.players
          .filter((player) => player.team === side && (player.inPossession || player.outOfPossession))
          .map((player) => ({
            player: player.displayName,
            inPossession: player.inPossession ? `${player.inPossession.position} ${player.inPossession.role}${player.inPossession.duty ? ` (${player.inPossession.duty})` : ""}` : undefined,
            outOfPossession: player.outOfPossession ? `${player.outOfPossession.position} ${player.outOfPossession.role}${player.outOfPossession.duty ? ` (${player.outOfPossession.duty})` : ""}` : undefined,
          })),
      }
    }
    return result
  } catch (error) {
    return { available: false, reason: `The captured tactic could not be decoded: ${(error as Error).message}` }
  }
}
