// One match, built up frame by frame from FMMatchLens's capture (live API or
// archive). Frames are visited once and dropped: what is kept is
//   - the dashboard's own history derivations (events, shots, xG, momentum),
//   - cumulative team and player stats at the end of every match minute, so any
//     time window is the difference of two of them,
//   - player positions sampled once a second, summed per minute and per phase
//     (in or out of possession), plus team-shape figures per sample,
//   - when each player came on or went off,
//   - possession spells and once-a-second shape samples for the phases of play
//     (see phases.ts).
// Positions are summed in raw pitch coordinates and turned into each team's own
// frame of reference (own goal to opponent goal, left to right) when asked,
// because which end a team defends is only known once its goalkeeper has been
// seen in that period.

import type {
  RealtimeFrame,
  RealtimeMatchMetadata,
  RealtimePlayer,
  RealtimeTeam,
} from "@/api/realtimeMatch"
import { HistoricalDerivations } from "@/api/replay/replayDerivations"
import { TacticalWireState } from "@/components/formation/tactics"
import type { TacticalConfiguration, TacticalSnapshot } from "@/types/match"

/** The dashboard's position heatmaps: not used here, and about a fifth of the load time. */
function withoutHeatmaps(derived: HistoricalDerivations): HistoricalDerivations {
  const empty = { full: [], half: [] }
  ;(derived as unknown as { heatmaps: object }).heatmaps = {
    reset() {}, append() {}, appendFrame() {}, snapshot: () => empty, getHeatmap: () => [], exportState: () => empty, restoreState() {},
  }
  return derived
}

import { minuteNumber, periodEndMinute, periodStartSeconds, TICKS_PER_SECOND } from "./clock"
import { PossessionTracker, type ShapeSample, shapeSlot, shapeValues, SHAPE_VALUE_FIELDS } from "./phases"

export type Side = "home" | "away"
export const SIDES: readonly Side[] = ["home", "away"]
export const other = (side: Side): Side => (side === "home" ? "away" : "home")

export const TEAM_COUNTERS = [
  "goals",
  "xg",
  "shots",
  "shotsOnTarget",
  "shotsOffTarget",
  "blockedShots",
  "clearCutChances",
  "passes",
  "passesCompleted",
  "progressivePasses",
  "finalThirdPasses",
  "crosses",
  "crossesCompleted",
  "aerials",
  "aerialsWon",
  "tacklesAttempted",
  "tacklesWon",
  "fouls",
  "corners",
  "offsides",
  "yellowCards",
  "redCards",
  "possessionTime",
] as const
export type TeamCounter = (typeof TEAM_COUNTERS)[number]

export const PLAYER_COUNTERS = [
  "goals",
  "assists",
  "xg",
  "xa",
  "shots",
  "shotsOnTarget",
  "blockedShots",
  "hitWoodwork",
  "clearCutChances",
  "keyPasses",
  "passes",
  "passesCompleted",
  "progressivePasses",
  "crosses",
  "crossesCompleted",
  "dribbles",
  "tacklesAttempted",
  "tacklesWon",
  "keyTackles",
  "interceptions",
  "clearances",
  "aerials",
  "aerialsWon",
  "fouls",
  "fouled",
  "offsides",
  "distanceM",
  "shotsFaced",
  "savesHeld",
  "savesParried",
  "savesTipped",
  "ownGoals",
  "penalties",
  "corners",
] as const
export type PlayerCounter = (typeof PLAYER_COUNTERS)[number]

export type PlayerState = {
  team: Side
  counters: Float64Array
  rating: number
  condition: number
  sharpness: number
  onPitch: boolean
}

/** Cumulative stats as they stood at one frame. */
export type StatState = {
  tick: number
  period: number
  clockSeconds: number
  team: Record<Side, Float64Array>
  players: Map<number, PlayerState>
}

/** Position sums for one player in one minute: [n, sumX, sumY] in possession, then out of it. */
type PositionSums = Float64Array

