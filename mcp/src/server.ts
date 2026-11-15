// fm-match-analyst: a read-only MCP server over FMMatchLens's capture of a
// Football Manager match. Runs over stdio for Claude Desktop, Claude Code and Codex.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import * as z from "zod"

import guide from "../analyst/fm-analyst.md"
import { briefing } from "./briefing"
import { changesReport } from "./changes"
import { opponentRead } from "./opponent"
import { defaultRoleWindow, roleReport } from "./roles"
import { chanceStories } from "./sequences"
import { subPlan } from "./subs"
import { checkData, dataWarning } from "./checks"
import { DETAIL_LEVELS, defaultDetail, detailInstructions } from "./detail"
import { type CarryItem, checkActions, lastActions, METRIC_KEYS, METRICS, previousMatches, rememberMatch, saveActions, teamMetrics, warmMatchCache } from "./metrics"
import { setting } from "./env"
import { saveFeedback } from "./feedback"
import { clockLabel } from "./clock"
import type { MatchModel } from "./model"
import { phaseReport } from "./phaseViews"
import { buildHalfTime, buildPostMatch, LIMITS, lengthProblems, missingInputs, saveReport } from "./report"
import { DEFAULT_API, findArchive, listArchives, LiveSource, loadArchive, type ArchiveEntry } from "./sources"
import * as views from "./views"

declare const __VERSION__: string
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev"

const LIVE_WAIT_MS = Number(process.env.FM_ANALYST_LIVE_WAIT_MS ?? 40_000)

type Selection = { kind: "auto" } | { kind: "live" } | { kind: "archive"; entry: ArchiveEntry }

const WARM_DELAY_MS = 20_000

