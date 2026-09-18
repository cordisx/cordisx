export const PROJECTION_LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u
export const INTERNAL_MARKETPLACE_SOURCE = 'https://code.byted.org/fe/cordisx-plugins'
export const INTERNAL_PACKAGE = /^@byted\/cordisx-plugin-[a-z0-9][a-z0-9._-]*$/u
export const INTERNAL_SOURCE_MERGE_REQUEST =
  /^https:\/\/code\.byted\.org\/fe\/cordisx-plugins\/merge_requests\/[1-9][0-9]*$/u
export const GIT_COMMIT = /^[a-f0-9]{40}$/u
export const CERTIFIED_EXTENSION_POINTS = ['manager.settings.navigation-items', 'manager.content'] as const

const SEMANTIC_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

export function uniqueSortedStrings(
  value: unknown,
  label: string,
  maximum: number,
  validate: (item: string) => boolean,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} items`)
  }
  const values = value.map((item, index) => {
    if (typeof item !== 'string' || !validate(item)) throw new Error(`${label}[${index}] is invalid`)
    return item
  })
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`)
  return Object.freeze([...values].sort())
}

export function isSemanticVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 5 && value.length <= 64 && SEMANTIC_VERSION.test(value)
}

export function dateTimeEpoch(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)([Zz]|([+-])(\d{2})(?::?(\d{2}))?)$/u
    .exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = Number(match[9] ?? 0)
  const offsetMinute = Number(match[10] ?? 0)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [0, 31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] ?? 0
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59
    || offsetHour > 23 || offsetMinute > 59 || second >= 61
  ) return undefined
  const offsetSign = match[8] === '-' ? -1 : 1
  const utcMinute = minute - offsetMinute * offsetSign
  const utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0)
  if (second >= 60 && !((utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1))) {
    return undefined
  }
  const wholeSecond = Math.min(Math.floor(second), 59)
  const millisecond = Math.floor((second - Math.floor(second)) * 1_000)
  const timestamp = new Date(0)
  timestamp.setUTCFullYear(year, month - 1, day)
  timestamp.setUTCHours(hour, minute, wholeSecond, millisecond)
  return timestamp.getTime()
    - offsetSign * (offsetHour * 60 + offsetMinute) * 60_000
    + (second >= 60 ? 1_000 : 0)
}

export function isHttpsUri(value: unknown, maximum = 2_048): value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > maximum || !value.startsWith('https://')
    || /[\u0000-\u0020\u007f]/u.test(value) || /%(?![0-9A-Fa-f]{2})/u.test(value)
  ) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.length > 0
  } catch {
    return false
  }
}
