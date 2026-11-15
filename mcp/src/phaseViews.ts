// The phases of play as the tools present them: one block per moment (in
// possession, out of possession, transitions, set pieces), each team set against
// the other and against an earlier stretch; what stands out, worked out here so
// that no single number gets more weight than it deserves; and whether what the
// manager asked for in the tactic is what is happening on the pitch.

import { decodeTeamInstructions } from "@/components/formation/tactics"
import type { TacticalConfiguration } from "@/types/match"

import { type MatchModel, other, type Side, SIDES, type WindowSelection } from "./model"
import { blockName, PhaseContext, phases, type ShotSummary, type TeamPhases } from "./phases"
import { pct, round, sideLabel, teamDiff, teamName, tickRange, windowInfo } from "./views"

export type WindowPhases = {
  selection: WindowSelection
  /** Match minutes covered. */
  minutes: number
  teams: Record<Side, TeamPhases>
  /** FM's own counters over the window. */
  counters: Record<Side, Counters>
}

type Counters = {
  possessionPct?: number
  passCompletionPct?: number
  progressivePasses: number
  tackles: { won: number; attempted: number }
  aerials: { won: number; attempted: number }
  fouls: number
  corners: number
  xg: number
  shots: number
  goals: number
}

export function windowPhases(context: PhaseContext, selection: WindowSelection): WindowPhases {
  const counters = {} as Record<Side, Counters>
  for (const side of SIDES) {
    const d = (name: Parameters<typeof teamDiff>[2]) => teamDiff(selection, side, name)
    const own = d("possessionTime")
    const theirs = teamDiff(selection, other(side), "possessionTime")
    counters[side] = {
      possessionPct: pct(own, own + theirs) ?? undefined,
      passCompletionPct: pct(d("passesCompleted"), d("passes")) ?? undefined,
      progressivePasses: d("progressivePasses"),
      tackles: { won: d("tacklesWon"), attempted: d("tacklesAttempted") },
      aerials: { won: d("aerialsWon"), attempted: d("aerials") },
      fouls: d("fouls"),
      corners: d("corners"),
      xg: d("xg"),
      shots: d("shots"),
      goals: d("goals"),
    }
  }
  const teams = phases(context, tickRange(selection), { home: counters.home.corners, away: counters.away.corners })
  return { selection, minutes: selection.buckets.length, teams, counters }
}

// ---------------------------------------------------------------------------
// One block per moment

const shotText = (summary: ShotSummary) =>
  summary.shots === 0 ? "none" : `${summary.shots} (${round(summary.xg)} xG${summary.goals ? `, ${summary.goals} goal${summary.goals > 1 ? "s" : ""}` : ""})`
const pair = (won: number, attempted: number) => `${won}/${attempted}`
const share = (part: number, whole: number) => (whole > 0 ? `${part} of ${whole}` : "0")
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
const ppdaText = (value: number | undefined) => (value == null ? "no tackles or interceptions high up" : `ppda ${value}`)

export function inPossessionView(window: WindowPhases, side: Side) {
  const team = window.teams[side].inPossession
  const counters = window.counters[side]
  const entries = team.finalThirdEntries
  const allShots = team.shots.settled.shots + team.shots.transition.shots + team.shots.setPiece.shots
  const allXg = team.shots.settled.xg + team.shots.transition.xg + team.shots.setPiece.xg
  return {
    possessionPct: counters.possessionPct,
    possessions: team.possessions,
    phaseSplit:
      team.buildUpPct == null
        ? undefined
        : `build-up ${team.buildUpPct}% / progression ${team.progressionPct}% / final third ${team.finalThirdPct}% / transition ${team.transitionPct}%`,
    reachedFinalThird: share(team.reachedFinalThird, team.possessions),
    reachedBox: share(team.reachedBox, team.possessions),
    endedInShot: share(team.endedInShot, team.possessions),
    finalThirdEntriesBy: `left ${entries.left} / centre ${entries.centre} / right ${entries.right}`,
    shots: allShots === 0 ? "none" : `${allShots} (${round(allXg)} xG, ${round(allXg / allShots)} per shot)`,
    shotsFromOutsideBoxPct: team.shotsFromOutsideBoxPct,
    passCompletionPct: counters.passCompletionPct,
    progressivePasses: counters.progressivePasses,
    longPassPct: team.longPassPct,
    openPlayCrosses: `left ${pair(team.openPlayCrosses.left.completed, team.openPlayCrosses.left.attempted)}, right ${pair(team.openPlayCrosses.right.completed, team.openPlayCrosses.right.attempted)}`,
    widthM: team.widthM,
  }
}

