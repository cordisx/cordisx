import type { HttpConnectionV1, HttpResultV1 } from '@cordisx/protocol/plugin-http/v1'
import type { LocalWalletHttpResultV4 } from '@cordisx/protocol/plugin-http/v4'
import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import type { OwnerDocumentPrincipal } from './owner-document-rpc.js'
import type { Grant } from './plugin-http-authority.js'
import type { PluginHttpClientLifetime } from './plugin-http-client-lifetime.js'
import type { LauncherKeychainBackend } from './secret-store.js'
import {
  type HttpNativeAccountValue,
  HttpNativeCallingContextUnavailableError,
} from './plugin-http-native-account-diagnostics.js'
import type { LocalWalletAuthority } from './local-wallet-authority.js'
const fail = (
  code: 'invalid-request' | 'connection-unavailable' | 'stale-generation' | 'deadline-exceeded',
): HttpResultV1<never> => ({
  status: 'unavailable',
  code,
})
const accepted = <T>(value: T): HttpResultV1<T> => ({ status: 'accepted', value })
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid local wallet request')
  return value as Record<string, unknown>
}
interface LocalWalletHttpOperationOptions {
  readonly setPublicationGuard: (guard: () => void) => void
  readonly setNativeReadLive: (live: () => boolean) => void
  readonly input: Record<string, unknown>
  readonly principal: OwnerDocumentPrincipal
  readonly client: PluginHttpClientLifetime
  readonly clientLive: () => boolean
  readonly account: (() => Promise<HttpNativeAccountValue>) | undefined
  readonly readWork: (() => Promise<WorkUsageSnapshotV2>) | undefined
  readonly ownerKey: string
  readonly keychain: LauncherKeychainBackend
  readonly local: LocalWalletAuthority
  readonly grants: Map<string, Grant>
  readonly live: () => boolean
  readonly authorize: (
    principal: OwnerDocumentPrincipal,
    input: Record<string, unknown>,
    client: PluginHttpClientLifetime,
  ) => Promise<HttpResultV1<HttpConnectionV1>>
  readonly retire: (id: string, grant: Grant) => Promise<void>
}
export async function handleLocalWalletHttpOperation(
  options: LocalWalletHttpOperationOptions,
): Promise<LocalWalletHttpResultV4<unknown>> {
  const deadline = options.input.managedDeadline
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline > Date.now() + 15_000) {
    return fail('invalid-request')
  }
  if (deadline <= Date.now()) return fail('deadline-exceeded')
  let active = true
  let timer!: ReturnType<typeof setTimeout>
  const expired = new Promise<LocalWalletHttpResultV4<unknown>>(resolve => {
    timer = setTimeout(() => {
      active = false
      resolve(fail('deadline-exceeded'))
    }, deadline - Date.now())
  })
  options.setNativeReadLive(() => active && Date.now() < deadline && options.clientLive() && options.live())
  const run = executeLocalWalletHttpOperation({
    ...options,
    live: () => active && Date.now() < deadline && options.live(),
  })
  try {
    return await Promise.race([run, expired])
  } finally {
    active = false
    clearTimeout(timer)
  }
}
async function executeLocalWalletHttpOperation(
  options: LocalWalletHttpOperationOptions,
): Promise<LocalWalletHttpResultV4<unknown>> {
  const { input, principal, client, clientLive, account, readWork } = options
  const enrolling = input.operation === 'plugin-http-enroll-local-wallet'
  const request = record(input.input)
  const binding = enrolling ? record(request.binding) : request
  if (
    binding.audience !== (enrolling
      ? 'local-wallet-enrollment'
      : ['plugin-http-submit-local-work', 'plugin-http-settle-local-work'].includes(String(input.operation))
      ? 'local-work-income'
      : 'local-wallet')
  ) return fail('invalid-request')
  let enrollment: {
    originalAccountId: string
    account: () => Promise<HttpNativeAccountValue>
    bearer: () => Promise<string>
  } | undefined
  let grantLive = () => true
  if (enrolling) {
    if (Object.keys(request).some(name => !['binding', 'connection'].includes(name)) || !account) {
      return fail('invalid-request')
    }
    const descriptor = record(request.connection), previous = options.grants.get(String(descriptor.id))
    if (
      !previous || previous.client !== client || previous.owner !== options.ownerKey || !previous.nativeAccount
      || !previous.nativeWalletAccountId || previous.retained || previous.localFence
      || previous.connection.origin !== binding.origin || descriptor.origin !== previous.connection.origin
      || descriptor.contract !== previous.connection.contract || descriptor.credential !== 'bearer'
      || previous.connection.credential !== 'bearer'
    ) return fail('connection-unavailable')
    const pinned = previous.nativeAccount
    grantLive = () => options.grants.get(previous.connection.id) === previous && previous.nativeAccount === pinned
    const reader = account
    enrollment = {
      originalAccountId: previous.nativeWalletAccountId,
      account: async () => {
        const value = await reader()
        if (value instanceof HttpNativeCallingContextUnavailableError) throw value
        if (!grantLive() || value !== pinned) throw new Error('original grant retired')
        return value
      },
      bearer: async () => {
        if (!grantLive()) throw new Error('original grant retired')
        return options.keychain.read(previous.keychainService, previous.connection.id)
      },
    }
  }
  const live = () => clientLive() && grantLive() && options.live()
  const result = await options.local.execute(
    principal,
    binding,
    Number(input.managedDeadline),
    live,
    enrollment,
    readWork,
    input.operation === 'plugin-http-settle-local-work',
  )
  options.setPublicationGuard(result.publicationGuard)
  result.publicationGuard()
  if (!live() || !options.local.current(result.profile)) return fail('stale-generation')
  const response = {
    statusCode: result.statusCode,
    contentType: 'application/json',
    body: JSON.stringify(result.body),
  }
  if (input.operation !== 'plugin-http-connect-local-account') return accepted(response)
  const { sessionToken, ...safe } = result.body
  if (
    typeof sessionToken !== 'string' || result.body.instanceId !== binding.instanceId
    || typeof record(result.body.account).id !== 'string' || !record(result.body.account).id
  ) return fail('invalid-request')
  const authorized = await options.authorize(principal, {
    origin: binding.origin,
    credential: 'bearer',
    secret: sessionToken,
  }, client)
  if (authorized.status !== 'accepted') return authorized
  const grant = options.grants.get(authorized.value.id)!
  const local = options.local
  grant.localFence = () => local.current(result.profile)
  if (!live() || !grant.localFence()) {
    await options.retire(grant.connection.id, grant)
    return fail('stale-generation')
  }
  return accepted({ connection: authorized.value, response: { ...response, body: JSON.stringify(safe) } })
}
