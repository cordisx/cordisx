import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function desktopAgentSessionRendererTimeoutMs(enabled) {
  return enabled ? 120_000 : 30_000
}

export async function waitForOwnedProfileQuiescence(read, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 100
  const startedAt = Date.now()
  let active = read()
  while (active.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, timeoutMs - (Date.now() - startedAt))))
    active = read()
  }
  return active
}

export async function writeDesktopAgentSessionHarnessReport(reportPath, fallback, harness) {
  let report
  let fallbackCreated = false
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    report = fallback
    fallbackCreated = true
  }
  const next = { ...report, harness }
  await mkdir(path.dirname(reportPath), { recursive: true })
  const temporary = `${reportPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, reportPath)
  return { fallbackCreated }
}
