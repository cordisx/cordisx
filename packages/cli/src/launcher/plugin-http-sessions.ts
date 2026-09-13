import { createHash, randomBytes } from 'node:crypto'
import type { HttpSessionScopeV2 } from '@cordisx/protocol/plugin-http/v2'
import type { OwnerDocumentPrincipal } from './owner-document-rpc.js'
import type { LauncherKeychainBackend } from './secret-store.js'

export interface RetainedHttpSession {
  readonly location: string
  readonly revision: string
  readonly account: string
}
const queues = new Map<string, Promise<unknown>>()
export async function sessionCommit<T>(location: string, run: () => Promise<T>): Promise<T> {
  const prior = queues.get(location) ?? Promise.resolve()
  const pending = prior.catch(() => {}).then(run)
  queues.set(location, pending)
  try {
    return await pending
  } finally {
    if (queues.get(location) === pending) queues.delete(location)
  }
}
export function sessionLocation(principal: OwnerDocumentPrincipal, account: string, scope: HttpSessionScopeV2): string {
  for (const [label, value, minimum] of [['sourceId', scope.sourceId, 1], ['accountId', scope.accountId, 0]] as const) {
    if (
      typeof value !== 'string' || value.length < minimum || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error(`invalid ${label}`)
    }
  }
  return createHash('sha256').update(
    JSON.stringify([
      principal.profileId,
      account,
      principal.identity.source,
      principal.identity.pluginId,
      scope.origin,
      scope.sourceId,
      scope.accountId,
    ]),
  ).digest('hex')
}
const service = 'cordisx/http-session/v2'
export async function readSession(backend: LauncherKeychainBackend, location: string) {
  if (await backend.status(service, location) === 'unset') return null
  const entry = JSON.parse(await backend.read(service, location)) as {
    revision?: unknown
    secret?: unknown
    nativeAccount?: unknown
  }
  if (
    typeof entry.revision !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(entry.revision)
    || typeof entry.secret !== 'string' || !entry.secret || entry.secret.length > 12_000
    || /[\r\n\u0000]/u.test(entry.secret)
    || (entry.nativeAccount !== undefined
      && (typeof entry.nativeAccount !== 'string' || !entry.nativeAccount || entry.nativeAccount.length > 1024))
  ) throw new Error('credential-unavailable')
  return {
    revision: entry.revision,
    secret: entry.secret,
    ...(typeof entry.nativeAccount === 'string' ? { nativeAccount: entry.nativeAccount } : {}),
  }
}
export async function writeSession(
  backend: LauncherKeychainBackend,
  location: string,
  secret: string,
  nativeAccount?: string,
) {
  if (!secret || secret.length > 12_000 || /[\r\n\u0000]/u.test(secret)) throw new Error('credential-unavailable')
  const revision = randomBytes(32).toString('base64url')
  await backend.upsert(
    service,
    location,
    JSON.stringify({ revision, secret, ...(nativeAccount === undefined ? {} : { nativeAccount }) }),
  )
  return revision
}
export async function removeSession(backend: LauncherKeychainBackend, location: string, revision?: string) {
  if (revision !== undefined) {
    const entry = await readSession(backend, location)
    if (entry === null || entry.revision !== revision) return false
  }
  await backend.remove(service, location)
  return true
}
