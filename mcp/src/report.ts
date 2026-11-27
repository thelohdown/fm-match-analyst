// build_report: the printed reports a manager gets from the analysts. Every
// number on the page is worked out here from the match itself (the same figures
// the other tools return); the analyst writes only the lines that need judgement
// (the verdict or the half-time decisions, and the plan checks), within lengths
// that fit the page. reportPage.ts draws it; the page is saved as one HTML file
// in the data folder, ready to open in a browser and print or save as PDF.

import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import type { MatchMomentumPoint, TacticalEventPoint, XgShotPoint } from "@/types/match"

import { minuteLabel } from "./clock"
import { dataFolder } from "./feedback"
import { type CachedMatch, type CarryArea, checkActions, type MatchMetrics, type MetricKey, METRICS, type SavedActions, teamMetrics, trendRows } from "./metrics"
import { type MatchModel, other, type Side, type WindowSelection } from "./model"
import { PhaseContext } from "./phases"
import { windowPhases, type WindowPhases } from "./phaseViews"
import {
  halfTimeHtml,
  type HalfTimePage,
  type MomentRow,
  type MomentumBlock,
  type PageHeader,
  type PassLink,
  type PitchPlayer,
  type PlanRow,
  type MeaningPage,
  type PlayerLine,
  postMatchHtml,
  type PostMatchPage,
  type ShotPoint,
} from "./reportPage"
import * as views from "./views"

/** Lengths that fit the page; the tool's input schema enforces them. */
export const LIMITS = {
  verdictTitle: 40,
  verdictDetail: 95,
  planLabel: 32,
  planEvidence: 46,
  flowLabel: 26,
  decisionTitle: 34,
  decisionEvidence: 120,
  decisionOption: 80,
  watchLabel: 38,
  watchEvidence: 95,
  personWhy: 44,
  personBench: 48,
  headline: 110,
  takeawayTitle: 32,
  takeawayHappened: 88,
  takeawayWhy: 88,
  takeawayAction: 120,
  carryAction: 64,
  outlookWhy: 48,
} as const

export type ReportKind = "post_match" | "half_time"

export type ReportInput = {
  verdict?: Array<{ title: string; detail: string }>
  decisions?: Array<{ title: string; evidence: string; option: string }>
  our_plan?: Array<{ instruction: string; status: "seen" | "not_seen"; evidence: string }>
  their_plan?: Array<{ label: string; status?: "hurt" | "contained"; evidence: string }>
  flow_events?: Array<{ minute: number; label: string }>
  players?: Array<{ name: string; status: "watch" | "keep"; why: string; bench?: string }>
  /** post_match page 1: what this means for us. */
  headline?: string
  takeaways?: Array<{ tag: "keep" | "fix" | "try"; title: string; happened: string; why: string; action: string; metric?: MetricKey }>
  carry_forward?: Array<{ area: CarryArea; action: string; check_metric?: MetricKey; check_target?: "up" | "down" }>
  outlook?: Array<{ name: string; outlook: "rest" | "start" | "watch" | "form"; why: string }>
}

/** What the post-match report adds from other matches: the trend and the last actions saved. */
export type PostMatchExtras = { previous?: CachedMatch[]; lastTime?: SavedActions }

/** Condition at or below this is flagged on the post-match player table. */
const CONDITION_FLAG = 70

type Built = { html: string; title: string; notes: string[] }

export function missingInputs(kind: ReportKind, input: ReportInput): string[] {
  const missing: string[] = []
  if (kind === "post_match") {
    if (!input.headline) missing.push("headline (one line: the result against the performance, and what it means)")
    if (input.takeaways?.length !== 3) missing.push("takeaways (exactly 3, each tagged keep, fix or try, with what happened, why, and the action for the next match)")
    if (!input.carry_forward?.length) missing.push("carry_forward (1-5 actions for the next match, each with its area)")
    if (!input.their_plan?.length) missing.push("their_plan (1-4 rows, each with status hurt or contained)")
    else if (input.their_plan.some((row) => !row.status)) missing.push("a status (hurt or contained) on every their_plan row")
  } else {
    if (!input.decisions?.length) missing.push("decisions (up to 3)")
    if (!input.their_plan?.length) missing.push("their_plan (1-4 things the opponent is doing)")
    if (!input.players?.length) missing.push("players (up to 5: watch or keep)")
  }
  if (!input.our_plan?.length) missing.push("our_plan (1-4 rows)")
  return missing
}

