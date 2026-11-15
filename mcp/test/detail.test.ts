// The level of help: the install's default, and what the briefing sends at each level.
import { existsSync } from "node:fs"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { checkData } from "../src/checks"
import { briefing } from "../src/briefing"
import { defaultDetail, detailInstructions } from "../src/detail"
import type { MatchModel } from "../src/model"
import { loadArchive } from "../src/sources"

const archive = process.env.FM_ANALYST_TEST_ARCHIVE ?? "../local/archives/2025-12-30-Chicago-vs-LAFC-1-0.fmlens"
const saved = process.env.FM_ANALYST_DETAIL
afterEach(() => {
  if (saved === undefined) delete process.env.FM_ANALYST_DETAIL
  else process.env.FM_ANALYST_DETAIL = saved
})

describe("level of help", () => {
  it("reads the install setting leniently, coach when unset or unknown", () => {
    delete process.env.FM_ANALYST_DETAIL
    expect(defaultDetail()).toBe("coach")
    process.env.FM_ANALYST_DETAIL = "${user_config.detail_level}"
    expect(defaultDetail()).toBe("coach")
    process.env.FM_ANALYST_DETAIL = "Hints"
    expect(defaultDetail()).toBe("hints")
    process.env.FM_ANALYST_DETAIL = "full (everything)"
    expect(defaultDetail()).toBe("full")
    process.env.FM_ANALYST_DETAIL = "deep"
    expect(defaultDetail()).toBe("full")
    process.env.FM_ANALYST_DETAIL = "loads"
    expect(defaultDetail()).toBe("coach")
    expect(detailInstructions("hints")).toContain("Default level of help: Hints")
  })

  describe.skipIf(!existsSync(archive))("in the briefing", () => {
    let model: MatchModel
    const source = { kind: "archive" as const, detail: "test" }
    beforeAll(async () => {
      model = await loadArchive({ file: "detail", path: archive, finished: true, modified: "detail", sizeKb: 0 })
    }, 120_000)

    it("sends only the game state and the flags for hints, everything otherwise", () => {
      const check = checkData(model)
      const hints = briefing(model, source, check, "hints")
      const coach = briefing(model, source, check, "coach")
      const full = briefing(model, source, check, "full")
      expect(hints.levelOfHelp?.level).toBe("hints")
      expect(Object.keys(hints)).toEqual(expect.arrayContaining(["gameState", "standsOut", "dataCheck"]))
      expect(hints).not.toHaveProperty("inPossession")
      expect(coach).toHaveProperty("inPossession")
      expect(Object.keys(full)).toEqual(Object.keys(coach))
      expect(JSON.stringify(hints).length).toBeLessThan(JSON.stringify(coach).length / 3)
    })
  })
})
