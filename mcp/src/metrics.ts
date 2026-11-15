// Team figures for one match, so matches can be compared: the post-match report's
// "new or a trend?" strip (this match against the last five saved), and the
// carry-forward actions a report saves, checked at the next match ("last time we
// said: stop their counters; this match: 1 fast break against, down from 5").
// Figures for saved matches are cached in the data folder, keyed by archive.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { dataFolder } from "./feedback"
import { type MatchModel, other, type Side } from "./model"
import { PhaseContext } from "./phases"
import { windowPhases } from "./phaseViews"
import { type ArchiveEntry, listArchives, readArchive } from "./sources"
import { teamName } from "./views"

export const METRIC_KEYS = [
  "xg_for",
  "xg_against",
  "shots_for",
  "shots_against",
  "box_entries_for",
  "box_entries_against",
  "fast_breaks_for",
  "fast_breaks_against",
  "lost_in_own_third",
  "won_back_5s_pct",
  "ppda",
  "high_regains",
  "possession_pct",
  "set_piece_shots_against",
  "aerials_won_pct",
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

type MetricInfo = { label: string; better: "up" | "down" | "neither"; digits: number; unit?: string }
export const METRICS: Record<MetricKey, MetricInfo> = {
  xg_for: { label: "xG for", better: "up", digits: 2 },
  xg_against: { label: "xG against", better: "down", digits: 2 },
  shots_for: { label: "Shots", better: "up", digits: 0 },
  shots_against: { label: "Shots against", better: "down", digits: 0 },
  box_entries_for: { label: "Box entries", better: "up", digits: 0 },
  box_entries_against: { label: "Box entries against", better: "down", digits: 0 },
  fast_breaks_for: { label: "Fast breaks", better: "up", digits: 0 },
  fast_breaks_against: { label: "Fast breaks against", better: "down", digits: 0 },
  lost_in_own_third: { label: "Lost in own third", better: "down", digits: 0 },
  won_back_5s_pct: { label: "Won back in 5 s", better: "up", digits: 0, unit: "%" },
  ppda: { label: "PPDA", better: "down", digits: 1 },
  high_regains: { label: "High regains", better: "up", digits: 0 },
  possession_pct: { label: "Possession", better: "neither", digits: 0, unit: "%" },
  set_piece_shots_against: { label: "Set-piece shots against", better: "down", digits: 0 },
  aerials_won_pct: { label: "Aerials won", better: "up", digits: 0, unit: "%" },
}

export type MatchMetrics = Partial<Record<MetricKey, number>>

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : undefined)

/** One team's figures over a whole match. */
export function teamMetrics(model: MatchModel, side: Side, context = new PhaseContext(model)): MatchMetrics {
  const selection = model.select({})
  if (!selection) return {}
  const window = windowPhases(context, selection)
  const us = window.teams[side]
  const them = window.teams[other(side)]
  const c = window.counters
  return {
    xg_for: c[side].xg,
    xg_against: c[other(side)].xg,
    shots_for: c[side].shots,
    shots_against: c[other(side)].shots,
    box_entries_for: us.inPossession.boxEntries,
    box_entries_against: us.outOfPossession.opponentBoxEntries,
    fast_breaks_for: us.attackingTransition.counters,
    fast_breaks_against: us.defensiveTransition.opponentCounters,
    lost_in_own_third: us.defensiveTransition.lostInOwnThird,
    won_back_5s_pct: pct(us.defensiveTransition.regainedWithin5s, us.defensiveTransition.openPlayLosses),
    ppda: us.outOfPossession.ppda,
    high_regains: us.outOfPossession.highRegains,
    possession_pct: c[side].possessionPct,
    set_piece_shots_against: them.setPieces.shots.shots,
    aerials_won_pct: pct(c[side].aerials.won, c[side].aerials.attempted),
  }
}

// ---------------------------------------------------------------------------
// Saved matches

const norm = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "")

export type CachedMatch = { file: string; modified: string; matchId: string; date?: string; team: string; opponent: string; metrics: MatchMetrics }

/** One finished match: both teams' figures, from a live match at full time or a saved archive. */
type MatchRecord = {
  matchId: string
  date?: string
  home: string
  away: string
  metrics: Record<Side, MatchMetrics>
  /** The archive it was read from, when it was (so a changed file is read again). */
  file?: string
  modified?: string
}
type MetricsCache = { version: 2; matches: Record<string, MatchRecord> }

const cacheFile = () => join(dataFolder(), "match-metrics.json")
let memory: { folder: string; cache: MetricsCache } | undefined

async function readCache(): Promise<MetricsCache> {
  if (memory?.folder === dataFolder()) return memory.cache
  let cache: MetricsCache = { version: 2, matches: {} }
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), "utf8")) as Partial<MetricsCache>
    if (parsed.version === 2 && parsed.matches) cache = parsed as MetricsCache
  } catch {
    // No cache yet, or an older format: rebuilt as matches are read.
  }
  memory = { folder: dataFolder(), cache }
  return cache
}

