// get_sequences: how each goal and big chance came about. For every one, the
// possession it came from is followed back to its start: who won the ball and who
// lost it (and where), or which restart it came from; then the players who had the
// ball on the way, how fast it went and through which channel; and the moment of
// the shot: how close the nearest defender was, how many defenders were in the way,
// who was in the box, and how the defending team's line and width compared with
// how it usually stood with the ball near its goal. Patterns across the chances a
// team conceded or created are pulled out at the end.

import type { XgShotPoint } from "@/types/match"

import { type MatchModel, other, type Side, type WindowSelection } from "./model"
import { type LabelledSpell, PhaseContext, SHAPE_VALUE_FIELDS, shapeSlot } from "./phases"
import { eventTime, playerName, round, SHOT_OUTCOME, shotLocation, sideLabel, teamName, tickRange } from "./views"

const TICKS_PER_SECOND = 4
const BOX_DEPTH = 16.5
const BOX_HALF_WIDTH = 20.16
const POST_X = 3.66
/** A defender this close to the line from shooter to either post counts as in the way. */
const IN_THE_WAY_M = 1
/** Chains longer than this are shortened in the middle. */
const MAX_CHAIN = 8
/** The ball standing still this many seconds in a row is a set piece being set. */
const STILL_SECONDS = 3

export type ChanceFilter = "goals" | "big_chances" | "both"

const isBig = (shot: XgShotPoint) => shot.metricId === "goals" || shot.xg >= 0.3 || (shot.annotations ?? []).includes("clearCutChance")

type Zone = { third: "own third" | "middle third" | "final third"; channel: "left" | "centre" | "right"; inBox: boolean; inOwnBox: boolean }

/** Where a point is, for a team attacking in a direction. */
function zoneOf(model: MatchModel, x: number, y: number, direction: 1 | -1): Zone {
  const L = model.halfLength
  const W = model.halfWidth
  const depth = ((direction * y + L) / (2 * L)) * 100
  const width = ((direction * x + W) / (2 * W)) * 100
  return {
    third: depth < 100 / 3 ? "own third" : depth < 200 / 3 ? "middle third" : "final third",
    channel: width < 100 / 3 ? "left" : width > 200 / 3 ? "right" : "centre",
    inBox: direction * y >= L - BOX_DEPTH && Math.abs(x) <= BOX_HALF_WIDTH,
    inOwnBox: direction * y <= -(L - BOX_DEPTH) && Math.abs(x) <= BOX_HALF_WIDTH,
  }
}

const zoneText = (zone: Zone) => (zone.inBox ? `box, ${zone.channel}` : zone.inOwnBox ? `own box, ${zone.channel}` : `${zone.third}, ${zone.channel}`)
const opposite = { "own third": "final third", "middle third": "middle third", "final third": "own third" } as const
/** The other team's left is this team's right. */
const mirrored = (channel: Zone["channel"]) => (channel === "left" ? "right" : channel === "right" ? "left" : "centre")

/** What started a possession that did not begin with an open-play regain. */
function restartName(model: MatchModel, context: PhaseContext, spell: LabelledSpell, shot: XgShotPoint, at: { x: number; y: number; depth: number; first: boolean }): string {
  const annotations = (shot.annotations ?? []) as readonly string[]
  if (annotations.includes("penaltyKick")) return "penalty"
  if (annotations.includes("corner")) return "corner"
  if (annotations.includes("attackingFreeKick")) return "free kick"
  const L = model.halfLength
  const W = model.halfWidth
  if (Math.abs(at.x) < 1.5 && Math.abs(at.y) < 1.5) return "kick-off"
  if (Math.abs(at.y) > L - 3 && Math.abs(at.x) > W - 4) return "corner"
  if (Math.abs(at.x) > W - 2) return "throw-in"
  if (at.depth < 17 && Math.abs(at.x) <= BOX_HALF_WIDTH) {
    const before = context.spells[context.spells.indexOf(spell) - 1]
    return at.first && before && before.shots.length > 0 ? "goalkeeper's restart after a save or block" : "goal kick or goalkeeper's restart"
  }
  return "free kick"
}

/** Everyone in a position frame, with team. */
function people(model: MatchModel, frame: { ids: Int32Array; xy: Float32Array }) {
  const rows: Array<{ id: number; side?: Side; x: number; y: number }> = []
  for (let index = 0; index < frame.ids.length; index++) {
    rows.push({ id: frame.ids[index], side: model.teamOf(frame.ids[index]), x: frame.xy[2 * index], y: frame.xy[2 * index + 1] })
  }
  return rows
}

