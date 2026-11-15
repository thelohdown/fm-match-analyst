// get_changes: did a tactical change work? For each change a team made during the
// match (mentality, shape, roles, team instructions), the stretch before it is set
// against the stretch after it, per 10 minutes so stretches of different lengths
// compare, for both the team that changed and what it allowed. What else happened
// in those stretches (goals, red cards, substitutions, the other side changing) is
// listed beside it, because any of those can move the numbers as much as the change.

import { type MatchModel, other, type Side, type WindowSelection } from "./model"
import { PhaseContext } from "./phases"
import { windowPhases, type WindowPhases } from "./phaseViews"
import { describeTacticChange, eventTime, playerName, round, sideLabel, teamDiff, teamName, windowInfo } from "./views"

/** Longest stretch compared on either side of a change, in match minutes. */
export const CHANGE_WINDOW_MINUTES = 15
/** Under this many minutes after a change, its numbers are reported but not judged. */
export const MIN_JUDGE_MINUTES = 8
/** Under this many minutes before a change there is nothing to compare with. */
const MIN_BEFORE_MINUTES = 5

type Direction = "higher is better" | "lower is better" | "neutral"

type Metric = {
  key: string
  label: string
  direction: Direction
  value: (window: WindowPhases, side: Side) => number | undefined
  /** Smallest difference worth calling out. */
  minDiff: number
  /** For counts and rates: also needs this ratio between before and after. */
  minRatio?: number
  /** The raw amount behind a rate; a shift needs at least minCount of it in one stretch, so two shots against none is not news. */
  count?: (window: WindowPhases, side: Side) => number
  minCount?: number
  /** Only call out a shift when both values are under this (ppda over a few minutes with little pressing is noise). */
  maxValue?: number
}

const per10 = (count: number, window: WindowPhases) => (window.minutes > 0 ? (count * 10) / window.minutes : undefined)

/** A per-10-minute rate of a count, needing at least minCount of it in one stretch to be called out. */
function rate(key: string, label: string, direction: Direction, minDiff: number, minRatio: number, count: (w: WindowPhases, s: Side) => number, minCount = 3): Metric {
  return { key, label, direction, minDiff, minRatio, count, minCount, value: (w, s) => per10(count(w, s), w) }
}

/** The figures compared, from the changing team's point of view. */
const METRICS: Metric[] = [
  { key: "possessionPct", label: "possession %", direction: "neutral", minDiff: 8, value: (w, s) => w.counters[s].possessionPct },
  rate("xgPer10", "xG per 10 min", "higher is better", 0.15, 1.5, (w, s) => w.counters[s].xg, 0.3),
  rate("shotsPer10", "shots per 10 min", "higher is better", 1, 1.5, (w, s) => w.counters[s].shots),
  rate("boxEntriesPer10", "box entries per 10 min", "higher is better", 1, 1.5, (w, s) => w.teams[s].inPossession.boxEntries),
  rate("finalThirdEntriesPer10", "final-third entries per 10 min", "higher is better", 1.5, 1.4, (w, s) => {
    const entries = w.teams[s].inPossession.finalThirdEntries
    return entries.left + entries.centre + entries.right
  }),
  rate("countersPer10", "fast breaks per 10 min", "higher is better", 0.7, 1.5, (w, s) => w.teams[s].attackingTransition.counters),
  rate("highRegainsPer10", "high regains per 10 min", "higher is better", 0.7, 1.5, (w, s) => w.teams[s].outOfPossession.highRegains),
  { key: "ppda", label: "ppda (lower = more pressing)", direction: "neutral", minDiff: 3, minRatio: 1.4, maxValue: 40, value: (w, s) => w.teams[s].outOfPossession.ppda },
  {
    key: "defensiveLineM",
    label: "defensive line when they build up (m from own goal)",
    direction: "neutral",
    minDiff: 4,
    value: (w, s) => w.teams[s].outOfPossession.defensiveLineM.whenTheyBuildUp ?? w.teams[s].outOfPossession.defensiveLineM.whenTheyProgress,
  },
  {
    key: "lossesPer10OnBall",
    label: "open-play losses per 10 min on the ball",
    direction: "lower is better",
    minDiff: 1.5,
    minRatio: 1.3,
    count: (w, s) => w.teams[s].defensiveTransition.openPlayLosses,
    minCount: 5,
    value: (w, s) => w.teams[s].defensiveTransition.lossesPer10MinOnBall,
  },
  rate("lostInOwnThirdPer10", "losses in own third per 10 min", "lower is better", 0.7, 1.5, (w, s) => w.teams[s].defensiveTransition.lostInOwnThird),
  rate("xgAgainstPer10", "xG conceded per 10 min", "lower is better", 0.15, 1.5, (w, s) => w.counters[other(s)].xg, 0.3),
  rate("shotsAgainstPer10", "shots conceded per 10 min", "lower is better", 1, 1.5, (w, s) => w.counters[other(s)].shots),
  rate("boxEntriesAgainstPer10", "box entries conceded per 10 min", "lower is better", 1, 1.5, (w, s) => w.teams[s].outOfPossession.opponentBoxEntries),
  rate("opponentCountersPer10", "fast breaks conceded per 10 min", "lower is better", 0.7, 1.5, (w, s) => w.teams[s].defensiveTransition.opponentCounters),
]

