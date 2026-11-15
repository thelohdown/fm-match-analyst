// Team figures per match, the trend across saved matches, and carry-forward actions
// saved with one report and checked at the next match.
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { checkActions, lastActions, previousMatches, saveActions, teamMetrics, trendRows } from "../src/metrics"
import type { MatchModel } from "../src/model"
import { loadArchive } from "../src/sources"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

describe.skipIf(!existsSync(archive))("figures across matches", () => {
  let model: MatchModel
  beforeAll(async () => {
    model = await loadArchive({ file: "metrics", path: archive, finished: true, modified: "metrics", sizeKb: 0 })
  }, 120_000)

  it("matches FM's own totals for the match", () => {
    const home = teamMetrics(model, "home")
    const away = teamMetrics(model, "away")
    expect(home.shots_for).toBe(18)
    expect(home.shots_against).toBe(9)
    expect(home.xg_for).toBeCloseTo(1.39, 2)
    expect(away.xg_for).toBeCloseTo(home.xg_against!, 5)
    expect(home.fast_breaks_against).toBe(away.fast_breaks_for)
  })

  it("finds earlier saved matches, leaves out this one, and caches them", async () => {
    process.env.FM_ANALYST_DATA_DIR = mkdtempSync(join(tmpdir(), "fm-metrics-"))
    process.env.FMMATCHLENS_ARCHIVE_DIR = resolve(archive, "..")
    expect(await previousMatches("Chicago", model.matchId)).toEqual([])
    const other = await previousMatches("Chicago", "some-other-match")
    expect(other).toHaveLength(1)
    expect(other[0]).toMatchObject({ team: "Chicago", opponent: "LAFC", date: "2025-12-30" })
    expect(Object.keys(JSON.parse(readFileSync(join(process.env.FM_ANALYST_DATA_DIR, "match-metrics.json"), "utf8")))).toHaveLength(1)
    expect(await previousMatches("Seattle", "some-other-match")).toEqual([])
  })

  it("calls a figure better or worse only when it moved enough", () => {
    const rows = trendRows(["fast_breaks_against", "xg_for", "possession_pct"], { fast_breaks_against: 13, xg_for: 1.41, possession_pct: 56 }, [
      { file: "a", modified: "m", matchId: "a", team: "Chicago", opponent: "X", metrics: { fast_breaks_against: 6, xg_for: 1.4, possession_pct: 40 } },
    ])
    expect(rows.map((row) => row.verdict)).toEqual(["worse", "same", undefined])
  })

  it("saves actions with their baseline and checks them at the next match", async () => {
    process.env.FM_ANALYST_DATA_DIR = mkdtempSync(join(tmpdir(), "fm-actions-"))
    const metrics = teamMetrics(model, "home")
    await saveActions(model, "home", [{ area: "tactic", action: "Stop their counters", check: { metric: "fast_breaks_against", target: "down" } }, { area: "selection", action: "Rest Bamba" }], metrics)
    // Not offered back for the same match.
    expect(await lastActions("Chicago", model.matchId)).toBeUndefined()
    const lastTime = await lastActions("Chicago", "next-match")
    expect(lastTime?.items[0].baseline).toBe(metrics.fast_breaks_against)
    const fewer = checkActions(lastTime!, { ...metrics, fast_breaks_against: 3 })
    expect(fewer.from).toBe("2025-12-30 v LAFC")
    expect(fewer.checks.map((check) => check.status)).toEqual(["done", "no measure"])
    expect(checkActions(lastTime!, { ...metrics, fast_breaks_against: 30 }).checks[0].status).toBe("worse")
    expect(checkActions(lastTime!, metrics).checks[0].status).toBe("not yet")
  })
})
