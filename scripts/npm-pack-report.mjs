export function npmPackItem(report, packageName) {
  const item = Array.isArray(report) ? report[0] : report?.[packageName]
  if (item === undefined || item === null || typeof item !== 'object') {
    throw new Error(`npm pack did not report ${packageName}`)
  }
  return item
}

export function npmViewItem(report, subject) {
  if (!Array.isArray(report)) return report
  if (report.length !== 1) {
    throw new Error(`npm view returned ${report.length} results for ${subject}`)
  }
  return report[0]
}

export function npmMaintainerNames(value) {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return entries.map((entry) => {
    if (typeof entry === 'string') return /^\s*([^\s<]+)/.exec(entry)?.[1]
    return typeof entry?.name === 'string' ? entry.name : undefined
  }).filter(Boolean)
}