/** Whether a before/after pair moved enough to mention, and which way. */
function shift(metric: Metric, before: number | undefined, after: number | undefined, counts?: [number, number]) {
  if (before == null || after == null) return undefined
  if (counts && metric.minCount != null && Math.max(...counts) < metric.minCount) return undefined
  if (metric.maxValue != null && Math.max(before, after) > metric.maxValue) return undefined
  const diff = after - before
  if (Math.abs(diff) < metric.minDiff) return undefined
  if (metric.minRatio) {
    const low = Math.min(before, after)
    const high = Math.max(before, after)
    if (low > 0 && high / low < metric.minRatio) return undefined
  }
  const up = diff > 0
  const verdict = metric.direction === "neutral" ? "changed" : (metric.direction === "higher is better") === up ? "better" : "worse"
  return { text: `${metric.label}: ${round(before, 1)} -> ${round(after, 1)}`, verdict }
}

/** The index of the minute bucket a tick falls in (or the first after it). */
function bucketIndexAt(model: MatchModel, tick: number) {
  const index = model.buckets.findIndex((bucket) => bucket.endTick >= tick)
  return index === -1 ? model.buckets.length - 1 : index
}

const span = (model: MatchModel, selection: WindowSelection | undefined) =>
  selection ? { ...windowInfo(model, selection), minutes: selection.buckets.length } : undefined

/** What else happened between two ticks that could explain a shift. */
function alsoHappened(model: MatchModel, side: Side, fromTick: number, toTick: number, changeTick: number) {
  const inside = (tick: number | undefined) => tick != null && tick >= fromTick && tick <= toTick
  const when = (tick: number) => `${eventTime(model, tick).minute}${tick < changeTick ? " (before)" : " (after)"}`
  const found: Array<{ tick: number; note: string }> = []
  const add = (note: string, tick: number) => found.push({ tick, note })
  for (const event of model.history().events) {
    if (!inside(event.tick)) continue
    const team = event.team ? teamName(model, event.team) : "?"
    if (event.type === "goal") add(`goal for ${team} ${when(event.tick!)}`, event.tick!)
    else if (event.type === "own_goal") add(`own goal (${team} event) ${when(event.tick!)}`, event.tick!)
    else if (event.type === "red_card") add(`red card for ${team} ${when(event.tick!)}`, event.tick!)
  }
  for (const version of model.tacticVersions) {
    if (version.side === side || !inside(version.tick)) continue
    const index = model.tacticVersions.filter((candidate) => candidate.side === version.side).indexOf(version)
    if (index > 0) add(`${teamName(model, version.side)} changed their tactic ${when(version.tick)}`, version.tick)
  }
  for (const [playerId, appearance] of model.appearances) {
    if (!inside(appearance.onTick)) continue
    add(`${teamName(model, appearance.team)} sub: ${playerName(model, playerId) ?? "?"} on ${when(appearance.onTick!)}`, appearance.onTick!)
  }
  return found.sort((left, right) => left.tick - right.tick).map((entry) => entry.note)
}

export type ChangeImpact = ReturnType<typeof changeImpacts>[number]

