// The printed reports: a post-match one-pager and a half-time sheet, each one
// self-contained HTML page sized to a landscape US Letter sheet (1056 x 816 CSS
// px at 96 per inch). This file only draws; report.ts works out every number
// from the match and passes it in, together with the few lines the analyst
// writes (the verdict, the decisions, the plan checks).
//
// Design rules (see the build spec): the user's team is always blue and the
// opponent orange, on every chart and key; status is never colour alone (a glyph
// and a word, and no red/green pair anywhere); nothing smaller than 12 px. The page
// is static and fully local: no scripts, no requests (Inter if installed, else the
// system font), and a Content-Security-Policy that holds it to that.

import type { ActionCheck, TrendRow } from "./metrics"

export const YOU = "#2a78d6"
const YOU_DARK = "#256abf"
const YOU_LIGHT = "#b7d3f6"
export const THEM = "#eb6834"
const INK = "#0b0b0b"
const SEC = "#52514e"
const MUTED = "#6b6a66"
const HAIR = "#e1e0d9"
const AXIS = "#c3c2b7"
const PANEL = "#f5f5f2"
const PITCH_BG = "#f3f3ef"
const PITCH_LINE = "#c3c2b7"
const WARN = "#fab219"
const FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif"
const SVG_FONT = "font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;"

// ---------------------------------------------------------------------------
// Data the pages draw

export type PlanStatus = "seen" | "not_seen" | "hurt" | "contained"
export type PlanRow = { label: string; status?: PlanStatus; evidence: string }

export type TeamHeader = { name: string; goals: number; xg: number; scorers: string }
export type PageHeader = {
  kicker: string
  title: string
  subtitle: string
  you: TeamHeader
  them: TeamHeader
  /** Up to three short lines on the right: tactics and bookings. */
  right: Array<{ team?: string; text: string }>
}

export type ShotPoint = { minute: number; xg: number; goal: boolean; fromGoalLine: number; fromCentre: number }
export type MomentumBlock = { from: number; to: number; value: number }
export type FlowEvent = { minute: number; label: string }

export type MomentRow = { label: string; you: string; them: string }

export type PitchPlayer = { number: string; depth: number; width: number; light: boolean }
export type PassLink = { a: number; b: number; passes: number }
export type PlayerLine = {
  number: string
  name: string
  minutes: number
  rating: number
  xg?: number
  xa?: number
  km: number
  condition?: number
}

export type PostMatchPage = {
  header: PageHeader
  verdict: Array<{ title: string; detail: string }>
  flow: { maxMinute: number; you: ShotPoint[]; them: ShotPoint[]; totals: { you: number; them: number }; momentum: MomentumBlock[]; events: FlowEvent[] }
  shots: { you: ShotPoint[]; them: ShotPoint[] }
  moments: Array<{ group: string; rows: MomentRow[] }>
  ourPlan: PlanRow[]
  theirPlan: PlanRow[]
  tacticName?: string
  shape?: { players: PitchPlayer[]; links: PassLink[] }
  players: PlayerLine[]
  /** Condition at or below this is flagged. */
  conditionFlag: number
}

export type TakeawayTag = "keep" | "fix" | "try"
export type MeaningPage = {
  header: PageHeader
  headline: string
  takeaways: Array<{ tag: TakeawayTag; title: string; happened: string; why: string; action: string; trend?: TrendRow }>
  carry: Array<{ area: "tactic" | "training" | "selection" | "recruitment"; action: string; check?: string }>
  trend: { rows: TrendRow[]; matches: number; against?: string; note?: string }
  outlook: Array<{ name: string; position?: string; outlook: "rest" | "start" | "watch" | "form"; why: string; rating?: number; condition?: number }>
  lastTime?: { from: string; checks: ActionCheck[] }
}

export type HalfTimePage = {
  header: PageHeader
  decisions: Array<{ title: string; evidence: string; option: string }>
  turn: { earlierLabel: string; laterLabel: string; rows: Array<{ label: string; earlier: string; later: string }>; momentum: MomentumBlock[]; halfEnd: number }
  theirPlan: PlanRow[]
  ourPlan: PlanRow[]
  tacticName?: string
  setPieces: string
  people: Array<{ status: "watch" | "keep"; name: string; position?: string; rating?: number; condition?: number; why: string; bench?: string }>
}

// ---------------------------------------------------------------------------
// Small pieces

export const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

const f1 = (value: number) => value.toFixed(1)
const f2 = (value: number) => value.toFixed(2)
const n1 = (value: number) => Math.round(value * 10) / 10

function sectionHead(label: string, right = ""): string {
  return (
    `<div class="head"><h2>${label}</h2>${right}</div>`
  )
}

const keyDot = (color: string, extra = "") => `<span class="dot" style="background: ${color};${extra}"></span>`
const keyLine = (color: string) => `<span class="keyline" style="background: ${color}"></span>`
const note = (text: string) => `<span class="note">${text}</span>`

function text(x: number, y: number, value: string, options: { size?: number; color?: string; anchor?: string; weight?: number } = {}) {
  const { size = 12, color = MUTED, anchor = "start", weight = 400 } = options
  return `<text x="${n1(x)}" y="${n1(y)}" fill="${color}" style="${SVG_FONT} font-size: ${size}px; font-weight: ${weight}; text-anchor: ${anchor}">${esc(value)}</text>`
}

function line(x1: number, y1: number, x2: number, y2: number, color = AXIS, width = 1) {
  return `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" stroke="${color}" stroke-width="${width}"></line>`
}