// Team shape per sample, for both possible playing directions (orientation +1:
// the team attacks towards +y). Per phase (0 in possession, 1 out of it) and
// orientation (0: +1, 1: -1): [n, defensiveLine, attackingLine, length, width, centroid].
const SHAPE_FIELDS = 6
const shapeIndex = (phase: number, orientation: 1 | -1) =>
  (phase * 2 + (orientation === 1 ? 0 : 1)) * SHAPE_FIELDS

export type Bucket = {
  period: number
  minute: number
  windowMinute: number
  startSeconds: number
  endSeconds: number
  startTick: number
  endTick: number
  /** Cumulative stats at the end of the minute; undefined while it is the current minute. */
  end?: StatState
  positions: Map<number, PositionSums>
  shape: Record<Side, Float64Array>
  /** Ball samples by raw longitudinal third: y < -L/3, middle, y > L/3. */
  ballThirds: Float64Array
}

export type Appearance = {
  team: Side
  startedOnPitch: boolean
  onTick?: number
  offTick?: number
}

/** A team's applied tactic as first seen, and each time it changed. */
export type TacticVersion = {
  tick: number
  side: Side
  config: TacticalConfiguration
}

export type MatchWindow = {
  half?: "first" | "second" | "extra"
  fromMinute?: number
  toMinute?: number
  lastMinutes?: number
}

export type WindowSelection = {
  buckets: Bucket[]
  start?: StatState
  end: StatState
  /** Readable description of the window. */
  label: string
}

const POSITION_SAMPLE_EVERY_TICKS = TICKS_PER_SECOND
/** Everyone's position is kept on every tick with the ball this close to a goal line (metres), to read the moment of a shot. */
const GOAL_AREA_DEPTH_M = 35

/** Everyone on the pitch at one tick: ids[i] stands at (xy[2i], xy[2i+1]) in metres. */
export type PositionFrame = { tick: number; ids: Int32Array; xy: Float32Array }

export class MatchModel {
  readonly matchId: string
  metadata: RealtimeMatchMetadata | null = null
  readonly derived = withoutHeatmaps(new HistoricalDerivations())
  readonly buckets: Bucket[] = []
  readonly appearances = new Map<number, Appearance>()
  last?: RealtimeFrame
  /** The latest tactic snapshot FMMatchLens captured (sampled about once a game minute). */
  tactics?: TacticalSnapshot
  readonly tacticVersions: TacticVersion[] = []
  readonly possession = new PossessionTracker()
  readonly shapeSamples: ShapeSample[] = []
  /** Ticks with the ball near either goal (see GOAL_AREA_DEPTH_M). */
  readonly goalAreaFrames: PositionFrame[] = []
  lastClockSeconds = 0
  frameCount = 0
  halfLength = 52.5
  halfWidth = 34

  private readonly tacticWire = new TacticalWireState()
  private readonly periodStartTick = new Map<number, number>([[1, 0]])
  private readonly possessionSeen = new Set<number>()
  private current?: Bucket
  private lastEndState?: StatState
  private initialLineupKnown = false
  private orientationCache = new Map<string, 1 | -1 | undefined>()
  private tacticKeys: Record<Side, string | undefined> = { home: undefined, away: undefined }

  constructor(matchId: string) {
    this.matchId = matchId
  }

  get lastTick(): number {
    return this.last?.tick ?? -1
  }

  setMetadata(metadata: RealtimeMatchMetadata | null) {
    if (!metadata) return
    this.metadata = metadata
    if (metadata.halfPitchLength && metadata.halfPitchLength > 0) this.halfLength = metadata.halfPitchLength
    if (metadata.halfPitchWidth && metadata.halfPitchWidth > 0) this.halfWidth = metadata.halfPitchWidth
  }