/** Before/after for every tactical change the given sides made. */
export function changeImpacts(model: MatchModel, sides: readonly Side[]) {
  const context = new PhaseContext(model)
  const lastIndex = model.buckets.length - 1
  const results = []
  for (const side of sides) {
    const versions = model.tacticVersions.filter((version) => version.side === side)
    for (let index = 1; index < versions.length; index++) {
      const changed = describeTacticChange(versions[index - 1].config, versions[index].config)
      if (changed.length === 0) continue
      const tick = versions[index].tick
      const at = bucketIndexAt(model, tick)
      // Before: back to the previous change (or kickoff), at most 15 minutes.
      const previousAt = index > 1 ? bucketIndexAt(model, versions[index - 1].tick) : 0
      const beforeFirst = Math.max(previousAt, at - CHANGE_WINDOW_MINUTES)
      // After: up to the next change (or now), at most 15 minutes.
      const nextAt = index + 1 < versions.length ? bucketIndexAt(model, versions[index + 1].tick) - 1 : lastIndex
      const afterLast = Math.min(nextAt, at + CHANGE_WINDOW_MINUTES - 1, lastIndex)
      const before = at - beforeFirst >= MIN_BEFORE_MINUTES ? model.selectIndices(beforeFirst, at - 1, "before the change") : undefined
      const after = afterLast >= at ? model.selectIndices(at, afterLast, "after the change") : undefined
      const minute = eventTime(model, tick).minute
      const scoreBefore = at > 0 ? model.selectIndices(0, at - 1, "to the change") : undefined
      const score = scoreBefore
        ? `${teamName(model, "home")} ${teamDiff(scoreBefore, "home", "goals")}-${teamDiff(scoreBefore, "away", "goals")} ${teamName(model, "away")}`
        : undefined
      const base = { team: sideLabel(model, side), minute, changed, scoreAtChange: score }
      if (!before || !after) {
        results.push({
          ...base,
          before: span(model, before),
          after: span(model, after),
          verdict: !before ? "too soon after kickoff or the previous change to compare" : "no play captured since the change yet",
        })
        continue
      }
      const beforePhases = windowPhases(context, before)
      const afterPhases = windowPhases(context, after)
      const figures: Record<string, { before?: number; after?: number }> = {}
      const better: string[] = []
      const worse: string[] = []
      const moved: string[] = []
      for (const metric of METRICS) {
        const was = metric.value(beforePhases, side)
        const now = metric.value(afterPhases, side)
        figures[metric.label] = { before: was == null ? undefined : round(was, 2), after: now == null ? undefined : round(now, 2) }
        const counts = metric.count ? ([metric.count(beforePhases, side), metric.count(afterPhases, side)] as [number, number]) : undefined
        const result = shift(metric, was, now, counts)
        if (!result) continue
        ;(result.verdict === "better" ? better : result.verdict === "worse" ? worse : moved).push(result.text)
      }
      const tooEarly = after.buckets.length < MIN_JUDGE_MINUTES
      const also = alsoHappened(model, side, before.buckets[0].startTick, after.buckets.at(-1)!.endTick, tick)
      results.push({
        ...base,
        before: span(model, before),
        after: span(model, after),
        tooEarly: tooEarly ? `only ${after.buckets.length} minutes since the change: figures shown, too early to judge` : undefined,
        better,
        worse,
        moved,
        alsoHappened: also.length > 0 ? also : undefined,
        figures,
      })
    }
  }
  return results
}

/** The tool's reply. */
export function changesReport(model: MatchModel, sides: readonly Side[], note?: string) {
  const changes = changeImpacts(model, sides)
  const result: Record<string, unknown> = {}
  if (note) result.note = note
  if (changes.length === 0) {
    result.changes = []
    result.summary = model.tacticVersions.length === 0 ? "The tactic was not captured for this match, so changes cannot be tracked." : "No tactical changes during the match so far."
    return result
  }
  result.changes = changes
  result.legend =
    `Each change compares up to ${CHANGE_WINDOW_MINUTES} minutes before it (back to the previous change at most) with up to ${CHANGE_WINDOW_MINUTES} minutes after it (up to the next change). ` +
    "Rates are per 10 match minutes, from the changing team's side: 'conceded' figures are what it allowed. better/worse/moved list only shifts big enough to mention. " +
    "alsoHappened lists goals, red cards, substitutions and the other side's changes in either stretch; any of them can move the numbers as much as the tactic did, " +
    "and a team that scores usually sits deeper and sees less of the ball. A few minutes of play is noisy: treat short stretches as a hint, not a verdict."
  return result
}

/** For the briefing: the user's latest change, compactly. */
export function latestChange(model: MatchModel, side: Side) {
  const latest = changeImpacts(model, [side]).at(-1)
  if (!latest) return undefined
  const { figures: _figures, ...rest } = latest as typeof latest & { figures?: unknown }
  return rest
}