/** A bar with a 4 px rounded data end and a square base. */
function barPath(x: number, w: number, base: number, h: number, up: boolean): string {
  const height = Math.max(h, 0.5)
  const r = Math.min(4, height / 2, w / 2)
  if (up) {
    const t = base - height
    return `M${n1(x)},${n1(base)} V${n1(t + r)} Q${n1(x)},${n1(t)} ${n1(x + r)},${n1(t)} H${n1(x + w - r)} Q${n1(x + w)},${n1(t)} ${n1(x + w)},${n1(t + r)} V${n1(base)} Z`
  }
  const b = base + height
  return `M${n1(x)},${n1(base)} V${n1(b - r)} Q${n1(x)},${n1(b)} ${n1(x + r)},${n1(b)} H${n1(x + w - r)} Q${n1(x + w)},${n1(b)} ${n1(x + w)},${n1(b - r)} V${n1(base)} Z`
}

const CHECK = `<path d="M4.6 8.3 L7 10.6 L11.6 5.6" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>`
const CROSS = `<path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"></path>`
const BANG = `<path d="M8 4 V8.8" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round"></path><circle cx="8" cy="11.7" r="1.15" fill="#ffffff"></circle>`
const STATUS: Record<PlanStatus, { color: string; glyph: string; word: string }> = {
  seen: { color: YOU_DARK, glyph: CHECK, word: "Seen" },
  not_seen: { color: THEM, glyph: CROSS, word: "Not seen" },
  hurt: { color: THEM, glyph: BANG, word: "Hurt us" },
  contained: { color: YOU_DARK, glyph: CHECK, word: "Contained" },
}

function statusIcon(status: PlanStatus, size = 16) {
  const { color, glyph } = STATUS[status]
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" class="icon"><circle cx="8" cy="8" r="8" fill="${color}"></circle>${glyph}</svg>`
}

function warnTriangle(size = 9) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 10 10" aria-hidden="true" class="tri"><path d="M5 0.8 L9.4 9 H0.6 Z" fill="${WARN}"></path></svg>`
}

// ---------------------------------------------------------------------------
// Header (both pages)

function header(h: PageHeader): string {
  const right = h.right
    .slice(0, 3)
    .map((row) => `<p class="small sec">${row.team ? `<b>${esc(row.team)}</b> ` : ""}${esc(row.text)}</p>`)
    .join("")
  return `<header class="top">
<div class="col">
<p class="kicker">${esc(h.kicker)}</p>
<p class="title">${esc(h.title)}</p>
<p class="small muted">${esc(h.subtitle)}</p>
</div>
<div class="score">
<div class="r"><p class="team">${keyDot(YOU, " margin-right: 6px;")}${esc(h.you.name)}</p><p class="small sec">${esc(h.you.scorers) || "&nbsp;"}</p></div>
<div class="c"><p class="big">${h.you.goals}–${h.them.goals}</p><p class="small sec">xG ${f2(h.you.xg)}–${f2(h.them.xg)}</p></div>
<div class="l"><p class="team">${esc(h.them.name)}${keyDot(THEM, " margin-left: 6px;")}</p><p class="small sec">${esc(h.them.scorers) || "&nbsp;"}</p></div>
</div>
<div class="col right">${right}</div>
</header>`
}

// ---------------------------------------------------------------------------
// Match flow: cumulative xG and FM momentum on one time axis

function flowChart(flow: PostMatchPage["flow"]): string {
  const W = 644
  const H = 130
  const GX = 80
  const PX = 598
  const top = 20
  const bottom = 78
  const MB = 100
  const MH = 14
  const max = flow.maxMinute
  const mx = (minute: number) => GX + (Math.min(minute, max) / max) * (PX - GX)
  const peak = Math.max(1.5, Math.ceil(Math.max(flow.totals.you, flow.totals.them, ...cumulative(flow.you), ...cumulative(flow.them)) * 2) / 2)
  const yx = (value: number) => bottom - (value / peak) * (bottom - top)
  const out: string[] = [
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative xG and FM momentum through the match" class="block">`,
  ]
  // Event labels sit right of their line, or left of it when they would run into
  // the next line or off the chart and there is room on the left.
  const marks = flow.events
    .slice(0, 3)
    .map((event) => ({ ...event, x: mx(event.minute), width: event.label.length * 6.6 }))
    .sort((left, right) => left.x - right.x)
  let previousRight = 0
  marks.forEach((mark, index) => {
    out.push(line(mark.x, 15, mark.x, MB + MH + 2))
    const next = marks[index + 1]?.x ?? W - 2
    const left = mark.x + 5 + mark.width > next - 4 && mark.x - 5 - mark.width >= previousRight + 6
    out.push(text(left ? mark.x - 5 : mark.x + 5, 11, mark.label, { color: SEC, anchor: left ? "end" : "start" }))
    previousRight = left ? mark.x - 5 : mark.x + 5 + mark.width
  })
  const ticks = peak <= 1.5 ? [0.5, 1, 1.5] : peak <= 3 ? [1, 2, 3].filter((tick) => tick <= peak) : [peak / 2, peak]
  for (const tick of ticks) out.push(line(GX, yx(tick), PX, yx(tick), HAIR))
  out.push(line(GX, yx(0), PX, yx(0)))
  for (const tick of [0, ...ticks]) out.push(text(GX - 6, yx(tick) + 4, tick === 0 ? "0" : tick.toFixed(1), { anchor: "end" }))
  out.push(text(0, yx(peak / 2) + 4, "xG", { color: SEC, weight: 600 }))
  const steps = (shots: ShotPoint[], color: string) => {
    let total = 0
    let d = `M${n1(mx(0))},${n1(yx(0))}`
    const goals: Array<[number, number]> = []
    for (const shot of [...shots].sort((left, right) => left.minute - right.minute)) {
      d += ` H${n1(mx(shot.minute))}`
      total += shot.xg
      d += ` V${n1(yx(total))}`
      if (shot.goal) goals.push([mx(shot.minute), yx(total)])
    }
    d += ` H${n1(mx(max))}`
    return { path: `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>`, goals, total }
  }
  const them = steps(flow.them, THEM)
  const you = steps(flow.you, YOU)
  out.push(them.path, you.path)
  for (const [x, y] of them.goals) out.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="5" fill="${THEM}" stroke="#ffffff" stroke-width="2"></circle>`)
  for (const [x, y] of you.goals) out.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="5" fill="${YOU}" stroke="#ffffff" stroke-width="2"></circle>`)
  let yYou = yx(you.total) + 4
  let yThem = yx(them.total) + 4
  if (Math.abs(yYou - yThem) < 13) {
    const mid = (yYou + yThem) / 2
    const youAbove = you.total >= them.total
    yYou = youAbove ? mid - 7 : mid + 7
    yThem = youAbove ? mid + 7 : mid - 7
  }
  out.push(text(PX + 7, yYou, f2(flow.totals.you), { color: INK, weight: 600 }))
  out.push(text(PX + 7, yThem, f2(flow.totals.them), { color: INK, weight: 600 }))
  out.push(text(0, MB + 4, "Momentum", { color: SEC, weight: 600 }))
  for (const block of flow.momentum) {
    const x0 = mx(block.from)
    const x1 = mx(block.to)
    const w = Math.min(22, Math.max(4, x1 - x0 - 4))
    const x = x0 + (x1 - x0 - w) / 2
    out.push(`<path d="${barPath(x, w, MB, (Math.min(Math.abs(block.value), 0.8) / 0.8) * MH, block.value > 0)}" fill="${block.value > 0 ? YOU : THEM}"></path>`)
  }
  out.push(line(GX, MB, PX, MB))
  const axis: Array<[number, string]> = [[0, "0'"], [15, "15'"], [30, "30'"], [45, "HT"], [60, "60'"], [75, "75'"], [90, "90'"]]
  if (max > 100) axis.push([105, "105'"], [120, "120'"])
  for (const [minute, label] of axis) if (minute <= max) out.push(text(mx(minute), H - 2, label, { anchor: "middle" }))
  out.push("</svg>")
  return out.join("")
}

