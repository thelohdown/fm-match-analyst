// Team colours on the reports come from the kits: readable on each theme's page
// and panels, and the two teams never alike. Chicago v LAFC is the real case.
import { describe, expect, it } from "vitest"

import { placeLabels, themeStyle } from "../src/reportPage"
import { contrast, distance, FALLBACK, SURFACES, teamColours } from "../src/teamColors"

const argb = (hex: string) => (0xff000000 | Number.parseInt(hex.slice(1), 16)) >>> 0
const kit = (shirt: string, trim: string) => ({ shirtBackgroundColor: argb(shirt), shirtForegroundColor: argb(trim) })
const CHICAGO = kit("#e82028", "#f8f8f8")
const LAFC = kit("#080808", "#c8b078")

describe("team colours", () => {
  it("uses each kit, moving to the trim where the shirt disappears", () => {
    const colours = teamColours(CHICAGO, LAFC)
    expect(colours.light).toEqual({ you: "#e82028", them: "#080808" })
    // Black on the dark page is unreadable: LAFC's gold trim instead.
    expect(colours.dark).toEqual({ you: "#e82028", them: "#c8b078" })
  })

  it("keeps our colour and moves the opponent off a clash", () => {
    const colours = teamColours(CHICAGO, kit("#e01e2a", "#ffffff"))
    expect(colours.light.you).toBe("#e82028")
    // Their red is too close, their white trim unreadable on a light page, and
    // the stand-in orange too near our red: blue.
    expect(colours.light.them).toBe(FALLBACK.you)
    for (const theme of ["light", "dark"] as const) {
      const { you, them } = colours[theme]
      expect(distance(you, them)).toBeGreaterThanOrEqual(0.12)
      expect(contrast(them, SURFACES[theme].page)).toBeGreaterThanOrEqual(3)
    }
  })

  it("falls back to blue and orange without kit colours", () => {
    expect(teamColours(undefined, undefined).light).toEqual(FALLBACK)
    expect(teamColours({ shirtBackgroundColor: 0 }, {}).dark).toEqual(FALLBACK)
  })

  it("sets light colours for print and dark ones only for dark screens", () => {
    const css = themeStyle({ you: CHICAGO, them: LAFC })
    expect(css).toMatch(/^:root\{[^}]*--them:#080808/)
    expect(css).toContain("@media screen and (prefers-color-scheme: dark){:root{")
    expect(css).toMatch(/prefers-color-scheme: dark\)\{:root\{[^}]*--them:#c8b078/)
  })
})

describe("match flow labels", () => {
  it("drops a label to a second row rather than overlap", () => {
    // The 4-1 match: three events, two of them seven minutes apart.
    const labels = placeLabels(
      [
        { label: "21' Wide playmaker AMR", x: 199.5 },
        { label: "47' Tempo up + counter", x: 347.5 },
        { label: "54' LAFC six subs", x: 387.4 },
      ],
      644
    )
    expect(labels.map((label) => [label.row, label.anchor])).toEqual([
      [1, "end"],
      [1, "start"],
      [2, "start"],
    ])
    const spans = labels.map((label) => {
      const width = label.label.length * 6.6
      return { row: label.row, from: label.anchor === "end" ? label.x - 5 - width : label.x + 5, to: label.anchor === "end" ? label.x - 5 : label.x + 5 + width }
    })
    for (const a of spans) for (const b of spans) if (a !== b && a.row === b.row) expect(a.to <= b.from || b.to <= a.from).toBe(true)
  })

  it("keeps one row when the labels fit", () => {
    const labels = placeLabels([{ label: "46' LAFC change 3", x: 343 }, { label: "61' Chicago go positive", x: 428 }], 644)
    expect(labels.every((label) => label.row === 1)).toBe(true)
  })
})
