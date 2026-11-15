// Phases of play: the moments coaches and analysts split a match into (in
// possession, out of possession, the two transitions and set pieces), with the
// finer phases data providers use where FMMatchLens's capture supports them:
// build-up, progression and final third with the ball; how high the block sits
// without it; counter-attacks, counter-pressing and set-piece threat.
//
// Two things are collected while frames arrive (see MatchModel):
//   - possession spells: each unbroken stretch of one team on the ball, with
//     where it started and ended, when the ball first reached each final third
//     and penalty box, and whether the ball had just gone out of play;
//   - shape samples: once a second, both teams' line heights, length and width
//     for either playing direction, with where the ball was.
// Everything else is worked out when asked, because which way a team attacks is
// only known once its goalkeeper has been seen in that period.

import type { RealtimeFrame } from "@/api/realtimeMatch"
import type { TacticalEventPoint, XgShotPoint } from "@/types/match"

import type { MatchModel, Side } from "./model"
import { other, SIDES } from "./model"

const TICKS_PER_SECOND = 4
/** Seconds after a regain that count as the transition (attacking or defensive). */
export const TRANSITION_SECONDS = 8
/** A regain this soon after losing the ball counts as a successful counter-press. */
export const COUNTERPRESS_SECONDS = 5
/** A shot this soon after a regain came from the transition. */
export const TRANSITION_SHOT_SECONDS = 15
/** A counter-attack reaches the final third this soon after an open-play regain. */
export const COUNTER_SECONDS = 10
/** Penalty area, metres. */
const BOX_DEPTH = 16.5
const BOX_HALF_WIDTH = 20.16
/** Possessions shorter than this, between two spells of the other team, are a scramble, not a change. */
const SCRAMBLE_TICKS = 4

// ---------------------------------------------------------------------------
// Collection

export type PossessionSpell = {
  side: Side
  period: number
  startTick: number
  endTick: number
  startX: number
  startY: number
  /** Ticks since the ball was last out of play when the spell began. */
  sinceOut: number
  /** First tick the ball was out of play during or just after the spell. */
  outTick?: number
  /** First time the ball was in each raw final third (y > L/3: "pos", y < -L/3: "neg"), and its x then. */
  entryPos?: { tick: number; x: number }
  entryNeg?: { tick: number; x: number }
  boxPos?: number
  boxNeg?: number
  /** Last tick the ball was out of play while this team kept it (a throw-in, corner or free kick of its own mid-spell). */
  lastOutTick?: number
  /** Each player who had the ball during the spell, in order, with where he got it (metres). Either team, since scrambles merge. */
  holders: Array<{ tick: number; playerId: number; x: number; y: number }>
}

/** Follows possession frame by frame. Frames with nobody on the ball leave the current spell open. */
export class PossessionTracker {
  readonly spells: PossessionSpell[] = []
  private lastOutTick = Number.NEGATIVE_INFINITY

  observe(frame: RealtimeFrame, halfLength: number, halfWidth: number) {
    const x = frame.ballXCentimeters / 100
    const y = frame.ballYCentimeters / 100
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const out = Math.abs(x) > halfWidth + 0.1 || Math.abs(y) > halfLength + 0.1
    let current = this.spells.at(-1)
    if (out) {
      this.lastOutTick = frame.tick
      if (current && current.outTick == null && current.period === frame.period) current.outTick = frame.tick
    }
    const side = frame.possessionTeam
    if (side == null) return
    if (!current || current.side !== side || current.period !== frame.period) {
      const previous = this.spells.at(-2)
      if (
        current &&
        previous &&
        current.period === frame.period &&
        previous.side === side &&
        previous.period === frame.period &&
        current.endTick - current.startTick < SCRAMBLE_TICKS
      ) {
        // A touch either way in a scramble: carry on with the earlier spell.
        this.spells.pop()
        current = previous
        current.outTick = undefined
      } else {
        current = {
          side,
          period: frame.period,
          startTick: frame.tick,
          endTick: frame.tick,
          startX: x,
          startY: y,
          sinceOut: frame.tick - this.lastOutTick,
          holders: [],
        }
        this.spells.push(current)
      }
    }
    current.endTick = frame.tick
    if (out) {
      if (current.startTick < frame.tick) current.lastOutTick = frame.tick
      return
    }
    const holder = frame.ballHolderPlayerId
    if (holder != null && current.holders.at(-1)?.playerId !== holder) current.holders.push({ tick: frame.tick, playerId: holder, x, y })
    const third = halfLength / 3
    if (y > third && !current.entryPos) current.entryPos = { tick: frame.tick, x }
    if (y < -third && !current.entryNeg) current.entryNeg = { tick: frame.tick, x }
    if (Math.abs(x) <= BOX_HALF_WIDTH) {
      if (y >= halfLength - BOX_DEPTH && current.boxPos == null) current.boxPos = frame.tick
      if (y <= -(halfLength - BOX_DEPTH) && current.boxNeg == null) current.boxNeg = frame.tick
    }
  }
}

