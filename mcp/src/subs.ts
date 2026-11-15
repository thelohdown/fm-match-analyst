// get_sub_plan: who to take off, when, and who to bring on. For each player on
// the pitch: his condition now and where it is heading (the drop over the last
// stretch of this half, run on to full time), his rating trend, whether he is
// booked and still giving fouls away, and whether he is losing his individual
// battle; then who on the bench can play his position, with condition,
// sharpness and the attributes that matter for a change. Plus the substitutions
// and windows already used.

import { type MatchModel, other, playerCounterIndex, type Side } from "./model"
import { briefingRead } from "./opponent"
import { eventTime, playerName, playerRoles, quickAttributes, round, sideLabel, teamName } from "./views"

/** Condition (%) at or below which a player is tiring now. */
const TIRING = 70
/** Forecast condition at full time at or below which he will be running on empty. */
const EMPTY = 64
/** The condition the forecast reports the crossing minute for. */
const WARN = 65
/** Minutes of this half used to measure how fast condition is dropping. */
const TREND_MINUTES = 20
const MIN_TREND_MINUTES = 6

type PlayerMeta = { positionFamiliarities?: Record<string, number>; position?: string }

/** FM's familiarity key for a tactic position: DCL -> DC, DMR -> DM, STL -> ST. */
export function familiarityKey(position: string): string {
  const centre = /^(DC|DM|MC|AMC|ST)[LR]?$/.exec(position)
  if (centre) return centre[1]
  return position
}

const metaOf = (model: MatchModel, playerId: number) => model.metadata?.players.find((player) => player.playerId === playerId) as (PlayerMeta & { playerId: number }) | undefined

