// The printable reports on the Chicago 1-0 LAFC archive: once with the tactic block
// from the macOS fixture attached and Chicago marked as the user's team (as a
// current capture has it), and once as recorded (no tactics, no human manager).
// Every number on the page must come from the match; the written lines must fit.
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

import { parseArchiveFile } from "@/api/archiveParser"
import type { TacticalSnapshot } from "@/types/match"

import { MatchModel } from "../src/model"
import { buildHalfTime, buildPostMatch, lengthProblems, missingInputs, type ReportInput, saveReport } from "../src/report"
import { loadArchive } from "../src/sources"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const fixture = new URL("./fixtures/tactics-macos-chicago.json", import.meta.url)
const source = { kind: "archive" as const, detail: "2025-12-30-Chicago-vs-LAFC-1-0.fmlens" }

export const POST_MATCH: ReportInput = {
  verdict: [
    { title: "Won on volume, not quality", detail: "18 shots to 9, but 1.39 xG to 1.19. One clear chance each side." },
    { title: "The left side carried us", detail: "Gutman and Bamba combined more than any pair in the side." },
    { title: "Saw it out comfortably", detail: "68% of the ball in the last 10 minutes and nothing conceded." },
  ],
  our_plan: [
    { instruction: "Focus play down both flanks", status: "seen", evidence: "Most final-third entries came wide" },
    { instruction: "Press higher", status: "not_seen", evidence: "PPDA above LAFC's for the match" },
  ],
  their_plan: [
    { label: "Ten changes by 51'", status: "contained", evidence: "Little threat after the changes" },
    { label: "Hollingshead's big chance", status: "hurt", evidence: "0.45 xG from 6 yards at 55'" },
  ],
  flow_events: [
    { minute: 46, label: "46' LAFC change 3" },
    { minute: 61, label: "61' Chicago go positive" },
  ],
}

export const HALF_TIME: ReportInput = {
  decisions: [
    { title: "Keep attacking down the left", evidence: "Most of our final-third entries came down the left.", option: "Keep the overlap on; Allen if Gutman tires." },
    { title: "Find Lewandowski earlier", evidence: "He scored from our best chance of the half.", option: "Keep him central with runners beyond." },
    { title: "Watch the counter", evidence: "LAFC's fast breaks came after we lost it high.", option: "Keep the regroup on." },
  ],
  their_plan: [
    { label: "Sitting in a mid block", evidence: "Their line held in midfield for most of the half." },
    { label: "Changing three at the break", evidence: "Friendly: expect fresh legs." },
  ],
  our_plan: [{ instruction: "Focus play down both flanks", status: "seen", evidence: "Most entries came wide" }],
  players: [
    { name: "Gutman", status: "watch", why: "Booked; up against their right winger", bench: "Allen · DL" },
    { name: "Robert Lewandowski", status: "keep", why: "The goal and our best chance", bench: "Keep feeding him early" },
  ],
}

/** The page's text with HTML escapes undone, for checking what a reader sees. */
const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

async function withTactics(): Promise<MatchModel> {
  const bytes = readFileSync(archive)
  const parsed = await parseArchiveFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "test.fmlens")
  const tactics = JSON.parse(readFileSync(fixture, "utf8")) as TacticalSnapshot
  const first = parsed.frames[0]
  for (const side of ["home", "away"] as const) {
    const players = first.players.filter((player) => player.team === side)
    for (const binding of tactics[side].players) {
      const match = players[binding.rosterSlot ?? -1]
      if (match) Object.assign(binding, { slot: match.slot, playerId: match.playerId })
    }
  }
  const later = structuredClone(tactics)
  later.revision = tactics.revision + 1
  later.home.processing!.mentality = 5
  const switchTick = 2700 * 4 + 15 * 240 + 400
  for (const frame of parsed.frames) frame.tactics = frame.tick < switchTick ? tactics : later
  const metadata = parsed.metadata!
  const manager = (metadata.home.manager ?? {}) as Record<string, unknown>
  metadata.home.manager = { ...manager, isHumanControlled: true } as typeof metadata.home.manager
  const model = new MatchModel(parsed.archive.matchId)
  model.setMetadata(metadata)
  model.ingest(parsed.frames)
  return model
}

