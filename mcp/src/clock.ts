// Football Manager's match clock, worked out from engine ticks.
//
// The engine runs at 4 ticks per second of match time. Ticks keep counting
// through first-half stoppage time, while FM's clock restarts the second half at
// 45:00, so the second-half clock is 45:00 plus the ticks since that half began.
// (FM's own event records carry the clock: in a capture the penalty FM listed at
// 82' sat at tick 19918 with clock 81:38, 324 ticks of first-half stoppage
// earlier.) FM labels minutes from 1: 0:00-0:59 is 1', and stoppage time is
// 45+1', 90+2' and so on.

export const TICKS_PER_SECOND = 4

/** Clock seconds at which each period starts, and at which its regulation time ends. */
const PERIOD_START_SECONDS = [0, 0, 2700, 5400, 6300]
const PERIOD_END_SECONDS = [0, 2700, 5400, 6300, 7200]

export function periodStartSeconds(period: number): number {
  return PERIOD_START_SECONDS[Math.min(Math.max(period, 1), 4)]
}

export function periodEndSeconds(period: number): number {
  return PERIOD_END_SECONDS[Math.min(Math.max(period, 1), 4)]
}

/** The last regulation minute of a period: 45, 90, 105 or 120. */
export function periodEndMinute(period: number): number {
  return periodEndSeconds(period) / 60
}

/**
 * FM minute number for a clock time: 1 for 0:00-0:59, 46 for 45:00-45:59. Stoppage
 * minutes keep counting (47, 48) and are labelled 45+2', 45+3' by minuteLabel.
 */
export function minuteNumber(clockSeconds: number): number {
  return Math.floor(Math.max(0, clockSeconds) / 60) + 1
}

/** A minute as FM shows it: 18', 45+2', 90+1'. */
export function minuteLabel(clockSeconds: number, period: number): string {
  const end = periodEndSeconds(period)
  if (clockSeconds < end) return `${minuteNumber(clockSeconds)}'`
  return `${end / 60}+${Math.floor((clockSeconds - end) / 60) + 1}'`
}

/** A clock reading: 67:12, or 45+1:35 in stoppage time. */
export function clockLabel(clockSeconds: number, period: number): string {
  const end = periodEndSeconds(period)
  const seconds = Math.max(0, Math.floor(clockSeconds))
  const pad = (value: number) => String(value).padStart(2, "0")
  if (seconds < end) return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`
  const extra = seconds - end
  return `${end / 60}+${Math.floor(extra / 60)}:${pad(extra % 60)}`
}

/**
 * The minute used to pick time windows. Stoppage minutes collapse onto the last
 * regulation minute, so first-half stoppage counts as 45 (not 46, which belongs
 * to the second half) and second-half stoppage as 90.
 */
export function windowMinute(clockSeconds: number, period: number): number {
  return Math.min(minuteNumber(clockSeconds), periodEndMinute(period))
}

export function periodName(period: number): string {
  switch (period) {
    case 1:
      return "first half"
    case 2:
      return "second half"
    case 3:
      return "extra time, first half"
    case 4:
      return "extra time, second half"
    default:
      return `period ${period}`
  }
}
