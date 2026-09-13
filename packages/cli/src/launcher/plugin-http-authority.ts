import { handleLocalWalletHttpOperation } from './local-wallet-http-operation.js'
import type { LocalWalletHttpResultV4 } from '@cordisx/protocol/plugin-http/v4'
import { LocalWalletAuthority } from './local-wallet-authority.js'
import { LocalWalletRegistry, LocalWalletStateError } from './local-wallet-registry.js'
import {
  type HttpNativeAccountValue,
  HttpNativeCallingContextUnavailableError,
  isHttpNativeAccountUnavailableReason,
} from './plugin-http-native-account-diagnostics.js'
import type { HttpSessionScopeV2 } from '@cordisx/protocol/plugin-http/v2'
import {
  readSession,
  removeSession,
  type RetainedHttpSession,
  sessionCommit,
  sessionLocation,
  writeSession,
} from './plugin-http-sessions.js'
import { createHash, randomBytes } from 'node:crypto'
import type {
  HttpConnectionV1,
  HttpFailureCodeV1,
  HttpResponseV1,
  HttpResultV1,
} from '@cordisx/protocol/plugin-http/v1'
import { createMacOSKeychainBackend, type LauncherKeychainBackend } from './secret-store.js'
import { type OwnerDocumentPrincipal, verifyOwnerDocumentPrincipalToken } from './owner-document-rpc.js'
import {
  ManagedSourceAuthority,
  ManagedSourceCredentialUnavailableError,
  type ManagedSourceTrust,
  ManagedSourceTrustUnavailableError,
} from './managed-source-authority.js'
import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import { type PluginHttpClientLifetime, PluginHttpClientLifetimes } from './plugin-http-client-lifetime.js'
import {
  emitPluginHttpDiagnostic,
  type PluginHttpDiagnostic,
  PluginHttpInvalidRequestError,
  type PluginHttpInvalidRequestReason,
  type PluginHttpRetirementReason,
} from './plugin-http-diagnostics.js'

export interface Grant {
  readonly connection: HttpConnectionV1
  readonly principal: OwnerDocumentPrincipal
  readonly owner: string
  readonly client: PluginHttpClientLifetime
  readonly keychainService: string
  readonly requests: Map<string, AbortController>
  readonly issued: number
  localFence?: () => boolean
  retained?: RetainedHttpSession
  nativeWalletAccountId?: string
  nativeAccount?: string
  accountReader?: () => Promise<HttpNativeAccountValue>
  checkingAccount?: boolean
  checkedAccountAt?: number
}
export interface PluginHttpAuthorityOptions {
  readonly localWalletHomeDir?: string
  readonly secret: string
  readonly profileId: string
  readonly generation: string
  readonly principalAllowed: (principal: OwnerDocumentPrincipal) => boolean
  readonly keychain?: LauncherKeychainBackend | null
  readonly fetch?: typeof fetch
  readonly managedSources?: () => Promise<readonly ManagedSourceTrust[]>
  readonly managedSourcesNow?: () => readonly ManagedSourceTrust[]
  readonly onDiagnostic?: (event: PluginHttpDiagnostic) => void
}
const fail = (code: HttpFailureCodeV1): HttpResultV1<never> => ({ status: 'unavailable', code })
const accepted = <T>(value: T): HttpResultV1<T> => ({ status: 'accepted', value })
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginHttpInvalidRequestError('record-invalid')
  }
  return value as Record<string, unknown>
}
const key = (principal: OwnerDocumentPrincipal): string =>
  JSON.stringify([
    principal.profileId,
    principal.generation,
    principal.moduleGeneration,
    principal.identity.source,
    principal.identity.pluginId,
  ])
export function canonicalHttpOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new PluginHttpInvalidRequestError('origin-invalid')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PluginHttpInvalidRequestError('origin-invalid')
  }
  if (
    !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || (value !== url.origin && value !== `${url.origin}/`)
  ) throw new PluginHttpInvalidRequestError('origin-invalid')
  return url.origin
}
export function isPluginHttpRequest(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && String((value as Record<string, unknown>).operation).startsWith('plugin-http-')
}