/** Shape figures per team and playing direction, in metres from the team's own goal line. */
export const SHAPE_VALUE_FIELDS = ["defensiveLine", "highest", "length", "width", "centroid"] as const
const FIELD = { defensiveLine: 0, highest: 1, length: 2, width: 3, centroid: 4 } as const
const VALUES = SHAPE_VALUE_FIELDS.length

export type ShapeSample = {
  tick: number
  period: number
  possession: Side
  ballX: number
  ballY: number
  /** The ball has not moved since the previous sample: a set piece being taken, or play stopped. */
  still: boolean
  /** [home +1, home -1, away +1, away -1] x SHAPE_VALUE_FIELDS; NaN when too few players were seen. */
  values: Float32Array
}

export const shapeSlot = (side: Side, orientation: 1 | -1) => ((side === "home" ? 0 : 2) + (orientation === 1 ? 0 : 1)) * VALUES

/** Line heights, length, width and average height of one team for one playing direction. */
export function shapeValues(
  players: ReadonlyArray<{ x: number; y: number }>,
  orientation: 1 | -1,
  halfLength: number,
  halfWidth: number
): number[] | undefined {
  if (players.length < 8) return undefined
  const points = players
    .map((player) => ({ depth: orientation * player.y + halfLength, lateral: orientation * player.x + halfWidth }))
    .sort((left, right) => left.depth - right.depth)
  const outfield = points.slice(1) // the deepest player is taken to be the goalkeeper
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const laterals = outfield.map((point) => point.lateral)
  return [
    mean(outfield.slice(0, 4).map((point) => point.depth)),
    mean(outfield.slice(-2).map((point) => point.depth)),
    outfield.at(-1)!.depth - outfield[0].depth,
    Math.max(...laterals) - Math.min(...laterals),
    mean(outfield.map((point) => point.depth)),
  ]
}

// ---------------------------------------------------------------------------
// Analysis

type History = ReturnType<MatchModel["history"]>

export type LabelledSpell = PossessionSpell & {
  /** Won in open play, or given by a restart (throw-in, goal kick, corner, free kick, kick-off). */
  kind: "regain" | "restart"
  direction?: 1 | -1
  /** Percent of the pitch length from the team's own goal line, and of its width from its left touchline. */
  startDepth?: number
  startWidth?: number
  startedInFinalThird: boolean
  /** First tick in the final third and the channel it got there through. */
  entryTick?: number
  entryWidth?: number
  boxTick?: number
  counter: boolean
  shots: XgShotPoint[]
}

export type ShotSource = "settled" | "transition" | "setPiece"

/** Everything the phase figures need, worked out once per request. */
export class PhaseContext {
  readonly history: History
  readonly spells: LabelledSpell[]
  readonly shotSource = new Map<XgShotPoint, ShotSource>()
  private readonly L: number
  private readonly W: number

  constructor(readonly model: MatchModel, history?: History) {
    this.history = history ?? model.history()
    this.L = model.halfLength
    this.W = model.halfWidth
    this.spells = this.label()
    this.classifyShots()
  }

  depth(y: number, direction: 1 | -1) {
    return ((direction * y + this.L) / (2 * this.L)) * 100
  }

  width(x: number, direction: 1 | -1) {
    return ((direction * x + this.W) / (2 * this.W)) * 100
  }