export function subPlan(model: MatchModel, side: Side) {
  const end = model.endState()
  if (!end || model.buckets.length === 0) return { note: "Not enough of the match captured yet." }
  const count = model.buckets.length
  const period = model.buckets.at(-1)!.period
  const periodStart = model.buckets.findIndex((bucket) => bucket.period === period)
  const minuteNow = model.lastClockSeconds / 60
  const fullTime = period >= 3 ? 120 : 90
  // FM adds a few minutes; plan to the whistle, not the 90th.
  const whistle = fullTime + 3
  const minutesLeft = Math.max(0, whistle - minuteNow)

  // Condition trend: over the last stretch of this half (half-time recovery would skew it), else the whole of the previous half.
  let trendStart = Math.max(periodStart, count - TREND_MINUTES)
  if (count - trendStart < MIN_TREND_MINUTES) trendStart = Math.max(0, count - TREND_MINUTES)
  const trend = model.selectIndices(trendStart, count - 1, "trend")
  const trendMinutes = count - trendStart
  const twenty = model.selectIndices(Math.max(0, count - 20), count - 1, "last 20 minutes")

  const history = model.history()
  const yellows = new Map<number, number>()
  for (const event of history.events) if (event.type === "yellow_card" && event.playerId != null && event.tick != null) yellows.set(event.playerId, event.tick)

  const read = briefingRead(model, side, model.select({})!)
  const losing = new Map<string, string>()
  for (const line of read.matchupsToWatch ?? []) {
    const match = /^(.+?) v (.+?): (.*)$/.exec(line)
    if (match) losing.set(match[2], `${match[1]} has the edge on him (${match[3]})`)
  }

  type Candidate = {
    player: string
    playerId: number
    position?: string
    role?: string
    condition?: number
    dropPer10?: number
    conditionAtWhistle?: number
    reaches65At?: string
    sharpness?: number
    rating?: number
    ratingChange20?: number
    booked?: string
    why: string[]
    score: number
    benchOptions?: string[]
  }
  const onPitch: Candidate[] = []
  for (const [playerId, state] of end.players) {
    if (state.team !== side || !state.onPitch) continue
    const roles = playerRoles(model, playerId)
    const position = roles?.inPossession?.position ?? metaOf(model, playerId)?.position
    const startState = trend?.start?.players.get(playerId)
    const why: string[] = []
    let score = 0
    const row: Candidate = {
      player: playerName(model, playerId) ?? `player ${playerId}`,
      playerId,
      position,
      role: roles?.inPossession ? `${roles.inPossession.position} ${roles.inPossession.role}${roles.inPossession.duty ? ` (${roles.inPossession.duty})` : ""}` : undefined,
      rating: state.rating ? round(state.rating, 1) : undefined,
      sharpness: state.sharpness ? Math.round(state.sharpness) : undefined,
      why,
      score,
    }
    if (state.condition) {
      row.condition = Math.round(state.condition)
      if (startState?.condition && trendMinutes >= MIN_TREND_MINUTES) {
        // A player who came on during the stretch only has his own minutes.
        const appearance = model.appearances.get(playerId)
        const cameOn = appearance?.onTick != null && trend && appearance.onTick > trend.buckets[0].startTick
        const minutes = cameOn ? Math.max(1, minuteNow - model.clockAtTick(appearance!.onTick!).seconds / 60) : trendMinutes
        const perMinute = Math.max(0, (startState.condition - state.condition) / minutes)
        row.dropPer10 = round(perMinute * 10, 1)
        row.conditionAtWhistle = Math.max(0, Math.round(state.condition - perMinute * minutesLeft))
        if (perMinute > 0 && state.condition > WARN && state.condition - perMinute * minutesLeft <= WARN) {
          const at = minuteNow + (state.condition - WARN) / perMinute
          row.reaches65At = `${Math.floor(at) + 1}'`
        }
      }
      if (row.condition <= TIRING) {
        why.push(`tiring now (${row.condition}% condition)`)
        score += 3
      } else if (row.conditionAtWhistle != null && row.conditionAtWhistle <= EMPTY) {
        why.push(`will be out on his feet by the whistle (about ${row.conditionAtWhistle}%${row.reaches65At ? `, under ${WARN}% from ${row.reaches65At}` : ""})`)
        score += 2
      }
    }
    const startRating = twenty?.start?.players.get(playerId)?.rating
    if (startRating && state.rating) {
      row.ratingChange20 = round(state.rating - startRating, 1)
      if (row.ratingChange20 <= -0.3) {
        why.push(`fading (rating ${row.ratingChange20} over the last 20 minutes)`)
        score += 1
      }
    }
    if (state.rating && state.rating < 6.4) {
      why.push(`struggling (rating ${round(state.rating, 1)})`)
      score += 1
    }
    const card = yellows.get(playerId)
    if (card != null) {
      // Counted from three minutes after the card: FM's foul count for the booking
      // offence can land a minute or two after the card itself (seen on the archive),
      // and a phantom "foul since" would raise a false second-yellow alarm.
      const atCard = model.buckets.find((bucket) => bucket.endTick >= card + 3 * 60 * 4 && bucket.end)?.end?.players.get(playerId)
      const fouls = state.counters[playerCounterIndex("fouls")] - (atCard?.counters[playerCounterIndex("fouls")] ?? state.counters[playerCounterIndex("fouls")])
      row.booked = `booked ${eventTime(model, card).minute}${fouls > 0 ? `, ${fouls} foul${fouls === 1 ? "" : "s"} since` : ""}`
      const defender = position != null && /^(D|WB|DM)/.test(position)
      why.push(`${row.booked}${fouls > 0 ? ": a second yellow is a real risk" : defender ? ": a defender on a yellow" : ""}`)
      score += 1 + (fouls > 0 ? 2 : 0) + (defender ? 1 : 0)
    }
    const battle = losing.get(row.player)
    if (battle) {
      why.push(`losing his matchup: ${battle}`)
      score += 1
    }
    row.score = score
    onPitch.push(row)
  }

  // The bench: who has not played yet.
  const bench: Array<{ playerId: number; name: string; familiarities?: Record<string, number>; text: Record<string, unknown> }> = []
  for (const [playerId, state] of end.players) {
    const appearance = model.appearances.get(playerId)
    if (state.team !== side || state.onPitch || appearance?.startedOnPitch || appearance?.onTick != null) continue
    const meta = metaOf(model, playerId)
    const familiarities = meta?.positionFamiliarities
    const natural = familiarities
      ? Object.entries(familiarities)
          .filter(([, value]) => value >= 14)
          .sort((left, right) => right[1] - left[1])
          .map(([key, value]) => (value >= 18 ? key : `${key} (accomplished)`))
          .join(", ")
      : undefined
    const sharpness = state.sharpness ? Math.round(state.sharpness) : undefined
    bench.push({
      playerId,
      name: playerName(model, playerId) ?? `player ${playerId}`,
      familiarities,
      text: {
        name: playerName(model, playerId),
        positions: natural || "not captured",
        condition: state.condition ? Math.round(state.condition) : undefined,
        sharpness,
        note: sharpness != null && sharpness < 50 ? "short of match sharpness" : undefined,
        attributes: quickAttributes(model, playerId) || undefined,
      },
    })
  }
  for (const row of onPitch) {
    if (!row.position || row.score === 0) continue
    const key = familiarityKey(row.position)
    const options = bench
      .map((candidate) => ({ candidate, value: candidate.familiarities?.[key] ?? 0 }))
      .filter((option) => option.value >= 14)
      .sort((left, right) => right.value - left.value)
      .map((option) => `${option.candidate.name}${option.value >= 18 ? "" : " (accomplished)"}`)
    row.benchOptions = bench.some((candidate) => candidate.familiarities) ? (options.length > 0 ? options : [`nobody on the bench plays ${key}`]) : undefined
  }

  // Substitutions and windows used; half-time changes do not use a window.
  const ons = [...model.appearances.values()].filter((appearance) => appearance.team === side && appearance.onTick != null).map((appearance) => appearance.onTick!)
  const secondHalfStart = model.buckets.find((bucket) => bucket.period === 2)?.startTick
  const windows = new Set<number>()
  for (const tick of ons) {
    if (secondHalfStart != null && Math.abs(tick - secondHalfStart) <= 60) continue
    windows.add(Math.round(model.clockAtTick(tick).seconds / 60))
  }

  const candidates = onPitch
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ playerId: _id, score: _score, ...rest }) => rest)
  const others = onPitch
    .filter((row) => row.score === 0)
    .map((row) => `${row.player}: ${row.condition ?? "?"}%${row.conditionAtWhistle != null ? ` (about ${row.conditionAtWhistle}% at the whistle)` : ""}, rating ${row.rating ?? "?"}`)
  const firstToTire = onPitch
    .filter((row) => row.conditionAtWhistle != null && row.position !== "GK")
    .sort((left, right) => left.conditionAtWhistle! - right.conditionAtWhistle!)
    .slice(0, 3)
    .map((row) => `${row.player}: ${row.condition}% now, about ${row.conditionAtWhistle}% at the whistle${row.reaches65At ? ` (under ${WARN}% from ${row.reaches65At})` : ""}`)
  return {
    team: sideLabel(model, side),
    minute: eventTime(model, model.last?.tick ?? 0).minute,
    minutesToTheWhistle: Math.round(minutesLeft),
    substitutionsMade: ons.length,
    windowsUsed: windows.size,
    candidates,
    firstToTire,
    everyoneElse: others,
    bench: bench.map((entry) => entry.text as { name: string } & Record<string, unknown>),
    against: teamName(model, other(side)),
    legend:
      `Condition is FM's physical condition %. dropPer10 is how fast it has fallen over the last ${TREND_MINUTES} minutes of this half (per 10 minutes), ` +
      `run on to the whistle (about ${fullTime + 3}') for conditionAtWhistle; ${TIRING}% or less is tiring, and players under about ${WARN}% fade and get injured more. ` +
      "Candidates are ordered by how many reasons there are to take them off (condition, a yellow with fouls since, fading or low rating, a lost individual battle). " +
      "benchOptions are unused substitutes natural (or accomplished) in his position. Most competitions allow five substitutions in three windows plus half-time; " +
      "friendlies and some cups differ, so check the rules shown in FM. sharpness is match sharpness: a player under 50% will not last or perform at his level.",
  }
}

/** For the briefing: the top substitution candidates, one line each. */
export function subCandidates(model: MatchModel, side: Side) {
  const plan = subPlan(model, side) as { candidates?: Array<{ player: string; why: string[]; benchOptions?: string[] }> }
  return plan.candidates?.slice(0, 3).map((row) => `${row.player}: ${row.why.join("; ")}${row.benchOptions ? ` (could come on: ${row.benchOptions.join(", ")})` : ""}`)
}