function cumulative(shots: ShotPoint[]): number[] {
  let total = 0
  return shots.map((shot) => (total += shot.xg))
}

// ---------------------------------------------------------------------------
// Shots: one half-pitch per team, attacking up; size = xG, solid = goal

function halfPitch(shots: ShotPoint[], color: string, label: string): string {
  const W = 146
  const across = 52
  const deep = 30
  const s = W / across
  const H = Math.round(deep * s) + 2
  const sx = (fromCentre: number) => (fromCentre + across / 2) * s
  const sy = (fromGoalLine: number) => 2 + fromGoalLine * s
  const ln = `fill="none" stroke="${PITCH_LINE}" stroke-width="1"`
  const arc = Math.sqrt(9.15 ** 2 - 5.5 ** 2)
  const out = [
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" class="block">`,
    `<rect x="0" y="2" width="${W}" height="${H - 2}" fill="${PITCH_BG}"></rect>`,
    `<rect x="${n1(sx(-20.16))}" y="2" width="${n1(40.32 * s)}" height="${n1(16.5 * s)}" ${ln}></rect>`,
    `<rect x="${n1(sx(-9.16))}" y="2" width="${n1(18.32 * s)}" height="${n1(5.5 * s)}" ${ln}></rect>`,
    `<path d="M${n1(sx(-arc))},${n1(sy(16.5))} A${n1(9.15 * s)},${n1(9.15 * s)} 0 0 0 ${n1(sx(arc))},${n1(sy(16.5))}" ${ln}></path>`,
    `<circle cx="${n1(sx(0))}" cy="${n1(sy(11))}" r="1.3" fill="${PITCH_LINE}"></circle>`,
    line(0, 2, W, 2, PITCH_LINE),
    line(sx(-3.66), 1.5, sx(3.66), 1.5, SEC, 3),
  ]
  const placed = shots
    .map((shot) => ({
      ...shot,
      x: sx(Math.max(-across / 2 + 2, Math.min(across / 2 - 2, shot.fromCentre))),
      y: sy(Math.max(0.5, Math.min(deep - 1, shot.fromGoalLine))),
    }))
    .sort((left, right) => Number(left.goal) - Number(right.goal) || right.xg - left.xg)
  for (const shot of placed) {
    const r = 4 + 8 * Math.sqrt(Math.max(shot.xg, 0))
    out.push(
      shot.goal
        ? `<circle cx="${n1(shot.x)}" cy="${n1(shot.y)}" r="${n1(r)}" fill="${color}" stroke="#ffffff" stroke-width="2"></circle>`
        : `<circle cx="${n1(shot.x)}" cy="${n1(shot.y)}" r="${n1(r)}" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="1.5"></circle>`
    )
  }
  out.push("</svg>")
  return out.join("")
}

function shotsBlock(page: PostMatchPage): string {
  const side = (shots: ShotPoint[], color: string, name: string, total: number) => {
    const label = `${name}: ${shots.length} shots, ${f2(total)} xG`
    return `<div class="stack6" style="width: 146px">${halfPitch(shots, color, label)}<div><p class="small strong">${keyDot(color)}${esc(name)}</p><p class="small sec">${shots.length} shots · ${f2(total)} xG</p></div></div>`
  }
  return `<section aria-label="Shots">${sectionHead("Shots", note("Size = xG · solid = goal"))}<div class="spread">${side(
    page.shots.you,
    YOU,
    page.header.you.name,
    page.flow.totals.you
  )}${side(page.shots.them, THEM, page.header.them.name, page.flow.totals.them)}</div></section>`
}