  private label(): LabelledSpell[] {
    const events = this.history.tacticalEvents as readonly TacticalEventPoint[]
    const shots = this.history.xgShots as readonly XgShotPoint[]
    const firstOfPeriod = new Set<number>()
    const seenPeriods = new Set<number>()
    this.model.possession.spells.forEach((spell, index) => {
      if (!seenPeriods.has(spell.period)) {
        seenPeriods.add(spell.period)
        firstOfPeriod.add(index)
      }
    })
    // Events are in tick order; walk them alongside the spells.
    let cursor = 0
    const labelled = this.model.possession.spells.map((spell, index): LabelledSpell => {
      while (cursor < events.length && events[cursor].tick < spell.startTick - 24) cursor++
      let foulOrOffside = false
      for (let at = cursor; at < events.length && events[at].tick <= spell.startTick + 4; at++) {
        const event = events[at]
        if (
          (event.team !== spell.side && (event.metricId === "foulsCommitted" || event.metricId === "offsides")) ||
          (event.team === spell.side && event.metricId === "fouled")
        ) {
          foulOrOffside = true
          break
        }
      }
      const kickOff = Math.abs(spell.startX) < 1.5 && Math.abs(spell.startY) < 1.5
      const outOfPlay = spell.sinceOut <= 4 * TICKS_PER_SECOND || (spell.outTick != null && spell.outTick - spell.startTick <= 2 * TICKS_PER_SECOND)
      const kind = firstOfPeriod.has(index) || kickOff || outOfPlay || foulOrOffside ? "restart" : "regain"
      const direction = this.model.direction(spell.period, spell.side)
      const result: LabelledSpell = { ...spell, kind, direction, startedInFinalThird: false, counter: false, shots: [] }
      if (direction) {
        result.startDepth = this.depth(spell.startY, direction)
        result.startWidth = this.width(spell.startX, direction)
        result.startedInFinalThird = result.startDepth >= 200 / 3
        const entry = direction === 1 ? spell.entryPos : spell.entryNeg
        if (entry) {
          result.entryTick = entry.tick
          result.entryWidth = this.width(entry.x, direction)
        }
        result.boxTick = direction === 1 ? spell.boxPos : spell.boxNeg
        result.counter =
          kind === "regain" &&
          result.startDepth < 50 &&
          result.entryTick != null &&
          result.entryTick - spell.startTick <= COUNTER_SECONDS * TICKS_PER_SECOND
      }
      return result
    })
    // Each shot belongs to the latest spell of its team that it falls in (a
    // blocked or saved shot often ends the spell on the same tick).
    const bySide: Record<Side, LabelledSpell[]> = { home: [], away: [] }
    for (const spell of labelled) bySide[spell.side].push(spell)
    for (const shot of shots) {
      const own = bySide[shot.team]
      for (let index = own.length - 1; index >= 0; index--) {
        const spell = own[index]
        if (spell.startTick > shot.tick) continue
        if (shot.tick <= spell.endTick + 3 * TICKS_PER_SECOND) spell.shots.push(shot)
        break
      }
    }
    return labelled
  }

  private classifyShots() {
    const owner = new Map<XgShotPoint, LabelledSpell>()
    for (const spell of this.spells) for (const shot of spell.shots) owner.set(shot, spell)
    for (const shot of this.history.xgShots as readonly XgShotPoint[]) {
      const annotations = (shot.annotations ?? []) as readonly string[]
      const spell = owner.get(shot)
      const sinceStart = spell ? (shot.tick - spell.startTick) / TICKS_PER_SECOND : Number.POSITIVE_INFINITY
      let source: ShotSource = "settled"
      if (annotations.some((annotation) => annotation === "corner" || annotation === "attackingFreeKick" || annotation === "penaltyKick")) {
        source = "setPiece"
      } else if (spell?.kind === "restart" && (spell.startDepth ?? 0) >= 200 / 3 && sinceStart <= TRANSITION_SHOT_SECONDS) {
        source = "setPiece"
      } else if (spell?.kind === "regain" && sinceStart <= TRANSITION_SHOT_SECONDS) {
        source = "transition"
      }
      this.shotSource.set(shot, source)
    }
  }
}

