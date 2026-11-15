// get_briefing: everything a pause-and-ask needs in one call, organised the way
// analysts break a match down. First the game state (score, time, who is on top,
// each side's mentality), then what stands out, then one block per moment of the
// game for both teams, recent against earlier, then whether the tactic's
// instructions are happening, then the people (who is tiring or struggling, the
// bench) and the latest events.

import { decodeTacticalSnapshot } from "@/components/formation/tactics"
import type { XgShotPoint } from "@/types/match"

import { latestChange } from "./changes"
import { type MatchModel, other, type Side, type WindowSelection } from "./model"
import { PhaseContext } from "./phases"
import { briefingRead } from "./opponent"
import { rolesNotHappening } from "./roles"
import { goalLines } from "./sequences"
import {
  findings,
  inPossessionView,
  outOfPossessionView,
  PHASE_LEGEND,
  planVsReality,
  setPiecesView,
  transitionsView,
  windowPhases,
  type WindowPhases,
} from "./phaseViews"
import {
  events,
  eventTime,
  humanize,
  matchState,
  mentalityName,
  naturalPositions,
  playerName,
  quickAttributes,
  roleText,
  round,
  SHOT_OUTCOME,
  shotLocation,
  sideLabel,
  type SourceInfo,
  tacticChanges,
  teamName,
  tickRange,
  windowInfo,
} from "./views"

/** The last 15 minutes, and the stretch to compare it with: the rest of this half, or the previous half. */
function briefingWindows(model: MatchModel) {
  const count = model.buckets.length
  const lastStart = Math.max(0, count - 15)
  const recent = model.selectIndices(lastStart, count - 1, "last 15 minutes")
  const currentPeriod = model.buckets.at(-1)?.period ?? 1
  const periodStart = model.buckets.findIndex((bucket) => bucket.period === currentPeriod)
  let earlier: WindowSelection | undefined
  if (lastStart - periodStart >= 10) earlier = model.selectIndices(periodStart, lastStart - 1, "earlier in this half")
  else {
    const previous = model.buckets
      .map((bucket, index) => ({ bucket, index }))
      .filter(({ bucket, index }) => bucket.period === currentPeriod - 1 && index < lastStart)
    if (previous.length >= 10) earlier = model.selectIndices(previous[0].index, previous.at(-1)!.index, "previous half")
  }
  return { recent, earlier, whole: model.select({}) }
}

