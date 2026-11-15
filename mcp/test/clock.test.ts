import { describe, expect, it } from "vitest"
import { clockLabel, minuteLabel, windowMinute } from "../src/clock"

describe("FM match clock", () => {
  it("labels minutes the way FM does", () => {
    expect(minuteLabel(0, 1)).toBe("1'")
    expect(minuteLabel(17 * 60 + 16, 1)).toBe("18'")
    expect(minuteLabel(45 * 60 + 5, 1)).toBe("45+1'")
    expect(minuteLabel(45 * 60 + 5, 2)).toBe("46'")
    expect(minuteLabel(81 * 60 + 38, 2)).toBe("82'") // FM's penalty at 81:38 was listed as 82'
    expect(minuteLabel(92 * 60 + 37, 2)).toBe("90+3'")
  })
  it("reads the clock with stoppage time", () => {
    expect(clockLabel(46 * 60 + 35, 1)).toBe("45+1:35")
    expect(clockLabel(67 * 60 + 12, 2)).toBe("67:12")
  })
  it("counts first-half stoppage as minute 45 for windows", () => {
    expect(windowMinute(46 * 60, 1)).toBe(45)
    expect(windowMinute(45 * 60, 2)).toBe(46)
    expect(windowMinute(93 * 60, 2)).toBe(90)
  })
})