/** Distance from point p to segment a-b. */
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Whether p is inside the triangle shooter-left post-right post. */
function inTriangle(px: number, py: number, a: [number, number], b: [number, number], c: [number, number]) {
  const sign = (p1: [number, number], p2: [number, number]) => (px - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (py - p2[1])
  const d1 = sign(a, b)
  const d2 = sign(b, c)
  const d3 = sign(c, a)
  const negative = d1 < 0 || d2 < 0 || d3 < 0
  const positive = d1 > 0 || d2 > 0 || d3 > 0
  return !(negative && positive)
}

/** The moment of the shot, from everyone's positions. */
function shotMoment(model: MatchModel, shot: XgShotPoint, direction: 1 | -1) {
  const frame = model.positionsAt(shot.tick)
  if (!frame || shot.playerId == null) return undefined
  const everyone = people(model, frame)
  const shooter = everyone.find((row) => row.id === shot.playerId)
  if (!shooter) return undefined
  const defending = other(shot.team)
  const goalY = direction * model.halfLength
  const defenders = everyone.filter((row) => row.side === defending)
  // The defender nearest his own goal line is taken to be the goalkeeper.
  const keeper = [...defenders].sort((left, right) => Math.abs(goalY - left.y) - Math.abs(goalY - right.y))[0]
  const outfield = defenders.filter((row) => row !== keeper)
  const nearest = outfield.reduce((best, row) => Math.min(best, Math.hypot(row.x - shooter.x, row.y - shooter.y)), Number.POSITIVE_INFINITY)
  const leftPost: [number, number] = [-POST_X, goalY]
  const rightPost: [number, number] = [POST_X, goalY]
  const inTheWay = outfield.filter(
    (row) =>
      inTriangle(row.x, row.y, [shooter.x, shooter.y], leftPost, rightPost) ||
      toSegment(row.x, row.y, shooter.x, shooter.y, -POST_X, goalY) <= IN_THE_WAY_M ||
      toSegment(row.x, row.y, shooter.x, shooter.y, POST_X, goalY) <= IN_THE_WAY_M
  ).length
  const inBox = (row: { x: number; y: number }) => direction * row.y >= model.halfLength - BOX_DEPTH && Math.abs(row.x) <= BOX_HALF_WIDTH
  const keeperOff = keeper ? Math.hypot(keeper.x, keeper.y - goalY) : undefined
  return {
    nearestDefenderM: Number.isFinite(nearest) ? round(nearest, 1) : undefined,
    defendersInTheWay: inTheWay,
    inTheBox: { attackers: everyone.filter((row) => row.side === shot.team && inBox(row)).length, defenders: outfield.filter(inBox).length },
    keeperFromGoalM: keeperOff == null ? undefined : round(keeperOff, 1),
  }
}

const FIELD = Object.fromEntries(SHAPE_VALUE_FIELDS.map((name, index) => [name, index])) as Record<(typeof SHAPE_VALUE_FIELDS)[number], number>

const median = (values: number[]) => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

/** How a team usually stands with the opponent on the ball near its goal: median line height, width and length. */
function usualShape(model: MatchModel, side: Side) {
  const lines: number[] = []
  const widths: number[] = []
  const lengths: number[] = []
  for (const sample of model.shapeSamples) {
    if (sample.possession === side || sample.still) continue
    const direction = model.direction(sample.period, side)
    if (!direction) continue
    const ownDepth = ((direction * sample.ballY + model.halfLength) / (2 * model.halfLength)) * 100
    if (ownDepth >= 100 / 3) continue
    const slot = shapeSlot(side, direction)
    const line = sample.values[slot + FIELD.defensiveLine]
    if (Number.isFinite(line)) lines.push(line)
    const width = sample.values[slot + FIELD.width]
    if (Number.isFinite(width)) widths.push(width)
    const length = sample.values[slot + FIELD.length]
    if (Number.isFinite(length)) lengths.push(length)
  }
  return { line: median(lines), width: median(widths), length: median(lengths), samples: lines.length }
}

/** The defending team's line, width and length at the shot (nearest once-a-second sample). */
function shapeAt(model: MatchModel, side: Side, tick: number, period: number) {
  const direction = model.direction(period, side)
  if (!direction) return undefined
  let best: (typeof model.shapeSamples)[number] | undefined
  for (let index = model.shapeSamples.length - 1; index >= 0; index--) {
    const sample = model.shapeSamples[index]
    if (sample.tick > tick) continue
    best = sample
    break
  }
  if (!best || tick - best.tick > 2 * TICKS_PER_SECOND) return undefined
  const slot = shapeSlot(side, direction)
  const value = (name: keyof typeof FIELD) => {
    const raw = best!.values[slot + FIELD[name]]
    return Number.isFinite(raw) ? raw : undefined
  }
  return { line: value("defensiveLine"), width: value("width"), length: value("length") }
}

/**
 * The last time play stopped while the attacking team kept the ball, before the
 * shot: the ball out of play, or standing still for a few seconds (a free kick or
 * corner being set). The move is then told from that restart.
 */
function lastStoppage(model: MatchModel, spell: LabelledSpell, shotTick: number) {
  const after = spell.startTick + 2 * TICKS_PER_SECOND
  let best: { tick: number; x: number; y: number } | undefined
  if (spell.lastOutTick != null && spell.lastOutTick > after && spell.lastOutTick < shotTick) {
    const next = spell.holders.find((holder) => holder.tick > spell.lastOutTick!)
    best = next && next.tick < shotTick ? { tick: next.tick, x: next.x, y: next.y } : { tick: spell.lastOutTick, x: spell.startX, y: spell.startY }
  }
  let run = 0
  for (const sample of model.shapeSamples) {
    if (sample.tick <= after) continue
    if (sample.tick >= shotTick) break
    run = sample.still ? run + 1 : 0
    if (run >= STILL_SECONDS && (!best || sample.tick > best.tick)) best = { tick: sample.tick, x: sample.ballX, y: sample.ballY }
  }
  return best
}

export type ChanceStory = ReturnType<typeof tellChance>

function tellChance(model: MatchModel, context: PhaseContext, shot: XgShotPoint, usual: Record<Side, ReturnType<typeof usualShape>>) {
  const team = shot.team
  const defending = other(team)
  const minute = eventTime(model, shot.tick).minute
  const shooter = playerName(model, shot.playerId) ?? "?"
  const outcome = SHOT_OUTCOME[shot.metricId] ?? shot.metricId
  const where = shotLocation(model, shot).where
  const source = context.shotSource.get(shot) ?? "settled"
  const spell = context.spells.find((candidate) => candidate.shots.includes(shot))
  const base: { minute: string; team: string; shooter: string; xg: number; outcome: string; where: string; source: string; clearCut?: boolean } = {
    minute,
    team: teamName(model, team),
    shooter,
    xg: round(shot.xg),
    outcome,
    where,
    source: source === "setPiece" ? "set piece" : source === "transition" ? "transition" : "settled possession",
    clearCut: (shot.annotations ?? []).includes("clearCutChance") || undefined,
  }
  const direction = spell?.direction ?? model.direction(model.clockAtTick(shot.tick).period, team)
  if (!spell || !direction) {
    return { ...base, summary: `${minute} ${base.team}, ${shooter} (${base.xg} xG, ${outcome}): the possession could not be traced.`, pattern: undefined }
  }

  // How the move started: the open-play regain or restart that began the
  // possession, or the team's own restart later in it (a throw-in or corner it won).
  let start: Record<string, unknown>
  let startText: string
  let lossZone: Zone | undefined
  const stoppage = lastStoppage(model, spell, shot.tick)
  const resumed = stoppage != null
  const moveStart = stoppage ?? { tick: spell.startTick, x: spell.startX, y: spell.startY }
  const sinceStart = Math.round((shot.tick - moveStart.tick) / TICKS_PER_SECOND)
  if (spell.kind === "regain" && !resumed) {
    const index = context.spells.indexOf(spell)
    const previous = context.spells[index - 1]
    const lostBy = previous && previous.side === defending ? previous.holders.filter((holder) => model.teamOf(holder.playerId) === defending).at(-1) : undefined
    const wonBy = spell.holders.find((holder) => model.teamOf(holder.playerId) === team)
    const wonZone = zoneOf(model, wonBy?.x ?? spell.startX, wonBy?.y ?? spell.startY, direction)
    lossZone = { ...wonZone, third: opposite[wonZone.third], channel: mirrored(wonZone.channel) }
    const lostName = playerName(model, lostBy?.playerId)
    const wonName = playerName(model, wonBy?.playerId)
    start = {
      how: "won the ball in open play",
      wonBy: wonName,
      lostBy: lostName,
      where: `${base.team}'s ${zoneText(wonZone)}`,
      lostIn: `${teamName(model, defending)}'s ${lossZone.third}`,
      secondsToShot: sinceStart,
    }
    startText = `${wonName ?? base.team} won it${lostName ? ` off ${lostName}` : ""} in ${base.team}'s ${zoneText(wonZone)}, ${sinceStart} s before the shot`
  } else {
    const startZone = zoneOf(model, moveStart.x, moveStart.y, direction)
    const depth = ((direction * moveStart.y + model.halfLength) / (2 * model.halfLength)) * 100
    const restart = restartName(model, context, spell, shot, { x: moveStart.x, y: moveStart.y, depth, first: !resumed })
    start = { how: restart, where: `${base.team}'s ${zoneText(startZone)}`, secondsToShot: sinceStart }
    // A shot soon after a corner, free kick or throw-in of the team's own is a set-piece chance.
    if (resumed && sinceStart <= 15 && restart !== "goal kick or goalkeeper's restart") base.source = "set piece"
    startText = restart === "penalty" ? "penalty" : `from a ${restart} in ${base.team}'s ${zoneText(startZone)}, ${sinceStart} s before the shot`
  }

  // The players who had the ball on the way, the attacking team's only.
  const chain = spell.holders
    .filter((holder) => holder.tick >= moveStart.tick && holder.tick <= shot.tick + 2 && model.teamOf(holder.playerId) === team)
    .map((holder) => `${playerName(model, holder.playerId) ?? "?"} (${zoneText(zoneOf(model, holder.x, holder.y, direction))})`)
  const shortChain = chain.length > MAX_CHAIN ? [...chain.slice(0, 2), `... ${chain.length - MAX_CHAIN + 2} more ...`, ...chain.slice(-(MAX_CHAIN - 3))] : chain
  const passes = Math.max(0, chain.length - 1)
  const entryChannel = spell.entryWidth == null ? undefined : spell.entryWidth < 100 / 3 ? "left" : spell.entryWidth > 200 / 3 ? "right" : "centre"
  const toFinalThird =
    spell.entryTick != null && !spell.startedInFinalThird && spell.entryTick >= moveStart.tick ? Math.round((spell.entryTick - moveStart.tick) / TICKS_PER_SECOND) : undefined
  const route = {
    touches: chain.length,
    passes,
    seconds: sinceStart,
    intoFinalThird: entryChannel && toFinalThird != null ? `down the ${entryChannel} after ${toFinalThird} s` : undefined,
    fastBreak: (spell.counter && !resumed) || undefined,
  }

  // The moment of the shot.
  const moment = shotMoment(model, shot, direction)
  const period = model.clockAtTick(shot.tick).period
  const shape = shapeAt(model, defending, shot.tick, period)
  const typical = usual[defending]
  const shapeNotes: string[] = []
  if (shape && typical.samples >= 30) {
    if (shape.line != null && typical.line != null && Math.abs(shape.line - typical.line) >= 4) {
      shapeNotes.push(`${teamName(model, defending)}'s line ${round(shape.line, 0)} m from goal (usually ${round(typical.line, 0)} m with the ball this close)`)
    }
    if (shape.width != null && typical.width != null && shape.width - typical.width >= 6) {
      shapeNotes.push(`${teamName(model, defending)} stretched ${round(shape.width, 0)} m wide (usually ${round(typical.width, 0)} m)`)
    }
    if (shape.length != null && typical.length != null && shape.length - typical.length >= 8) {
      shapeNotes.push(`${teamName(model, defending)} ${round(shape.length, 0)} m from back to front (usually ${round(typical.length, 0)} m)`)
    }
  }

  const momentText = moment
    ? `nearest defender ${moment.nearestDefenderM ?? "?"} m, ${moment.defendersInTheWay} in the way` +
      (moment.inTheBox.attackers + moment.inTheBox.defenders > 0 ? `, ${moment.inTheBox.attackers} attackers v ${moment.inTheBox.defenders} defenders in the box` : "")
    : undefined
  const routeText =
    base.source === "set piece" && passes <= 1
      ? undefined
      : `${passes} pass${passes === 1 ? "" : "es"} in ${sinceStart} s${route.intoFinalThird ? `, into the final third ${route.intoFinalThird}` : ""}${route.fastBreak ? " (fast break)" : ""}`
  const summary =
    `${minute} ${base.team}, ${shooter} (${base.xg} xG, ${outcome}, ${where}): ${startText}` +
    `${routeText ? `; ${routeText}` : ""}${momentText ? `; ${momentText}` : ""}${shapeNotes.length > 0 ? `; ${shapeNotes.join("; ")}` : ""}.`

  return {
    ...base,
    summary,
    start,
    route,
    chain: shortChain,
    atTheShot: moment || shapeNotes.length > 0 ? { ...moment, defendingShape: shapeNotes.length > 0 ? shapeNotes : undefined } : undefined,
    pattern: {
      attacking: team,
      kind: spell.kind === "regain" && !resumed ? "regain" : String(start.how),
      lossThird: lossZone?.third,
      lossChannel: lossZone?.channel,
      // Through which of the defending team's flanks it came.
      throughDefenders: entryChannel && toFinalThird != null ? mirrored(entryChannel) : undefined,
      quick: sinceStart <= 15,
      looseMarking: moment?.nearestDefenderM != null && moment.nearestDefenderM >= 3,
      openGoal: moment?.defendersInTheWay === 0,
    },
  }
}

/** What the chances a team created or conceded have in common. */
export function patterns(model: MatchModel, stories: ReadonlyArray<Pick<ChanceStory, "pattern">>, defending: Side) {
  const against = stories.filter((story) => story.pattern && story.pattern.attacking !== defending)
  if (against.length < 2) return undefined
  const lines: string[] = []
  const count = (test: (pattern: NonNullable<ChanceStory["pattern"]>) => boolean) => against.filter((story) => story.pattern && test(story.pattern)).length
  const out = (n: number, text: string) => n >= 2 && n * 2 >= against.length && lines.push(`${n} of ${against.length} ${text}`)
  const name = teamName(model, defending)
  out(count((p) => p.kind === "regain"), `came after ${name} lost the ball in open play`)
  for (const third of ["own third", "middle third"] as const) out(count((p) => p.lossThird === third), `came after ${name} lost it in its ${third}`)
  out(count((p) => p.kind === "regain" && p.quick), `came within 15 s of ${name} losing the ball`)
  for (const flank of ["left", "right", "centre"] as const) out(count((p) => p.throughDefenders === flank), `got into the final third through ${name}'s ${flank === "centre" ? "centre" : `${flank} flank`}`)
  out(count((p) => p.kind !== "regain"), `came from restarts or set pieces`)
  out(count((p) => p.looseMarking), `had no defender within 3 m of the shooter`)
  out(count((p) => p.openGoal), `had no defender between the shooter and goal`)
  return lines.length > 0 ? lines : undefined
}

/** The chances matching a filter, told one by one, with patterns. */
export function chanceStories(model: MatchModel, attackingSides: readonly Side[], selection: WindowSelection | undefined, filter: ChanceFilter, limit = 20) {
  const context = new PhaseContext(model)
  const range = selection ? tickRange(selection) : undefined
  const shots = (context.history.xgShots as readonly XgShotPoint[]).filter(
    (shot) =>
      attackingSides.includes(shot.team) &&
      (!range || (shot.tick >= range.from && shot.tick <= range.to)) &&
      (filter === "goals" ? shot.metricId === "goals" : filter === "big_chances" ? isBig(shot) && shot.metricId !== "goals" : isBig(shot))
  )
  const usual = { home: usualShape(model, "home"), away: usualShape(model, "away") }
  const stories = shots.map((shot) => tellChance(model, context, shot, usual))
  const kept = stories.slice(-limit)
  const user = model.userSide()
  const result: Record<string, unknown> = {
    chances: kept.map(({ pattern: _pattern, ...story }) => story),
  }
  if (stories.length > kept.length) result.note = `Showing the latest ${kept.length} of ${stories.length}.`
  const sidesSeen = new Set(stories.map((story) => story.pattern?.attacking).filter(Boolean) as Side[])
  const common: Record<string, string[]> = {}
  for (const attacking of sidesSeen) {
    const lines = patterns(model, stories, other(attacking))
    if (lines) common[`${sideLabel(model, attacking)}'s chances`] = lines
  }
  if (Object.keys(common).length > 0) result.patterns = common
  if (stories.length === 0) result.summary = "No goals or big chances (clear-cut, or 0.3 xG and up) in that stretch."
  result.legend =
    "Each chance is followed back to the start of its possession: won in open play (who won it, who lost it and where, from the losing team's point of view) or a restart. " +
    "chain lists who had the ball on the way and where (zones from the attacking team's point of view). atTheShot: the nearest outfield defender to the shooter, " +
    "defenders between the shooter and the posts, attackers v defenders in the box, and the defending team's line, width and length where they differed from how it usually " +
    `stands with the ball near its goal. Big chances are clear-cut or 0.3 xG and up. ${user ? "" : "No human manager was found. "}`
  return result
}

/** For the briefing: one line per goal so far. */
export function goalLines(model: MatchModel, context = new PhaseContext(model)) {
  const usual = { home: usualShape(model, "home"), away: usualShape(model, "away") }
  const goals = (context.history.xgShots as readonly XgShotPoint[]).filter((shot) => shot.metricId === "goals")
  return goals.map((shot) => tellChance(model, context, shot, usual).summary)
}
