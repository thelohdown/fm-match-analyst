// fm-match-analyst: a read-only MCP server over FMMatchLens's capture of a
// Football Manager match. Runs over stdio for Claude Desktop, Claude Code and Codex.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import * as z from "zod"

import guide from "../analyst/fm-analyst.md"
import { briefing } from "./briefing"
import { checkData, dataWarning } from "./checks"
import { saveFeedback } from "./feedback"
import { clockLabel } from "./clock"
import type { MatchModel } from "./model"
import { phaseReport } from "./phaseViews"
import { DEFAULT_API, findArchive, listArchives, LiveSource, loadArchive, type ArchiveEntry } from "./sources"
import * as views from "./views"

declare const __VERSION__: string
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev"

const LIVE_WAIT_MS = Number(process.env.FM_ANALYST_LIVE_WAIT_MS ?? 40_000)

type Selection = { kind: "auto" } | { kind: "live" } | { kind: "archive"; entry: ArchiveEntry }

export function createServer(options: { apiUrl?: string; startLive?: boolean } = {}) {
  const live = new LiveSource(options.apiUrl || process.env.FMMATCHLENS_API || DEFAULT_API)
  if (options.startLive !== false) live.start()
  let selection: Selection = { kind: "auto" }

  type Current = { model: MatchModel; source: views.SourceInfo; notes: string[] }

  async function current(): Promise<Current | { error: string }> {
    if (selection.kind === "archive") {
      const model = await loadArchive(selection.entry)
      return { model, source: { kind: "archive", detail: selection.entry.file }, notes: [] }
    }
    const caughtUp = await live.ready(LIVE_WAIT_MS)
    if (live.model && live.model.frameCount > 0) {
      const notes: string[] = []
      const progress = live.progress()
      if (!caughtUp || progress < 0.995) {
        notes.push(
          `Still reading this match from FMMatchLens (${Math.round(progress * 100)}% so far); figures run to ${clockLabel(
            live.model.lastClockSeconds,
            live.model.buckets.at(-1)?.period ?? live.model.last?.period ?? 1
          )}. Ask again shortly for the rest.`
        )
      }
      if (live.replayOf) {
        notes.unshift(
          `This is NOT the match in FM: FMMatchLens's API is ./mac/dev.sh serve replaying the saved match ${live.replayOf}. ` +
            "Tell the user; to analyse the game, stop the replay (Ctrl+C in its terminal) and start or resume the match in FM."
        )
      }
      return { model: live.model, source: { kind: "live", detail: live.status?.status ?? "unknown", replayOf: live.replayOf }, notes }
    }
    if (selection.kind === "live") {
      return { error: live.lastError ?? "FMMatchLens has not captured a match yet. Start a match in FM; capture begins at kickoff." }
    }
    const newest = (await listArchives())[0]
    if (!newest) {
      return {
        error:
          `${live.lastError ?? "FMMatchLens has not captured a match yet."} No saved match archives were found either ` +
          "(set FMMATCHLENS_ARCHIVE_DIR to the folder with the .fmlens files).",
      }
    }
    const model = await loadArchive(newest)
    return {
      model,
      source: { kind: "archive", detail: newest.file },
      notes: [`No live match from FMMatchLens, so this is the newest saved match: ${newest.file}. Use list_matches/load_match to pick another.`],
    }
  }

  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] })
  const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true })

  async function withMatch(build: (current: Current) => unknown) {
    try {
      const result = await current()
      if ("error" in result) return failure(result.error)
      const warning = dataWarning(checkData(result.model))
      const notes = warning ? [warning, ...result.notes] : result.notes
      const body = build(result) as Record<string, unknown>
      return reply(notes.length > 0 ? { notes, ...body } : body)
    } catch (error) {
      return failure(`Could not read the match: ${(error as Error).message}`)
    }
  }

  const server = new McpServer({ name: "fm-match-analyst", version: VERSION }, { instructions: guide })

  const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  const windowFields = {
    half: z.enum(["first", "second", "extra"]).optional().describe("Only this half (extra = extra time)."),
    from_minute: z.number().int().min(0).max(130).optional().describe("First match minute to include (FM minutes; first-half stoppage counts as 45, the second half starts at 46)."),
    to_minute: z.number().int().min(0).max(130).optional().describe("Last match minute to include."),
    last_minutes: z.number().int().min(1).max(130).optional().describe("Only the most recent N minutes of play."),
  }
  const team = z
    .enum(["mine", "opponent", "home", "away", "both"])
    .optional()
    .describe("Whose data: mine (the user's team), opponent, home, away or both (default).")
  const toWindow = (args: { half?: "first" | "second" | "extra"; from_minute?: number; to_minute?: number; last_minutes?: number }) => ({
    half: args.half,
    fromMinute: args.from_minute,
    toMinute: args.to_minute,
    lastMinutes: args.last_minutes,
  })

  server.registerTool(
    "get_match_state",
    {
      title: "Match state",
      description:
        "Start here. Score, clock, which team the user manages, xG and shots, possession (whole match and last 10 minutes), FM's momentum by five minutes and lately, goals, cards, substitutions, and notes on what data is missing.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => withMatch(({ model, source }) => views.matchState(model, source))
  )

  server.registerTool(
    "get_briefing",
    {
      title: "Briefing",
      description:
        "Start here for 'what should I do?' or a half-time talk. The whole picture in one call, organised by the moments of the game: " +
        "game state (score, time left, momentum, mentalities); what stands out (problems and what is working, measured against the opponent and earlier); " +
        "in possession (build-up/progression/final-third time, how often possessions reach the final third and box and through which channel, chance quality, crossing, passing); " +
        "out of possession (block and line height, where the opponent gets in, pressing, duels); transitions (regains, fast breaks, losses, counter-pressing, " +
        "shots within 15 s either way); set pieces; whether the tactic's team instructions are happening; shots in the last 20 minutes with how each came about; " +
        "who is tiring, fading, struggling or standing out; tactics with recent changes; the bench; the last 10 minutes' events. The last 15 minutes are set against earlier in the half for both teams.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => withMatch(({ model, source }) => briefing(model, source, checkData(model)))
  )

  server.registerTool(
    "get_phases",
    {
      title: "Phases of play",
      description:
        "The moments of the game for any stretch of play: in possession (time in build-up, progression and final third; possessions reaching the final third and box; " +
        "final-third entries by channel; shots by quality; crossing; long passing; width), out of possession (block and defensive line height for each opponent phase, " +
        "compactness, where the opponent reaches the final third against your flanks, box entries conceded, pressing, tackles and aerials), transitions " +
        "(open-play regains, fast breaks, losses per 10 minutes on the ball, losses in your own third, won back within 5 s, shots within 15 s either way) and set pieces.",
      inputSchema: { team, ...windowFields },
      annotations: readOnly,
    },
    async (args) =>
      withMatch(({ model }) => {
        const selection = model.select(toWindow(args))
        if (!selection) return { error: "No match data in that window yet." }
        const { sides, note } = views.resolveSides(model, args.team)
        return phaseReport(model, sides, selection, note)
      })
  )

  server.registerTool(
    "get_team_stats",
    {
      title: "Team stats",
      description:
        "Team stats per half (default), per 15 minutes, or for one window: goals, xG, shots on/off target and blocked, clear-cut chances, possession, territory by third, passes and completion, progressive and final-third passes, crosses, corners, aerials, tackles, fouls, offsides, cards.",
      inputSchema: {
        split: z.enum(["half", "15min", "none"]).optional().describe("half (default), 15min, or none for just the window total."),
        ...windowFields,
      },
      annotations: readOnly,
    },
    async (args) => withMatch(({ model }) => views.teamStats(model, args.split ?? "half", toWindow(args)))
  )

  server.registerTool(
    "get_players",
    {
      title: "Players",
      description:
        "Per player: position and role (from the tactic, or inferred from where he played), natural positions, whether they started or came on/off and when, minutes, FM match rating (and its change over the window), physical condition % and sharpness (and change), and their stats over the window: goals, assists, xG, xA, shots, key passes, passes, progressive passes, crosses, dribbles, tackles, interceptions, clearances, aerials, fouls, distance, saves, cards. Optionally attributes.",
      inputSchema: {
        team,
        include_unused_subs: z.boolean().optional().describe("Also list substitutes who have not played (to pick who to bring on)."),
        include_attributes: z.boolean().optional().describe("Add each player's attributes (FM's 1-20 values) and height, e.g. to compare a substitute with a tiring starter or a matchup."),
        ...windowFields,
      },
      annotations: readOnly,
    },
    async (args) =>
      withMatch(({ model }) => views.players(model, args.team, toWindow(args), args.include_unused_subs ?? false, args.include_attributes ?? false))
  )

  server.registerTool(
    "get_events",
    {
      title: "Match events",
      description:
        "Chronological events with FM minutes. Default types: goals, shots (xG, outcome, location, clear-cut chances), cards, subs. Also available: chances (only big chances: clear-cut or xG 0.3+), corners, fouls, offsides, saves, key_passes, turnovers (possession lost, with where).",
      inputSchema: {
        types: z.array(z.enum(views.ALL_EVENT_TYPES)).optional().describe("Which kinds of event; default goals, shots, cards, subs."),
        team,
        limit: z.number().int().min(1).max(500).optional().describe("Most events to return (latest first kept); default 80."),
        ...windowFields,
      },
      annotations: readOnly,
    },
    async (args) =>
      withMatch(({ model }) => views.events(model, args.types ?? views.DEFAULT_EVENT_TYPES, args.team, toWindow(args), args.limit ?? 80))
  )

  server.registerTool(
    "get_shape",
    {
      title: "Shape and passing",
      description:
        "How a team was set up in practice over a window: each player's average position in and out of possession, defensive line height, length, width and average height, territory, the pass network (top connections, most-found players), and where the ball is lost and won.",
      inputSchema: { team, ...windowFields },
      annotations: readOnly,
    },
    async (args) => withMatch(({ model }) => views.shape(model, args.team, toWindow(args)))
  )

  server.registerTool(
    "get_tactic",
    {
      title: "Tactic",
      description:
        "The tactic FM is applying, as FMMatchLens captured it: name, style, mentality, formation in and out of possession, team and transition instructions, each player's position, role and duty in both phases with player instructions, opposition instructions, and every change made during the match.",
      inputSchema: { team },
      annotations: readOnly,
    },
    async (args) => withMatch(({ model }) => views.tactic(model, args.team))
  )

  server.registerTool(
    "list_matches",
    {
      title: "List matches",
      description: "The live match FMMatchLens is capturing (if any) and the saved match archives, newest first, and which one the tools are reading.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Most archives to list; default 20.") },
      annotations: readOnly,
    },
    async (args) => {
      await live.ready(3000)
      const archives = await listArchives()
      const model = live.model
      return reply({
        reading:
          selection.kind === "archive" ? `archive ${selection.entry.file}` : selection.kind === "live" ? "the live match" : "the live match, or the newest archive when there is none",
        live: live.status?.matchId
          ? {
              status: live.status.status,
              match: model?.metadata ? `${model.metadata.home.name} v ${model.metadata.away.name}` : live.status.matchId,
              clock: model?.last ? clockLabel(model.lastClockSeconds, model.buckets.at(-1)?.period ?? model.last.period) : undefined,
              read: `${Math.round(live.progress() * 100)}%`,
            }
          : (live.lastError ?? "no match captured yet"),
        archives: archives.slice(0, args.limit ?? 20).map(({ path: _path, ...entry }) => entry),
        totalArchives: archives.length,
      })
    }
  )

  server.registerTool(
    "load_match",
    {
      title: "Load match",
      description:
        'Choose what the other tools read: "live" for the match FMMatchLens is capturing, "auto" (default: live, else newest archive), "latest" for the newest archive, or an archive by file name or words in it (e.g. "LAFC", "2025-12-30").',
      inputSchema: { match: z.string().min(1).describe('"live", "auto", "latest", or an archive file name or search words.') },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ match }) => {
      const wanted = match.trim().toLowerCase()
      if (wanted === "live" || wanted === "auto") {
        selection = { kind: wanted }
        return withMatch(({ model, source }) => ({ loaded: wanted, ...views.matchState(model, source) }))
      }
      const entry = await findArchive(match)
      if (!entry) return failure(`No archive matches "${match}". list_matches shows what there is.`)
      selection = { kind: "archive", entry }
      return withMatch(({ model, source }) => ({ loaded: entry.file, ...views.matchState(model, source) }))
    }
  )

  server.registerTool(
    "note_feedback",
    {
      title: "Save feedback",
      description:
        "Save the user's verdict on an answer (useful, partly useful, not useful, wrong) with their words, the question and a short summary of what you advised, together with the match situation. Call it when the user says an answer was good, bad or wrong, or asks to note something. It only writes a local file.",
      inputSchema: {
        verdict: z.enum(["useful", "partly useful", "not useful", "wrong"]).describe("The user's verdict."),
        note: z.string().min(1).max(2000).describe("What the user said, in their words."),
        question: z.string().max(1000).optional().describe("The question the answer was for."),
        answer_summary: z.string().max(2000).optional().describe("A short summary of what you advised."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ verdict, note, question, answer_summary }) => {
      try {
        let match: Record<string, unknown> | undefined
        const result = await current().catch(() => undefined)
        if (result && !("error" in result)) {
          const state = views.matchState(result.model, result.source)
          match = { id: result.model.matchId, score: state.score, minute: state.minute, clock: state.clock, source: state.source, youManage: state.youManage }
        }
        const saved = await saveFeedback({ savedAt: new Date().toISOString(), verdict, note, question, answer: answer_summary, match })
        return reply({ saved: true, file: saved.file, feedbackSoFar: saved.total })
      } catch (error) {
        return failure(`Could not save the feedback: ${(error as Error).message}`)
      }
    }
  )

  server.registerPrompt(
    "half_time_briefing",
    {
      title: "Half-time briefing",
      description: "What is working, what is not, and two or three changes, from the live match data.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Give me a briefing on my match as it stands (start with get_briefing): go through each moment of the game (in possession, out of possession, " +
              "transitions, set pieces) in the light of the score and time left, say what is working and what is not, who is tiring or struggling, " +
              "and give two or three concrete changes with the evidence for each and what to watch afterwards.",
          },
        },
      ],
    })
  )

  server.registerPrompt(
    "who_to_sub",
    {
      title: "Who to substitute",
      description: "Who is tiring or under-performing, and who on the bench to bring on.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Who should I substitute and who should come on? Use get_players for my team (with include_unused_subs) and the last 15 minutes, " +
              "look at condition, rating trend and output, and check get_shape for where the replacement would need to play.",
          },
        },
      ],
    })
  )

  server.registerPrompt(
    "match_review",
    {
      title: "Match review",
      description: "A full-time review of a finished match: how it was won or lost, phase by phase.",
      argsSchema: { match: z.string().optional().describe("Archive to review (file name or words); default: the current or newest match.") },
    },
    ({ match }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              (match ? `Load the match "${match}" with load_match, then review` : "Review") +
              " the match moment by moment: in possession, out of possession, transitions and set pieces for both teams (get_phases by half), " +
              "how the game swung (get_team_stats per 15 minutes), the chances each side made and how they came about, which players stood out or struggled, " +
              "and the two or three lessons for the next match.",
          },
        },
      ],
    })
  )

  server.registerResource(
    "analyst-guide",
    "fm-match-analyst://guide",
    { title: "FM match analyst guide", description: "How to analyse a Football Manager match with these tools.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide }] })
  )

  return { server, live }
}

async function main() {
  const { server } = createServer()
  await server.connect(new StdioServerTransport())
  console.error(`fm-match-analyst ${VERSION} running on stdio`)
}

const invokedDirectly = process.argv[1] && /server\.(mjs|js|ts)$/.test(process.argv[1])
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
