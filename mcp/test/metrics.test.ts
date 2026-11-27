// Team figures per match, the trend across saved matches, and carry-forward actions
// saved with one report and checked at the next match.
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

// On a machine with FM installed the game's own archive folder (under the home folder) is
// searched too; an empty home keeps the saved matches there out of these counts.
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>()
  const homedir = () => join(os.tmpdir(), "fm-analyst-no-home")
  return { ...os, homedir, default: { ...os, homedir } }
})

import { checkActions, lastActions, previousMatches, rememberMatch, saveActions, teamMetrics, trendRows, warmMatchCache } from "../src/metrics"
import type { MatchModel } from "../src/model"
import { loadArchive } from "../src/sources"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const saved = { ...process.env }
/** A folder holding only the test archive, so other saved matches next to it don't count. */
function archiveFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "fm-archives-"))
  copyFileSync(archive, join(folder, basename(archive)))
  return folder
}
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
    process.env.FMMATCHLENS_ARCHIVE_DIR = archiveFolder()
    expect(await previousMatches("Chicago", model.matchId)).toEqual([])
    const other = await previousMatches("Chicago", "some-other-match")
    expect(other).toHaveLength(1)
    expect(other[0]).toMatchObject({ team: "Chicago", opponent: "LAFC", date: "2025-12-30" })
    const cache = JSON.parse(readFileSync(join(process.env.FM_ANALYST_DATA_DIR, "match-metrics.json"), "utf8"))
    expect(cache.version).toBe(2)
    expect(Object.keys(cache.matches)).toEqual(["2025-12-30|chicago|lafc"])
    // Either team's figures come from the same record.
    expect((await previousMatches("LAFC", "some-other-match"))[0]).toMatchObject({ team: "LAFC", opponent: "Chicago" })
    expect(await previousMatches("Seattle", "some-other-match")).toEqual([])
  })

  it("remembers a match it already has, so its archive is never read again", async () => {
    process.env.FM_ANALYST_DATA_DIR = mkdtempSync(join(tmpdir(), "fm-metrics-"))
    process.env.FMMATCHLENS_ARCHIVE_DIR = archiveFolder()
    await rememberMatch(model)
    const started = performance.now()
    const other = await previousMatches("Chicago", "some-other-match")
    expect(performance.now() - started).toBeLessThan(1000)
    expect(other[0].metrics.fast_breaks_for).toBe(teamMetrics(model, "home").fast_breaks_for)
  })

  it("fills the cache in the background only while idle", async () => {
    process.env.FM_ANALYST_DATA_DIR = mkdtempSync(join(tmpdir(), "fm-metrics-"))
    process.env.FMMATCHLENS_ARCHIVE_DIR = archiveFolder()
    expect(await warmMatchCache(() => false, { pauseMs: 0 })).toBe(0)
    expect(await warmMatchCache(() => true, { pauseMs: 0 })).toBe(1)
    expect(await warmMatchCache(() => true, { pauseMs: 0 })).toBe(0)
  }, 60_000)

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
