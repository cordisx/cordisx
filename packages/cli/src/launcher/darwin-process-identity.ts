import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ProcessIdentity } from './process-identity.js'
import { compareProcessStartTimes, processIdentityEnvironment } from './process-start-identity.js'

const helper = fileURLToPath(
  new URL(
    import.meta.url.includes('/dist/')
      ? '../../native/CordisXProcessIdentity'
      : '../../dist/native/CordisXProcessIdentity',
    import.meta.url,
  ),
)
const maximumPid = 0x7fffffff

export function parseDarwinProcessIdentities(text: string, expectedPid: number): readonly ProcessIdentity[] {
  const snapshot = JSON.parse(text) as { version?: unknown; status?: unknown; reason?: unknown; processes?: unknown }
  if (snapshot?.version === 1 && snapshot.status === 'unavailable') {
    const reason = ['empty', 'truncated', 'enumeration-denied', 'identity-unavailable', 'invalid-identity']
      .find(reason => reason === snapshot.reason)
    if (reason !== undefined) throw new Error(`Darwin process identity snapshot is unavailable (${reason})`)
  }
  if (snapshot?.version !== 1 || snapshot.status !== 'complete' || !Array.isArray(snapshot.processes)) {
    throw new Error('Invalid Darwin process identity snapshot')
  }
  const seen = new Set<number>()
  const identities = snapshot.processes.map((row: Partial<ProcessIdentity> | null) => {
    const { pid, parentPid, startedAt } = row ?? {}
    if (
      typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > maximumPid || seen.has(pid)
      || typeof parentPid !== 'number' || !Number.isInteger(parentPid) || parentPid < 0 || parentPid > maximumPid
      || pid === parentPid || typeof startedAt !== 'string'
      || compareProcessStartTimes(startedAt, startedAt) !== 'alive'
    ) throw new Error('Invalid Darwin process identity row')
    seen.add(pid)
    return { pid, parentPid, startedAt }
  })
  // An empty or incomplete result must never be interpreted as proof of exit.
  if (!seen.has(expectedPid)) throw new Error('Darwin process identity snapshot omitted the launcher')
  return identities
}

export function darwinProcessIdentities(maxBuffer: number): readonly ProcessIdentity[] {
  return parseDarwinProcessIdentities(
    execFileSync(helper, [], {
      encoding: 'utf8',
      env: processIdentityEnvironment(),
      maxBuffer,
      timeout: 2_000,
    }),
    process.pid,
  )
}
