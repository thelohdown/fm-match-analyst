// Team colours for the printed reports, taken from the kit colours FM stores for
// each team (ARGB numbers in the match metadata). Each theme gets its own pair:
// a colour has to stand out from the page and the panels (3:1, the minimum for
// graphics), and the opponent's has to look different from ours. Our team keeps
// its first readable kit colour; the opponent moves down its own list (shirt,
// shirt trim, club colours) until it is both readable and distinct. With nothing
// usable, the old fixed blue and orange stand in.

export type KitSource = {
  shirtBackgroundColor?: number
  shirtForegroundColor?: number
  backgroundColour?: number
  foregroundColour?: number
}

export type Theme = "light" | "dark"
export type TeamPair = { you: string; them: string }

/** Page and panel colours of each theme, as reportPage.ts draws them. */
export const SURFACES: Record<Theme, { page: string; panel: string }> = {
  light: { page: "#ffffff", panel: "#f5f5f2" },
  dark: { page: "#12161b", panel: "#1b2027" },
}
export const FALLBACK: TeamPair = { you: "#2a78d6", them: "#eb6834" }

const MIN_CONTRAST = 3
/** OKLab distance below which two team colours read as the same. */
const MIN_DISTANCE = 0.12

type Rgb = { r: number; g: number; b: number }

export function teamColours(you?: KitSource, them?: KitSource): Record<Theme, TeamPair> {
  return { light: pick("light", you, them), dark: pick("dark", you, them) }
}

function pick(theme: Theme, you?: KitSource, them?: KitSource): TeamPair {
  const readable = (color: string) => surfaceContrast(color, theme) >= MIN_CONTRAST
  const ours = candidates(you).find(readable) ?? FALLBACK.you
  const distinct = (color: string) => distance(color, ours) >= MIN_DISTANCE
  const theirs =
    candidates(them).find((color) => readable(color) && distinct(color)) ??
    [FALLBACK.them, FALLBACK.you].find(distinct) ??
    FALLBACK.them
  return { you: ours, them: theirs }
}

function candidates(source?: KitSource): string[] {
  if (!source) return []
  const values = [source.shirtBackgroundColor, source.shirtForegroundColor, source.backgroundColour, source.foregroundColour]
  const colors = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && (value >>> 24) !== 0)
    .map((value) => "#" + (value & 0xffffff).toString(16).padStart(6, "0"))
  return [...new Set(colors)]
}

// ---------------------------------------------------------------------------
// Colour arithmetic

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace("#", ""), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function rgbToHex({ r, g, b }: Rgb): string {
  return "#" + [r, g, b].map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("")
}

const linear = (channel: number) => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function surfaceContrast(color: string, theme: Theme): number {
  return Math.min(contrast(color, SURFACES[theme].page), contrast(color, SURFACES[theme].panel))
}

function oklab(hex: string): [number, number, number] {
  const { r, g, b } = hexToRgb(hex)
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export function distance(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a)
  const [l2, a2, b2] = oklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/** `amount` of `color` laid over `base`. */
export function mix(color: string, base: string, amount: number): string {
  const c = hexToRgb(color)
  const b = hexToRgb(base)
  return rgbToHex({ r: c.r * amount + b.r * (1 - amount), g: c.g * amount + b.g * (1 - amount), b: c.b * amount + b.b * (1 - amount) })
}

/** White or near-black, whichever reads better on `fill`. */
export function textOn(fill: string): string {
  return contrast("#ffffff", fill) >= contrast("#0b0b0b", fill) ? "#ffffff" : "#0b0b0b"
}