  /** Adds frames in tick order. Frames at or before the last tick are ignored. */
  ingest(frames: readonly RealtimeFrame[], hydrateTactics = false) {
    const accepted: RealtimeFrame[] = []
    for (const raw of frames) {
      // FMMatchLens may resend the final tick once the match is over, with the
      // finished stats; take it without counting the tick twice.
      if (this.last && raw.tick === this.last.tick && raw.sequence > this.last.sequence) {
        this.last = hydrateTactics ? this.tacticWire.hydrate(raw) : raw
        this.lastEndState = undefined
        continue
      }
      if (this.last && raw.tick <= this.last.tick) continue
      const frame = hydrateTactics ? this.tacticWire.hydrate(raw) : raw
      this.ingestFrame(frame)
      accepted.push(frame)
    }
    if (accepted.length > 0) this.derived.append(accepted)
  }

  private ingestFrame(frame: RealtimeFrame) {
    if (frame.halfPitchLength > 0) this.halfLength = frame.halfPitchLength
    if (frame.halfPitchWidth > 0) this.halfWidth = frame.halfPitchWidth
    const previous = this.last
    if (previous && frame.period > previous.period && !this.periodStartTick.has(frame.period)) {
      this.periodStartTick.set(frame.period, frame.tick)
    }
    if (frame.possessionTeam != null) this.possessionSeen.add(frame.period)
    // After full time FM keeps ticking in a later period with nobody in
    // possession while the players walk off. Those frames only update the
    // final stats.
    const postMatch = frame.period >= 3 && !this.possessionSeen.has(frame.period)
    const clock = postMatch ? this.lastClockSeconds : this.clockSecondsAt(frame)

    if (!postMatch) {
      const minute = minuteNumber(clock)
      if (!this.current || this.current.period !== frame.period || this.current.minute !== minute) {
        if (this.current && previous) this.closeBucket(this.current, previous)
        this.current = this.openBucket(frame.period, minute, clock, frame.tick)
        this.buckets.push(this.current)
      }
      this.current.endSeconds = clock
      this.current.endTick = frame.tick
      this.possession.observe(frame, this.halfLength, this.halfWidth)
      const ballY = frame.ballYCentimeters / 100
      if (Number.isFinite(ballY) && Math.abs(ballY) >= this.halfLength - GOAL_AREA_DEPTH_M) this.recordPositions(frame)
      if (frame.tick % POSITION_SAMPLE_EVERY_TICKS === 0 && frame.possessionTeam != null) {
        this.samplePositions(this.current, frame)
      }
      this.trackAppearances(frame)
      if (frame.tactics && frame.tactics !== this.tactics) this.trackTactics(frame.tactics, frame.tick)
      this.lastClockSeconds = clock
    }
    this.last = frame
    this.frameCount++
    this.lastEndState = undefined
  }

  private trackTactics(tactics: TacticalSnapshot, tick: number) {
    this.tactics = tactics
    for (const side of SIDES) {
      const config = tactics[side]?.processing
      if (!config) continue
      // What a manager changes: mentality, style, instructions, shape and roles.
      const key = JSON.stringify([
        config.mentality,
        config.styleKey,
        config.teamInstructions,
        config.phaseSlotMapping,
        config.inPossession.map((position) => [position.positionMask, position.roleDuty]),
        config.outOfPossession.map((position) => [position.positionMask, position.roleDuty]),
      ])
      if (key === this.tacticKeys[side]) continue
      this.tacticKeys[side] = key
      this.tacticVersions.push({ tick, side, config })
    }
  }

  private recordPositions(frame: RealtimeFrame) {
    const onPitch = frame.players.filter((player) => player.isOnPitch && Number.isFinite(player.x) && Number.isFinite(player.y))
    const ids = new Int32Array(onPitch.length)
    const xy = new Float32Array(onPitch.length * 2)
    onPitch.forEach((player, index) => {
      ids[index] = player.playerId
      xy[2 * index] = player.x
      xy[2 * index + 1] = player.y
    })
    this.goalAreaFrames.push({ tick: frame.tick, ids, xy })
  }

  /** Everyone's position at (or just before) a tick with the ball near a goal. */
  positionsAt(tick: number, toleranceTicks = 4): PositionFrame | undefined {
    const frames = this.goalAreaFrames
    let low = 0
    let high = frames.length - 1
    let found: PositionFrame | undefined
    while (low <= high) {
      const middle = (low + high) >> 1
      if (frames[middle].tick <= tick) {
        found = frames[middle]
        low = middle + 1
      } else high = middle - 1
    }
    return found && tick - found.tick <= toleranceTicks ? found : undefined
  }