async function writeCache(cache: MetricsCache) {
  await mkdir(dataFolder(), { recursive: true })
  await writeFile(cacheFile(), JSON.stringify(cache), "utf8")
}

/** The same key for a match whether it comes from the live model or an archive's file name. */
const matchKey = (date: string | undefined, home: string, away: string) => `${date ?? "?"}|${norm(home)}|${norm(away)}`
const entryKey = (entry: ArchiveEntry) => (entry.date && entry.home && entry.away ? matchKey(entry.date, entry.home, entry.away) : undefined)

function recordOf(model: MatchModel, entry?: ArchiveEntry): MatchRecord {
  return {
    matchId: model.matchId,
    date: model.metadata?.matchDate?.slice(0, 10) ?? entry?.date,
    home: teamName(model, "home"),
    away: teamName(model, "away"),
    metrics: { home: teamMetrics(model, "home"), away: teamMetrics(model, "away") },
    file: entry?.file,
    modified: entry?.modified,
  }
}

async function store(record: MatchRecord, entry?: ArchiveEntry) {
  const cache = await readCache()
  const key = (entry && entryKey(entry)) ?? matchKey(record.date, record.home, record.away)
  cache.matches[key] = record
  // Also under the model's own names, in case the file name spells them differently.
  const own = matchKey(record.date, record.home, record.away)
  if (own !== key) cache.matches[own] = record
  await writeCache(cache)
}

const remembered = new Set<string>()

/**
 * Keeps a finished match's figures, so later reports set figures against it without
 * reading its archive again (about 6 s each). Cheap to call repeatedly.
 */
export async function rememberMatch(model: MatchModel, entry?: ArchiveEntry): Promise<void> {
  const tag = `${model.matchId}|${entry?.modified ?? "live"}|${dataFolder()}`
  if (remembered.has(tag) || !model.metadata) return
  remembered.add(tag)
  const cache = await readCache()
  const key = entry ? entryKey(entry) : undefined
  if (key && cache.matches[key]?.modified === entry?.modified) return
  try {
    await store(recordOf(model, entry), entry)
  } catch {
    remembered.delete(tag)
  }
}

function asCached(record: MatchRecord, side: Side): CachedMatch {
  return {
    file: record.file ?? "",
    modified: record.modified ?? "",
    matchId: record.matchId,
    date: record.date,
    team: side === "home" ? record.home : record.away,
    opponent: side === "home" ? record.away : record.home,
    metrics: record.metrics[side],
  }
}

/** Archives not yet in the cache, newest first. */
async function unread(cache: MetricsCache, team?: string): Promise<ArchiveEntry[]> {
  const wanted = team ? norm(team) : undefined
  return (await listArchives()).filter((entry) => {
    if (wanted && entry.home && entry.away && norm(entry.home) !== wanted && norm(entry.away) !== wanted) return false
    const key = entryKey(entry)
    const known = key ? cache.matches[key] : undefined
    if (!known) return !Object.values(cache.matches).some((record) => record.file === entry.file && record.modified === entry.modified)
    return Boolean(known.file === entry.file && known.modified !== entry.modified)
  })
}

async function readInto(entry: ArchiveEntry): Promise<void> {
  let model: MatchModel
  try {
    model = await readArchive(entry)
  } catch {
    // Unreadable: remember the file so it is not tried every time.
    const cache = await readCache()
    cache.matches[`file|${entry.file}`] = { matchId: "", home: "", away: "", metrics: { home: {}, away: {} }, file: entry.file, modified: entry.modified }
    await writeCache(cache)
    return
  }
  await store(recordOf(model, entry), entry)
}

/**
 * The team's figures in its previous matches, newest first (up to `limit`), leaving
 * out the match being reported. Matches already remembered cost nothing; any other
 * archive with the team in its file name is read once and remembered.
 */
export async function previousMatches(team: string, excludeMatchId: string, limit = 5): Promise<CachedMatch[]> {
  const cache = await readCache()
  for (const entry of await unread(cache, team)) await readInto(entry)
  const wanted = norm(team)
  const seen = new Set<string>()
  const found: CachedMatch[] = []
  for (const record of Object.values(cache.matches)) {
    if (!record.matchId || record.matchId === excludeMatchId || seen.has(record.matchId)) continue
    const side: Side | undefined = norm(record.home) === wanted ? "home" : norm(record.away) === wanted ? "away" : undefined
    if (!side) continue
    seen.add(record.matchId)
    found.push(asCached(record, side))
  }
  return found.sort((left, right) => (right.date ?? "").localeCompare(left.date ?? "")).slice(0, limit)
}

