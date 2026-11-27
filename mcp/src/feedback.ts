// The user's verdicts on answers, kept with the match situation they were about, so
// the analyst instructions can be improved against real misses. One JSON line per
// verdict in FM_ANALYST_DATA_DIR (default ~/Documents/FM Tinkerman).

import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { setting } from "./env"

export function dataFolder(): string {
  const configured = setting("FM_ANALYST_DATA_DIR")
  if (configured) return configured
  const folder = join(homedir(), "Documents", "FM Tinkerman")
  // Reports and verdicts saved under the earlier name stay where they are.
  const earlier = join(homedir(), "Documents", "FM Match Analyst")
  return !existsSync(folder) && existsSync(earlier) ? earlier : folder
}

export type FeedbackRecord = {
  savedAt: string
  verdict: string
  note: string
  question?: string
  answer?: string
  match?: Record<string, unknown>
}

export async function saveFeedback(record: FeedbackRecord): Promise<{ file: string; total: number }> {
  const folder = dataFolder()
  await mkdir(folder, { recursive: true })
  const file = join(folder, "feedback.jsonl")
  await appendFile(file, JSON.stringify(record) + "\n", "utf8")
  const total = (await readFile(file, "utf8")).split("\n").filter(Boolean).length
  return { file, total }
}
