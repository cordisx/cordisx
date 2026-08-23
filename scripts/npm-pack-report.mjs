export function npmPackItem(report, packageName) {
  const item = Array.isArray(report) ? report[0] : report?.[packageName]
  if (item === undefined || item === null || typeof item !== 'object') {
    throw new Error(`npm pack did not report ${packageName}`)
  }
  return item
}