  /** Match clock in seconds for a frame (see clock.ts). */
  clockSecondsAt(frame: RealtimeFrame): number {
    if (frame.period <= 1) return Math.max(0, frame.tick) / TICKS_PER_SECOND
    const start = this.periodStartTick.get(frame.period)
    if (start != null) return periodStartSeconds(frame.period) + (frame.tick - start) / TICKS_PER_SECOND
    // The capture began during this period, so its start was not seen.
    return Math.max(periodStartSeconds(frame.period), frame.displayTick / TICKS_PER_SECOND)
  }

  /** Period and clock for an engine tick, e.g. of an event. */
  clockAtTick(tick: number): { period: number; seconds: number } {
    let period = 1
    let start = 0
    for (const [candidate, candidateStart] of this.periodStartTick) {
      // A period with nobody ever in possession is the post-match walk-off.
      if (candidate >= 3 && !this.possessionSeen.has(candidate)) continue
      if (candidate > period && tick >= candidateStart) {
        period = candidate
        start = candidateStart
      }
    }
    if (period === 1) return { period, seconds: Math.max(0, tick) / TICKS_PER_SECOND }
    return { period, seconds: periodStartSeconds(period) + (tick - start) / TICKS_PER_SECOND }
  }

  private openBucket(period: number, minute: number, clock: number, tick: number): Bucket {
    const blankShape = () => new Float64Array(2 * 2 * SHAPE_FIELDS)
    return {
      period,
      minute,
      windowMinute: Math.min(minute, periodEndMinute(period)),
      startSeconds: clock,
      endSeconds: clock,
      startTick: tick,
      endTick: tick,
      positions: new Map(),
      shape: { home: blankShape(), away: blankShape() },
      ballThirds: new Float64Array(3),
    }
  }

  private closeBucket(bucket: Bucket, lastFrameOfBucket: RealtimeFrame) {
    bucket.end = this.statState(lastFrameOfBucket, bucket.endSeconds)
  }

  private statState(frame: RealtimeFrame, clockSeconds: number): StatState {
    const players = new Map<number, PlayerState>()
    for (const player of frame.players) {
      players.set(player.playerId, {
        team: player.team,
        counters: playerCounters(player),
        rating: finite(player.rating),
        condition: finite((player as PlayerWithCondition).overallPhysicalCondition),
        sharpness: finite((player as PlayerWithCondition).matchSharpness),
        onPitch: player.isOnPitch,
      })
    }
    return {
      tick: frame.tick,
      period: frame.period,
      clockSeconds,
      team: { home: teamCounters(frame.home), away: teamCounters(frame.away) },
      players,
    }
  }

  /** Cumulative stats as of the latest frame. */
  endState(): StatState | undefined {
    if (!this.last) return undefined
    this.lastEndState ??= this.statState(this.last, this.lastClockSeconds)
    return this.lastEndState
  }