export function outOfPossessionView(window: WindowPhases, side: Side) {
  const team = window.teams[side].outOfPossession
  const counters = window.counters[side]
  const opponent = window.teams[other(side)].inPossession
  const line = team.defensiveLineM
  const theirShots = opponent.shots.settled.shots + opponent.shots.transition.shots + opponent.shots.setPiece.shots
  const theirXg = opponent.shots.settled.xg + opponent.shots.transition.xg + opponent.shots.setPiece.xg
  return {
    block: team.block,
    defensiveLineM:
      line.whenTheyProgress == null
        ? undefined
        : `${line.whenTheyBuildUp ?? "n/a"} when they build up / ${line.whenTheyProgress} when they are in midfield / ${line.whenInOwnThird ?? "n/a"} in your third`,
    lengthM: team.lengthM,
    widthM: team.widthM,
    opponentPhaseSplit:
      team.opponentBuildUpPct == null
        ? undefined
        : `their build-up ${team.opponentBuildUpPct}% / midfield ${team.opponentProgressionPct}% / your third ${team.opponentFinalThirdPct}% / transition ${team.opponentTransitionPct}%`,
    ppda: team.ppda,
    highRegains: team.highRegains,
    opponentReachedFinalThirdVia: `your left ${team.opponentEntries.ourLeft} / centre ${team.opponentEntries.centre} / your right ${team.opponentEntries.ourRight}`,
    opponentReachedBox: team.opponentBoxEntries,
    shotsConceded: theirShots === 0 ? "none" : `${theirShots} (${round(theirXg)} xG)`,
    tackles: pair(counters.tackles.won, counters.tackles.attempted),
    aerials: pair(counters.aerials.won, counters.aerials.attempted),
    fouls: counters.fouls,
  }
}

export function transitionsView(window: WindowPhases, side: Side) {
  const attacking = window.teams[side].attackingTransition
  const defending = window.teams[side].defensiveTransition
  return {
    afterWinningIt: {
      openPlayRegains: attacking.openPlayRegains,
      fastBreaks: attacking.counters,
      shotsWithin15s: shotText(attacking.shots),
    },
    afterLosingIt: {
      possessionsLostInOpenPlay: share(defending.openPlayLosses, window.teams[side].inPossession.possessions),
      lostInOwnThird: defending.lostInOwnThird,
      wonBackWithin5s: share(defending.regainedWithin5s, defending.openPlayLosses),
      opponentFastBreaks: defending.opponentCounters,
      opponentShotsWithin15s: shotText(defending.opponentShots),
    },
  }
}

export function setPiecesView(window: WindowPhases, side: Side) {
  const team = window.teams[side].setPieces
  return {
    corners: team.corners,
    freeKicksWonInFinalThird: team.freeKicksWonInFinalThird,
    shots: shotText(team.shots),
    conceded: shotText(team.against),
  }
}

export const PHASE_LEGEND =
  "Phases follow the moments analysts use: in possession (build-up = ball in your own third, progression = middle third, final third; " +
  "transition = the first 8 s after winning the ball in open play), out of possession (block from your defensive line in metres from your own goal " +
  "while they are in midfield: under 25 low, 25-37 mid, over 37 high), transitions (open-play regains and losses; fast break = won in your own half " +
  "and in the final third within 10 s) and set pieces. Phase shares are of ball-in-play time. Left/right are as the team attacks; " +
  "the opponent's entries are shown against your flanks. ppda = opponent passes in its own 60% per tackle, interception or foul of yours there " +
  "(lower = more pressing; compare teams and spells, FM's values run higher than real football). 'n of m' counts possessions."

// ---------------------------------------------------------------------------
// What stands out

export type Finding = { moment: string; finding: string; weight: number }