export type TickRange = { from: number; to: number }

const round = (value: number, digits = 0) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : undefined)
const channelOf = (width: number) => (width < 100 / 3 ? "left" : width > 200 / 3 ? "right" : "centre")

/** How high a team defends, from its defensive line (metres from its own goal) while the opponent is in the middle third. */
export function blockName(defensiveLineM: number | undefined): string | undefined {
  if (defensiveLineM == null) return undefined
  return defensiveLineM < 25 ? "low block" : defensiveLineM < 37 ? "mid block" : "high block"
}

export type ShotSummary = { shots: number; xg: number; goals: number }

/** The raw phase figures for one team over a stretch of play. */
export type TeamPhases = {
  side: Side
  /** Seconds on and off the ball (once-a-second samples), and of those with the ball in play. */
  seconds: { inPossession: number; outOfPossession: number; inPlayOnBall: number }
  inPossession: {
    possessions: number
    /** Share of ball-in-play time on the ball in each phase; setPlayPct is the share of all time on the ball with it dead or being set. */
    transitionPct?: number
    buildUpPct?: number
    progressionPct?: number
    finalThirdPct?: number
    setPlayPct?: number
    reachedFinalThird: number
    reachedBox: number
    endedInShot: number
    finalThirdEntries: { left: number; centre: number; right: number }
    boxEntries: number
    widthM?: number
    highestPlayersM?: number
    passes: number
    longPassPct?: number
    longPassCompletionPct?: number
    openPlayCrosses: { left: { completed: number; attempted: number }; right: { completed: number; attempted: number } }
    shots: Record<ShotSource, ShotSummary>
    shotsFromOutsideBoxPct?: number
  }
  outOfPossession: {
    /** Share of the opponent's time on the ball spent in each of its phases. */
    opponentTransitionPct?: number
    opponentBuildUpPct?: number
    opponentProgressionPct?: number
    opponentFinalThirdPct?: number
    opponentSetPlayPct?: number
    defensiveLineM: { whenTheyBuildUp?: number; whenTheyProgress?: number; whenInOwnThird?: number }
    lengthM?: number
    widthM?: number
    block?: string
    /** Opponent passes in its own 60% of the pitch per defensive action of ours there; lower = more pressing. */
    ppda?: number
    highRegains: number
    /** Where the opponent reached the final third, as this team sees its own flanks. */
    opponentEntries: { ourLeft: number; centre: number; ourRight: number }
    opponentBoxEntries: number
  }
  attackingTransition: {
    openPlayRegains: number
    counters: number
    shots: ShotSummary
  }
  defensiveTransition: {
    openPlayLosses: number
    lossesPer10MinOnBall?: number
    lostInOwnThird: number
    lostInMiddleThird: number
    regainedWithin5s: number
    opponentCounters: number
    opponentShots: ShotSummary
  }
  setPieces: {
    corners: number
    freeKicksWonInFinalThird: number
    shots: ShotSummary
    against: ShotSummary
  }
}

const emptyShots = (): ShotSummary => ({ shots: 0, xg: 0, goals: 0 })
const addShot = (summary: ShotSummary, shot: XgShotPoint) => {
  summary.shots++
  summary.xg += shot.xg
  if (shot.metricId === "goals") summary.goals++
}
const roundShots = (summary: ShotSummary): ShotSummary => ({ ...summary, xg: round(summary.xg, 2) })