  private samplePositions(bucket: Bucket, frame: RealtimeFrame) {
    const holder = frame.possessionTeam
    if (holder == null) return
    const byTeam: Record<Side, RealtimePlayer[]> = { home: [], away: [] }
    for (const player of frame.players) {
      if (!player.isOnPitch || !Number.isFinite(player.x) || !Number.isFinite(player.y)) continue
      byTeam[player.team].push(player)
      const inPossession = holder === player.team
      let sums = bucket.positions.get(player.playerId)
      if (!sums) {
        sums = new Float64Array(6)
        bucket.positions.set(player.playerId, sums)
      }
      const base = inPossession ? 0 : 3
      sums[base] += 1
      sums[base + 1] += player.x
      sums[base + 2] += player.y
    }
    const ballX = frame.ballXCentimeters / 100
    const ballY = frame.ballYCentimeters / 100
    const previous = this.shapeSamples.at(-1)
    const sample: ShapeSample = {
      tick: frame.tick,
      period: frame.period,
      possession: holder,
      ballX,
      ballY,
      still: previous != null && frame.tick - previous.tick <= POSITION_SAMPLE_EVERY_TICKS && Math.hypot(ballX - previous.ballX, ballY - previous.ballY) < 0.25,
      values: new Float32Array(4 * SHAPE_VALUE_FIELDS.length).fill(Number.NaN),
    }
    for (const side of SIDES) {
      const phase = holder === side ? 0 : 1
      for (const orientation of [1, -1] as const) {
        const values = shapeValues(byTeam[side], orientation, this.halfLength, this.halfWidth)
        if (!values) continue
        // Per-minute sums: [n, defensive line, highest, length, width, centroid].
        const target = bucket.shape[side]
        const base = shapeIndex(phase, orientation)
        target[base] += 1
        values.forEach((value, field) => {
          target[base + 1 + field] += value
        })
        sample.values.set(values, shapeSlot(side, orientation))
      }
    }
    if (Number.isFinite(ballX) && Number.isFinite(ballY)) this.shapeSamples.push(sample)
    if (Number.isFinite(ballY)) {
      const third = this.halfLength / 3
      bucket.ballThirds[ballY < -third ? 0 : ballY > third ? 2 : 1] += 1
    }
  }

  private trackAppearances(frame: RealtimeFrame) {
    if (frame.possessionTeam == null && !this.initialLineupKnown) return
    for (const player of frame.players) {
      let appearance = this.appearances.get(player.playerId)
      if (!appearance) {
        appearance = { team: player.team, startedOnPitch: !this.initialLineupKnown && player.isOnPitch }
        this.appearances.set(player.playerId, appearance)
        if (this.initialLineupKnown && player.isOnPitch) appearance.onTick = frame.tick
        continue
      }
      if (player.isOnPitch && !appearance.startedOnPitch && appearance.onTick == null) appearance.onTick = frame.tick
      if (!player.isOnPitch && appearance.offTick == null && (appearance.startedOnPitch || appearance.onTick != null)) {
        appearance.offTick = frame.tick
      }
    }
    this.initialLineupKnown = true
  }

  /**
   * Playing direction of a team in a period: +1 if it attacks towards +y. Taken
   * from its goalkeeper (the player whose average position is furthest from the
   * centre line), who stands in front of the goal the team defends.
   */
  orientation(period: number, side: Side): 1 | -1 | undefined {
    const key = `${period}|${side}`
    const closed = this.current?.period !== period
    if (closed && this.orientationCache.has(key)) return this.orientationCache.get(key)
    const totals = new Map<number, { n: number; y: number }>()
    for (const bucket of this.buckets) {
      if (bucket.period !== period) continue
      for (const [playerId, sums] of bucket.positions) {
        if (this.teamOf(playerId) !== side) continue
        const total = totals.get(playerId) ?? { n: 0, y: 0 }
        total.n += sums[0] + sums[3]
        total.y += sums[2] + sums[5]
        totals.set(playerId, total)
      }
    }
    let best: { meanY: number; n: number } | undefined
    for (const total of totals.values()) {
      if (total.n < 20) continue
      const meanY = total.y / total.n
      if (!best || Math.abs(meanY) > Math.abs(best.meanY)) best = { meanY, n: total.n }
    }
    const result = best && Math.abs(best.meanY) > this.halfLength * 0.4 ? (best.meanY < 0 ? 1 : -1) : undefined
    if (closed) this.orientationCache.set(key, result)
    return result
  }

  /** Playing direction of a team, falling back to the opposite of the other team's. */
  direction(period: number, side: Side): 1 | -1 | undefined {
    const own = this.orientation(period, side)
    if (own) return own
    const opponent = this.orientation(period, other(side))
    return opponent ? (opponent === 1 ? -1 : 1) : undefined
  }

  teamOf(playerId: number): Side | undefined {
    return (
      this.appearances.get(playerId)?.team ??
      this.metadata?.players.find((player) => player.playerId === playerId)?.team ??
      this.last?.players.find((player) => player.playerId === playerId)?.team
    )
  }