/**
 * Reads saved archives the cache does not have yet, newest first, one at a time with a
 * pause between, while `idle()` says nothing else needs the server. Each read holds the
 * server for a few seconds, so this runs only when no live match is being followed.
 */
export async function warmMatchCache(idle: () => boolean, options: { max?: number; pauseMs?: number } = {}): Promise<number> {
  const { max = 10, pauseMs = 2000 } = options
  let read = 0
  for (const entry of (await unread(await readCache())).slice(0, max)) {
    await new Promise((resolve) => setTimeout(resolve, pauseMs))
    if (!idle()) break
    await readInto(entry)
    read += 1
  }
  return read
}

export type TrendRow = { key: MetricKey; label: string; now: string; average?: string; previous: number[]; verdict?: "better" | "worse" | "same"; unit?: string }

const show = (key: MetricKey, value: number | undefined) =>
  value == null ? "–" : `${value.toFixed(METRICS[key].digits)}${METRICS[key].unit ?? ""}`

/** This match against the average of the previous ones, for the keys asked for. */
export function trendRows(keys: readonly MetricKey[], now: MatchMetrics, previous: CachedMatch[]): TrendRow[] {
  return keys.map((key) => {
    const values = previous.map((match) => match.metrics[key]).filter((value): value is number => value != null)
    const average = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
    const value = now[key]
    let verdict: TrendRow["verdict"]
    if (average != null && value != null && METRICS[key].better !== "neither") {
      const gap = value - average
      const meaningful = Math.abs(gap) >= Math.max(0.15 * Math.abs(average), METRICS[key].digits === 2 ? 0.2 : 1)
      verdict = !meaningful ? "same" : (gap > 0) === (METRICS[key].better === "up") ? "better" : "worse"
    }
    return {
      key,
      label: METRICS[key].label,
      now: show(key, value),
      average: average == null ? undefined : show(key, average),
      previous: values,
      verdict,
    }
  })
}

// ---------------------------------------------------------------------------
// Carry-forward actions

export type CarryArea = "tactic" | "training" | "selection" | "recruitment"
export type CarryItem = { area: CarryArea; action: string; check?: { metric: MetricKey; target: "down" | "up" } }
export type SavedActions = {
  savedAt: string
  matchId: string
  date?: string
  team: string
  opponent: string
  items: Array<CarryItem & { baseline?: number }>
}

const ACTIONS_FILE = () => join(dataFolder(), "carry-forward.jsonl")

export async function saveActions(model: MatchModel, side: Side, items: CarryItem[], metrics: MatchMetrics): Promise<void> {
  if (items.length === 0) return
  const record: SavedActions = {
    savedAt: new Date().toISOString(),
    matchId: model.matchId,
    date: model.metadata?.matchDate?.slice(0, 10),
    team: teamName(model, side),
    opponent: teamName(model, other(side)),
    items: items.map((item) => ({ ...item, baseline: item.check ? metrics[item.check.metric] : undefined })),
  }
  await mkdir(dataFolder(), { recursive: true })
  await appendFile(ACTIONS_FILE(), JSON.stringify(record) + "\n", "utf8")
}

/** The latest actions saved for this team from another match. */
export async function lastActions(team: string, currentMatchId: string): Promise<SavedActions | undefined> {
  let lines: string[]
  try {
    lines = (await readFile(ACTIONS_FILE(), "utf8")).split("\n").filter(Boolean)
  } catch {
    return undefined
  }
  const records = lines
    .map((line) => {
      try {
        return JSON.parse(line) as SavedActions
      } catch {
        return undefined
      }
    })
    .filter((record): record is SavedActions => Boolean(record) && norm(record!.team) === norm(team) && record!.matchId !== currentMatchId)
  return records.at(-1)
}

export type ActionCheck = { area: CarryArea; action: string; result: string; status: "done" | "not yet" | "worse" | "no measure" }

/** Each saved action against this match's figures. */
export function checkActions(saved: SavedActions, now: MatchMetrics): { from: string; checks: ActionCheck[] } {
  const checks = saved.items.map((item): ActionCheck => {
    if (!item.check || item.baseline == null || now[item.check.metric] == null) {
      return { area: item.area, action: item.action, result: "nothing to measure it by", status: "no measure" }
    }
    const key = item.check.metric
    const before = item.baseline
    const after = now[key]!
    const gap = after - before
    const meaningful = Math.abs(gap) >= Math.max(0.15 * Math.abs(before), METRICS[key].digits === 2 ? 0.15 : 1)
    const status = !meaningful ? "not yet" : (gap > 0) === (item.check.target === "up") ? "done" : "worse"
    return { area: item.area, action: item.action, result: `${METRICS[key].label}: ${show(key, before)} then, ${show(key, after)} now`, status }
  })
  return { from: `${saved.date ?? saved.savedAt.slice(0, 10)} v ${saved.opponent}`, checks }
}