describe.skipIf(!existsSync(archive))("printable reports", () => {
  let model: MatchModel
  let plain: MatchModel
  beforeAll(async () => {
    model = await withTactics()
    plain = await loadArchive({ file: source.detail, path: archive, finished: true, modified: "report", sizeKb: 0 })
  }, 120_000)

  it("asks for the lines it needs and keeps them to the page", () => {
    expect(missingInputs("post_match", POST_MATCH)).toEqual([])
    expect(missingInputs("half_time", HALF_TIME)).toEqual([])
    expect(missingInputs("post_match", { our_plan: POST_MATCH.our_plan })).toEqual(
      expect.arrayContaining([expect.stringContaining("verdict"), expect.stringContaining("their_plan")])
    )
    expect(lengthProblems("post_match", { their_plan: [{ label: "Pressing", status: "hurt", evidence: "x".repeat(60) }] })).toHaveLength(1)
    expect(lengthProblems("half_time", { their_plan: [{ label: "Pressing", evidence: "x".repeat(60) }] })).toEqual([])
  })

  it("builds the post-match one-pager from the match's own numbers", () => {
    const built = buildPostMatch(model, source, POST_MATCH)
    const { title, notes } = built
    const html = decode(built.html)
    expect(title).toBe("Chicago 1-0 LAFC")
    expect(notes).toEqual([])
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("Post-match report")
    // Score, xG and the shot counts FM recorded (18 to 9, as in the phases test).
    expect(html).toMatch(/>1–0</)
    expect(html).toContain("xG 1.39–1.19")
    expect(html).toContain("18 shots · 1.39 xG")
    expect(html).toContain("9 shots · 1.19 xG")
    expect(html).toContain("Lewandowski 18'")
    // The tactic as captured, its mid-match mentality change, and the written lines.
    expect(html).toContain("Wing Play")
    expect(html).toContain("Positive from 6")
    expect(html).toContain("Won on volume, not quality")
    expect(html).toContain("Hurt us")
    // 11 starters plus substitutes, at most 13 rows; shirt numbers on the pitch.
    const rows = html.split('<td class="num muted">').length - 1
    expect(rows).toBeGreaterThanOrEqual(11)
    expect(rows).toBeLessThanOrEqual(13)
    expect(html).not.toMatch(/NaN|undefined|null%/)
  })

  it("builds the half-time sheet from the first half only", () => {
    const built = buildHalfTime(model, source, HALF_TIME)
    const { title } = built
    const html = decode(built.html)
    expect(title).toBe("Chicago 1-0 LAFC at half-time")
    expect(html).toContain("Half-time report")
    expect(html).toContain("Three decisions for the second half")
    expect(html).toContain("0–30'")
    expect(html).toContain("31'–HT")
    expect(html).toContain("Set pieces")
    // Players found by surname or full name, with rating and condition at 45'.
    expect(html).toContain("<b>Gutman</b>")
    expect(html).toContain("<b>Lewandowski</b>")
    expect(html).toMatch(/\d{2}%<\/td>/)
    expect(html).not.toMatch(/NaN|undefined/)
  })

  it("says so when a player is not in the squad", () => {
    expect(() => buildHalfTime(model, source, { ...HALF_TIME, players: [{ name: "Messi", status: "keep", why: "Never here" }] })).toThrow(/No player called "Messi"/)
  })

  it("still builds without tactics or a known manager, and says which side it took", () => {
    const { html, notes } = buildPostMatch(plain, source, POST_MATCH)
    expect(notes[0]).toContain("Could not tell which team you manage")
    expect(html).toContain("Tactics were not captured for this match")
    expect(html).not.toMatch(/NaN|undefined/)
  })

  it("saves one file per match and kind in the data folder", async () => {
    process.env.FM_ANALYST_DATA_DIR = mkdtempSync(join(tmpdir(), "fm-report-"))
    const { html } = buildPostMatch(model, source, POST_MATCH)
    const file = await saveReport(model, "post_match", html)
    expect(file).toMatch(/reports[\\/]2025-12-30-Chicago-v-LAFC-post-match\.html$/)
    expect(readFileSync(file, "utf8")).toBe(html)
  })
})