/** Launcher-only authority. Plaintext is accepted only from the Host capture UI. */
export class PluginHttpAuthority {
  private readonly grants = new Map<string, Grant>()
  private readonly clients = new PluginHttpClientLifetimes()
  private issued = 0
  private readonly forgotten = new Map<string, number>()
  private readonly keychain: LauncherKeychainBackend | undefined
  private readonly transport: typeof fetch
  private disposed = false
  private local?: LocalWalletAuthority
  private managed?: ManagedSourceAuthority
  private managedInit?: Promise<ManagedSourceAuthority>
  private readonly accountEpochs = new Map<string, number>()
  private readonly managedRequests = new Map<string, Promise<HttpResultV1<unknown>>>()
  private readonly retirement: ReturnType<typeof setInterval>
  constructor(private readonly options: PluginHttpAuthorityOptions) {
    this.keychain = options.keychain === null
      ? undefined
      : options.keychain ?? (process.platform === 'darwin' ? createMacOSKeychainBackend() : undefined)
    this.transport = options.fetch ?? fetch
    this.retirement = setInterval(() => {
      for (const [id, grant] of this.grants) {
        if (
          !grant.client.active || !this.options.principalAllowed(grant.principal)
          || (grant.localFence && !grant.localFence())
        ) {
          void this.retire(id, grant, 'principal-retired').catch(() => {})
        } else if (
          grant.nativeAccount && grant.accountReader && !grant.checkingAccount
          && Date.now() - (grant.checkedAccountAt ?? 0) >= 1000
        ) {
          grant.checkingAccount = true
          grant.checkedAccountAt = Date.now()
          const epoch = this.managed?.epoch(grant.principal) ?? 0
          void grant.accountReader().then(account => {
            if (account instanceof HttpNativeCallingContextUnavailableError) {
              return this.retire(id, grant, 'native-calling-context-unavailable')
            }
            if (this.grants.get(id) === grant && (this.managed?.epoch(grant.principal) ?? 0) === epoch) {
              this.observeNative(grant.principal, account)
            }
            if (account !== grant.nativeAccount) {
              return this.retire(id, grant, account === null ? 'native-account-unavailable' : 'native-account-changed')
            }
          }).catch(error => {
            if (error instanceof HttpNativeCallingContextUnavailableError) {
              return this.retire(id, grant, 'native-calling-context-unavailable')
            }
            if (this.grants.get(id) === grant && (this.managed?.epoch(grant.principal) ?? 0) === epoch) {
              this.managed?.closeOwner(grant.principal)
            }
            return this.retire(id, grant, 'native-account-unavailable')
          }).finally(() => {
            grant.checkingAccount = false
          }).catch(() => {})
        }
      }
    }, 250)
    this.retirement.unref()
  }
  private principal(token: unknown): OwnerDocumentPrincipal | undefined {
    if (this.disposed || typeof token !== 'string') return undefined
    const value = verifyOwnerDocumentPrincipalToken(this.options.secret, token)
    return value?.profileId === this.options.profileId && value.generation === this.options.generation
        && this.options.principalAllowed(value)
      ? value
      : undefined
  }
  reportNativeAccountUnavailable(raw: unknown, reason: unknown): void {
    if (!isHttpNativeAccountUnavailableReason(reason)) return
    const input = record(raw), principal = this.principal(input.token)
    if (!principal) return
    const client = this.clients.find(key(principal), input.clientId)
    if (!client || client.reportedNativeReasons.has(reason)) return
    client.reportedNativeReasons.add(reason)
    emitPluginHttpDiagnostic(this.options.onDiagnostic, {
      event: 'native-account-read-unavailable',
      pluginId: principal.identity.pluginId,
      client: client.key,
      reason,
    })
  }
  private invalidRequest(
    principal: OwnerDocumentPrincipal,
    client: PluginHttpClientLifetime,
    reason: PluginHttpInvalidRequestReason,
    connection?: string,
  ) {
    if (!client.reportedInvalidReasons.has(reason)) {
      client.reportedInvalidReasons.add(reason)
      emitPluginHttpDiagnostic(this.options.onDiagnostic, {
        event: 'invalid-request',
        pluginId: principal.identity.pluginId,
        client: client.key,
        reason,
        ...(connection === undefined ? {} : { connection }),
      })
    }
    return fail('invalid-request')
  }
  private observeNative(principal: OwnerDocumentPrincipal, account: string | null) {
    this.managed?.observeAccount(principal, account)
    for (const [id, grant] of this.grants) {
      if (grant.owner === key(principal) && grant.nativeAccount && grant.nativeAccount !== account) {
        void this.retire(id, grant, account === null ? 'native-account-unavailable' : 'native-account-changed').catch(
          () => {},
        )
      }
    }
  }
  private managedRequest(
    principal: OwnerDocumentPrincipal,
    deadline: number,
    queueKey: string,
    work: boolean,
    live: () => boolean,
    run: (
      active: () => boolean,
      cleanup: (retire: () => Promise<void>) => void,
      observe: () => void,
    ) => Promise<HttpResultV1<unknown>>,
  ) {
    let active = true, observed = false, epoch = this.managed?.epoch(principal) ?? 0
    const observe = () => {
      if (!observed) {
        observed = true
        epoch = this.managed?.epoch(principal) ?? 0
      }
    }
    const cleanups = new Set<() => Promise<void>>()
    const cleanup = (retire: () => Promise<void>) => {
      if (active && live() && Date.now() < deadline) cleanups.add(retire)
      else void retire().catch(() => {})
    }
    let timeout: ReturnType<typeof setTimeout>
    const expired = new Promise<HttpResultV1<unknown>>(resolve => {
      timeout = setTimeout(() => {
        active = false
        if (work && live() && (this.managed?.epoch(principal) ?? 0) === epoch) this.managed?.closeOwner(principal)
        for (const retire of cleanups) void retire().catch(() => {})
        resolve(fail('deadline-exceeded'))
      }, Math.max(0, deadline - Date.now()))
    })
    const previous = this.managedRequests.get(queueKey) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => {
      if (!active || Date.now() >= deadline) return fail('deadline-exceeded')
      if (!live()) return fail('stale-generation')
      return Promise.race([run(() => active && live() && Date.now() < deadline, cleanup, observe), expired])
    })
    const queued = operation.catch(error => {
      for (const retire of cleanups) void retire().catch(() => {})
      throw error
    }).finally(() => {
      if (this.managedRequests.get(queueKey) === queued) this.managedRequests.delete(queueKey)
    })
    this.managedRequests.set(queueKey, queued)
    return Promise.race([queued, expired]).finally(() => {
      active = false
      clearTimeout(timeout)
    })
  }
  async handle(
    raw: unknown,
    account?: () => Promise<HttpNativeAccountValue>,
    readWork?: () => Promise<WorkUsageSnapshotV2>,
  ): Promise<LocalWalletHttpResultV4<unknown>> {
    // Every observed Native change, including ordinary retained requests and
    // exchange/session checks, retires managed work continuity for this owner.
    let diagnosticPrincipal: OwnerDocumentPrincipal | undefined
    let diagnosticClient: PluginHttpClientLifetime | undefined
    let nativeReadLive = () => true
    let nativeReadObserved = () => {}
    const reader = account
    if (reader) {
      account = async () => {
        const principal = this.principal(record(raw).token)
        const epoch = principal ? this.managed?.epoch(principal) ?? 0 : 0
        try {
          const value = await reader()
          if (value instanceof HttpNativeCallingContextUnavailableError) return value
          if (principal && nativeReadLive()) {
            if ((this.managed?.epoch(principal) ?? 0) !== epoch) {
              this.reportNativeAccountUnavailable(raw, 'authority-native-epoch-obsolete')
              return null
            }
            this.observeNative(principal, value)
            nativeReadObserved()
          }
          return value
        } catch (error) {
          if (error instanceof HttpNativeCallingContextUnavailableError) return error
          this.reportNativeAccountUnavailable(raw, 'authority-native-read-exception')
          if (principal && nativeReadLive() && (this.managed?.epoch(principal) ?? 0) === epoch) {
            this.observeNative(principal, null)
          }
          return null
        }
      }
    }
    try {
      const input = record(raw)
      const principal = this.principal(input.token)
      if (principal === undefined) return fail('stale-generation')
      diagnosticPrincipal = principal
      diagnosticClient = this.clients.find(key(principal), input.clientId)
      const client = this.clients.open(key(principal), input.clientId)
      diagnosticClient = client
      if (input.operation === 'plugin-http-dispose') {
        if (!client.active) return accepted(null)
        this.clients.close(client)
        emitPluginHttpDiagnostic(this.options.onDiagnostic, {
          event: 'client-disposed',
          pluginId: principal.identity.pluginId,
          client: client.key,
        })
        if (!this.clients.hasSibling(client)) {
          this.local?.closeOwner(principal)
          this.managed?.closeOwner(principal)
          this.accountEpochs.set(key(principal), (this.accountEpochs.get(key(principal)) ?? 0) + 1)
        }
        for (const [id, grant] of this.grants) {
          if (grant.client === client) await this.retire(id, grant, 'client-disposed')
        }
        return accepted(null)
      }
      if (!client.active) return fail('stale-generation')
      const clientEpoch = client.epoch
      const clientLive = () => client.active && client.epoch === clientEpoch
      nativeReadLive = clientLive
      if (
        ['plugin-http-enroll-local-wallet', 'plugin-http-connect-local-account', 'plugin-http-submit-local-work']
          .includes(String(input.operation))
      ) {
        if (
          !this.keychain || !this.options.localWalletHomeDir || !this.options.managedSources
          || !this.options.managedSourcesNow
        ) return fail('unsupported')
        this.local ??= new LocalWalletAuthority({
          registry: new LocalWalletRegistry(this.options.localWalletHomeDir, this.options.profileId, this.keychain),
          keychain: this.keychain,
          fetch: this.transport,
          trusts: this.options.managedSources,
          trustsNow: this.options.managedSourcesNow,
          live: owner => !this.disposed && this.options.principalAllowed(owner),
        })
        return await handleLocalWalletHttpOperation({
          setNativeReadLive: live => {
            nativeReadLive = live
          },
          input,
          principal,
          client,
          clientLive,
          account,
          readWork,
          ownerKey: key(principal),
          keychain: this.keychain,
          local: this.local,
          grants: this.grants,
          live: () => !this.disposed && this.options.principalAllowed(principal),
          authorize: (owner, request, lifetime) => this.authorize(owner, request, lifetime),
          retire: (id, grant) => this.retire(id, grant),
        })
      }
      if (input.operation === 'plugin-http-connect-account' || input.operation === 'plugin-http-submit-work') {
        if (!account || !this.keychain || !this.options.managedSources) return fail('unsupported')
        const deadline = input.managedDeadline
        if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline > Date.now() + 15_000) {
          return this.invalidRequest(principal, client, 'managed-deadline-invalid')
        }
        if (deadline <= Date.now()) return fail('deadline-exceeded')
        const rawBinding = record(input.input)
        const queueKey = JSON.stringify([
          principal,
          client.key,
          rawBinding.origin,
          rawBinding.sourceId,
          rawBinding.instanceId,
          rawBinding.audience,
        ])
        if (this.managedRequests.size >= 128 && !this.managedRequests.has(queueKey)) {
          return this.invalidRequest(principal, client, 'managed-queue-limit')
        }
        return await this.managedRequest(
          principal,
          deadline,
          queueKey,
          input.operation === 'plugin-http-submit-work',
          clientLive,
          async (operationActive, cleanup, observe) => {
            nativeReadLive = () => operationActive() && clientLive()
            nativeReadObserved = observe
            const epoch = this.accountEpochs.get(key(principal)) ?? 0
            const live = () => operationActive() && (this.accountEpochs.get(key(principal)) ?? 0) === epoch
            this.managedInit ??= (async () => {
              const managed = new ManagedSourceAuthority({
                trusts: [],
                getTrusts: this.options.managedSources!,
                keychain: this.keychain!,
                fetch: this.transport,
                live: owner => !this.disposed && this.options.principalAllowed(owner),
                trustedNow: trust =>
                  !!this.options.managedSourcesNow?.().some(entry =>
                    entry.signingKeyRef === trust.signingKeyRef && entry.serverPublicKey === trust.serverPublicKey
                    && JSON.stringify(entry.binding) === JSON.stringify(trust.binding)
                    && entry.owner.pluginId === trust.owner.pluginId && entry.owner.source === trust.owner.source
                  ),
                trusted: async trust =>
                  (await this.options.managedSources!()).some(entry =>
                    entry.signingKeyRef === trust.signingKeyRef && entry.serverPublicKey === trust.serverPublicKey
                    && JSON.stringify(entry.binding) === JSON.stringify(trust.binding)
                    && entry.owner.pluginId === trust.owner.pluginId && entry.owner.source === trust.owner.source
                  ),
                ...(readWork === undefined ? {} : { readWork: async () => readWork() }),
              })
              if (this.disposed) managed.dispose()
              this.managed = managed
              return managed
            })()
            const managed = await this.managedInit
            const request = record(input.input)
            if (input.operation === 'plugin-http-submit-work') {
              let completedEpoch: number | undefined
              try {
                const result = await managed.submit(principal, request, account, live)
                completedEpoch = result.accountEpoch
                const currentAccount = await account()
                if (currentAccount instanceof HttpNativeCallingContextUnavailableError) throw currentAccount
                if (!live() || this.disposed || !this.options.principalAllowed(principal)) {
                  return fail('credential-unavailable')
                }
                if (
                  currentAccount !== result.account || !live() || this.disposed
                  || !this.options.principalAllowed(principal)
                ) throw new Error('managed source retired')
                return accepted({
                  statusCode: result.statusCode,
                  contentType: 'application/json',
                  body: JSON.stringify(result.body),
                })
              } catch (error) {
                if (
                  !(error instanceof HttpNativeCallingContextUnavailableError)
                  && operationActive() && completedEpoch !== undefined && managed.epoch(principal) === completedEpoch
                ) {
                  managed.closeOwner(principal)
                }
                return fail(
                  error instanceof ManagedSourceTrustUnavailableError
                    ? 'connection-unavailable'
                    : 'credential-unavailable',
                )
              }
            }
            const { previousConnection, ...binding } = request
            let previousBearer: string | undefined
            let previousValid = () => true
            if (previousConnection !== undefined) {
              const descriptor = record(previousConnection), previous = this.grants.get(String(descriptor.id))
              if (
                !previous || previous.client !== client || previous.owner !== key(principal)
                || previous.connection.origin !== binding.origin
                || descriptor.origin !== previous.connection.origin
                || descriptor.contract !== previous.connection.contract
                || descriptor.credential !== 'bearer' || previous.connection.credential !== 'bearer'
                || (previous.retained && await account() !== previous.retained.account)
                || (previous.nativeAccount && await account() !== previous.nativeAccount)
              ) return fail('connection-unavailable')
              previousBearer = await this.keychain!.read(previous.keychainService, previous.connection.id)
              previousValid = () => this.grants.get(previous.connection.id) === previous
            }
            const result = await managed.connect(
              principal,
              binding,
              account,
              previousBearer,
              () => live() && previousValid(),
            )
            const { sessionToken, ...safe } = result.body
            if (
              typeof sessionToken !== 'string' || result.body.instanceId !== binding.instanceId
              || typeof record(result.body.account).id !== 'string' || !record(result.body.account).id
            ) return this.invalidRequest(principal, client, 'managed-response-invalid')
            const authorized = await this.authorize(principal, {
              origin: binding.origin,
              credential: 'bearer',
              secret: sessionToken,
            }, client)
            if (authorized.status !== 'accepted') return authorized
            const grant = this.grants.get(authorized.value.id)!
            grant.nativeWalletAccountId = String(record(result.body.account).id)
            grant.nativeAccount = result.account
            grant.accountReader = account
            cleanup(() => this.retire(grant.connection.id, grant))
            if (!live()) {
              await this.retire(grant.connection.id, grant)
              return fail('credential-unavailable')
            }
            if (
              await account() !== result.account || !live() || this.disposed
              || !this.options.principalAllowed(principal)
            ) {
              await this.retire(grant.connection.id, grant)
              return fail('credential-unavailable')
            }
            return accepted({
              connection: authorized.value,
              response: {
                statusCode: result.statusCode,
                contentType: 'application/json',
                body: JSON.stringify(safe),
              },
            })
          },
        )
      }
      if (['plugin-http-retain', 'plugin-http-resume', 'plugin-http-forget'].includes(String(input.operation))) {
        return await this.sessionOperation(principal, input, client, account)
      }
      if (input.operation === 'plugin-http-authorize') return await this.authorize(principal, input, client)
      const connection = record(input.connection)
      const grant = this.grants.get(String(connection.id))
      if (
        grant === undefined || grant.client !== client || grant.owner !== key(principal)
        || connection.contract !== grant.connection.contract || connection.origin !== grant.connection.origin
        || connection.credential !== grant.connection.credential
      ) {
        if (!client.reportedUnavailable) {
          client.reportedUnavailable = true
          emitPluginHttpDiagnostic(this.options.onDiagnostic, {
            event: 'connection-not-owned',
            pluginId: principal.identity.pluginId,
            client: client.key,
            ...(typeof connection.id === 'string' ? { connection: connection.id } : {}),
          })
        }
        return fail('connection-unavailable')
      }
      if (input.operation === 'plugin-http-revoke') {
        client.epoch++
        if (grant.retained !== undefined || !this.clients.hasSibling(client)) {
          this.local?.closeOwner(principal)
          this.managed?.closeOwner(principal)
          this.accountEpochs.set(key(principal), (this.accountEpochs.get(key(principal)) ?? 0) + 1)
        }
        try {
          if (grant.retained !== undefined) {
            if (this.keychain === undefined) return fail('credential-unavailable')
            const retained = grant.retained
            if (await account?.() !== retained.account) return fail('credential-unavailable')
            await sessionCommit(retained.location, async () => {
              if (await removeSession(this.keychain!, retained.location, retained.revision)) {
                this.forgotten.set(retained.location, this.issued)
              }
              for (const [id, other] of this.grants) {
                if (other.retained?.location === retained.location && other.retained.revision === retained.revision) {
                  await this.retire(id, other, 'client-revoked')
                }
              }
            })
          } else await this.retire(grant.connection.id, grant, 'client-revoked')
        } catch {
          return fail('credential-unavailable')
        }
        return accepted(null)
      }
      if (input.operation === 'plugin-http-abort') {
        grant.requests.get(String(input.operationId))?.abort()
        return accepted(null)
      }
      if (input.operation === 'plugin-http-exchange') return await this.exchange(grant, input, account)
      if (input.operation !== 'plugin-http-request') {
        return this.invalidRequest(principal, client, 'operation-unsupported')
      }
      return await this.request(grant, input, account)
    } catch (error) {
      if (
        error instanceof ManagedSourceCredentialUnavailableError
        || error instanceof HttpNativeCallingContextUnavailableError
      ) return fail('credential-unavailable')
      if (error instanceof LocalWalletStateError) return { status: 'unavailable', code: error.code }
      if (error instanceof ManagedSourceTrustUnavailableError) return fail('connection-unavailable')
      return diagnosticPrincipal && diagnosticClient
        ? this.invalidRequest(
          diagnosticPrincipal,
          diagnosticClient,
          error instanceof PluginHttpInvalidRequestError ? error.reason : 'authority-request-exception',
        )
        : fail('invalid-request')
    }
  }
  private async sessionOperation(
    principal: OwnerDocumentPrincipal,
    input: Record<string, unknown>,
    client: PluginHttpClientLifetime,
    readAccount?: () => Promise<HttpNativeAccountValue>,
  ): Promise<HttpResultV1<unknown>> {
    if (input.operation === 'plugin-http-retain' && this.grants.get(String(record(input.connection).id))?.localFence) {
      return fail('unsupported')
    }
    if (this.keychain === undefined || readAccount === undefined) return fail('unsupported')
    const nativeAccount = await readAccount()
    if (typeof nativeAccount !== 'string' || !nativeAccount) return fail('credential-unavailable')
    const scope = record(input.scope)
    if (Object.keys(scope).some(name => !['origin', 'sourceId', 'accountId'].includes(name))) {
      return this.invalidRequest(principal, client, 'session-scope-invalid')
    }
    const origin = canonicalHttpOrigin(scope.origin)
    const url = new URL(origin)
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return this.invalidRequest(principal, client, 'session-origin-insecure')
    }
    const location = sessionLocation(principal, nativeAccount, { ...scope, origin } as unknown as HttpSessionScopeV2)
    const clientEpoch = client.epoch
    return await sessionCommit(location, async () => {
      const valid = async () => {
        const currentAccount = await readAccount()
        return client.active && client.epoch === clientEpoch && currentAccount === nativeAccount
          && !this.disposed && this.options.principalAllowed(principal)
      }
      if (!await valid()) return fail('stale-generation')
      try {
        if (input.operation === 'plugin-http-forget') {
          this.local?.closeOwner(principal)
          this.managed?.closeOwner(principal)
          this.accountEpochs.set(key(principal), (this.accountEpochs.get(key(principal)) ?? 0) + 1)
          await removeSession(this.keychain!, location)
          this.forgotten.set(location, this.issued)
          for (const [id, grant] of this.grants) {
            if (grant.retained?.location === location) await this.retire(id, grant, 'session-forgotten')
          }
          return accepted(null)
        }
        if (input.operation === 'plugin-http-retain') {
          const descriptor = record(input.connection)
          const grant = this.grants.get(String(descriptor.id))
          if (
            grant === undefined || grant.client !== client || grant.owner !== key(principal)
            || grant.connection.origin !== origin
            || descriptor.contract !== grant.connection.contract || descriptor.origin !== origin
            || descriptor.credential !== 'bearer' || grant.connection.credential !== 'bearer'
            || (grant.nativeAccount !== undefined && grant.nativeAccount !== nativeAccount)
          ) return fail('connection-unavailable')
          if (
            grant.retained !== undefined
            && (grant.retained.location !== location || grant.retained.account !== nativeAccount)
          ) return this.invalidRequest(principal, client, 'session-retained-scope-mismatch')
          if (grant.issued <= (this.forgotten.get(location) ?? -1)) return fail('credential-unavailable')
          const secret = await this.keychain!.read(grant.keychainService, grant.connection.id)
          if (!await valid() || this.grants.get(grant.connection.id) !== grant) return fail('stale-generation')
          const revision = await writeSession(this.keychain!, location, secret, grant.nativeAccount)
          if (!await valid() || this.grants.get(grant.connection.id) !== grant) {
            await removeSession(this.keychain!, location, revision)
            return fail('stale-generation')
          }
          grant.retained = { location, revision, account: nativeAccount }
          return accepted(null)
        }
        const entry = await readSession(this.keychain!, location)
        if (!await valid()) return fail('stale-generation')
        if (entry === null) return accepted(null)
        if (entry.nativeAccount !== undefined && entry.nativeAccount !== nativeAccount) {
          return fail('credential-unavailable')
        }
        const result = await this.authorize(principal, { origin, credential: 'bearer', secret: entry.secret }, client)
        if (result.status !== 'accepted') return result
        const grant = this.grants.get(result.value.id)!
        if (!await valid()) {
          await this.retire(result.value.id, grant)
          return fail('stale-generation')
        }
        grant.retained = { location, revision: entry.revision, account: nativeAccount }
        if (entry.nativeAccount !== undefined) {
          grant.nativeAccount = entry.nativeAccount
          grant.accountReader = readAccount
        }
        return result
      } catch {
        return fail('credential-unavailable')
      }
    })
  }
  private async authorize(
    principal: OwnerDocumentPrincipal,
    input: Record<string, unknown>,
    client: PluginHttpClientLifetime,
  ) {
    const clientEpoch = client.epoch
    const origin = canonicalHttpOrigin(input.origin)
    if (input.credential !== 'none' && input.credential !== 'bearer') {
      return this.invalidRequest(principal, client, 'authorization-credential-invalid')
    }
    const url = new URL(origin)
    if (
      input.credential === 'bearer' && url.protocol !== 'https:'
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) return this.invalidRequest(principal, client, 'authorization-origin-insecure')
    if (this.grants.size >= 128) return fail('unsupported')
    const id = randomBytes(32).toString('base64url')
    const connection: HttpConnectionV1 = {
      contract: 'cordisx.http-connection/v1',
      id,
      origin,
      credential: input.credential,
    }
    const owner = key(principal)
    const keychainService = `cordisx/http/${createHash('sha256').update(owner).digest('hex')}`
    if (input.credential === 'bearer') {
      if (this.keychain === undefined) return fail('unsupported')
      if (
        typeof input.secret !== 'string' || input.secret.length < 1 || input.secret.length > 16_384
        || /[\r\n\u0000]/u.test(input.secret)
      ) return this.invalidRequest(principal, client, 'authorization-secret-invalid')
      try {
        await this.keychain.upsert(keychainService, id, input.secret)
      } catch {
        return fail('credential-unavailable')
      }
    } else if (input.secret !== undefined) {
      return this.invalidRequest(principal, client, 'authorization-secret-unexpected')
    }
    if (!client.active || client.epoch !== clientEpoch || this.disposed || !this.options.principalAllowed(principal)) {
      if (input.credential === 'bearer') await this.keychain?.remove(keychainService, id).catch(() => {})
      return fail('stale-generation')
    }
    this.grants.set(id, {
      connection,
      principal,
      owner,
      client,
      keychainService,
      requests: new Map(),
      issued: ++this.issued,
    })
    return accepted(connection)
  }
  private async exchange(
    grant: Grant,
    input: Record<string, unknown>,
    account?: () => Promise<HttpNativeAccountValue>,
  ): Promise<HttpResultV1<unknown>> {
    const field = input.credentialField
    if (
      typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(field)
      || ['__proto__', 'constructor', 'prototype'].includes(field)
    ) return this.invalidRequest(grant.principal, grant.client, 'exchange-field-invalid', grant.connection.id)
    const result = await this.request(grant, { ...input, method: 'POST' }, account)
    if (result.status !== 'accepted') return result
    if (result.value.statusCode < 200 || result.value.statusCode >= 300) return fail('network-error')
    let body: Record<string, unknown>
    try {
      body = record(JSON.parse(result.value.body))
    } catch {
      return this.invalidRequest(grant.principal, grant.client, 'exchange-response-invalid', grant.connection.id)
    }
    if (!Object.hasOwn(body, field) || typeof body[field] !== 'string') return fail('credential-unavailable')
    if (
      (grant.nativeAccount !== undefined && await account?.() !== grant.nativeAccount)
      || (grant.localFence && !grant.localFence())
      || this.disposed || this.grants.get(grant.connection.id) !== grant
      || !this.options.principalAllowed(grant.principal)
    ) {
      return fail('stale-generation')
    }
    const connection = await this.authorize(grant.principal, {
      origin: grant.connection.origin,
      credential: 'bearer',
      secret: body[field],
    }, grant.client)
    delete body[field]
    if (connection.status !== 'accepted') return connection
    if (
      (grant.nativeAccount !== undefined && await account?.() !== grant.nativeAccount)
      || (grant.localFence && !grant.localFence())
      || this.disposed || this.grants.get(grant.connection.id) !== grant
      || !this.options.principalAllowed(grant.principal)
    ) {
      const child = this.grants.get(connection.value.id)
      if (child !== undefined) await this.retire(child.connection.id, child)
      return fail('stale-generation')
    }
    const child = this.grants.get(connection.value.id)!
    if (grant.localFence) child.localFence = grant.localFence
    if (grant.nativeAccount !== undefined) {
      child.nativeAccount = grant.nativeAccount
      if (grant.accountReader !== undefined) child.accountReader = grant.accountReader
    }
    return accepted({ connection: connection.value, response: { ...result.value, body: JSON.stringify(body) } })
  }

  private async request(
    grant: Grant,
    input: Record<string, unknown>,
    account?: () => Promise<HttpNativeAccountValue>,
  ): Promise<HttpResultV1<HttpResponseV1>> {
    const operationId = input.operationId
    if (
      typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/u.test(operationId)
    ) return this.invalidRequest(grant.principal, grant.client, 'request-id-invalid', grant.connection.id)
    if (grant.requests.has(operationId)) {
      return this.invalidRequest(grant.principal, grant.client, 'request-id-duplicate', grant.connection.id)
    }
    if (grant.requests.size >= 8) {
      return this.invalidRequest(grant.principal, grant.client, 'request-concurrency-limit', grant.connection.id)
    }
    if (
      typeof input.path !== 'string' || input.path.length > 8192 || !input.path.startsWith('/')
      || input.path.startsWith('//') || /[\\#\r\n]/u.test(input.path)
    ) return this.invalidRequest(grant.principal, grant.client, 'request-path-invalid', grant.connection.id)
    const url = new URL(input.path, grant.connection.origin)
    if (url.origin !== grant.connection.origin || url.username || url.password) {
      return this.invalidRequest(grant.principal, grant.client, 'request-origin-invalid', grant.connection.id)
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(input.method))) {
      return this.invalidRequest(grant.principal, grant.client, 'request-method-invalid', grant.connection.id)
    }
    if (typeof input.deadline !== 'number' || !Number.isSafeInteger(input.deadline)) {
      return this.invalidRequest(grant.principal, grant.client, 'request-deadline-invalid', grant.connection.id)
    }
    if (input.deadline <= Date.now()) return fail('deadline-exceeded')
    if (
      input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 1_048_576
        || input.method === 'GET')
    ) return this.invalidRequest(grant.principal, grant.client, 'request-body-invalid', grant.connection.id)
    const headers: Record<string, string> = {}
    if (input.headers !== undefined) {
      for (const [name, value] of Object.entries(record(input.headers))) {
        if (
          !['accept', 'content-type', 'idempotency-key'].includes(name) || typeof value !== 'string'
          || value.length > 4096 || /[\r\n]/u.test(value)
        ) return this.invalidRequest(grant.principal, grant.client, 'request-header-invalid', grant.connection.id)
        headers[name] = value
      }
    }
    const abort = new AbortController()
    grant.requests.set(operationId, abort)
    let expired = false
    const deadline = setTimeout(() => {
      expired = true
      abort.abort()
    }, Math.min(30_000, input.deadline - Date.now()))
    const fence = setInterval(() => {
      if (
        !this.options.principalAllowed(grant.principal) || this.grants.get(grant.connection.id) !== grant
        || (grant.localFence && !grant.localFence())
      ) {
        abort.abort()
      }
    }, 100)
    const matchesAccount = async () => {
      if (grant.localFence && !grant.localFence()) return false
      const retained = grant.retained?.account, native = grant.nativeAccount
      if (retained !== undefined && native !== undefined && retained !== native) return false
      if (retained === undefined && native === undefined) return true
      // One fresh read per checkpoint validates both pins. Never reuse it
      // across the secret read, transport, or response body observation.
      const current = await account?.()
      return (retained === undefined || current === retained) && (native === undefined || current === native)
        && grant.retained?.account === retained && grant.nativeAccount === native
    }
    try {
      if (!await matchesAccount()) {
        await this.retire(grant.connection.id, grant)
        return fail('credential-unavailable')
      }
      if (grant.connection.credential === 'bearer') {
        try {
          headers.authorization = `Bearer ${await this.keychain!.read(grant.keychainService, grant.connection.id)}`
        } catch {
          return fail('credential-unavailable')
        }
      }
      if (!await matchesAccount()) {
        await this.retire(grant.connection.id, grant)
        return fail('credential-unavailable')
      }
      if (
        abort.signal.aborted || this.disposed || !this.options.principalAllowed(grant.principal)
        || this.grants.get(grant.connection.id) !== grant
      ) return fail(expired ? 'deadline-exceeded' : 'aborted')
      const response = await this.transport(url, {
        method: String(input.method),
        headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: abort.signal,
        ...(input.body === undefined ? {} : { body: input.body as string }),
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        return fail('redirect-denied')
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader !== undefined) {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.byteLength
          if (bytes > 1_048_576) {
            await reader.cancel()
            abort.abort()
            return fail('response-too-large')
          }
          chunks.push(next.value)
        }
      }
      if (!await matchesAccount()) {
        await this.retire(grant.connection.id, grant)
        return fail('credential-unavailable')
      }
      if (
        abort.signal.aborted || this.disposed || !this.options.principalAllowed(grant.principal)
        || this.grants.get(grant.connection.id) !== grant
      ) return fail(expired ? 'deadline-exceeded' : 'aborted')
      return accepted({
        statusCode: response.status,
        contentType: response.headers.get('content-type'),
        body: Buffer.concat(chunks).toString('utf8'),
      })
    } catch {
      return fail(expired ? 'deadline-exceeded' : abort.signal.aborted ? 'aborted' : 'network-error')
    } finally {
      clearTimeout(deadline)
      clearInterval(fence)
      grant.requests.delete(operationId)
    }
  }
  private async retire(
    id: string,
    grant: Grant,
    reason: PluginHttpRetirementReason = 'connection-closed',
  ): Promise<void> {
    if (this.grants.get(id) !== grant) return
    this.grants.delete(id)
    emitPluginHttpDiagnostic(this.options.onDiagnostic, {
      event: 'retired',
      pluginId: grant.principal.identity.pluginId,
      client: grant.client.key,
      connection: id,
      reason,
    })
    for (const abort of grant.requests.values()) abort.abort()
    if (grant.connection.credential === 'bearer') await this.keychain?.remove(grant.keychainService, id)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.local?.dispose()
    this.managed?.dispose()
    clearInterval(this.retirement)
    await Promise.allSettled([...this.grants].map(([id, grant]) => this.retire(id, grant, 'authority-disposed')))
  }
}