/** Lines too long for the page they are going on (the post-match plan rows are narrower than the half-time list). */
export function lengthProblems(kind: ReportKind, input: ReportInput): string[] {
  const problems: string[] = []
  const check = (what: string, value: string | undefined, limit: number) => {
    if (value && value.length > limit) problems.push(`${what} is ${value.length} characters; it fits ${limit}`)
  }
  check("headline", input.headline, LIMITS.headline)
  input.takeaways?.forEach((row, index) => {
    check(`takeaways[${index}].title`, row.title, LIMITS.takeawayTitle)
    check(`takeaways[${index}].happened`, row.happened, LIMITS.takeawayHappened)
    check(`takeaways[${index}].why`, row.why, LIMITS.takeawayWhy)
    check(`takeaways[${index}].action`, row.action, LIMITS.takeawayAction)
  })
  input.carry_forward?.forEach((row, index) => check(`carry_forward[${index}].action`, row.action, LIMITS.carryAction))
  input.outlook?.forEach((row, index) => check(`outlook[${index}].why`, row.why, LIMITS.outlookWhy))
  input.their_plan?.forEach((row, index) => {
    const labelLimit = kind === "post_match" ? LIMITS.planLabel : LIMITS.watchLabel
    const evidenceLimit = kind === "post_match" ? LIMITS.planEvidence : LIMITS.watchEvidence
    check(`their_plan[${index}].label`, row.label, labelLimit)
    check(`their_plan[${index}].evidence`, row.evidence, evidenceLimit)
  })
  return problems
}

// ---------------------------------------------------------------------------
// Shared helpers

function sidesOf(model: MatchModel): { you: Side; them: Side; notes: string[] } {
  const user = model.userSide()
  if (user) return { you: user, them: other(user), notes: [] }
  return {
    you: "home",
    them: "away",
    notes: [`Could not tell which team you manage, so the report treats ${views.teamName(model, "home")} (home) as yours.`],
  }
}

/** Minutes on a single time axis: first-half stoppage folds onto 45, the second half runs on from 45. */
function chartMinute(model: MatchModel, tick: number): number {
  const { period, seconds } = model.clockAtTick(tick)
  const minute = seconds / 60
  return period === 1 ? Math.min(minute, 45) : Math.max(45, minute)
}

function shotPoints(model: MatchModel, side: Side, range?: { from: number; to: number }): ShotPoint[] {
  return (model.history().xgShots as readonly XgShotPoint[])
    .filter((shot) => shot.team === side && (!range || (shot.tick >= range.from && shot.tick <= range.to)))
    .map((shot) => ({ minute: chartMinute(model, shot.tick), xg: shot.xg, goal: shot.metricId === "goals", ...views.shotMetres(model, shot) }))
}

function momentumBlocks(model: MatchModel, you: Side, upTo = Number.POSITIVE_INFINITY): MomentumBlock[] {
  const sign = you === "home" ? 1 : -1
  const points = model.history().momentum as readonly MatchMomentumPoint[]
  const blocks: MomentumBlock[] = []
  let from = 0
  for (const point of points) {
    if (point.minute > upTo + 0.5) break
    blocks.push({ from, to: point.minute, value: sign * point.value })
    from = point.minute
  }
  return blocks
}

const capital = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text)
const pctText = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–")
const xgText = (value: number) => value.toFixed(2)

