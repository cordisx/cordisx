/** Keep ps identity output independent of the caller's locale without changing its environment. */
export function processIdentityEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C' }
}

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const chineseWeekdays = ['日', '一', '二', '三', '四', '五', '六']
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Read only C lstart and the confirmed Darwin zh_CN legacy format. Compare
 * calendar fields, not Date.parse or timezone-dependent epoch conversions.
 * Unsupported old locale records cannot prove a live PID was reused.
 */
function startTimeKey(value: string): string | undefined {
  const english =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u
      .exec(value)
  const chinese = /^([日一二三四五六])\s+(\d{1,2})月\/\s*(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(value)
  const match = english ?? chinese
  if (match === null) return undefined
  const weekday = english === null ? chineseWeekdays.indexOf(match[1]!) : weekdays.indexOf(match[1]!)
  const month = english === null ? Number(match[2]) - 1 : months.indexOf(match[2]!)
  const [day, hour, minute, second, year] = match.slice(3).map(Number)
  if (
    month < 0 || month > 11 || day! < 1 || day! > 31 || hour! > 23
    || minute! > 59 || second! > 59 || year! < 1000
  ) return undefined
  const date = new Date(Date.UTC(year!, month, day))
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCDay() !== weekday) return undefined
  return [year, month, day, hour, minute, second].join(':')
}

/** Unknown legacy text fails closed; only comparable full timestamps prove PID reuse. */
export function compareProcessStartTimes(current: string, recorded: string): 'alive' | 'dead' | 'unknown' {
  const currentKey = startTimeKey(current)
  const recordedKey = startTimeKey(recorded)
  if (currentKey === undefined || recordedKey === undefined) return 'unknown'
  return currentKey === recordedKey ? 'alive' : 'dead'
}