// ---------------------------------------------------------------------------
// Tables and lists

function momentsBlock(page: PostMatchPage): string {
  const head = `<div class="mhead"><span></span><span>${keyDot(YOU)}${esc(page.header.you.name)}</span><span>${keyDot(THEM)}${esc(page.header.them.name)}</span></div>`
  const groups = page.moments
    .map(
      (group) =>
        `<div class="mgroup"><h3>${esc(group.group)}</h3><table class="mtable"><tbody>${group.rows
          .map((row) => `<tr><th scope="row">${esc(row.label)}</th><td>${esc(row.you)}</td><td>${esc(row.them)}</td></tr>`)
          .join("")}</tbody></table></div>`
    )
    .join("")
  return `<section aria-label="Moments of the game">${sectionHead("Moments of the game")}${head}${groups}</section>`
}

function planRows(rows: PlanRow[], dense = false): string {
  return `<ul class="plan">${rows
    .map((row) => {
      const icon = row.status ? statusIcon(row.status) : `<span class="bullet"></span>`
      const word = row.status ? `<span class="word">${STATUS[row.status].word}</span>` : ""
      return `<li class="${dense ? "dense" : ""}"><div class="iconcell">${icon}</div><div class="grow"><div class="spread"><span class="label">${esc(row.label)}</span>${word}</div><p class="ev">${esc(row.evidence)}</p></div></li>`
    })
    .join("")}</ul>`
}

function planSub(color: string, who: string, what: string | undefined, top: number) {
  return `<h3 class="sub" style="margin-top: ${top}px">${keyDot(color)}${esc(who)}${what ? ` <span class="muted normal">· ${esc(what)}</span>` : ""}</h3>`
}

function plansBlock(page: PostMatchPage): string {
  return `<section aria-label="Plans vs reality">${sectionHead("Plans vs reality")}${planSub(YOU, "Our plan", page.tacticName, 0)}${planRows(page.ourPlan)}${planSub(
    THEM,
    "Their plan",
    page.header.them.name,
    5
  )}${planRows(page.theirPlan)}</section>`
}

// ---------------------------------------------------------------------------
// Shape: average positions on the ball, strongest passing links, player table

