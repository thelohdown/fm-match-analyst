// The tactic block the macOS plugin read from a graph snapshot (Chicago v Atlanta United
// 2, as the API serialises it), attached to the Chicago 1-0 LAFC archive's frames so the
// analyst's tactic and role views can be checked end to end. Players in the snapshot are
// mapped onto Chicago's players by roster slot. Skipped when the archive is not there.
import { existsSync, readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import { parseArchiveFile } from "@/api/archiveParser"
import type { TacticalSnapshot } from "@/types/match"

import { MatchModel } from "../src/model"
import * as views from "../src/views"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const fixture = new URL("./fixtures/tactics-macos-chicago.json", import.meta.url)

describe.skipIf(!existsSync(archive))("tactics captured on macOS", () => {
  let model: MatchModel
  beforeAll(async () => {
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
    // From 60' Chicago goes one step more attacking.
    const later = structuredClone(tactics)
    later.revision = tactics.revision + 1
    later.home.processing!.mentality = 5
    const switchTick = 2700 * 4 + 15 * 240 + 400
    for (const frame of parsed.frames) frame.tactics = frame.tick < switchTick ? tactics : later
    model = new MatchModel(parsed.archive.matchId)
    model.setMetadata(parsed.metadata ?? null)
    model.ingest(parsed.frames)
  })

  it("reports the applied tactic in FM's terms", () => {
    const result = views.tactic(model, "home") as Record<string, any>
    expect(result.available).toBe(true)
    const chicago = result.Chicago
    expect(chicago.tacticName).toBe("Wing Play")
    expect(chicago.mentality).toBe("positive")
    expect(chicago.inPossession.instructions).toEqual(
      expect.arrayContaining(["focus play down both flanks", "look for overlap both", "work ball into box"])
    )
    expect(chicago.outOfPossession.instructions).toEqual(expect.arrayContaining(["line of engagement mid", "pressing intensity higher"]))
    expect(chicago.players).toHaveLength(11)
    expect(chicago.players[0].inPossession).toBe("GK Goalkeeper (Defend)")
    expect(chicago.players.at(-1).inPossession).toBe("ST Channel Forward (Attack)")
    expect(chicago.changes).toEqual([{ minute: expect.stringMatching(/^6[12]'$/), changed: ["mentality balanced -> positive"] }])
  })

  it("names each player's position and role instead of inferring a zone", () => {
    const result = views.players(model, "home", {}, false) as Record<string, Array<Record<string, unknown>>>
    const keeper = result.Chicago.find((row) => row.number === 1)!
    expect(keeper.role).toBe("GK Goalkeeper (Defend); out of possession GK Goalkeeper (Support)")
    expect(keeper.zone).toBeUndefined()
  })
})