export function createServer(options: { apiUrl?: string; startLive?: boolean } = {}) {
  const live = new LiveSource(options.apiUrl || setting("FMMATCHLENS_API") || DEFAULT_API)
  if (options.startLive !== false) {
    live.start()
    // Fill the cross-match figures in the background while no match is being followed,
    // so the first post-match report never waits on old archives.
    const idle = () => live.status?.status !== "live"
    setTimeout(() => void warmMatchCache(idle).catch(() => undefined), WARM_DELAY_MS).unref()
  }
  let selection: Selection = { kind: "auto" }

  type Current = { model: MatchModel; source: views.SourceInfo; notes: string[] }

  async function current(): Promise<Current | { error: string }> {
    if (selection.kind === "archive") {
      const model = await loadArchive(selection.entry)
      void rememberMatch(model, selection.entry).catch(() => undefined)
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
      if (live.status?.status === "ended" && caughtUp && !live.replayOf) void rememberMatch(live.model).catch(() => undefined)
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
    void rememberMatch(model, newest).catch(() => undefined)
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

  const server = new McpServer({ name: "fm-match-analyst", version: VERSION }, { instructions: guide + detailInstructions() })

  const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  const windowFields = {
    half: z.enum(["first", "second", "extra"]).optional().describe("extra = extra time."),
    from_minute: z.number().int().min(0).max(130).optional().describe("FM minutes: first-half stoppage is 45, the second half starts at 46."),
    to_minute: z.number().int().min(0).max(130).optional(),
    last_minutes: z.number().int().min(1).max(130).optional().describe("The most recent N minutes."),
  }
  const team = z
    .enum(["mine", "opponent", "home", "away", "both"])
    .optional()
    .describe("mine = the user's team; default both.")
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
        "who is tiring, fading, struggling or standing out; tactics with recent changes; whether your latest change is working (before against after); how each goal came about; roles and player instructions that are clearly not happening; both shapes as actually played and the matchups that favour the opponent; the top substitution candidates; the bench; the last 10 minutes' events. The last 15 minutes are set against earlier in the half for both teams.",
      inputSchema: {
        detail: z
          .enum(DETAIL_LEVELS)
          .optional()
          .describe("Level of help the user wants in this chat (default: the install's). hints returns only the game state, what stands out and your last change."),
      },
      annotations: readOnly,
    },
    async ({ detail }) => withMatch(({ model, source }) => briefing(model, source, checkData(model), detail ?? defaultDetail()))
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
    "get_changes",
    {
      title: "Did the change work?",
      description:
        "For each tactical change made during the match (mentality, shape, roles, team instructions): up to 15 minutes before it against up to 15 minutes after it, " +
        "per 10 minutes, for attacking (possession, xG, shots, box and final-third entries, fast breaks), pressing and the defensive line, ball losses, " +
        "and what the team conceded (xG, shots, box entries, fast breaks). Lists what got better, worse or simply moved, and what else happened in those stretches " +
        "(goals, red cards, substitutions, the other side changing) that could explain it. Use when the user asks whether a change worked or what it did. Defaults to the user's team.",
      inputSchema: { team },
      annotations: readOnly,
    },
    async (args) =>
      withMatch(({ model }) => {
        const { sides, note } = views.resolveSides(model, args.team ?? "mine")
        return changesReport(model, sides, note)
      })
  )

  server.registerTool(
    "get_sequences",
    {
      title: "How the chances came about",
      description:
        "Why did that goal happen? For each goal and big chance (clear-cut or 0.3 xG and up), the possession it came from traced back to its start: " +
        "who won the ball and who lost it, and where, or which restart it came from; the players who had the ball on the way; how many passes, how fast, " +
        "and through which channel; and the moment of the shot: the nearest defender, defenders in the way, attackers v defenders in the box, and the defending " +
        "team's line and width against how it usually stood. Then what the chances a team conceded or created have in common. Defaults to both teams, whole match.",
      inputSchema: {
        team: z
          .enum(["mine", "opponent", "home", "away", "both"])
          .optional()
          .describe("Whose chances: mine (the user's team's chances), opponent (chances against the user), home, away or both (default)."),
        which: z.enum(["goals", "big_chances", "both"]).optional().describe("goals only, big chances that were not goals, or both (default)."),
        ...windowFields,
        limit: z.number().int().min(1).max(50).optional().describe("Most chances to tell (latest kept); default 20."),
      },
      annotations: readOnly,
    },
    async (args) =>
      withMatch(({ model }) => {
        const selection = model.select(toWindow(args))
        if (!selection) return { error: "No match data in that window yet." }
        const { sides, note } = views.resolveSides(model, args.team)
        const result = chanceStories(model, sides, selection, args.which ?? "both", args.limit ?? 20)
        return note ? { note, ...result } : result
      })
  )

  server.registerTool(
    "get_roles",
    {
      title: "Are the players doing their jobs?",
      description:
        "Role and instruction check for one team (default: yours). For each player, what his role, duty and player instructions ask, turned into what the capture can measure: " +
        "where he stands with and without the ball (metres from his own goal and from the centre line) and what he does (per-90 counts ranked within the team), " +
        "with a verdict (yes / no / unclear) for each. notHappening lists the clear misses. Defaults to the stretch since your latest tactic change (or the whole match). " +
        "Use when the user asks whether a player or role is working, or why a flank or a midfielder isn't doing what they expect.",
      inputSchema: { team: z.enum(["mine", "opponent", "home", "away"]).optional().describe("Whose players: mine (default), opponent, home or away."), ...windowFields },
      annotations: readOnly,
    },
    async (args) =>
      withMatch(({ model }) => {
        const { sides, note } = views.resolveSides(model, args.team ?? "mine")
        const side = sides[0]
        const custom = args.half != null || args.from_minute != null || args.to_minute != null || args.last_minutes != null
        const selection = custom ? model.select(toWindow(args)) : defaultRoleWindow(model, side)
        if (!selection) return { error: "No match data in that window yet." }
        const result = roleReport(model, side, selection)
        return note ? { ...result, teamNote: `${note} Showing ${views.teamName(model, side)}.` } : result
      })
  )

  server.registerTool(
    "get_opponent_read",
    {
      title: "How the opponent is playing",
      description:
        "A scout's read of one team (default: the opponent) from what happened on the pitch, not from its tactic screen: its shape with and without the ball " +
        "(matched to the nearest FM formation, with who played where), block and line height, pressing, build-up and goal kicks (short or long), where it attacks " +
        "(down your left, middle or right), crosses, who it goes through and who threatens, its transitions, and the matchups against your players with an edge in " +
        "pace, strength or the air. Use early in a match (10-15 minutes in) to confirm or correct the pre-match plan, or whenever the user asks how they are playing.",
      inputSchema: { team: z.enum(["mine", "opponent", "home", "away"]).optional().describe("Whose play to read: opponent (default), mine, home or away."), ...windowFields },
      annotations: readOnly,
    },
    async (args) =>
      withMatch(({ model }) => {
        const selection = model.select(toWindow(args))
        if (!selection) return { error: "No match data in that window yet." }
        const { sides, note } = views.resolveSides(model, args.team ?? "opponent")
        const result = opponentRead(model, sides[0], selection)
        return note ? { ...result, teamNote: `${note} Showing ${views.teamName(model, sides[0])}.` } : result
      })
  )

  server.registerTool(
    "get_sub_plan",
    {
      title: "Who to take off, and who to bring on",
      description:
        "Substitution planner for one team (default: yours). For each player on the pitch: condition now and forecast to the whistle (from how fast it has dropped this half), " +
        "the minute he goes under 65%, rating trend, a yellow card and fouls since, and whether he is losing his individual matchup. Candidates are ordered by how many reasons " +
        "there are to take them off, each with the unused substitutes natural or accomplished in his position. Also the first players to tire, the bench (positions, condition, " +
        "sharpness, key attributes) and the substitutions and windows already used.",
      inputSchema: { team: z.enum(["mine", "opponent", "home", "away"]).optional().describe("Whose team: mine (default), opponent, home or away.") },
      annotations: readOnly,
    },
    async (args) =>
      withMatch(({ model }) => {
        const { sides, note } = views.resolveSides(model, args.team ?? "mine")
        const result = subPlan(model, sides[0])
        return note ? { ...result, teamNote: `${note} Showing ${views.teamName(model, sides[0])}.` } : result
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

  server.registerTool(
    "get_last_actions",
    {
      title: "Did last match's actions work?",
      description:
        "The carry-forward actions saved with the user's last post-match report, each checked against this match so far: the figure it should move, then and now, and done, not yet or worse. " +
        "Use at half-time and full time, or when the user asks whether last week's changes worked.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        const result = await current()
        if ("error" in result) return failure(result.error)
        const side = result.model.userSide() ?? "home"
        const team = views.teamName(result.model, side)
        const saved = await lastActions(team, result.model.matchId)
        if (!saved) return reply({ team, note: "No carry-forward actions saved yet: they come with the next post-match report." })
        return reply({ team, ...checkActions(saved, teamMetrics(result.model, side)), legend: "done: the figure moved the right way by enough to count; not yet: no real change; worse: it moved the wrong way. One match is a small sample." })
      } catch (error) {
        return failure(`Could not check the last actions: ${(error as Error).message}`)
      }
    }
  )

  const line = (limit: number) => z.string().min(1).max(limit)
  server.registerTool(
    "build_report",
    {
      title: "Build a printable report",
      description:
        "Only when the user asks for a report or something to print or keep. Builds the printable post-match report (kind post_match: page 1, what this " +
        "means for us; page 2, the evidence) or the half-time sheet (kind half_time), saved as one HTML page; building it again replaces the file. Every number " +
        "and chart is worked out from the match; you write only the lines that need judgement, so do the analysis first.",
      inputSchema: {
        kind: z.enum(["post_match", "half_time"]).describe("post_match: the one-pager after full time; half_time: the sheet at the break."),
        verdict: z
          .array(z.object({ title: line(LIMITS.verdictTitle), detail: line(LIMITS.verdictDetail) }))
          .max(3)
          .optional()
          .describe("post_match, optional: three short lines for page 2's verdict strip. Left out, page 2 shows the takeaways' titles and what happened."),
        decisions: z
          .array(z.object({ title: line(LIMITS.decisionTitle), evidence: line(LIMITS.decisionEvidence), option: line(LIMITS.decisionOption) }))
          .max(3)
          .optional()
          .describe("half_time, up to three: what to change or keep for the second half, the evidence, and one option FM lets them make (a substitution, role, duty, instruction or mentality)."),
        our_plan: z
          .array(
            z.object({
              instruction: line(LIMITS.planLabel).describe("The instruction as FM names it, short (e.g. 'Engage lower (31\')')."),
              status: z.enum(["seen", "not_seen"]),
              evidence: line(LIMITS.planEvidence).describe("The deciding figure, one short line."),
            })
          )
          .max(4)
          .optional()
          .describe("Both kinds, up to four of the user's team instructions (planVsReality in get_briefing) and whether the numbers show them happening. For one added mid-match, judge only the minutes after it."),
        their_plan: z
          .array(
            z.object({
              label: line(Math.max(LIMITS.planLabel, LIMITS.watchLabel)),
              status: z.enum(["hurt", "contained"]).optional(),
              evidence: line(Math.max(LIMITS.planEvidence, LIMITS.watchEvidence)),
            })
          )
          .max(4)
          .optional()
          .describe(
            `post_match: up to four things the opponent set out to do or changed (get_tactic for the opponent: changes and opposition instructions; get_phases before and after each change), each with status hurt or contained and what it did to the user's team (label up to ${LIMITS.planLabel} characters, evidence up to ${LIMITS.planEvidence}). ` +
              `half_time: up to four things the opponent is doing now (no status; label up to ${LIMITS.watchLabel}, evidence up to ${LIMITS.watchEvidence}). Write "after", not "because": the data shows what followed a change, not the AI's reasons.`
          ),
        flow_events: z
          .array(z.object({ minute: z.number().int().min(0).max(130), label: line(LIMITS.flowLabel) }))
          .max(3)
          .optional()
          .describe("post_match, optional, up to three changes to mark on the timeline, e.g. \"31' Engage lower\" or \"74' LAFC go cautious\" (prefix the opponent's with its name)."),
        players: z
          .array(
            z.object({
              name: z.string().min(1).max(60).describe("As get_players names him."),
              status: z.enum(["watch", "keep"]),
              why: line(LIMITS.personWhy),
              bench: line(LIMITS.personBench).optional().describe("For watch: who could replace him and the attributes that matter, e.g. 'Allen \u00b7 DL \u00b7 Pace 15'. For keep: how to use him."),
            })
          )
          .max(5)
          .optional()
          .describe("half_time, up to five of the user's players: those to watch (booked, tiring, struggling, losing a matchup) and those to keep. Rating and condition at 45' are filled in from the match."),
        headline: line(LIMITS.headline)
          .optional()
          .describe("post_match: one line to the manager on the result against the performance and what it means, with the deciding number (e.g. 'Won 1-0, but the chances were even (1.39 xG v 1.19): a good result, not yet a fixed team')."),
        takeaways: z
          .array(
            z.object({
              tag: z.enum(["keep", "fix", "try"]).describe("keep: working, carry on; fix: costing us; try: an opportunity worth testing."),
              title: line(LIMITS.takeawayTitle),
              happened: line(LIMITS.takeawayHappened).describe("What happened, with a number from the tools."),
              why: line(LIMITS.takeawayWhy).describe("The mechanism behind it, from the tools (get_sequences, get_roles, get_changes, get_opponent_read, get_phases). Say 'after', not 'because', unless the data shows the cause."),
              action: line(LIMITS.takeawayAction).describe("What to do next match, in FM's terms: an instruction, role, duty, opposition instruction, training focus or selection."),
              metric: z.enum(METRIC_KEYS).optional().describe("The team figure that best tracks this takeaway; shown against the last five matches."),
            })
          )
          .max(3)
          .optional()
          .describe("post_match, exactly three: what this match means for us. The report's page 1 is built around them; page 2 is the evidence."),
        carry_forward: z
          .array(
            z.object({
              area: z.enum(["tactic", "training", "selection", "recruitment"]),
              action: line(LIMITS.carryAction),
              check_metric: z.enum(METRIC_KEYS).optional().describe("The team figure that shows next match whether the action worked."),
              check_target: z.enum(["up", "down"]).optional().describe("Which way that figure should move."),
            })
          )
          .max(5)
          .optional()
          .describe("post_match, 1-5 actions to carry into the next match. They are saved, and get_last_actions checks them against the next match. Recruitment only for a problem that keeps coming back across matches."),
        outlook: z
          .array(
            z.object({
              name: z.string().min(1).max(60).describe("As get_players names him."),
              outlook: z.enum(["rest", "start", "watch", "form"]).describe("rest: needs a break; start: has earned a start; watch: a concern; form: a dip across matches."),
              why: line(LIMITS.outlookWhy),
            })
          )
          .max(5)
          .optional()
          .describe("post_match, up to five players to rest, start or watch next match. Rating and condition at the whistle are filled in from the match."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const label = args.kind === "post_match" ? "post-match" : "half-time"
      const missing = missingInputs(args.kind, args)
      if (missing.length > 0) return failure(`To build the ${label} report, also pass: ${missing.join("; ")}.`)
      const tooLong = lengthProblems(args.kind, args)
      if (tooLong.length > 0) return failure(`Shorten these to fit the page: ${tooLong.join("; ")}.`)
      try {
        const result = await current()
        if ("error" in result) return failure(result.error)
        const warning = dataWarning(checkData(result.model))
        if (warning) return failure(`${warning} No report was built.`)
        const notes = [...result.notes]
        let html: string
        let title: string
        if (args.kind === "post_match") {
          const side = result.model.userSide() ?? "home"
          const team = views.teamName(result.model, side)
          const previous = await previousMatches(team, result.model.matchId).catch(() => [])
          const lastTime = await lastActions(team, result.model.matchId)
          const built = buildPostMatch(result.model, result.source, args, { previous, lastTime })
          notes.push(...built.notes)
          html = built.html
          title = built.title
          const items = (args.carry_forward ?? []).map((row) => ({
            area: row.area,
            action: row.action,
            check: row.check_metric ? { metric: row.check_metric, target: row.check_target ?? (METRICS[row.check_metric].better === "up" ? "up" : "down") } : undefined,
          })) as CarryItem[]
          await saveActions(result.model, built.side, items, built.metrics)
          if (items.length > 0) notes.push(`Saved ${items.length} carry-forward action${items.length === 1 ? "" : "s"}; get_last_actions checks them during the next match.`)
        } else {
          const built = buildHalfTime(result.model, result.source, args)
          notes.push(...built.notes)
          html = built.html
          title = built.title
        }
        const file = await saveReport(result.model, args.kind, html)
        return reply({
          saved: file,
          report: label,
          match: title,
          open: "Open the file in a browser to see it; print it landscape on US Letter or save it as a PDF.",
          ...(notes.length > 0 ? { notes } : {}),
        })
      } catch (error) {
        return failure(`Could not build the report: ${(error as Error).message}`)
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
              "Who should I substitute and who should come on? Start with get_sub_plan for my team (condition forecast, cards, form, matchups and bench options), " +
              "weigh it against the game state from get_briefing, and use get_players with include_attributes to compare a replacement with the player he would replace.",
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

  server.registerPrompt(
    "post_match_report",
    {
      title: "Post-match report",
      description: "The printable report after full time: page 1, what this means for us (takeaways, actions to carry forward, trends, player outlook); page 2, the evidence.",
      argsSchema: { match: z.string().optional().describe("Archive to report on (file name or words); default: the current or newest match.") },
    },
    ({ match }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              (match ? `Load the match "${match}" with load_match. ` : "") +
              "Build my post-match report. First do the analysis: get_briefing; get_phases for both teams over the whole match and each half; get_tactic for my team; " +
              "get_sequences for the goals and big chances; get_roles; get_opponent_read; get_changes; get_last_actions; get_events for goals, shots and turnovers. " +
              "Then call build_report with kind post_match. Page 1 is what this means for us: a headline (the result against the performance, and what it means); three " +
              "takeaways, each tagged keep, fix or try, with what happened (a number), why (the mechanism the tools show), the action for next match in FM's terms, and " +
              "the team figure that tracks it; one to five carry-forward actions with their area and the figure to check next match; and up to five players to rest, start " +
              "or watch. Page 2 is the evidence: four of my team instructions as seen or not seen with the deciding figure; four things the opponent did or changed, each " +
              "hurt or contained with what it did to us, saying \"after\", not \"because\"; and up to three changes to mark on the timeline. Then tell me where the file is " +
              "in one line, and anything the report could not cover.",
          },
        },
      ],
    })
  )

  server.registerPrompt(
    "half_time_report",
    {
      title: "Half-time report",
      description: "The printable half-time sheet: three decisions for the second half, how the half turned, what the opponent is doing, the plan so far, players and bench.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Build my half-time sheet. Start with get_briefing; then get_phases for both teams for 0-30 and 31-45, get_tactic for both teams, and get_players for my " +
              "team with include_unused_subs and include_attributes (condition read with to_minute 45, before the half-time recovery) and for the opponent's key players. " +
              "Then call build_report with kind half_time and: three decisions for the second half, each with its evidence and one option FM lets me make; up to four " +
              "things the opponent is doing now; up to four of my instructions as seen or not seen in the first half; and up to five of my players, those to watch " +
              "(booked, tiring, struggling, losing a matchup) with a bench option and the attributes that matter, and those to keep. Then tell me where the file is in one line.",
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