function formatDate(date: string | undefined): string | undefined {
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null
  if (!match) return date
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`
}

type TacticLine = { name?: string; formation?: string; mentality?: string; changes?: Array<{ minute: string; changed: string[] }> }

function tacticLines(model: MatchModel): Partial<Record<Side, TacticLine>> {
  const result = views.tactic(model, "both") as Record<string, unknown>
  if (!result.available) return {}
  const lines: Partial<Record<Side, TacticLine>> = {}
  for (const side of ["home", "away"] as const) {
    const team = result[views.sideLabel(model, side)] as Record<string, any> | undefined
    if (!team?.inPossession) continue
    lines[side] = { name: team.tacticName, formation: team.inPossession.formation, mentality: team.mentality, changes: team.changes }
  }
  return lines
}

/** "Cautious from 74'" when the mentality changed (by `upToMinute`, if given), else the mentality. */
function mentalityText(line: TacticLine | undefined, upToMinute = Number.POSITIVE_INFINITY): string | undefined {
  if (!line) return undefined
  const changes = (line.changes ?? []).filter((change) => minuteValue(change.minute) <= upToMinute)
  for (const change of [...changes].reverse()) {
    const mentality = change.changed.find((item) => item.startsWith("mentality "))
    if (mentality) {
      const to = mentality.split("-> ")[1]
      return to ? `${capital(to)} from ${change.minute}` : undefined
    }
  }
  if (upToMinute !== Number.POSITIVE_INFINITY && (line.changes ?? []).some((change) => change.changed.some((item) => item.startsWith("mentality ")))) {
    // Changed later in the match: the mentality at this point is where the first later change started from.
    const later = (line.changes ?? []).find((change) => change.changed.some((item) => item.startsWith("mentality ")))!
    const from = later.changed.find((item) => item.startsWith("mentality "))!.replace("mentality ", "").split(" ->")[0]
    return capital(from)
  }
  return line.mentality ? capital(line.mentality) : undefined
}

function minuteValue(label: string): number {
  const match = /^(\d+)(?:\+(\d+))?/.exec(label)
  return match ? Number(match[1]) + (match[2] ? Number(match[2]) / 100 : 0) : 0
}

function header(
  model: MatchModel,
  sides: { you: Side; them: Side },
  options: { kicker: string; status: string; goals: Record<Side, number>; xg: Record<Side, number>; untilTick?: number; untilMinute?: number }
): PageHeader {
  const history = model.history()
  // One entry per scorer, in the order they first scored: "Lewandowski 25', 37'".
  const scorers = (side: Side) => {
    const goals = new Map<string, string[]>()
    for (const event of history.events) {
      if (event.type !== "goal" && event.type !== "own_goal") continue
      if (event.tick == null || event.team !== side || (options.untilTick != null && event.tick > options.untilTick)) continue
      const name = `${surname(views.playerName(model, event.playerId) ?? "Goal")}${event.type === "own_goal" ? " (og)" : ""}`
      goals.set(name, [...(goals.get(name) ?? []), views.eventTime(model, event.tick).minute])
    }
    return [...goals].map(([name, minutes]) => `${name} ${minutes.join(", ")}`).join(" · ")
  }
  const cards = history.events
    .filter((event) => (event.type === "yellow_card" || event.type === "red_card") && event.team === sides.you && event.tick != null)
    .filter((event) => options.untilTick == null || event.tick! <= options.untilTick)
    .map((event) => `${surname(views.playerName(model, event.playerId) ?? "?")} ${views.eventTime(model, event.tick!).minute}${event.type === "red_card" ? " (red)" : ""}`)
  const tactics = tacticLines(model)
  const right: PageHeader["right"] = []
  const you = tactics[sides.you]
  const them = tactics[sides.them]
  if (you) right.push({ team: views.teamName(model, sides.you), text: [you.name, you.formation, mentalityText(you, options.untilMinute)].filter(Boolean).join(" · ") })
  if (them) right.push({ team: views.teamName(model, sides.them), text: [them.formation, mentalityText(them, options.untilMinute)].filter(Boolean).join(" · ") })
  if (!you && !them) right.push({ text: "Tactics were not captured for this match" })
  right.push({ text: cards.length > 0 ? `Booked: ${cards.join(", ")}` : "No bookings for us" })
  const competition = model.metadata?.competition?.name
  const date = formatDate(model.metadata?.matchDate)
  const venue = sides.you === "home" ? "at home" : "away"
  return {
    kicker: options.kicker,
    title: [competition, date].filter(Boolean).join(" · ") || "Match report",
    subtitle: `${views.teamName(model, sides.you)} ${venue} · ${options.status} · FMMatchLens`,
    you: { name: views.teamName(model, sides.you), goals: options.goals[sides.you], xg: options.xg[sides.you], scorers: scorers(sides.you) },
    them: { name: views.teamName(model, sides.them), goals: options.goals[sides.them], xg: options.xg[sides.them], scorers: scorers(sides.them) },
    right,
    kits: { you: model.metadata?.[sides.you], them: model.metadata?.[sides.them] },
  }
}

function surname(name: string): string {
  const parts = name.trim().split(/\s+/)
  return parts.length > 1 ? parts.slice(1).join(" ") : name
}

const planRows = (input: ReportInput["our_plan"]): PlanRow[] =>
  (input ?? []).slice(0, 4).map((row) => ({ label: row.instruction, status: row.status, evidence: row.evidence }))
const theirRows = (input: ReportInput["their_plan"]): PlanRow[] =>
  (input ?? []).slice(0, 4).map((row) => ({ label: row.label, status: row.status, evidence: row.evidence }))

/** The last regulation minute played: 120 if extra time was really played, else 90. */
function lastRegulationMinute(model: MatchModel): number {
  return model.buckets.filter((bucket) => bucket.period >= 3).length >= 10 ? 120 : 90
}

// ---------------------------------------------------------------------------
// Post-match one-pager

function momentRows(window: WindowPhases, you: Side, them: Side): PostMatchPage["moments"] {
  const both = (pick: (side: Side) => string, label: string): MomentRow => ({ label, you: pick(you), them: pick(them) })
  const t = window.teams
  const c = window.counters
  return [
    {
      group: "In possession",
      rows: [
        both((side) => (c[side].possessionPct != null ? `${c[side].possessionPct}%` : "–"), "Possession"),
        both((side) => pctText(t[side].inPossession.reachedFinalThird, t[side].inPossession.possessions), "Possessions into final third"),
        both((side) => pctText(t[side].inPossession.reachedBox, t[side].inPossession.possessions), "Possessions into the box"),
        both((side) => `${c[side].shots} · ${xgText(c[side].xg)}`, "Shots · xG"),
        both((side) => (t[side].inPossession.shotsFromOutsideBoxPct != null ? `${t[side].inPossession.shotsFromOutsideBoxPct}%` : "–"), "Shots from outside the box"),
      ],
    },
    {
      group: "Out of possession",
      rows: [
        both((side) => (t[side].outOfPossession.ppda != null ? String(t[side].outOfPossession.ppda) : "–"), "PPDA (lower = more pressing)"),
        both((side) => String(t[side].outOfPossession.highRegains), "High regains"),
        both((side) => String(t[side].outOfPossession.opponentBoxEntries), "Box entries conceded"),
        both((side) => pctText(c[side].aerials.won, c[side].aerials.attempted), "Aerials won"),
      ],
    },
    {
      group: "Transitions",
      rows: [
        both((side) => String(t[side].attackingTransition.counters), "Fast breaks"),
        both((side) => {
          const shots = t[side].attackingTransition.shots
          return shots.shots > 0 ? `${shots.shots} · ${xgText(shots.xg)}` : "0"
        }, "Shots ≤15 s after a regain"),
        both((side) => pctText(t[side].defensiveTransition.regainedWithin5s, t[side].defensiveTransition.openPlayLosses), "Won back ≤5 s after a loss"),
      ],
    },
    {
      group: "Set pieces",
      rows: [
        both((side) => String(t[side].setPieces.corners), "Corners"),
        both((side) => String(t[side].setPieces.shots.shots), "Shots from set pieces"),
      ],
    },
  ]
}

function shapeData(model: MatchModel, selection: WindowSelection, you: Side): PostMatchPage["shape"] {
  const positions = views.averagePositions(model, selection.buckets)
  const meta = new Map((model.metadata?.players ?? []).map((player) => [player.playerId, player]))
  const players: Array<PitchPlayer & { playerId: number }> = []
  for (const entry of positions.values()) {
    if (entry.side !== you || !entry.inPossession || entry.samples.in + entry.samples.out < 300) continue
    const minutes = (entry.samples.in + entry.samples.out) / 60
    const info = meta.get(entry.playerId)
    players.push({
      playerId: entry.playerId,
      number: String(info?.shirtNumber ?? info?.squadNumber ?? ""),
      depth: entry.inPossession.depth,
      width: entry.inPossession.width,
      light: minutes < 60,
    })
  }
  if (players.length === 0) return undefined
  const index = new Map(players.map((player, position) => [player.playerId, position]))
  const range = views.tickRange(selection)
  const pairs = new Map<string, number>()
  for (const event of model.history().tacticalEvents as readonly TacticalEventPoint[]) {
    if (event.team !== you || event.metricId !== "passesCompleted" || !event.receiverPlayerId) continue
    if (event.tick < range.from || event.tick > range.to) continue
    const a = index.get(event.playerId)
    const b = index.get(event.receiverPlayerId)
    if (a == null || b == null || a === b) continue
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    pairs.set(key, (pairs.get(key) ?? 0) + 1)
  }
  const sorted = [...pairs.entries()].sort((left, right) => right[1] - left[1])
  // Pairs with 10 or more passes between them (both ways), at most 8, and at least the top 4.
  const chosen = sorted.filter(([, count], position) => position < 4 || count >= 10).slice(0, 8)
  const links: PassLink[] = chosen.map(([key, passes]) => {
    const [a, b] = key.split("-").map(Number)
    return { a, b, passes }
  })
  return { players: players.map(({ playerId: _id, ...player }) => player), links }
}

function playerLines(model: MatchModel, you: Side): PlayerLine[] {
  const label = views.sideLabel(model, you)
  const whole = (views.players(model, you, {}, false) as Record<string, any>)[label] as Array<Record<string, any>> | undefined
  // Condition at the final whistle: a full-time read includes FM's recovery once play stops.
  const atWhistle = (views.players(model, you, { toMinute: lastRegulationMinute(model) }, false) as Record<string, any>)[label] as Array<Record<string, any>> | undefined
  const condition = new Map((atWhistle ?? []).map((row) => [row.name, row.condition as number | undefined]))
  const rows = (whole ?? []).map((row) => {
    const keeper = /^GK\b/.test(String(row.role ?? "")) || String(row.zone ?? "").startsWith("goalkeeper") || row.naturalPositions === "GK"
    // The players view leaves out zero counts; a blank is 0 for outfielders and not applicable for keepers.
    const stat = (value: unknown) => (typeof value === "number" ? value : keeper ? undefined : 0)
    return {
      started: String(row.status).startsWith("started"),
      line: {
        number: String(row.number ?? ""),
        name: surname(String(row.name)),
        minutes: Number(row.minutesPlayed ?? 0),
        rating: Number(row.rating ?? 0),
        xg: stat(row.xg),
        xa: stat(row.xa),
        km: Number(row.distanceKm ?? 0),
        condition: condition.get(row.name) ?? (row.condition as number | undefined),
      } satisfies PlayerLine,
    }
  })
  const starters = rows.filter((row) => row.started)
  const subs = rows.filter((row) => !row.started).sort((left, right) => right.line.minutes - left.line.minutes)
  // 13 rows fit under the pitch: the starters and the substitutes who played longest.
  return [...starters, ...subs].slice(0, 13).map((row) => row.line)
}

export function buildPostMatch(model: MatchModel, source: views.SourceInfo, input: ReportInput, extras: PostMatchExtras = {}): Built & { metrics: MatchMetrics; side: Side } {
  const selection = model.select({})
  if (!selection) throw new Error("No match data yet.")
  const { you, them, notes } = sidesOf(model)
  const context = new PhaseContext(model)
  const whole = windowPhases(context, selection)
  const state = views.matchState(model, source)
  const finished = state.status === "full time"
  if (!finished) notes.push(`The match is not over (${state.minute}); the report covers it so far.`)
  const goals = { home: state.home.goals, away: state.away.goals }
  const xg = { home: state.home.xg, away: state.away.xg }
  const lastTick = selection.buckets.at(-1)!.endTick
  const maxMinute = Math.max(90, Math.ceil(chartMinute(model, lastTick)))
  const tactics = tacticLines(model)
  const page: PostMatchPage = {
    header: header(model, { you, them }, { kicker: "Post-match report", status: finished ? "Full time" : `data to ${state.minute}`, goals, xg }),
    verdict: (input.verdict?.length ? input.verdict : (input.takeaways ?? []).map((row) => ({ title: row.title, detail: row.happened }))).slice(0, 3),
    flow: {
      maxMinute,
      you: shotPoints(model, you),
      them: shotPoints(model, them),
      totals: { you: xg[you], them: xg[them] },
      momentum: momentumBlocks(model, you),
      events: (input.flow_events ?? []).slice(0, 3),
    },
    shots: { you: shotPoints(model, you), them: shotPoints(model, them) },
    moments: momentRows(whole, you, them),
    ourPlan: planRows(input.our_plan),
    theirPlan: theirRows(input.their_plan),
    tacticName: tactics[you]?.name,
    shape: shapeData(model, selection, you),
    players: playerLines(model, you),
    conditionFlag: CONDITION_FLAG,
  }
  const metrics = teamMetrics(model, you, context)
  const meaning = input.takeaways?.length ? meaningPage(model, input, you, metrics, extras, page.header) : undefined
  const title = `${page.header.you.name} ${page.header.you.goals}-${page.header.them.goals} ${page.header.them.name}`
  return { html: postMatchHtml(page, meaning), title, notes, metrics, side: you }
}

/** Figures shown in the trend strip when the takeaways do not name enough of their own. */
const DEFAULT_TREND: MetricKey[] = ["xg_for", "xg_against", "box_entries_against", "fast_breaks_against", "won_back_5s_pct", "lost_in_own_third"]

function meaningPage(model: MatchModel, input: ReportInput, you: Side, metrics: MatchMetrics, extras: PostMatchExtras, head: PageHeader): MeaningPage {
  const previous = extras.previous ?? []
  const lastTime = extras.lastTime ? checkActions(extras.lastTime, metrics) : undefined
  const named = (input.takeaways ?? []).map((row) => row.metric).filter((key): key is MetricKey => Boolean(key))
  const keys = [...new Set([...named, ...DEFAULT_TREND])].slice(0, lastTime ? 5 : 6)
  const rows = trendRows(keys, metrics, previous)
  const byKey = new Map(rows.map((row) => [row.key, row]))
  // Rating and condition at the whistle, for the players the outlook names.
  const atWhistle = model.select({ toMinute: lastRegulationMinute(model) })?.end ?? model.endState()
  const outlook = (input.outlook ?? []).slice(0, 5).map((row) => {
    const found = findPlayer(model, you, row.name)
    const state = found ? atWhistle?.players.get(found.playerId) : undefined
    const roles = found ? views.playerRoles(model, found.playerId) : undefined
    return {
      name: found ? surname(views.playerName(model, found.playerId) ?? row.name) : row.name,
      position: roles?.inPossession?.position ?? found?.position,
      outlook: row.outlook,
      why: row.why,
      rating: state?.rating ? Math.round(state.rating * 10) / 10 : undefined,
      condition: state?.condition ? Math.round(state.condition) : undefined,
    }
  })
  return {
    header: { ...head, kicker: "Post-match · what it means" },
    headline: input.headline ?? "",
    takeaways: (input.takeaways ?? []).slice(0, 3).map((row) => ({
      tag: row.tag,
      title: row.title,
      happened: row.happened,
      why: row.why,
      action: row.action,
      trend: row.metric ? byKey.get(row.metric) : undefined,
    })),
    carry: (input.carry_forward ?? []).slice(0, 5).map((row) => ({
      area: row.area,
      action: row.action,
      check: row.check_metric ? `${METRICS[row.check_metric].label} ${(row.check_target ?? (METRICS[row.check_metric].better === "up" ? "up" : "down")) === "up" ? "\u25b2" : "\u25bc"}` : undefined,
    })),
    trend: {
      rows,
      matches: previous.length,
      against: previous.length > 0 ? `last ${previous.length === 1 ? "match" : `${previous.length} matches`}` : undefined,
      note:
        previous.length === 0
          ? `First match on record for ${views.teamName(model, you)}: from the next one, each figure is set against your last five.`
          : undefined,
    },
    outlook,
    lastTime,
  }
}

// ---------------------------------------------------------------------------
// Half-time sheet

function normalise(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
}

function findPlayer(model: MatchModel, side: Side, wanted: string) {
  const target = normalise(wanted)
  const squad = (model.metadata?.players ?? []).filter((player) => player.team === side)
  const names = (player: (typeof squad)[number]) =>
    [player.displayName, player.shirtName, player.commonName, player.secondName, [player.firstName, player.secondName].filter(Boolean).join(" ")]
      .filter((name): name is string => Boolean(name))
      .map(normalise)
  return (
    squad.find((player) => names(player).includes(target)) ??
    squad.find((player) => names(player).some((name) => name.endsWith(` ${target}`) || name.split(/\s+/).includes(target)))
  )
}

export function buildHalfTime(model: MatchModel, source: views.SourceInfo, input: ReportInput): Built {
  const half = model.select({ half: "first" })
  if (!half) throw new Error("No first-half data yet.")
  const { you, them, notes } = sidesOf(model)
  const context = new PhaseContext(model)
  const lastBucket = half.buckets.at(-1)!
  const halfOver = model.buckets.some((bucket) => bucket.period >= 2)
  const untilTick = lastBucket.endTick
  const atLabel = minuteLabel(Math.max(0, lastBucket.endSeconds - 1), 1)
  if (!halfOver) notes.push(`The first half is still going (${atLabel}); the sheet covers it so far.`)
  const goals = { home: views.teamDiff(half, "home", "goals"), away: views.teamDiff(half, "away", "goals") }
  const xg = { home: Math.round(views.teamDiff(half, "home", "xg") * 100) / 100, away: Math.round(views.teamDiff(half, "away", "xg") * 100) / 100 }

  const earlierSel = model.select({ fromMinute: 0, toMinute: 30 })
  const laterSel = model.select({ fromMinute: 31, toMinute: 45 })
  const wholeHalf = windowPhases(context, half)
  const earlier = earlierSel ? windowPhases(context, earlierSel) : undefined
  const later = laterSel ? windowPhases(context, laterSel) : undefined
  const entries = wholeHalf.teams[you].outOfPossession.opponentEntries
  const flank: "ourLeft" | "ourRight" = entries.ourLeft >= entries.ourRight ? "ourLeft" : "ourRight"
  const cell = (window: WindowPhases | undefined, pick: (window: WindowPhases) => string) => (window ? pick(window) : "–")
  const row = (label: string, pick: (window: WindowPhases) => string) => ({ label, earlier: cell(earlier, pick), later: cell(later, pick) })
  const themName = views.teamName(model, them)
  const turnRows = [
    row("Possession", (w) => (w.counters[you].possessionPct != null ? `${w.counters[you].possessionPct}%` : "–")),
    row("Possessions into the box", (w) => `${w.teams[you].inPossession.reachedBox} of ${w.teams[you].inPossession.possessions}`),
    row("Shots · xG", (w) => `${w.counters[you].shots} · ${xgText(w.counters[you].xg)}`),
    row("Our PPDA", (w) => (w.teams[you].outOfPossession.ppda != null ? String(w.teams[you].outOfPossession.ppda) : "–")),
    row("Our high regains", (w) => String(w.teams[you].outOfPossession.highRegains)),
    row(`${themName} entries down our ${flank === "ourLeft" ? "left" : "right"}`, (w) => String(w.teams[you].outOfPossession.opponentEntries[flank])),
  ]

  const setPieces = wholeHalf.teams[you].setPieces
  const setShots = setPieces.shots.shots
  const setPieceText =
    `<b>Set pieces</b> ${setPieces.corners} corner${setPieces.corners === 1 ? "" : "s"} and ${setPieces.freeKicksWonInFinalThird} free kick${setPieces.freeKicksWonInFinalThird === 1 ? "" : "s"} in their third, ` +
    (setShots > 0 ? `${setShots} shot${setShots === 1 ? "" : "s"} (${xgText(setPieces.shots.xg)} xG).` : "no shot.")

  // Ratings at the break, condition read at 45' (it jumps once the half-time whistle goes).
  const atBreak = model.select({ toMinute: 45 })
  const people: HalfTimePage["people"] = []
  const unknown: string[] = []
  for (const person of (input.players ?? []).slice(0, 5)) {
    const player = findPlayer(model, you, person.name)
    if (!player) {
      unknown.push(person.name)
      continue
    }
    const state = atBreak?.end.players.get(player.playerId)
    const position = views.playerRoles(model, player.playerId)?.inPossession?.position ?? player.position ?? undefined
    people.push({
      status: person.status,
      name: surname(player.displayName ?? person.name),
      position: position ? String(position) : undefined,
      rating: state && state.rating > 0 ? state.rating : undefined,
      condition: state && state.condition > 0 ? state.condition : undefined,
      why: person.why,
      bench: person.bench,
    })
  }
  if (unknown.length > 0) {
    const squad = (model.metadata?.players ?? []).filter((player) => player.team === you).map((player) => player.displayName).filter(Boolean)
    throw new Error(`No player called ${unknown.map((name) => `"${name}"`).join(", ")} in your squad. Use names as get_players gives them: ${squad.join(", ")}.`)
  }

  const tactics = tacticLines(model)
  const page: HalfTimePage = {
    header: header(model, { you, them }, { kicker: "Half-time report", status: `data to ${atLabel}`, goals, xg, untilTick, untilMinute: 45.99 }),
    decisions: (input.decisions ?? []).slice(0, 3),
    turn: {
      earlierLabel: "0–30'",
      laterLabel: halfOver ? "31'–HT" : "31'–now",
      rows: turnRows,
      momentum: momentumBlocks(model, you, 45),
      halfEnd: 45,
    },
    theirPlan: theirRows(input.their_plan),
    ourPlan: planRows(input.our_plan),
    tacticName: tactics[you]?.name,
    setPieces: setPieceText,
    people,
  }
  const title = `${page.header.you.name} ${page.header.you.goals}-${page.header.them.goals} ${page.header.them.name} at half-time`
  return { html: halfTimeHtml(page), title, notes }
}

// ---------------------------------------------------------------------------
// Saving

export async function saveReport(model: MatchModel, kind: ReportKind, html: string): Promise<string> {
  const folder = join(dataFolder(), "reports")
  await mkdir(folder, { recursive: true })
  const slug = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")
  // The date and team names come from the archive, which may not be ours: only a
  // YYYY-MM-DD date and slugged names reach the file name, and the result must stay in the folder.
  const recorded = /^\d{4}-\d{2}-\d{2}/.exec(model.metadata?.matchDate ?? "")?.[0]
  const date = recorded ?? new Date().toISOString().slice(0, 10)
  const name = `${date}-${slug(views.teamName(model, "home")) || "home"}-v-${slug(views.teamName(model, "away")) || "away"}-${kind === "post_match" ? "post-match" : "half-time"}.html`
  const file = join(folder, name)
  if (!resolve(file).startsWith(resolve(folder) + sep)) throw new Error("Refusing to save a report outside the reports folder.")
  await writeFile(file, html, "utf8")
  return file
}
