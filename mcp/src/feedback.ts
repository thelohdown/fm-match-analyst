// The user's verdicts on answers, kept with the match situation they were about, so
// the analyst instructions can be improved against real misses. One JSON line per
// verdict in FM_ANALYST_DATA_DIR (default ~/Documents/FM Match Analyst).

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export function dataFolder(): string {
  const configured = process.env.FM_ANALYST_DATA_DIR?.trim()
  return configured ? configured : join(homedir(), "Documents", "FM Match Analyst")
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
