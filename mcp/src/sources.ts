// Where match data comes from: FMMatchLens's local API while FM runs, or the
// .fmlens archives it saves after every match.

import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { RealtimeFrame, RealtimeMatchMetadata } from "@/api/realtimeMatch"
import { parseArchiveFile } from "@/api/archiveParser"

import { MatchModel } from "./model"

export const DEFAULT_API = "http://127.0.0.1:16726"
const PAGE_SIZE = 1200

type ApiStatus = {
  status: string
  matchId?: string | null
  frameCount: number
  lastTick: number
  period?: number | null
}

type ApiHealth = {
  status: string
  /** Set by ./mac/dev.sh serve: the archive being replayed instead of the game. */
  replayOf?: string | null
}

type FrameSlice = {
  matchId?: string | null
  status: string
  totalFrameCount: number
  frames: RealtimeFrame[]
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

/** Follows the match FMMatchLens is capturing, pulling new frames as they appear. */
export class LiveSource {
  model?: MatchModel
  status?: ApiStatus
  lastError?: string
  /** The saved match being replayed by ./mac/dev.sh serve, when the API is the replay tool and not the game. */
  replayOf?: string
  private syncing?: Promise<void>
  private metadataFetchedAt = 0
  private timer?: NodeJS.Timeout

  constructor(readonly baseUrl: string = DEFAULT_API) {}

  start(intervalMs = 3000) {
    if (this.timer) return
    const tick = () => {
      void this.sync().catch(() => undefined)
    }
    tick()
    this.timer = setInterval(tick, intervalMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One catch-up pass; concurrent callers share it. */
  sync(): Promise<void> {
    this.syncing ??= this.syncOnce().finally(() => {
      this.syncing = undefined
    })
    return this.syncing
  }

  /** Waits for the current catch-up, at most timeoutMs. */
  async ready(timeoutMs: number): Promise<boolean> {
    const pass = this.sync()
    const timeout = new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs).unref())
    return Promise.race([pass.then(() => true), timeout]).catch(() => false)
  }

  /** Share of the match's frames read so far (1 when caught up). */
  progress(): number {
    if (!this.model || !this.status || this.status.lastTick <= 0) return 0
    return Math.min(1, Math.max(0, this.model.lastTick) / this.status.lastTick)
  }

  private async syncOnce() {
    let status: ApiStatus
    try {
      status = await getJson<ApiStatus>(`${this.baseUrl}/api/match/status`, 2000)
    } catch (error) {
      this.lastError = `FMMatchLens's local API at ${this.baseUrl} is not answering (${(error as Error).message}). Is FM running with the plugin, or ./mac/dev.sh serve?`
      this.status = undefined
      return
    }
    this.lastError = undefined
    this.status = status
    if (!status.matchId) return
    if (!this.model || this.model.matchId !== status.matchId) {
      this.model = new MatchModel(status.matchId)
      this.metadataFetchedAt = 0
    }
    const model = this.model
    if (Date.now() - this.metadataFetchedAt > 15_000 || !model.metadata) {
      const health = await getJson<ApiHealth>(`${this.baseUrl}/api/health`, 2000).catch(() => undefined)
      if (health) this.replayOf = health.replayOf || undefined
      const metadata = await getJson<RealtimeMatchMetadata | null>(`${this.baseUrl}/api/match/meta`, 5000).catch(() => null)
      if (metadata && metadata.matchId === model.matchId) {
        model.setMetadata(metadata)
        this.metadataFetchedAt = Date.now()
      }
    }
    for (;;) {
      const fromTick = Math.max(0, model.lastTick)
      const slice = await getJson<FrameSlice>(
        `${this.baseUrl}/api/match/frames?fromTick=${fromTick}&stride=1&limit=${PAGE_SIZE}`,
        60_000
      )
      if (slice.matchId && slice.matchId !== model.matchId) return
      const before = model.lastTick
      model.ingest(slice.frames, true)
      this.status = { ...status, status: slice.status, lastTick: Math.max(status.lastTick, model.lastTick) }
      if (slice.frames.length < PAGE_SIZE || model.lastTick === before) return
    }
  }
}

// ---------------------------------------------------------------------------
// Archives

export type ArchiveEntry = {
  file: string
  path: string
  date?: string
  home?: string
  away?: string
  score?: string
  finished: boolean
  modified: string
  sizeKb: number
}

/** Folders that may hold FMMatchLens archives, most specific first. */
export function archiveFolders(): string[] {
  const configured = (process.env.FMMATCHLENS_ARCHIVE_DIR ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((value) => value.trim())
    .filter(Boolean)
  const home = homedir()
  const plugin = ["BepInEx", "plugins", "FMMatchLens", "data", "matches"]
  const candidates = [
    ...configured,
    join(home, "Library/Application Support/Steam/steamapps/common/Football Manager 27/FM27-BepInEx", ...plugin),
    join(home, "Library/Application Support/Steam/steamapps/common/Football Manager 26/FM26-BepInEx", ...plugin),
    join("C:/Program Files (x86)/Steam/steamapps/common/Football Manager 27", ...plugin),
    join("C:/Program Files (x86)/Steam/steamapps/common/Football Manager 26", ...plugin),
  ]
  // Running from the repository (mcp/dist/server.mjs): ./mac/dev.sh dump copies archives to local/archives.
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    candidates.push(resolve(here, "../../local/archives"))
  } catch {
    // Not running from a file.
  }
  return [...new Set(candidates)]
}

const FINISHED_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)-vs-(.+)-(\d+)-(\d+)\.fmlens$/