function shapePitch(players: PitchPlayer[], links: PassLink[]): string {
  const PW = 232
  const PH = 150
  const px = (depth: number) => 2 + (depth / 100) * PW
  const py = (width: number) => (width / 100) * PH
  const sxm = PW / 105
  const sym = PH / 68
  const ln = `fill="none" stroke="${PITCH_LINE}" stroke-width="1"`
  const out = [
    `<svg width="${PW + 4}" height="${PH}" viewBox="0 0 ${PW + 4} ${PH}" role="img" aria-label="Average positions on the ball, attacking right, with the main passing links" class="block">`,
    `<rect x="2" y="0" width="${PW}" height="${PH}" fill="${PITCH_BG}"></rect>`,
    `<rect x="2.5" y="0.5" width="${PW - 1}" height="${PH - 1}" ${ln}></rect>`,
    line(2 + PW / 2, 0, 2 + PW / 2, PH, PITCH_LINE),
    `<circle cx="${2 + PW / 2}" cy="${PH / 2}" r="${n1(9.15 * sxm)}" ${ln}></circle>`,
  ]
  for (const left of [true, false]) {
    const bw = 16.5 * sxm
    const bh = 40.32 * sym
    const sw = 5.5 * sxm
    const sh = 18.32 * sym
    out.push(`<rect x="${n1(left ? 2 : 2 + PW - bw)}" y="${n1((PH - bh) / 2)}" width="${n1(bw)}" height="${n1(bh)}" ${ln}></rect>`)
    out.push(`<rect x="${n1(left ? 2 : 2 + PW - sw)}" y="${n1((PH - sh) / 2)}" width="${n1(sw)}" height="${n1(sh)}" ${ln}></rect>`)
    const gx = left ? 1 : PW + 3
    out.push(line(gx, (PH - 7.32 * sym) / 2, gx, (PH + 7.32 * sym) / 2, SEC, 2))
  }
  const most = Math.max(1, ...links.map((link) => link.passes))
  for (const link of links) {
    const a = players[link.a]
    const b = players[link.b]
    if (!a || !b) continue
    out.push(
      `<line x1="${n1(px(a.depth))}" y1="${n1(py(a.width))}" x2="${n1(px(b.depth))}" y2="${n1(py(b.width))}" stroke="${SEC}" stroke-opacity="0.38" stroke-linecap="round" stroke-width="${n1(1 + (link.passes / most) * 4)}"></line>`
    )
  }
  for (const light of [true, false]) {
    for (const player of players) {
      if (player.light !== light) continue
      const x = px(player.depth)
      const y = py(player.width)
      out.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="9" fill="${light ? YOU_LIGHT : YOU_DARK}" stroke="#ffffff" stroke-width="2"></circle>`)
      out.push(text(x, y + 4, player.number, { size: 11.5, color: light ? INK : "#ffffff", anchor: "middle", weight: 700 }))
    }
  }
  out.push("</svg>")
  return out.join("")
}

function shapeBlock(page: PostMatchPage): string {
  const legend = [
    `<b>Attacking →</b>`,
    `<span class="swatchline"></span> Main passing links`,
    `<span class="swatchdot" style="background: ${YOU_LIGHT}"></span> Under 60 minutes`,
    `${warnTriangle(10)} Condition at the whistle ${page.conditionFlag}% or lower`,
  ]
    .map((item) => `<p class="small sec tight">${item}</p>`)
    .join("")
  const rows = page.players
    .map((player) => {
      const flag = player.condition != null && player.condition <= page.conditionFlag ? warnTriangle() : ""
      return `<tr><td class="num muted">${esc(player.number)}</td><td class="name">${esc(player.name)}</td><td>${player.minutes}</td><td class="${player.rating >= 7 ? "strong" : ""}">${
        player.rating > 0 ? f1(player.rating) : "–"
      }</td><td class="sec">${player.xg == null ? "–" : f2(player.xg)}</td><td class="sec">${player.xa == null ? "–" : f2(player.xa)}</td><td class="sec">${f1(
        player.km
      )}</td><td class="cond">${flag}${player.condition == null ? "–" : `${player.condition}%`}</td></tr>`
    })
    .join("")
  const pitch = page.shape
    ? `<div class="row10">${shapePitch(page.shape.players, page.shape.links)}<div class="stack8 legend">${legend}</div></div>`
    : `<p class="small muted">Positions were not captured for this match.</p>`
  return `<section aria-label="Shape and players">${sectionHead("Shape &amp; players")}${pitch}<table class="ptable"><thead><tr><th class="num">#</th><th class="name">Player</th><th>Min</th><th>Rtg</th><th>xG</th><th>xA</th><th>Km</th><th class="cond">Cond</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

// ---------------------------------------------------------------------------
// Half-time pieces

function decisionsBlock(page: HalfTimePage): string {
  const rows = page.decisions
    .map(
      (decision, index) =>
        `<div class="decision"><span class="num-badge">${index + 1}</span><h3>${esc(decision.title)}</h3><p class="ev13">${esc(decision.evidence)}</p><p class="opt"><b>Option</b> ${esc(decision.option)}</p></div>`
    )
    .join("")
  return `<section aria-label="Decisions for the second half">${sectionHead(page.decisions.length === 3 ? "Three decisions for the second half" : "Decisions for the second half")}<div class="stack6">${rows}</div></section>`
}

function momentumStrip(blocks: MomentumBlock[], halfEnd: number): string {
  const W = 312
  const H = 58
  const G = 76
  const PX = 306
  const MB = 24
  const MH = 18
  const mx = (minute: number) => G + (Math.min(minute, halfEnd) / halfEnd) * (PX - G)
  const out = [`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="FM momentum by five minutes in the first half" class="block">`]
  out.push(text(0, MB + 4, "Momentum", { color: SEC, weight: 600 }))
  for (const block of blocks) {
    const x0 = mx(block.from)
    const x1 = mx(block.to)
    const w = Math.min(18, Math.max(4, x1 - x0 - 4))
    out.push(`<path d="${barPath(x0 + (x1 - x0 - w) / 2, w, MB, (Math.min(Math.abs(block.value), 0.8) / 0.8) * MH, block.value > 0)}" fill="${block.value > 0 ? YOU : THEM}"></path>`)
  }
  out.push(line(G, MB, PX, MB))
  for (const [minute, label] of [[0, "0'"], [15, "15'"], [30, "30'"]] as Array<[number, string]>) out.push(text(mx(minute), H - 2, label, { anchor: "middle" }))
  out.push(text(W - 1, H - 2, "HT", { anchor: "end" }))
  out.push("</svg>")
  return out.join("")
}

function turnBlock(page: HalfTimePage): string {
  const head = `<div class="thead3"><span></span><span>${esc(page.turn.earlierLabel)}</span><span>${esc(page.turn.laterLabel)}</span></div>`
  const rows = page.turn.rows
    .map((row) => `<tr><th scope="row">${esc(row.label)}</th><td class="sec">${esc(row.earlier)}</td><td class="strong">${esc(row.later)}</td></tr>`)
    .join("")
  return `<section aria-label="How the half turned">${sectionHead("How the half turned")}${momentumStrip(page.turn.momentum, page.turn.halfEnd)}<div style="height: 8px"></div>${head}<table class="ttable"><tbody>${rows}</tbody></table></section>`
}

function peopleBlock(page: HalfTimePage): string {
  const rows = page.people
    .map((person) => {
      const mark =
        person.status === "watch"
          ? `<span class="mark">${warnTriangle(12)}Watch</span>`
          : `<span class="mark">${statusIcon("seen", 14)}Keep</span>`
      return `<tr><td>${mark}</td><td><b>${esc(person.name)}</b>${person.position ? ` <span class="muted">${esc(person.position)}</span>` : ""}</td><td class="r ${
        (person.rating ?? 0) >= 7 ? "strong" : ""
      }">${person.rating ? f1(person.rating) : "–"}</td><td class="r sec">${person.condition != null ? `${person.condition}%` : "–"}</td><td class="why sec">${esc(
        person.why
      )}</td><td>${esc(person.bench ?? "")}</td></tr>`
    })
    .join("")
  return `<section aria-label="Players and bench">${sectionHead("Players and bench")}<table class="people"><thead><tr><th style="width: 80px"></th><th style="width: 130px">Player</th><th class="r" style="width: 40px">Rtg</th><th class="r" style="width: 52px">Cond</th><th class="why">Why</th><th style="width: 300px">Bench option</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

// ---------------------------------------------------------------------------
// Pages

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:${FONT};color:${INK};-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:11in 8.5in;margin:0}
@media screen{body{background:#e9e9e6;padding:24px}.page{margin:0 auto;box-shadow:0 1px 3px rgba(0,0,0,.12)}}
@media print{body{background:#fff;padding:0}.page{box-shadow:none}}
.page{width:1056px;height:816px;padding:40px;background:#fff;display:flex;flex-direction:column;overflow:hidden;page-break-after:always}
p{margin:0}
h2{margin:0;font-size:12px;line-height:18px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${INK}}
h3{margin:0}
b,.strong{font-weight:600;color:${INK}}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;height:18px;margin-bottom:8px}
.note{font-size:12px;line-height:18px;color:${MUTED}}
.small{font-size:12px;line-height:16px}
.tight{line-height:15px}
.sec{color:${SEC}}
.muted{color:${MUTED}}
.normal{font-weight:400}
.block{display:block}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle;margin-right:5px}
.keyline{display:inline-block;width:14px;height:2px;border-radius:1px;vertical-align:middle;margin-right:5px}
.icon{flex-shrink:0;display:block}
.tri{display:inline-block;vertical-align:0;margin-right:3px}
.spread{display:flex;justify-content:space-between;gap:8px}
.stack6{display:flex;flex-direction:column;gap:6px}
.stack8{display:flex;flex-direction:column;gap:8px}
.row10{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px}
.grow{flex:1;min-width:0}
header.top{height:66px;border-bottom:1px solid ${AXIS};padding-bottom:10px;display:grid;grid-template-columns:280px minmax(0,1fr) 280px;align-items:end;gap:16px;flex-shrink:0}
header .col{display:flex;flex-direction:column;gap:2px;min-width:0}
header .right{text-align:right}
header .right p{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kicker{font-size:12px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.title{font-size:15px;line-height:20px;font-weight:600}
.score{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:end;column-gap:18px}
.score .r{text-align:right;min-width:0}.score .c{text-align:center}.score .l{text-align:left;min-width:0}
.score .team{font-size:22px;line-height:28px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.score .small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.big{font-size:40px;line-height:40px;font-weight:700;letter-spacing:-.01em}
.verdict{height:68px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:12px;flex-shrink:0}
.verdict>div{background:${PANEL};border-radius:6px;padding:8px 12px;display:flex;gap:10px;align-items:flex-start;overflow:hidden}
.verdict .n{font-size:20px;line-height:22px;font-weight:700;color:${MUTED};width:14px;flex-shrink:0}
.verdict .t{font-size:14px;line-height:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.verdict .d{font-size:12px;line-height:16px;color:${SEC};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row2{height:156px;display:grid;grid-template-columns:644px 312px;gap:20px;margin-top:12px;flex-shrink:0}
.row3{height:410px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:12px;min-height:0}
.row3>section{min-width:0;overflow:hidden}
.legendrow{display:flex;gap:14px;font-size:12px;line-height:18px;color:${SEC}}
.mhead{display:grid;grid-template-columns:minmax(0,1fr) 70px 70px;height:18px;align-items:center;font-size:12px;font-weight:600}
.mhead span{text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mgroup{border-top:1px solid ${AXIS};padding-top:4px;margin-top:4px}
.mgroup h3{font-size:12px;line-height:18px;font-weight:600}
.mtable{width:100%;border-collapse:collapse;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.mtable th{padding:0;height:18px;text-align:left;font-weight:400;color:${SEC};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}
.mtable td{padding:0;width:70px;text-align:right}
.sub{font-size:12px;line-height:20px;font-weight:600;margin-bottom:2px}
.plan{list-style:none;margin:0;padding:0}
.plan li{display:flex;gap:10px;align-items:flex-start;padding:3px 0;border-top:1px solid ${HAIR}}
.plan .iconcell{padding-top:1px}
.plan .label{font-size:13px;line-height:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plan .word{font-size:12px;line-height:18px;font-weight:600;white-space:nowrap}
.plan .ev{font-size:12px;line-height:16px;color:${SEC};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plan .bullet{display:block;width:8px;height:8px;border-radius:50%;background:${THEM};margin:5px 4px 0}
.plan.wrap .ev,.plan li.wrap .ev{white-space:normal}
.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.legend{padding-top:2px;min-width:0}
.swatchline{display:inline-block;width:16px;height:3px;border-radius:2px;background:rgba(82,81,78,.5);vertical-align:middle}
.swatchdot{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle}
.ptable{width:100%;border-collapse:collapse;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.ptable th{padding:0 0 2px;font-weight:600;color:${MUTED};text-align:right;border-bottom:1px solid ${AXIS}}
.ptable td{padding:0;height:16px;text-align:right;white-space:nowrap}
.ptable .num{text-align:left;width:26px}.ptable .name{text-align:left;overflow:hidden;text-overflow:ellipsis;max-width:110px}
.ptable .cond{padding-left:6px;width:48px}
.decision{background:${PANEL};border-radius:8px;padding:7px 14px;display:grid;grid-template-columns:26px 190px minmax(0,1fr) 280px;column-gap:16px;align-items:start}
.decision h3{font-size:15px;line-height:19px;font-weight:700;padding-top:3px;text-wrap:balance}
.num-badge{width:26px;height:26px;border-radius:50%;background:${INK};color:#fff;font-size:14px;line-height:26px;font-weight:700;text-align:center}
.ev13{font-size:13px;line-height:18px;color:${SEC};display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.opt{font-size:13px;line-height:18px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.mid3{height:262px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:14px;flex-shrink:0}
.mid3>section{min-width:0;overflow:hidden}
.thead3{display:grid;grid-template-columns:minmax(0,1fr) 64px 64px;height:18px;align-items:center;font-size:12px;font-weight:600;border-bottom:1px solid ${AXIS}}
.thead3 span{text-align:right}
.ttable{width:100%;border-collapse:collapse;font-size:12px;line-height:21px;font-variant-numeric:tabular-nums}
.ttable th{padding:0;height:21px;text-align:left;font-weight:400;color:${SEC};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.ttable td{padding:0;width:64px;text-align:right}
.setp{margin-top:8px;padding-top:6px;border-top:1px solid ${HAIR};font-size:12px;line-height:16px;color:${SEC}}
.people{width:100%;border-collapse:collapse;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.people th{padding:0 12px 4px 0;font-weight:600;color:${MUTED};text-align:left}
.people th.r{padding:0 0 4px 12px;text-align:right}
.people th.why,.people td.why{padding-left:16px}
.people td{padding:0 12px 0 0;height:25px;border-top:1px solid ${HAIR};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:330px}
.people td.r{padding:0 0 0 12px;text-align:right}
.mark{display:inline-flex;align-items:center;gap:6px;font-weight:600}
@media screen{.page+.page{margin-top:24px}}
.headline{margin-top:14px;font-size:20px;line-height:26px;font-weight:700;flex-shrink:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.takes{height:282px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:14px;flex-shrink:0}
.take{background:${PANEL};border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.take>*{flex-shrink:0}
.ttop{display:flex;align-items:center;gap:6px;height:22px;margin-bottom:6px}
.tword{font-size:12px;line-height:16px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.take h3{font-size:15px;line-height:20px;font-weight:700;margin-left:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.klabel{font-size:12px;line-height:16px;font-weight:600;color:${MUTED};margin-top:4px}
.ktext{font-size:13px;line-height:18px;color:${SEC};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.next{margin-top:8px;background:#fff;border-radius:6px;padding:4px 10px 6px;border-left:3px solid ${INK}}
.ntext{font-size:13px;line-height:18px;font-weight:600;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.kt{margin-top:auto;padding-top:6px;font-size:12px;line-height:16px;color:${SEC};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw{font-weight:600;white-space:nowrap}
.row4{flex:1;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:16px}
.row4>section{min-width:0;overflow:hidden}
.carry{list-style:none;margin:0;padding:0}
.carry li,.lastl li{display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-top:1px solid ${HAIR}}
.lastl{list-style:none;margin:0;padding:0}
.box{flex-shrink:0;width:13px;height:13px;border:1.5px solid ${SEC};border-radius:3px;margin-top:3px}
.ctext{font-size:13px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cnote{font-size:12px;line-height:16px;color:${MUTED};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.area{flex-shrink:0;font-size:12px;line-height:18px;font-weight:600;color:${SEC}}
.oname{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.onum{text-align:right;flex-shrink:0}
.ttable4{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px;line-height:22px;font-variant-numeric:tabular-nums}
.ttable4 thead th{font-weight:600;color:${INK};line-height:18px;border-bottom:1px solid ${AXIS};text-align:right;white-space:nowrap}
.ttable4 th{padding:0;text-align:left;font-weight:400;color:${SEC};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ttable4 th:nth-child(2),.ttable4 td:nth-child(2){width:62px}
.ttable4 th:nth-child(3),.ttable4 td:nth-child(3){width:50px}
.ttable4 th:nth-child(4),.ttable4 td:nth-child(4){width:64px}
.ttable4 td{padding:0;text-align:right;white-space:nowrap}
.last{margin-top:12px}
`

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1104">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// Post-match page 1: what this means for us

const ARROW = `<path d="M4.5 8 H11 M8.2 5.2 L11 8 L8.2 10.8" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>`
const TAGS: Record<TakeawayTag, { color: string; glyph: string; word: string }> = {
  keep: { color: YOU_DARK, glyph: CHECK, word: "Keep" },
  fix: { color: THEM, glyph: BANG, word: "Fix" },
  try: { color: MUTED, glyph: ARROW, word: "Try" },
}
const tagIcon = (tag: TakeawayTag, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" class="icon"><circle cx="8" cy="8" r="8" fill="${TAGS[tag].color}"></circle>${TAGS[tag].glyph}</svg>`
const AREA_WORD = { tactic: "Tactic", training: "Training", selection: "Selection", recruitment: "Recruitment" } as const
const OUTLOOK_WORD = { rest: "Rest", start: "Start", watch: "Watch", form: "Form dip" } as const
const VERDICT_MARK: Record<NonNullable<TrendRow["verdict"]>, { glyph: string; word: string; color: string }> = {
  better: { glyph: "▲", word: "Better", color: YOU_DARK },
  worse: { glyph: "▼", word: "Worse", color: THEM },
  same: { glyph: "–", word: "Same", color: MUTED },
}
const CHECK_MARK: Record<ActionCheck["status"], { word: string; color: string }> = {
  done: { word: "Done", color: YOU_DARK },
  "not yet": { word: "Not yet", color: MUTED },
  worse: { word: "Worse", color: THEM },
  "no measure": { word: "–", color: MUTED },
}

function trendWord(row: TrendRow): string {
  if (!row.verdict) return ""
  const mark = VERDICT_MARK[row.verdict]
  return `<span class="tw" style="color: ${mark.color}">${mark.glyph} ${mark.word}</span>`
}

function takeawayCard(row: MeaningPage["takeaways"][number]): string {
  const trend = row.trend
    ? `<p class="kt">${esc(row.trend.label)}: <b>${esc(row.trend.now)}</b>${row.trend.average ? ` · usual ${esc(row.trend.average)}` : ""} ${trendWord(row.trend)}</p>`
    : ""
  return `<article class="take">
<div class="ttop">${tagIcon(row.tag)}<span class="tword" style="color: ${TAGS[row.tag].color}">${TAGS[row.tag].word}</span><h3>${esc(row.title)}</h3></div>
<p class="klabel">What happened</p><p class="ktext">${esc(row.happened)}</p>
<p class="klabel">Why</p><p class="ktext">${esc(row.why)}</p>
<div class="next"><p class="klabel">Next match</p><p class="ntext">${esc(row.action)}</p></div>
${trend}
</article>`
}

function meaningHtml(page: MeaningPage): string {
  const carry = page.carry
    .map(
      (row) =>
        `<li><span class="box" aria-hidden="true"></span><div class="grow"><p class="ctext">${esc(row.action)}</p>${row.check ? `<p class="cnote">Check: ${esc(row.check)}</p>` : ""}</div><span class="area">${AREA_WORD[row.area]}</span></li>`
    )
    .join("")
  const trendHead = `<thead><tr><th></th><th class="r">This match</th><th class="r">${page.trend.matches > 0 ? `Last ${page.trend.matches === 1 ? "match" : page.trend.matches}` : ""}</th><th></th></tr></thead>`
  const trendRows = page.trend.rows
    .map(
      (row) =>
        `<tr><th>${esc(row.label)}</th><td><b>${esc(row.now)}</b></td><td>${row.average ? esc(row.average) : "–"}</td><td class="tv">${trendWord(row)}</td></tr>`
    )
    .join("")
  const last = page.lastTime
    ? `<div class="last">${sectionHead(`Last time we said · ${esc(page.lastTime.from)}`)}<ul class="lastl">${page.lastTime.checks
        .slice(0, 3)
        .map(
          (check) =>
            `<li><div class="grow"><p class="ctext">${esc(check.action)}</p><p class="cnote">${esc(check.result)}</p></div><span class="area" style="color: ${CHECK_MARK[check.status].color}">${CHECK_MARK[check.status].word}</span></li>`
        )
        .join("")}</ul></div>`
    : ""
  const outlook = page.outlook
    .map(
      (row) =>
        `<li><div class="grow"><p class="oname"><b>${esc(row.name)}</b>${row.position ? ` <span class="muted">${esc(row.position)}</span>` : ""}</p><p class="cnote">${esc(row.why)}</p></div><div class="onum"><span class="area">${OUTLOOK_WORD[row.outlook]}</span><p class="cnote">${row.rating != null ? `${row.rating.toFixed(1)}` : ""}${row.condition != null ? ` · ${row.condition}%` : ""}</p></div></li>`
    )
    .join("")
  return `<main class="page">
${header(page.header)}
<p class="headline">${esc(page.headline)}</p>
<section aria-label="Three takeaways" class="takes">${page.takeaways.map(takeawayCard).join("")}</section>
<div class="row4">
<section aria-label="Carry forward">${sectionHead("Carry forward", note("Saved and checked next match"))}<ul class="carry">${carry}</ul></section>
<section aria-label="New or a trend">${sectionHead("New or a trend?", page.trend.matches > 1 ? note("Average of your last matches") : "")}<table class="ttable4">${trendHead}<tbody>${trendRows}</tbody></table>${page.trend.note ? `<p class="setp">${esc(page.trend.note)}</p>` : ""}${last}</section>
<section aria-label="Player outlook">${sectionHead("Player outlook", note("Rating · condition at the whistle"))}${outlook ? `<ul class="carry">${outlook}</ul>` : `<p class="setp">No player notes for this match.</p>`}</section>
</div>
</main>`
}

const capitalise = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text)

export function postMatchHtml(page: PostMatchPage, meaning?: MeaningPage): string {
  const verdict = page.verdict
    .map(
      (item, index) =>
        `<div><span class="n">${index + 1}</span><div class="grow"><p class="t">${esc(item.title)}</p><p class="d">${esc(item.detail)}</p></div></div>`
    )
    .join("")
  const legend = `<div class="legendrow"><span>${keyLine(YOU)}${esc(page.header.you.name)}</span><span>${keyLine(THEM)}${esc(page.header.them.name)}</span><span>${keyDot(MUTED)}Goal</span></div>`
  const body = `${meaning ? meaningHtml(meaning) + "\n" : ""}<main class="page">
${header(meaning ? { ...page.header, kicker: "Post-match \u00b7 the evidence" } : page.header)}
<section aria-label="The verdict" class="verdict">${verdict}</section>
<div class="row2">
<section aria-label="Match flow" style="min-width: 0">${sectionHead("Match flow", legend)}${flowChart(page.flow)}</section>
${shotsBlock(page)}
</div>
<div class="row3">
${momentsBlock(page)}
${plansBlock(page)}
${shapeBlock(page)}
</div>
</main>`
  return htmlDocument(`Post-match report: ${page.header.you.name} ${page.header.you.goals}-${page.header.them.goals} ${page.header.them.name}`, body)
}

export function halfTimeHtml(page: HalfTimePage): string {
  const body = `<main class="page">
${header(page.header)}
<div style="margin-top: 14px">${decisionsBlock(page)}</div>
<div class="mid3">
${turnBlock(page)}
<section aria-label="What they are doing">${sectionHead(`What ${esc(page.header.them.name)} are doing`)}<ul class="plan">${page.theirPlan
    .map(
      (row) =>
        `<li class="wrap" style="padding: 4px 0"><div class="iconcell">${row.status ? statusIcon(row.status) : `<span class="bullet"></span>`}</div><div class="grow"><div class="spread"><span class="label">${esc(
          row.label
        )}</span>${row.status ? `<span class="word">${STATUS[row.status].word}</span>` : ""}</div><p class="ev clamp2">${esc(row.evidence)}</p></div></li>`
    )
    .join("")}</ul></section>
<section aria-label="Our plan so far">${sectionHead("Our plan so far")}${planRows(page.ourPlan)}<p class="setp">${page.setPieces}</p></section>
</div>
<div style="margin-top: 14px">${peopleBlock(page)}</div>
</main>`
  return htmlDocument(`Half-time report: ${page.header.you.name} ${page.header.you.goals}-${page.header.them.goals} ${page.header.them.name}`, body)
}
