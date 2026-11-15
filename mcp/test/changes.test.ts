// get_changes on the Chicago 1-0 LAFC archive, with the macOS tactic fixture attached
// and Chicago (the user's team) changing mentality three times in the second half.
// Every rate must match FM's own counters over the same stretch.
import { existsSync, readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import { parseArchiveFile } from "@/api/archiveParser"
import type { TacticalSnapshot } from "@/types/match"

import { briefing } from "../src/briefing"
import { CHANGE_WINDOW_MINUTES, changeImpacts, changesReport, MIN_JUDGE_MINUTES } from "../src/changes"
import { checkData } from "../src/checks"
import { MatchModel } from "../src/model"
import { loadArchive } from "../src/sources"
import { teamDiff } from "../src/views"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const fixture = new URL("./fixtures/tactics-macos-chicago.json", import.meta.url)
const source = { kind: "archive" as const, detail: "2025-12-30-Chicago-vs-LAFC-1-0.fmlens" }

/** Changes at these match minutes: positive, then attacking, then very attacking. */
const CHANGES = [
  { minute: 61, mentality: 5 },
  { minute: 75, mentality: 6 },
  { minute: 88, mentality: 7 },
]

async function parse() {
  const bytes = readFileSync(archive)
  return parseArchiveFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "test.fmlens")
}

async function withChanges(): Promise<MatchModel> {
  // A first pass finds the engine tick of each change minute.
  const probe = new MatchModel("probe")
  const first = await parse()
  probe.setMetadata(first.metadata!)
  probe.ingest(first.frames)
  const tickAt = (minute: number) => probe.buckets.find((bucket) => bucket.windowMinute === minute && bucket.period === 2)!.startTick + 20

  const parsed = await parse()
  const base = JSON.parse(readFileSync(fixture, "utf8")) as TacticalSnapshot
  const frame0 = parsed.frames[0]
  for (const side of ["home", "away"] as const) {
    const players = frame0.players.filter((player) => player.team === side)
    for (const binding of base[side].players) {
      const match = players[binding.rosterSlot ?? -1]
      if (match) Object.assign(binding, { slot: match.slot, playerId: match.playerId })
    }
  }
  const versions = CHANGES.map((change, index) => {
    const version = structuredClone(base)
    version.revision = base.revision + index + 1
    version.home.processing!.mentality = change.mentality
    return { tick: tickAt(change.minute), tactics: version }
  })
  for (const frame of parsed.frames) {
    frame.tactics = versions.filter((version) => frame.tick >= version.tick).at(-1)?.tactics ?? base
  }
  const metadata = parsed.metadata!
  const manager = (metadata.home.manager ?? {}) as Record<string, unknown>
  metadata.home.manager = { ...manager, isHumanControlled: true } as typeof metadata.home.manager
  const model = new MatchModel(parsed.archive.matchId)
  model.setMetadata(metadata)
  model.ingest(parsed.frames)
  return model
}

describe.skipIf(!existsSync(archive))("did the change work", () => {
  let model: MatchModel
  let plain: MatchModel
  beforeAll(async () => {
    model = await withChanges()
    plain = await loadArchive({ file: source.detail, path: archive, finished: true, modified: "changes", sizeKb: 0 })
  }, 120_000)

  it("finds each change with its minute and what changed", () => {
    const changes = changeImpacts(model, ["home"])
    expect(changes.map((change) => change.minute)).toEqual(["61'", "75'", "88'"])
    expect(changes[0].changed).toEqual([expect.stringMatching(/^mentality .* -> positive$/)])
    expect(changes[1].changed).toEqual(["mentality positive -> attacking"])
    expect(changeImpacts(model, ["away"])).toEqual([])
  })

  it("compares stretches that stop at the neighbouring changes", () => {
    const [first, second, third] = changeImpacts(model, ["home"])
    // Before the first change: the 15 minutes up to it (the second half starts at 45:00 on the clock).
    expect(first.before).toMatchObject({ from: "45:00", minutes: CHANGE_WINDOW_MINUTES })
    // After the first change: up to the next change, not past it.
    expect(first.after?.minutes).toBe(14)
    expect(second.before?.minutes).toBe(14)
    expect(second.after?.minutes).toBe(13)
    // The last change has only stoppage time after it: shown, but not judged.
    expect(third.after!.minutes).toBeLessThan(MIN_JUDGE_MINUTES)
    expect("tooEarly" in third && third.tooEarly).toMatch(/too early to judge/)
    expect("tooEarly" in first && first.tooEarly).toBeFalsy()
  })

  it("rates match FM's own counters over the same minutes", () => {
    const [first] = changeImpacts(model, ["home"])
    if (!("figures" in first)) throw new Error("expected figures")
    const at = model.buckets.findIndex((bucket) => bucket.windowMinute === 61 && bucket.period === 2)
    const after = model.selectIndices(at, at + 13, "after")!
    const before = model.selectIndices(at - 15, at - 1, "before")!
    const rate = (selection: typeof after, side: "home" | "away", name: "xg" | "shots") => (teamDiff(selection, side, name) * 10) / selection.buckets.length
    expect(first.figures["xG per 10 min"].after).toBeCloseTo(rate(after, "home", "xg"), 2)
    expect(first.figures["xG per 10 min"].before).toBeCloseTo(rate(before, "home", "xg"), 2)
    expect(first.figures["shots conceded per 10 min"].after).toBeCloseTo(rate(after, "away", "shots"), 2)
    expect(first.scoreAtChange).toMatch(/1-0|0-0/)
    for (const line of [...first.better, ...first.worse, ...first.moved]) expect(line).toMatch(/: -?[\d.]+ -> -?[\d.]+$/)
  })

  it("lists what else happened in the stretches", () => {
    const all = changeImpacts(model, ["home"]).flatMap((change) => ("alsoHappened" in change ? (change.alsoHappened ?? []) : []))
    // LAFC used substitutions in the second half; any that fall in a stretch are named.
    for (const line of all) expect(line).toMatch(/\d+'.*\((before|after)\)$/)
  })

  it("puts the latest change in the briefing", () => {
    const result = briefing(model, source, checkData(model)) as { yourLastChange?: { minute: string; figures?: unknown } }
    expect(result.yourLastChange?.minute).toBe("88'")
    expect(result.yourLastChange && "figures" in result.yourLastChange).toBe(false)
  })

  it("says so when there is nothing to track", () => {
    expect(changesReport(plain, ["home", "away"])).toMatchObject({ changes: [], summary: expect.stringContaining("not captured") })
  })
})