  /** The side the human manager controls, if exactly one is human-controlled. */
  userSide(): Side | undefined {
    const home = this.metadata?.home.manager?.isHumanControlled
    const away = this.metadata?.away.manager?.isHumanControlled
    if (home && !away) return "home"
    if (away && !home) return "away"
    return undefined
  }

  /** Buckets and boundary states for a time window. */
  select(window: MatchWindow = {}): WindowSelection | undefined {
    const end = this.endState()
    if (!end || this.buckets.length === 0) return undefined
    let indices = this.buckets.map((_, index) => index)
    const labels: string[] = []
    if (window.half) {
      const wanted = (period: number) =>
        window.half === "first" ? period === 1 : window.half === "second" ? period === 2 : period >= 3
      indices = indices.filter((index) => wanted(this.buckets[index].period))
      labels.push(window.half === "extra" ? "extra time" : `${window.half} half`)
    }
    if (window.fromMinute != null || window.toMinute != null) {
      const from = window.fromMinute ?? 0
      const to = window.toMinute ?? Number.POSITIVE_INFINITY
      // Stoppage minutes count as the period's last minute (45 or 90), and the
      // second half starts at 46', so the two never overlap.
      indices = indices.filter((index) => {
        const minute = this.buckets[index].windowMinute
        return minute >= from && minute <= to
      })
      labels.push(`minutes ${from}-${Number.isFinite(to) ? to : "end"}`)
    }
    if (window.lastMinutes != null && window.lastMinutes > 0) {
      indices = indices.slice(-Math.ceil(window.lastMinutes))
      labels.push(`last ${window.lastMinutes} minutes played`)
    }
    if (indices.length === 0) return undefined
    const first = indices[0]
    const lastIndex = indices.at(-1)!
    const buckets = indices.map((index) => this.buckets[index])
    const start = first > 0 ? this.bucketEnd(first - 1) : undefined
    return {
      buckets,
      start,
      end: this.bucketEnd(lastIndex) ?? end,
      label: labels.length > 0 ? labels.join(", ") : "whole match so far",
    }
  }

  /** A selection of consecutive buckets by index (inclusive), for comparing stretches of play. */
  selectIndices(first: number, last: number, label: string): WindowSelection | undefined {
    const end = this.endState()
    if (!end || first < 0 || last >= this.buckets.length || first > last) return undefined
    return {
      buckets: this.buckets.slice(first, last + 1),
      start: first > 0 ? this.bucketEnd(first - 1) : undefined,
      end: this.bucketEnd(last) ?? end,
      label,
    }
  }

  private bucketEnd(index: number): StatState | undefined {
    const bucket = this.buckets[index]
    if (bucket.end) return bucket.end
    return bucket === this.current ? this.endState() : undefined
  }

  /** Events, shots and momentum derived by the dashboard's own history code. */
  history() {
    return this.derived.snapshot(this.last?.tick ?? 0)
  }
}

type PlayerWithCondition = RealtimePlayer & {
  overallPhysicalCondition?: number
  matchSharpness?: number
  distanceM?: number
  clearances?: number
}

const finite = (value: number | undefined | null) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

function teamCounters(team: RealtimeTeam): Float64Array {
  const values = new Float64Array(TEAM_COUNTERS.length)
  const record = team as unknown as Record<string, number | undefined>
  TEAM_COUNTERS.forEach((name, index) => {
    values[index] = finite(record[name])
  })
  return values
}

function playerCounters(player: RealtimePlayer): Float64Array {
  const values = new Float64Array(PLAYER_COUNTERS.length)
  const record = player as unknown as Record<string, number | undefined>
  PLAYER_COUNTERS.forEach((name, index) => {
    values[index] = finite(record[name])
  })
  return values
}

export const teamCounterIndex = (name: TeamCounter) => TEAM_COUNTERS.indexOf(name)
export const playerCounterIndex = (name: PlayerCounter) => PLAYER_COUNTERS.indexOf(name)
export { SHAPE_FIELDS, shapeIndex }