export function briefing(model: MatchModel, source: SourceInfo, check: { ok: boolean; problems: string[] }) {
  const state = matchState(model, source)
  const user = model.userSide()
  const sides: Side[] = user ? [user, other(user)] : ["home", "away"]
  const label = (side: Side) => sideLabel(model, side)
  const context = new PhaseContext(model)
  const history = context.history
  const { recent, earlier, whole } = briefingWindows(model)
  if (!recent || !whole) return { match: state.score, clock: state.clock, status: state.status, note: "Not enough of the match captured yet for a briefing." }
  const recentPhases = windowPhases(context, recent)
  const earlierPhases = earlier ? windowPhases(context, earlier) : undefined
  const wholePhases = windowPhases(context, whole)
  const recentKey = `last 15 (${windowInfo(model, recent).from}-${windowInfo(model, recent).to})`
  const earlierKey = earlier ? `${earlier.label} (${windowInfo(model, earlier).from}-${windowInfo(model, earlier).to})` : undefined

  const moment = <T>(view: (window: WindowPhases, side: Side) => T) =>
    Object.fromEntries(
      sides.map((side) => {
        const entry: Record<string, T> = { [recentKey]: view(recentPhases, side) }
        if (earlierPhases && earlierKey) entry[earlierKey] = view(earlierPhases, side)
        return [label(side), entry]
      })
    )

  // Game state: the frame for every judgement (a lead late on changes what "bad" looks like).
  const goals = (side: Side) => (side === "home" ? state.home.goals : state.away.goals)
  const lead = user ? goals(user) - goals(other(user)) : undefined
  const minuteNow = Math.floor(model.lastClockSeconds / 60)
  const period = model.buckets.at(-1)?.period ?? 1
  const regulationEnd = period >= 3 ? 120 : 90
  const mentalities = Object.fromEntries(
    sides.map((side) => {
      const versions = model.tacticVersions.filter((version) => version.side === side)
      const current = versions.at(-1)
      if (!current) return [label(side), undefined]
      const changed = versions.length > 1 && versions.at(-2)!.config.mentality !== current.config.mentality
      return [label(side), `${mentalityName(current.config)}${changed ? ` (changed ${eventTime(model, current.tick).minute})` : ""}`]
    })
  )
  const gameState = {
    score: state.score,
    you: lead == null ? undefined : lead > 0 ? `leading by ${lead}` : lead < 0 ? `trailing by ${-lead}` : "level",
    minute: state.minute,
    minutesLeftInNormalTime: state.status === "full time" ? 0 : Math.max(0, regulationEnd - minuteNow),
    momentum: state.momentum.last10Minutes ?? state.momentum.last5Minutes,
    mentality: Object.values(mentalities).some(Boolean) ? mentalities : undefined,
  }

  const standsOut = user
    ? findings(model, user, recentPhases, earlierPhases, wholePhases)
    : Object.fromEntries(sides.map((side) => [label(side), findings(model, side, recentPhases, earlierPhases, wholePhases)]))

  // Players: tiring, fading, struggling, standing out.
  const count = model.buckets.length
  const twenty = model.selectIndices(Math.max(0, count - 20), count - 1, "last 20 minutes")
  const end = model.endState()
  const people = (side: Side) => {
    const rows: Array<{ name: string; role?: string; condition?: number; conditionChange?: number; rating: number; ratingChange20?: number }> = []
    for (const [playerId, player] of end?.players ?? []) {
      if (player.team !== side || !player.onPitch) continue
      const start = twenty?.start?.players.get(playerId)
      rows.push({
        name: playerName(model, playerId) ?? `player ${playerId}`,
        role: roleText(model, playerId)?.split(";")[0],
        condition: player.condition || undefined,
        conditionChange: start && start.condition ? player.condition - start.condition : undefined,
        rating: round(player.rating, 1),
        ratingChange20: start && start.rating ? round(player.rating - start.rating, 1) : undefined,
      })
    }
    const tiring = rows.filter((row) => row.condition != null && row.condition < 75).sort((left, right) => (left.condition ?? 100) - (right.condition ?? 100))
    const fading = rows.filter((row) => (row.ratingChange20 ?? 0) <= -0.3).sort((left, right) => (left.ratingChange20 ?? 0) - (right.ratingChange20 ?? 0))
    const struggling = rows.filter((row) => row.rating > 0 && row.rating < 6.4).sort((left, right) => left.rating - right.rating)
    const standouts = [...rows].sort((left, right) => right.rating - left.rating).slice(0, 2)
    return { tiring, fading, struggling, standouts }
  }

  // Each team's shots in the last 20 minutes, with how each chance came about.
  const twentyRange = twenty ? tickRange(twenty) : undefined
  const sourceName = { settled: "settled possession", transition: "transition", setPiece: "set piece" } as const
  const recentShots = (side: Side) =>
    (history.xgShots as readonly XgShotPoint[])
      .filter((shot) => shot.team === side && twentyRange && shot.tick >= twentyRange.from && shot.tick <= twentyRange.to)
      .map((shot) => ({
        minute: eventTime(model, shot.tick).minute,
        player: playerName(model, shot.playerId),
        xg: round(shot.xg),
        outcome: SHOT_OUTCOME[shot.metricId] ?? shot.metricId,
        where: shotLocation(model, shot).where,
        from: sourceName[context.shotSource.get(shot) ?? "settled"],
      }))

  // Tactics, briefly.
  let tactics: Record<string, unknown> | string = "not captured for this match; ask the user for their setup if it matters"
  if (model.tactics) {
    try {
      const decoded = decodeTacticalSnapshot(model.tactics)
      tactics = Object.fromEntries(
        sides.map((side) => {
          const config = decoded[side].processing ?? decoded[side].command
          const changes = tacticChanges(model, side)?.slice(-3)
          return [
            label(side),
            config
              ? {
                  name: config.style.configurationName || undefined,
                  mentality: humanize(config.mentality.name),
                  formations: `${config.inPossession.formation.displayName} in possession, ${config.outOfPossession.formation.displayName} out of possession`,
                  recentChanges: changes,
                }
              : "not captured",
          ]
        })
      )
    } catch {
      tactics = "captured but could not be decoded"
    }
  }
  const plan = user ? planVsReality(model, user, wholePhases, recentPhases) : undefined

  const lastTen = (events(model, ["goals", "cards", "subs", "chances"], "both", { lastMinutes: 10 }, 50).events ?? []) as Array<Record<string, unknown>>

  // The bench: who could come on, with what FM shows about them.
  const benchSides: Side[] = user ? [user] : ["home", "away"]
  const bench = Object.fromEntries(
    benchSides.map((side) => {
      const rows: Array<Record<string, unknown>> = []
      for (const [playerId, player] of end?.players ?? []) {
        const appearance = model.appearances.get(playerId)
        if (player.team !== side || player.onPitch || appearance?.startedOnPitch || appearance?.onTick != null) continue
        rows.push({
          name: playerName(model, playerId),
          naturalPositions: naturalPositions(model, playerId),
          condition: player.condition || undefined,
          sharpness: player.sharpness || undefined,
          attributes: quickAttributes(model, playerId) || undefined,
        })
      }
      return [label(side), rows]
    })
  )

  return {
    match: state.score,
    clock: state.clock,
    period: state.period,
    status: state.status,
    youManage: state.youManage,
    source: state.source,
    dataCheck: check.ok ? "passed" : check.problems,
    gameState,
    standsOut,
    inPossession: moment(inPossessionView),
    outOfPossession: moment(outOfPossessionView),
    transitions: moment(transitionsView),
    setPieces: Object.fromEntries(sides.map((side) => [label(side), setPiecesView(wholePhases, side)])),
    planVsReality: plan ?? (user ? "no measurable team instructions captured" : undefined),
    yourLastChange: user ? latestChange(model, user) : undefined,
    rolesNotHappening: user ? rolesNotHappening(model, user) : undefined,
    ...(user ? briefingRead(model, user, whole) : {}),
    howTheGoalsCame: goalLines(model, context),
    shotsLast20Minutes: Object.fromEntries(sides.map((side) => [label(side), recentShots(side)])),
    players: Object.fromEntries(sides.map((side) => [label(side), people(side)])),
    tactics,
    lastTenMinutes: lastTen,
    bench,
    substitutionsMade: Object.fromEntries(sides.map((side) => [label(side), state.substitutions.filter((sub) => sub.team === teamName(model, side)).length])),
    legend:
      `${PHASE_LEGEND} Set pieces are for the whole match. standsOut is worked out from the numbers below: problems and what is working, recent against the opponent and earlier. ` +
      "howTheGoalsCame traces each goal back to the start of its move (get_sequences for big chances and detail). " +
      "shapesAsPlayed is each team's formation as it actually stood, with and without the ball; matchupsToWatch are their attackers with an edge on whoever of yours faced them (get_opponent_read for the full read). " +
      "rolesNotHappening lists roles and player instructions the numbers say are clearly not being carried out (get_roles for every player). " +
      "yourLastChange is the latest tactical change against the stretch before it (get_changes for every change). " +
      "condition is physical condition %, ratingChange20 the change over the last 20 minutes. Use get_phases for any other stretch, and get_players, get_events, get_shape or get_tactic for detail.",
  }
}
