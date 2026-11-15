// How much help the analyst gives: an install setting for the default, which the user
// can change in any chat ("just hints", "go deep").
import { setting } from "./env"

export const DETAIL_LEVELS = ["hints", "coach", "full"] as const
export type DetailLevel = (typeof DETAIL_LEVELS)[number]

export const DETAIL_MEANS: Record<DetailLevel, string> = {
  hints: "Hints: confirm or challenge the user's own read with a number, or point where to look; no full plan and no changes unless asked.",
  coach: "Coach: the answer first, the evidence by moment, and at most three changes.",
  full: "Full analysis: every moment for both teams, why it is happening, options with their trade-offs, and what to check next.",
}

const ALIASES: Record<string, DetailLevel> = {
  hint: "hints", hints: "hints", light: "hints", minimal: "hints", low: "hints", "1": "hints",
  coach: "coach", standard: "coach", normal: "coach", medium: "coach", default: "coach", "2": "coach",
  full: "full", deep: "full", detailed: "full", analyst: "full", high: "full", max: "full", "3": "full",
}

/** The level the install asks for (FM_ANALYST_DETAIL), coach when unset or not recognised. */
export function defaultDetail(): DetailLevel {
  const value = setting("FM_ANALYST_DETAIL")?.toLowerCase().split(/[\s(:-]/)[0]
  return (value && ALIASES[value]) || "coach"
}

/** Appended to the analyst guide sent as the server's instructions. */
export function detailInstructions(level = defaultDetail()): string {
  return `\n\n## This install\n\nDefault level of help: ${DETAIL_MEANS[level]} Use it until the user asks for another level in the chat.\n`
}