const per10 = (value: number, minutes: number) => (minutes > 0 ? (value / minutes) * 10 : 0)
const shots = (team: TeamPhases) => team.inPossession.shots.settled.shots + team.inPossession.shots.transition.shots + team.inPossession.shots.setPiece.shots
const xg = (team: TeamPhases) => team.inPossession.shots.settled.xg + team.inPossession.shots.transition.xg + team.inPossession.shots.setPiece.xg

/**
 * Problems and things that are working for one team over the recent stretch,
 * measured against the opponent and against the earlier stretch. Each rule
 * needs enough events to mean something, so a quiet spell yields few findings.
 */
export function findings(model: MatchModel, side: Side, recent: WindowPhases, earlier: WindowPhases | undefined, whole: WindowPhases) {
  const problems: Finding[] = []
  const working: Finding[] = []
  const opponent = other(side)
  const us = recent.teams[side]
  const them = recent.teams[opponent]
  const before = earlier?.teams[side]
  const themBefore = earlier?.teams[opponent]
  const they = teamName(model, opponent)
  const span = `in the last ${recent.minutes} minutes`
  const minutes = recent.minutes
  const earlierMinutes = earlier?.minutes ?? 0

  // In possession
  const ourShots = shots(us)
  const ourXg = xg(us)
  if (ourShots >= 4 && ourXg / ourShots < 0.08) {
    problems.push({
      moment: "in possession",
      finding: `Low-quality chances: ${ourShots} shots worth ${round(ourXg)} xG ${span} (${round(ourXg / ourShots)} per shot)${
        us.inPossession.shotsFromOutsideBoxPct != null ? `, ${us.inPossession.shotsFromOutsideBoxPct}% from outside the box` : ""
      }.`,
      weight: 3,
    })
  }
  if (us.inPossession.reachedFinalThird >= 6 && us.inPossession.reachedBox / us.inPossession.reachedFinalThird < 0.4) {
    problems.push({
      moment: "in possession",
      finding: `Reaching the final third but not the box: ${us.inPossession.reachedFinalThird} possessions got there ${span}, only ${us.inPossession.reachedBox} reached the box.`,
      weight: 2,
    })
  }
  if (before && earlierMinutes >= 8 && us.seconds.inPlayOnBall >= 120 && before.seconds.inPlayOnBall >= 120) {
    const now = (us.inPossession.reachedFinalThird / us.seconds.inPlayOnBall) * 600
    const then = (before.inPossession.reachedFinalThird / before.seconds.inPlayOnBall) * 600
    if (then >= 4 && now <= then * 0.65) {
      problems.push({
        moment: "in possession",
        finding: `Progression has dropped: ${round(now, 1)} possessions reaching the final third per 10 minutes on the ball ${span}, down from ${round(then, 1)} earlier.`,
        weight: 3,
      })
    } else if (then > 0 && now >= then * 1.5 && now >= 5) {
      working.push({ moment: "in possession", finding: `Getting forward more: ${round(now, 1)} final-third possessions per 10 minutes on the ball ${span}, up from ${round(then, 1)}.`, weight: 2 })
    }
  }
  const entries = us.inPossession.finalThirdEntries
  const entryTotal = entries.left + entries.centre + entries.right
  if (entryTotal >= 8) {
    const top = (["left", "centre", "right"] as const).reduce((best, channel) => (entries[channel] > entries[best] ? channel : best), "left" as "left" | "centre" | "right")
    if (entries[top] / entryTotal >= 0.6) {
      problems.push({
        moment: "in possession",
        finding: `Attacks lean on one side: ${entries[top]} of ${entryTotal} final-third entries came through the ${top} ${span}.`,
        weight: 1,
      })
    }
  }
  for (const flank of ["left", "right"] as const) {
    const crosses = us.inPossession.openPlayCrosses[flank]
    if (crosses.attempted >= 6 && crosses.completed / crosses.attempted < 0.25) {
      const aerials = recent.counters[side].aerials
      problems.push({
        moment: "in possession",
        finding: `Crossing from the ${flank} is not working: ${crosses.completed}/${crosses.attempted} open-play crosses found a team-mate ${span}${
          aerials.attempted >= 6 ? ` (aerials won ${aerials.won}/${aerials.attempted})` : ""
        }.`,
        weight: 2,
      })
    }
  }
  if (us.attackingTransition.shots.xg >= 0.3 && us.attackingTransition.shots.xg >= ourXg * 0.5) {
    working.push({ moment: "attacking transition", finding: `Your best chances come on the break: ${round(us.attackingTransition.shots.xg)} of your ${round(ourXg)} xG ${span} came within 15 s of winning the ball.`, weight: 2 })
  }
  if (us.attackingTransition.counters >= 3 && us.attackingTransition.shots.shots === 0) {
    problems.push({ moment: "attacking transition", finding: `Breaking but not finishing: ${plural(us.attackingTransition.counters, "fast break")} ${span}, no shots from them.`, weight: 1 })
  }

  // Out of possession
  const theirShots = shots(them)
  const theirXg = xg(them)
  const theirBoxRate = per10(them.inPossession.reachedBox, minutes)
  if (themBefore && earlierMinutes >= 8) {
    const before10 = per10(themBefore.inPossession.reachedBox, earlierMinutes)
    if (them.inPossession.reachedBox >= 5 && theirBoxRate >= before10 * 1.5) {
      problems.push({
        moment: "out of possession",
        finding: `${they} are getting into your box more: ${them.inPossession.reachedBox} times ${span} (${round(theirBoxRate, 1)} per 10 minutes, up from ${round(before10, 1)}).`,
        weight: 3,
      })
    }
  }
  const against = us.outOfPossession.opponentEntries
  const againstTotal = against.ourLeft + against.centre + against.ourRight
  if (againstTotal >= 7) {
    const top = (["ourLeft", "centre", "ourRight"] as const).reduce((best, channel) => (against[channel] > against[best] ? channel : best), "ourLeft" as "ourLeft" | "centre" | "ourRight")
    if (against[top] / againstTotal >= 0.6) {
      const where = top === "ourLeft" ? "your left" : top === "ourRight" ? "your right" : "the middle"
      problems.push({ moment: "out of possession", finding: `${they} are attacking down ${where}: ${against[top]} of their ${againstTotal} final-third entries ${span}.`, weight: 2 })
    }
  }
  if (theirXg >= 0.5 && theirXg > ourXg) {
    problems.push({ moment: "out of possession", finding: `${they} are creating more: ${round(theirXg)} xG from ${plural(theirShots, "shot")} ${span}, against your ${round(ourXg)} xG.`, weight: 3 })
  } else if (theirShots <= 1 && theirXg < 0.15 && minutes >= 10 && them.inPossession.possessions >= 5) {
    working.push({ moment: "out of possession", finding: `Keeping ${they} quiet: ${theirShots} shot${theirShots === 1 ? "" : "s"} (${round(theirXg)} xG) ${span}.`, weight: 2 })
  }
  const aerials = recent.counters[side].aerials
  if (aerials.attempted >= 8 && aerials.won / aerials.attempted < 0.4) {
    problems.push({ moment: "out of possession", finding: `Losing in the air: ${aerials.won}/${aerials.attempted} aerial duels won ${span}.`, weight: 1 })
  }
  const tackles = recent.counters[side].tackles
  const theirTackles = recent.counters[opponent].tackles
  if (theirTackles.attempted >= 6 && tackles.attempted <= theirTackles.attempted / 2) {
    problems.push({
      moment: "out of possession",
      finding: `Hardly tackling: ${pair(tackles.won, tackles.attempted)} tackles ${span} against ${they}'s ${pair(theirTackles.won, theirTackles.attempted)}.`,
      weight: 1,
    })
  } else if (tackles.attempted >= 6 && tackles.won / tackles.attempted < 0.5) {
    problems.push({ moment: "out of possession", finding: `Losing tackles: ${pair(tackles.won, tackles.attempted)} won ${span}.`, weight: 1 })
  }
  const lineNow = us.outOfPossession.defensiveLineM.whenTheyProgress
  const lineThen = before?.outOfPossession.defensiveLineM.whenTheyProgress
  if (lineNow != null && lineThen != null && lineThen - lineNow >= 5) {
    problems.push({
      moment: "out of possession",
      finding: `Your block has dropped: defensive line ${lineNow} m from goal when ${they} are in midfield ${span}, from ${lineThen} m earlier (${blockName(lineNow)}).`,
      weight: 2,
    })
  }

  // Defensive transition
  const losses = us.defensiveTransition
  if (losses.opponentShots.shots >= 2 || losses.opponentShots.xg >= 0.3) {
    problems.push({
      moment: "defensive transition",
      finding: `Exposed after losing the ball: ${they}'s shots within 15 s of winning it ${span}: ${shotText(losses.opponentShots)}${losses.opponentCounters ? `, from ${losses.opponentCounters} fast breaks` : ""}.`,
      weight: 3,
    })
  } else if (losses.opponentCounters >= 3) {
    problems.push({ moment: "defensive transition", finding: `${they} keep breaking: ${plural(losses.opponentCounters, "fast break")} ${span} after you lost the ball.`, weight: 2 })
  }
  const theirLosses = them.defensiveTransition
  // Turnovers are normal (most possessions end in one), so only a clear gap to the opponent counts.
  const lossShare = us.inPossession.possessions > 0 ? losses.openPlayLosses / us.inPossession.possessions : 0
  const theirLossShare = them.inPossession.possessions > 0 ? theirLosses.openPlayLosses / them.inPossession.possessions : 0
  if (losses.openPlayLosses >= 6 && theirLossShare > 0 && lossShare >= theirLossShare * 1.3) {
    problems.push({
      moment: "defensive transition",
      finding: `Giving the ball away more than ${they}: ${losses.openPlayLosses} of ${us.inPossession.possessions} possessions lost in open play ${span}, against their ${theirLosses.openPlayLosses} of ${them.inPossession.possessions}.`,
      weight: 1,
    })
  }
  if (losses.lostInOwnThird >= 3) {
    problems.push({ moment: "defensive transition", finding: `Losing it in your own third: ${losses.lostInOwnThird} times ${span}.`, weight: 2 })
  }

  // Set pieces (over the whole match: they are rare)
  const setAgainst = whole.teams[side].setPieces.against
  if (setAgainst.xg >= 0.3 || setAgainst.shots >= 3) {
    problems.push({ moment: "set pieces", finding: `${they} are dangerous from set pieces: shots from them this match ${shotText(setAgainst)}.`, weight: 2 })
  }
  const setFor = whole.teams[side].setPieces
  if (setFor.corners >= 5 && setFor.shots.shots === 0) {
    problems.push({ moment: "set pieces", finding: `${setFor.corners} corners this match and no shot from a set piece.`, weight: 1 })
  } else if (setFor.shots.xg >= 0.3) {
    working.push({ moment: "set pieces", finding: `Set pieces are a threat: shots from them this match ${shotText(setFor.shots)}.`, weight: 1 })
  }

  // Possession swing
  const possessionNow = recent.counters[side].possessionPct
  const possessionThen = earlier?.counters[side].possessionPct
  if (possessionNow != null && possessionThen != null && earlierMinutes >= 8 && Math.abs(possessionNow - possessionThen) >= 12) {
    problems.push({
      moment: possessionNow < possessionThen ? "out of possession" : "in possession",
      finding: `Possession has swung: ${possessionNow}% ${span}, ${possessionThen}% earlier.`,
      weight: possessionNow < possessionThen ? 1 : 0,
    })
  }

  const ranked = (list: Finding[]) => list.sort((left, right) => right.weight - left.weight).map(({ moment, finding }) => `[${moment}] ${finding}`)
  return { problems: ranked(problems).slice(0, 7), working: ranked(working).slice(0, 4) }
}