/** Phase figures for both teams over a tick range. */
export function phases(context: PhaseContext, range: TickRange, corners?: Record<Side, number>): Record<Side, TeamPhases> {
  const { model, spells } = context
  const inRange = (tick: number) => tick >= range.from && tick <= range.to
  const result = {} as Record<Side, TeamPhases>

  for (const side of SIDES) {
    result[side] = {
      side,
      seconds: { inPossession: 0, outOfPossession: 0, inPlayOnBall: 0 },
      inPossession: {
        possessions: 0,
        reachedFinalThird: 0,
        reachedBox: 0,
        endedInShot: 0,
        finalThirdEntries: { left: 0, centre: 0, right: 0 },
        boxEntries: 0,
        passes: 0,
        openPlayCrosses: { left: { completed: 0, attempted: 0 }, right: { completed: 0, attempted: 0 } },
        shots: { settled: emptyShots(), transition: emptyShots(), setPiece: emptyShots() },
      },
      outOfPossession: {
        defensiveLineM: {},
        highRegains: 0,
        opponentEntries: { ourLeft: 0, centre: 0, ourRight: 0 },
        opponentBoxEntries: 0,
      },
      attackingTransition: { openPlayRegains: 0, counters: 0, shots: emptyShots() },
      defensiveTransition: {
        openPlayLosses: 0,
        lostInOwnThird: 0,
        lostInMiddleThird: 0,
        regainedWithin5s: 0,
        opponentCounters: 0,
        opponentShots: emptyShots(),
      },
      setPieces: { corners: corners?.[side] ?? 0, freeKicksWonInFinalThird: 0, shots: emptyShots(), against: emptyShots() },
    }
  }

  // Possessions, transitions and shots, from the spells that began in the range.
  spells.forEach((spell, index) => {
    if (!inRange(spell.startTick)) return
    const own = result[spell.side]
    const them = result[other(spell.side)]
    own.inPossession.possessions++
    if (spell.entryTick != null) own.inPossession.reachedFinalThird++
    if (spell.boxTick != null) {
      own.inPossession.reachedBox++
      own.inPossession.boxEntries++
      them.outOfPossession.opponentBoxEntries++
    }
    if (spell.shots.length > 0) own.inPossession.endedInShot++
    if (spell.entryTick != null && !spell.startedInFinalThird && spell.entryWidth != null) {
      const channel = channelOf(spell.entryWidth)
      own.inPossession.finalThirdEntries[channel]++
      // The opponent's left is this team's right.
      them.outOfPossession.opponentEntries[channel === "left" ? "ourRight" : channel === "right" ? "ourLeft" : "centre"]++
    }
    for (const shot of spell.shots) {
      const source = context.shotSource.get(shot) ?? "settled"
      addShot(own.inPossession.shots[source], shot)
      if (source === "setPiece") {
        addShot(own.setPieces.shots, shot)
        addShot(them.setPieces.against, shot)
      }
    }
    if (spell.kind !== "regain") return
    // An open-play regain: a transition for both teams.
    own.attackingTransition.openPlayRegains++
    if (spell.counter) {
      own.attackingTransition.counters++
      them.defensiveTransition.opponentCounters++
    }
    if ((spell.startDepth ?? 0) >= 60) own.outOfPossession.highRegains++
    for (const shot of spell.shots) {
      if (context.shotSource.get(shot) !== "transition") continue
      addShot(own.attackingTransition.shots, shot)
      addShot(them.defensiveTransition.opponentShots, shot)
    }
    them.defensiveTransition.openPlayLosses++
    if (spell.startDepth != null) {
      // Where the loser lost it, from its own point of view.
      const loserDepth = 100 - spell.startDepth
      if (loserDepth < 100 / 3) them.defensiveTransition.lostInOwnThird++
      else if (loserDepth < 200 / 3) them.defensiveTransition.lostInMiddleThird++
    }
    const next = spells[index + 1]
    if (next && next.side !== spell.side && next.kind === "regain" && next.startTick - spell.startTick <= COUNTERPRESS_SECONDS * TICKS_PER_SECOND) {
      them.defensiveTransition.regainedWithin5s++
    }
  })

  // Time in each phase, and shape, from the once-a-second samples.
  type Acc = { n: number; sum: number }
  const acc = () => ({ n: 0, sum: 0 })
  const add = (target: Acc, value: number) => {
    if (!Number.isFinite(value)) return
    target.n++
    target.sum += value
  }
  const avg = (target: Acc) => (target.n > 0 ? round(target.sum / target.n) : undefined)
  // Phases: 0 transition, 1 build-up, 2 progression, 3 final third, 4 set play.
  const phaseTime: Record<Side, number[]> = { home: [0, 0, 0, 0, 0], away: [0, 0, 0, 0, 0] }
  const lines: Record<Side, Acc[]> = { home: [acc(), acc(), acc(), acc()], away: [acc(), acc(), acc(), acc()] }
  const length: Record<Side, Acc> = { home: acc(), away: acc() }
  const widthOut: Record<Side, Acc> = { home: acc(), away: acc() }
  const widthIn: Record<Side, Acc> = { home: acc(), away: acc() }
  const highest: Record<Side, Acc> = { home: acc(), away: acc() }
  let pointer = 0
  for (const sample of model.shapeSamples) {
    if (sample.tick < range.from) continue
    if (sample.tick > range.to) break
    while (pointer + 1 < spells.length && spells[pointer + 1].startTick <= sample.tick) pointer++
    const holder = sample.possession
    const defender = other(holder)
    const holderDirection = model.direction(sample.period, holder)
    const defenderDirection = model.direction(sample.period, defender)
    if (!holderDirection || !defenderDirection) continue
    result[holder].seconds.inPossession++
    result[defender].seconds.outOfPossession++
    const spell = spells[pointer]
    const inTransition =
      spell && spell.side === holder && spell.kind === "regain" && sample.tick - spell.startTick < TRANSITION_SECONDS * TICKS_PER_SECOND
    const dead = sample.still || Math.abs(sample.ballX) > model.halfWidth || Math.abs(sample.ballY) > model.halfLength
    const ballDepth = context.depth(sample.ballY, holderDirection)
    const phase = dead ? 4 : inTransition ? 0 : ballDepth < 100 / 3 ? 1 : ballDepth < 200 / 3 ? 2 : 3
    phaseTime[holder][phase]++
    if (dead) continue
    result[holder].seconds.inPlayOnBall++
    const defenderSlot = shapeSlot(defender, defenderDirection)
    const holderSlot = shapeSlot(holder, holderDirection)
    add(lines[defender][phase], sample.values[defenderSlot + FIELD.defensiveLine])
    if (phase > 0) {
      add(length[defender], sample.values[defenderSlot + FIELD.length])
      add(widthOut[defender], sample.values[defenderSlot + FIELD.width])
      add(widthIn[holder], sample.values[holderSlot + FIELD.width])
      add(highest[holder], sample.values[holderSlot + FIELD.highest])
    }
  }
  for (const side of SIDES) {
    const own = result[side]
    const opponent = other(side)
    const time = phaseTime[side]
    const live = time[0] + time[1] + time[2] + time[3]
    own.inPossession.transitionPct = pct(time[0], live)
    own.inPossession.buildUpPct = pct(time[1], live)
    own.inPossession.progressionPct = pct(time[2], live)
    own.inPossession.finalThirdPct = pct(time[3], live)
    own.inPossession.setPlayPct = pct(time[4], live + time[4])
    own.inPossession.widthM = avg(widthIn[side])
    own.inPossession.highestPlayersM = avg(highest[side])
    const theirs = phaseTime[opponent]
    const theirLive = theirs[0] + theirs[1] + theirs[2] + theirs[3]
    own.outOfPossession.opponentTransitionPct = pct(theirs[0], theirLive)
    own.outOfPossession.opponentBuildUpPct = pct(theirs[1], theirLive)
    own.outOfPossession.opponentProgressionPct = pct(theirs[2], theirLive)
    own.outOfPossession.opponentFinalThirdPct = pct(theirs[3], theirLive)
    own.outOfPossession.opponentSetPlayPct = pct(theirs[4], theirLive + theirs[4])
    own.outOfPossession.defensiveLineM = {
      whenTheyBuildUp: avg(lines[side][1]),
      whenTheyProgress: avg(lines[side][2]),
      whenInOwnThird: avg(lines[side][3]),
    }
    own.outOfPossession.lengthM = avg(length[side])
    own.outOfPossession.widthM = avg(widthOut[side])
    // The block is where the team sets up once the opponent is past its first line.
    own.outOfPossession.block = blockName(own.outOfPossession.defensiveLineM.whenTheyProgress)
    if (own.seconds.inPlayOnBall > 0) {
      own.defensiveTransition.lossesPer10MinOnBall = round((own.defensiveTransition.openPlayLosses / own.seconds.inPlayOnBall) * 600, 1)
    }
  }

  // Passing, crossing, pressing and free kicks, from the event stream.
  const events = (context.history.tacticalEvents as readonly TacticalEventPoint[]).filter((event) => inRange(event.tick))
  const eventDepth = (event: TacticalEventPoint) => (event.team === "home" ? event.x : 100 - event.x)
  const eventWidth = (event: TacticalEventPoint) => (event.team === "home" ? event.y : 100 - event.y)
  const pressure: Record<Side, { opponentPasses: number; actions: number }> = { home: { opponentPasses: 0, actions: 0 }, away: { opponentPasses: 0, actions: 0 } }
  const long: Record<Side, { all: number; long: number; longCompleted: number }> = { home: { all: 0, long: 0, longCompleted: 0 }, away: { all: 0, long: 0, longCompleted: 0 } }
  for (const event of events) {
    const own = result[event.team]
    const annotations = (event.annotations ?? []) as readonly string[]
    const setPiece = annotations.includes("corner") || annotations.includes("attackingFreeKick") || annotations.includes("defensiveFreeKick")
    const depth = eventDepth(event)
    switch (event.metricId) {
      case "passesCompleted":
      case "passesIncomplete": {
        if (setPiece) break
        // Passes in a team's own 60% of the pitch, for the opponent's pressing figure.
        if (depth < 60) pressure[other(event.team)].opponentPasses++
        if (event.endX == null || event.endY == null) break
        const lengthM = Math.hypot(((event.endX - event.x) / 100) * 2 * model.halfLength, ((event.endY - event.y) / 100) * 2 * model.halfWidth)
        long[event.team].all++
        if (lengthM >= 32) {
          long[event.team].long++
          if (event.metricId === "passesCompleted") long[event.team].longCompleted++
        }
        break
      }
      case "crossesCompleted":
      case "crossesIncomplete": {
        if (setPiece) break
        const flank = eventWidth(event) < 50 ? "left" : "right"
        own.inPossession.openPlayCrosses[flank].attempted++
        if (event.metricId === "crossesCompleted") own.inPossession.openPlayCrosses[flank].completed++
        break
      }
      case "tacklesWon":
      case "tacklesLost":
      case "interceptions":
        if (depth >= 40) pressure[event.team].actions++
        break
      case "foulsCommitted":
        if (depth >= 40) pressure[event.team].actions++
        // A foul in the fouling team's own third gives the other side a free kick in its final third.
        if (depth < 100 / 3) result[other(event.team)].setPieces.freeKicksWonInFinalThird++
        break
    }
  }
  for (const side of SIDES) {
    const own = result[side]
    own.inPossession.passes = long[side].all
    own.inPossession.longPassPct = pct(long[side].long, long[side].all)
    own.inPossession.longPassCompletionPct = long[side].long >= 5 ? pct(long[side].longCompleted, long[side].long) : undefined
    own.outOfPossession.ppda = pressure[side].actions > 0 ? round(pressure[side].opponentPasses / pressure[side].actions, 1) : undefined
    const allShots = Object.values(own.inPossession.shots).reduce((sum, summary) => sum + summary.shots, 0)
    const outside = context.spells
      .filter((spell) => spell.side === side && inRange(spell.startTick))
      .flatMap((spell) => spell.shots)
      .filter((shot) => {
        const depth = shot.team === "home" ? shot.x : 100 - shot.x
        const width = shot.team === "home" ? shot.y : 100 - shot.y
        const fromGoal = ((100 - depth) / 100) * 2 * model.halfLength
        const fromCentre = Math.abs(((width - 50) / 100) * 2 * model.halfWidth)
        return fromGoal > BOX_DEPTH || fromCentre > BOX_HALF_WIDTH
      }).length
    own.inPossession.shotsFromOutsideBoxPct = allShots >= 3 ? pct(outside, allShots) : undefined
    for (const source of ["settled", "transition", "setPiece"] as const) own.inPossession.shots[source] = roundShots(own.inPossession.shots[source])
    own.attackingTransition.shots = roundShots(own.attackingTransition.shots)
    own.defensiveTransition.opponentShots = roundShots(own.defensiveTransition.opponentShots)
    own.setPieces.shots = roundShots(own.setPieces.shots)
    own.setPieces.against = roundShots(own.setPieces.against)
  }
  return result
}