export async function listArchives(): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  const seen = new Set<string>()
  for (const folder of archiveFolders()) {
    let names: string[]
    try {
      names = await readdir(folder)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith(".fmlens") || seen.has(name)) continue
      seen.add(name)
      const path = join(folder, name)
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) continue
      const match = FINISHED_NAME.exec(name)
      entries.push({
        file: name,
        path,
        date: match?.[1],
        home: match?.[2],
        away: match?.[3],
        score: match ? `${match[4]}-${match[5]}` : undefined,
        finished: Boolean(match),
        modified: info.mtime.toISOString(),
        sizeKb: Math.round(info.size / 1024),
      })
    }
  }
  return entries.sort((left, right) => right.modified.localeCompare(left.modified))
}

/** Finds an archive by file name, path, or words in its name ("LAFC", "2025-12-30"). */
export async function findArchive(query: string): Promise<ArchiveEntry | undefined> {
  const archives = await listArchives()
  const wanted = query.trim().toLowerCase()
  if (wanted === "latest" || wanted === "newest" || wanted === "last") return archives[0]
  const exact = archives.find((entry) => entry.file.toLowerCase() === wanted || entry.path.toLowerCase() === wanted)
  if (exact) return exact
  if (query.endsWith(".fmlens")) {
    const info = await stat(query).catch(() => undefined)
    if (info?.isFile()) {
      return { file: basename(query), path: query, finished: FINISHED_NAME.test(basename(query)), modified: info.mtime.toISOString(), sizeKb: Math.round(info.size / 1024) }
    }
  }
  const words = wanted.split(/\s+/).filter(Boolean)
  return archives.find((entry) => words.every((word) => entry.file.toLowerCase().replace(/-/g, " ").includes(word)))
}

const archiveCache = new Map<string, { modified: string; model: MatchModel }>()

export async function loadArchive(entry: ArchiveEntry): Promise<MatchModel> {
  const cached = archiveCache.get(entry.path)
  if (cached && cached.modified === entry.modified) return cached.model
  const bytes = await readFile(entry.path)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const parsed = await parseArchiveFile(buffer, entry.file)
  const model = new MatchModel(parsed.archive.matchId)
  model.setMetadata(parsed.metadata ?? parsed.metadataTimeline.at(-1) ?? null)
  model.ingest(parsed.frames)
  archiveCache.clear() // keep one archive in memory
  archiveCache.set(entry.path, { modified: entry.modified, model })
  return model
}