// ---------------------------------------------------------------------------
// Plan against reality

/** FM's own names for the team instructions set in a captured tactic, e.g. "FocusPlayDownTheLeftFlank". */
export function rawInstructionNames(config: TacticalConfiguration | undefined): string[] {
  if (!config) return []
  try {
    return decodeTeamInstructions(config.teamInstructions)
      .map((instruction) => (instruction as { name?: string }).name)
      .filter((name): name is string => Boolean(name) && name !== "unknown")
  } catch {
    return []
  }
}

/**
 * For each team instruction that has a measurable effect, what the numbers
 * show, for the whole match and the recent stretch. A gap means the players
 * are not doing it, or the opponent is stopping it.
 */
export function planVsReality(model: MatchModel, side: Side, whole: WindowPhases, recent: WindowPhases) {
  const config = model.tacticVersions.filter((version) => version.side === side).at(-1)?.config
  const names = new Set(rawInstructionNames(config))
  if (names.size === 0) return undefined
  const opponent = other(side)
  const they = teamName(model, opponent)
  const checks: Array<{ instruction: string; onThePitch: string }> = []
  const both = (pick: (window: WindowPhases) => string) => `${pick(whole)} this match; ${pick(recent)} in the last ${recent.minutes} minutes`
  const has = (...candidates: string[]) => candidates.find((name) => names.has(name))
  const entryShare = (window: WindowPhases, channel: "left" | "centre" | "right") => {
    const entries = window.teams[side].inPossession.finalThirdEntries
    const total = entries.left + entries.centre + entries.right
    return total > 0 ? `${entries[channel]} of ${total} final-third entries through the ${channel}` : "no final-third entries"
  }
  const focus = has("FocusPlayDownTheLeftFlank", "FocusPlayDownTheRightFlank", "FocusPlayDownTheMiddle", "FocusPlayDownBothFlanks")
  if (focus) {
    const channel = focus.includes("Left") ? "left" : focus.includes("Right") ? "right" : focus.includes("Middle") ? "centre" : undefined
    checks.push({
      instruction: humanizeInstruction(focus),
      onThePitch: channel
        ? both((window) => entryShare(window, channel))
        : both((window) => {
            const entries = window.teams[side].inPossession.finalThirdEntries
            const total = entries.left + entries.centre + entries.right
            return total > 0 ? `${entries.left + entries.right} of ${total} final-third entries down the flanks` : "no final-third entries"
          }),
    })
  }
  const line = has("DefensiveLineMuchHigher", "DefensiveLineHigherDefensiveLine", "DefensiveLineDeeper", "DefensiveLineMuchDeeper")
  const engagement = has("LineOfEngagementHigh", "LineOfEngagementMid", "LineOfEngagementLow")
  if (line || engagement) {
    checks.push({
      instruction: [line, engagement].filter(Boolean).map((name) => humanizeInstruction(name!)).join(", "),
      onThePitch: both((window) => {
        const own = window.teams[side].outOfPossession.defensiveLineM
        const theirs = window.teams[opponent].outOfPossession.defensiveLineM
        return `line ${own.whenTheyBuildUp ?? "n/a"} m when they build up, ${own.whenTheyProgress ?? "n/a"} m when they are in midfield (${they}: ${theirs.whenTheyBuildUp ?? "n/a"} / ${theirs.whenTheyProgress ?? "n/a"} m)`
      }),
    })
  }
  const press = has("PressingIntensityMuchHigher", "PressingIntensityHigher", "PressingIntensityLower", "PressingIntensityMuchLower")
  if (press) {
    checks.push({
      instruction: humanizeInstruction(press),
      onThePitch: both(
        (window) =>
          `${ppdaText(window.teams[side].outOfPossession.ppda)} (${they}: ${ppdaText(window.teams[opponent].outOfPossession.ppda)}), ${plural(window.teams[side].outOfPossession.highRegains, "high regain")}`
      ),
    })
  }
  const trap = has("PressingTrapOut", "PressingTrapIn")
  if (trap) {
    checks.push({
      instruction: humanizeInstruction(trap),
      onThePitch: both((window) => {
        const entries = window.teams[side].outOfPossession.opponentEntries
        return `${they} reached the final third via your left ${entries.ourLeft}, centre ${entries.centre}, your right ${entries.ourRight}`
      }),
    })
  }
  const counterPress = has("DefenceTransitionCounterpress", "DefenceTransitionRegroup")
  if (counterPress) {
    checks.push({
      instruction: humanizeInstruction(counterPress),
      onThePitch: both((window) => {
        const losses = window.teams[side].defensiveTransition
        return `won it back within 5 s after ${losses.regainedWithin5s} of ${losses.openPlayLosses} open-play losses; ${they} shots within 15 s: ${shotText(losses.opponentShots)}`
      }),
    })
  }
  const counter = has("AttackTransitionCounter", "AttackTransitionHoldShape")
  if (counter) {
    checks.push({
      instruction: humanizeInstruction(counter),
      onThePitch: both((window) => {
        const attacking = window.teams[side].attackingTransition
        return `${plural(attacking.counters, "fast break")} from ${attacking.openPlayRegains} open-play regains, shots within 15 s: ${shotText(attacking.shots)}`
      }),
    })
  }
  const passing = has("PassingStyleMuchMoreDirect", "PassingStyleMoreDirect", "PassingStyleShorter", "PassingStyleMuchShorter", "BypassPress", "PlayThroughPress")
  if (passing) {
    checks.push({
      instruction: humanizeInstruction(passing),
      onThePitch: both((window) => `long passes ${window.teams[side].inPossession.longPassPct ?? "n/a"}% of passes (${they} ${window.teams[opponent].inPossession.longPassPct ?? "n/a"}%), build-up ${window.teams[side].inPossession.buildUpPct ?? "n/a"}% of time on the ball`),
    })
  }
  const box = has("WorkBallIntoBox", "ShotsFromDistanceShootOnSight", "ShotsFromDistanceStayPatient")
  if (box) {
    checks.push({
      instruction: humanizeInstruction(box),
      onThePitch: both((window) => {
        const team = window.teams[side].inPossession
        const shooting = team.shotsFromOutsideBoxPct == null ? "too few shots to judge where from" : `${team.shotsFromOutsideBoxPct}% of shots from outside the box`
        return `${shooting}, ${team.reachedBox} of ${team.possessions} possessions reached the box`
      }),
    })
  }
  const width = has("SetupMuchWiderInPossession", "SetupWiderInPossession", "SetupNarrowerInPossession", "SetupMuchNarrowerInPossession")
  if (width) {
    checks.push({
      instruction: humanizeInstruction(width),
      onThePitch: both((window) => `in-possession width ${window.teams[side].inPossession.widthM ?? "n/a"} m (${they} ${window.teams[opponent].inPossession.widthM ?? "n/a"} m)`),
    })
  }
  const crossing = ["HitEarlyCrosses", "LowCrosses", "WhippedCrosses", "FloatCrosses", "CrossInvite", "CrossStop"].filter((name) => names.has(name))
  if (crossing.length > 0) {
    checks.push({
      instruction: crossing.map(humanizeInstruction).join(", "),
      onThePitch: both((window) => {
        const crosses = window.teams[side].inPossession.openPlayCrosses
        return `open-play crosses left ${pair(crosses.left.completed, crosses.left.attempted)}, right ${pair(crosses.right.completed, crosses.right.attempted)}`
      }),
    })
  }
  if (names.has("PlayForSetPieces")) {
    checks.push({
      instruction: "play for set pieces",
      onThePitch: `${whole.teams[side].setPieces.corners} corners, ${whole.teams[side].setPieces.freeKicksWonInFinalThird} free kicks in the final third, set-piece shots ${shotText(whole.teams[side].setPieces.shots)} this match`,
    })
  }
  const tackling = has("GetStuckIn", "StayOnFeet")
  if (tackling) {
    checks.push({
      instruction: humanizeInstruction(tackling),
      onThePitch: both((window) => `tackles ${pair(window.counters[side].tackles.won, window.counters[side].tackles.attempted)}, fouls ${window.counters[side].fouls}`),
    })
  }
  return checks.length > 0 ? checks : undefined
}

function humanizeInstruction(name: string): string {
  return name
    .replace("DefensiveLineHigherDefensiveLine", "HigherDefensiveLine")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
}

// ---------------------------------------------------------------------------
// get_phases

export function phaseReport(model: MatchModel, sides: Side[], selection: WindowSelection, note?: string) {
  const context = new PhaseContext(model)
  const window = windowPhases(context, selection)
  const result: Record<string, unknown> = { window: windowInfo(model, selection), legend: PHASE_LEGEND }
  if (note) result.note = note
  for (const side of sides) {
    result[sideLabel(model, side)] = {
      inPossession: inPossessionView(window, side),
      outOfPossession: outOfPossessionView(window, side),
      transitions: transitionsView(window, side),
      setPieces: setPiecesView(window, side),
    }
  }
  return result
}
