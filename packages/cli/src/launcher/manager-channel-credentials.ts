import { ChannelCredentialDraftBroker, type ChannelCredentialDraftResult } from './channel-credential-drafts.js'
import type { HostServiceConfigNarrowApi } from './service-config.js'
import type { LauncherSecretStore } from './secret-store.js'
import { validateChannelCredentials } from './channel-credential-validation.js'
import type { ManagerChannelDraftJournal } from './manager-channel-draft-journal.js'
import type { ChannelRuntimeSnapshot } from '@cordisx/channel-runtime'
import type { ChannelManagerActionResult } from './channel-manager-api.js'

type Account = { readonly adapterId: 'feishu' | 'lark'; readonly accountId: string; readonly tenantId: string }
type Base = { readonly kind: 'manager-channel-credentials'; readonly sessionId: string }
export type ManagerChannelCredentialOperation =
  | (Base & { readonly action: 'view' | 'retire' })
  | (Base & {
    readonly action: 'capture'
    readonly purpose: 'create' | 'rotate'
    readonly serviceGeneration: string
    readonly expectedRevision: number
    readonly account: Account
    readonly secret: string
  })
  | (Base & {
    readonly action: 'commit'
    readonly draftId: string
    readonly draft?: {
      readonly displayName?: string
      readonly selectors?: readonly string[]
    }
  })
  | (Base & { readonly action: 'discard'; readonly draftId: string })
  | (Base & {
    readonly action: 'resolve-tenant'
    readonly serviceGeneration: string
    readonly expectedRevision: number
    readonly account: Account
    readonly tenantId?: string
  })
  | (Base & {
    readonly action: 'set-enabled'
    readonly serviceGeneration: string
    readonly expectedRevision: number
    readonly account: Account
    readonly enabled: boolean
  })

const SESSION = /^[a-f0-9]{64}$/u
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const DRAFT = /^[A-Za-z0-9_-]{43}$/u
const RETIRED_MS = 8 * 60 * 60_000
const SESSION_MS = 10 * 60_000
const MAX_RETIRED = 4_096
const VALIDATE_TIMEOUT_MS = 15_000
const fail = (code: string) => ({ status: 'unavailable' as const, code })
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

async function boundedValidation(
  validate: typeof validateChannelCredentials,
  value: Parameters<typeof validateChannelCredentials>[0],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      validate(value),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CREDENTIAL_VALIDATION_TIMEOUT')), VALIDATE_TIMEOUT_MS)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Parsing is deliberately value-free: errors cannot contain a submitted credential. */
export function parseManagerChannelCredentialOperation(value: unknown): ManagerChannelCredentialOperation {
  const item = object(value)
  const action = item?.action
  const common = ['kind', 'sessionId', 'action']
  const fields = action === 'view' || action === 'retire'
    ? common
    : action === 'capture'
    ? [...common, 'purpose', 'serviceGeneration', 'expectedRevision', 'account', 'secret']
    : action === 'commit'
    ? [...common, 'draftId', 'draft']
    : action === 'discard'
    ? [...common, 'draftId']
    : action === 'resolve-tenant'
    ? [...common, 'serviceGeneration', 'expectedRevision', 'account', 'tenantId']
    : action === 'set-enabled'
    ? [...common, 'serviceGeneration', 'expectedRevision', 'account', 'enabled']
    : []
  if (
    !item || item.kind !== 'manager-channel-credentials' || !fields.length
    || Object.keys(item).some(key => !fields.includes(key)) || typeof item.sessionId !== 'string'
    || !SESSION.test(item.sessionId)
  ) throw new Error('INVALID_CHANNEL_CREDENTIAL_REQUEST')
  if (action === 'capture' || action === 'resolve-tenant' || action === 'set-enabled') {
    const account = object(item.account)
    if (
      !account || Object.keys(account).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))
      || !['feishu', 'lark'].includes(String(account.adapterId)) || typeof account.accountId !== 'string'
      || !/^cli_[A-Za-z0-9_]{1,256}$/u.test(account.accountId) || typeof account.tenantId !== 'string'
      || account.tenantId.length > 512 || /[\u0000-\u001f]/u.test(account.tenantId)
      || typeof item.serviceGeneration !== 'string' || !GENERATION.test(item.serviceGeneration)
      || !Number.isSafeInteger(item.expectedRevision) || (item.expectedRevision as number) < 0
    ) {
      throw new Error('INVALID_CHANNEL_CREDENTIAL_REQUEST')
    }
    if (
      action === 'capture' && (!['create', 'rotate'].includes(String(item.purpose))
        || typeof item.secret !== 'string' || item.secret.length === 0 || item.secret.length > 16 * 1024
        || /[\r\n\u0000]/u.test(item.secret))
    ) throw new Error('INVALID_CHANNEL_CREDENTIAL_REQUEST')
    if (
      action === 'resolve-tenant' && (account.tenantId !== '' || item.tenantId !== undefined
          && (typeof item.tenantId !== 'string' || item.tenantId.length > 512
            || /[\u0000-\u001f]/u.test(item.tenantId)))
    ) {
      throw new Error('INVALID_CHANNEL_CREDENTIAL_REQUEST')
    }
    if (action === 'set-enabled' && (account.tenantId.trim() === '' || typeof item.enabled !== 'boolean')) {
      throw new Error('INVALID_CHANNEL_CREDENTIAL_REQUEST')
    }
  }
  if (action === 'commit' || action === 'discard') {
    if (typeof item.draftId !== 'string' || !DRAFT.test(item.draftId)) {
      throw new Error('INVALID_CHANNEL_CREDENTIAL_REQUEST')
    }
    if (action === 'commit' && item.draft !== undefined) {
      const draft = object(item.draft)
      if (
        !draft || Object.keys(draft).some(key => !['displayName', 'selectors'].includes(key))
        || draft.displayName !== undefined && (typeof draft.displayName !== 'string' || draft.displayName.length > 240)
        || draft.selectors !== undefined && (!Array.isArray(draft.selectors)
            || draft.selectors.some(value => !['direct', 'group', 'mentions', 'replies'].includes(String(value))))
      ) {
        throw new Error('INVALID_CHANNEL_CREDENTIAL_REQUEST')
      }
    }
  }
  return item as unknown as ManagerChannelCredentialOperation
}

interface Session {
  readonly generation: string
  readonly documentId: string
  readonly service: HostServiceConfigNarrowApi
  readonly broker: ChannelCredentialDraftBroker
  expires: number
  retiring: boolean
}

/** Host-local Channel drafts: no credentials or secret references are returned. */
export class ManagerChannelCredentials {
  private readonly sessions = new Map<string, Session>()
  private readonly retired = new Map<string, number>()
  private readonly timer: ReturnType<typeof setInterval>
  private blockedUntil = 0
  private closed = false
  private recovery: Promise<void> | undefined
  constructor(
    private readonly input: {
      readonly profileId: string
      readonly runtimeGeneration: string
      readonly generation: () => string | undefined
      readonly runtime?: () => ChannelRuntimeSnapshot | undefined
      readonly setEnabled?: (
        input: {
          readonly ref: Account
          readonly enabled: boolean
          readonly expectedRevision: number
          readonly generation: string
        },
      ) => Promise<ChannelManagerActionResult>
      readonly withOwner: <T>(action: () => Promise<T>) => Promise<T | undefined>
      readonly openService: (serviceGeneration: string) => HostServiceConfigNarrowApi
      readonly store: LauncherSecretStore
      readonly journal?: Pick<ManagerChannelDraftJournal, 'record' | 'retire' | 'recover' | 'cleanup'>
      readonly now?: () => number
      readonly validateCredentials?: ConstructorParameters<
        typeof ChannelCredentialDraftBroker
      >[0]['validateCredentials']
      readonly discoverTenant?: ConstructorParameters<typeof ChannelCredentialDraftBroker>[0]['discoverTenant']
    },
  ) {
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined)
    }, 30_000)
    this.timer.unref()
  }
  private now() {
    return this.input.now?.() ?? Date.now()
  }
  private denied(sessionId: string) {
    return this.closed || this.blockedUntil > this.now() || this.retired.has(sessionId)
  }
  private async retireSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return true
    session.retiring = true
    try {
      await session.broker.retireDocument(session.documentId)
      await session.broker.dispose()
      session.service.dispose()
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
      return true
    } catch {
      return false
    }
  }
  private async sweep(): Promise<void> {
    const now = this.now()
    for (const [id, expiry] of this.retired) if (expiry <= now) this.retired.delete(id)
    for (const [id, session] of this.sessions) {
      if (session.retiring || session.expires <= now) await this.retireSession(id)
    }
  }
  private open(sessionId: string, generation: string): Session | undefined {
    const existing = this.sessions.get(sessionId)
    if (existing) return !existing.retiring && existing.generation === generation ? existing : undefined
    if (this.sessions.size >= 16) return undefined
    const service = this.input.openService(generation)
    const broker = new ChannelCredentialDraftBroker({
      profileId: this.input.profileId,
      store: this.input.store,
      service,
      ...(this.input.now ? { now: this.input.now } : {}),
      validateCredentials: async value =>
        await boundedValidation(this.input.validateCredentials ?? validateChannelCredentials, value),
      ...(this.input.discoverTenant ? { discoverTenant: this.input.discoverTenant } : {}),
      ...(this.input.journal
        ? {
          recordDraft: (reference: string) => this.input.journal!.record(reference),
          retireDraft: (reference: string) => this.input.journal!.retire(reference),
          cleanupDraft: (reference: string) => this.input.journal!.cleanup(reference),
        }
        : {}),
    })
    const session = {
      generation,
      documentId: `manager:${sessionId}`,
      service,
      broker,
      expires: this.now() + SESSION_MS,
      retiring: false,
    }
    this.sessions.set(sessionId, session)
    return session
  }
  private async descriptor(service: HostServiceConfigNarrowApi) {
    const descriptor = await service.descriptor()
    if (
      descriptor.identity.pluginId !== 'channel' || descriptor.identity.serviceId !== 'runtime'
      || descriptor.scope.profileId !== this.input.profileId
      || descriptor.scope.generation !== this.input.runtimeGeneration
    ) {
      throw new Error('stale scope')
    }
    return descriptor
  }
  async handle(value: unknown): Promise<unknown> {
    let mutationAttempted = false
    try {
      const operation = parseManagerChannelCredentialOperation(value)
      if (this.closed) return fail('OWNER_UNAVAILABLE')
      if (operation.action === 'retire') {
        for (const [id, expiry] of this.retired) if (expiry <= this.now()) this.retired.delete(id)
        if (
          this.blockedUntil > this.now() || !this.retired.has(operation.sessionId) && this.retired.size >= MAX_RETIRED
        ) {
          this.blockedUntil = this.now() + RETIRED_MS
          for (const id of this.sessions.keys()) void this.retireSession(id)
        } else this.retired.set(operation.sessionId, this.now() + RETIRED_MS)
        return await this.retireSession(operation.sessionId)
          ? { status: 'retired' }
          : fail('CREDENTIAL_CLEANUP_UNAVAILABLE')
      }
      if (this.blockedUntil > this.now()) return fail('SESSION_CAPACITY')
      if (this.retired.has(operation.sessionId)) return fail('SESSION_RETIRED')
      const result = await this.input.withOwner(async () => {
        if (this.denied(operation.sessionId)) return fail('SESSION_RETIRED')
        if (this.input.journal) {
          this.recovery ??= this.input.journal.recover().catch(error => {
            this.recovery = undefined
            throw error
          })
          try {
            await this.recovery
          } catch {
            return fail('DRAFT_RECOVERY_UNAVAILABLE')
          }
        }
        const generation = this.input.generation()
        if (!generation) return fail('CHANNEL_UNAVAILABLE')
        if (operation.action === 'view') {
          const service = this.input.openService(generation)
          try {
            const descriptor = await this.descriptor(service)
            if (this.denied(operation.sessionId) || generation !== this.input.generation()) {
              return fail('STALE_GENERATION')
            }
            const configuration = object(descriptor.configuration)
            if (!configuration || !Array.isArray(configuration.connections)) return fail('CHANNEL_UNAVAILABLE')
            const runtimeAccounts = this.input.runtime?.()?.accounts ?? []
            const connections = configuration.connections.filter(value => {
              const ref = object(object(value)?.ref)
              return ref && ['feishu', 'lark'].includes(String(ref.adapterId))
            }).map(value => {
              const item = object(value)!
              const ref = object(item.ref)!
              const observed = runtimeAccounts.find(candidate =>
                candidate.ref.adapterId === ref.adapterId
                && candidate.ref.accountId === ref.accountId && candidate.ref.tenantId === ref.tenantId
              )
              const state = observed?.connectionState
              const credential = observed?.secretState
              return {
                ref: item.ref,
                enabled: item.enabled,
                connectionState:
                  state && ['disabled', 'starting', 'ready', 'retrying', 'unavailable', 'stopped'].includes(state)
                    ? state
                    : 'unknown',
                secretState: credential && ['missing', 'ready', 'unavailable'].includes(credential)
                  ? credential
                  : 'unknown',
                ...(item.displayName === undefined ? {} : { displayName: item.displayName }),
              }
            })
            const pendingConnections = Array.isArray(configuration.pendingConnections)
              ? configuration.pendingConnections.filter(value => {
                const account = object(object(value)?.account)
                return account && ['feishu', 'lark'].includes(String(account.adapterId))
              }).map(value => {
                const item = object(value)!
                return {
                  account: item.account,
                  ...(item.displayName === undefined ? {} : { displayName: item.displayName }),
                }
              })
              : []
            return {
              status: 'available',
              revision: descriptor.revision,
              serviceGeneration: generation,
              writable: descriptor.writable,
              connections,
              pendingConnections,
            }
          } finally {
            service.dispose()
          }
        }
        if (operation.action === 'set-enabled') {
          if (generation !== operation.serviceGeneration) return fail('STALE_GENERATION')
          if (!this.input.setEnabled) return fail('CHANNEL_UNAVAILABLE')
          mutationAttempted = true
          const changed = await this.input.setEnabled({
            ref: operation.account,
            enabled: operation.enabled,
            expectedRevision: operation.expectedRevision,
            generation,
          })
          if (changed.status === 'applied') return { status: 'applied' }
          if (changed.code === 'REVISION_CONFLICT') return { status: 'conflict', code: 'REVISION_CONFLICT' }
          if (changed.status === 'not-found') return fail('TARGET_UNAVAILABLE')
          const allowed = [
            'STALE_GENERATION',
            'PERMISSION_DENIED',
            'CONNECTION_CONFIGURATION_UNAVAILABLE',
          ]
          return typeof changed.code === 'string' && allowed.includes(changed.code)
            ? fail(changed.code)
            : { status: 'unknown', code: 'RESULT_UNKNOWN' }
        }
        if (
          (operation.action === 'capture' || operation.action === 'resolve-tenant')
          && generation !== operation.serviceGeneration
        ) return fail('STALE_GENERATION')
        const previous = this.sessions.get(operation.sessionId)
        if (previous && (previous.generation !== generation || previous.expires <= this.now())) {
          if (!await this.retireSession(operation.sessionId)) return fail('CREDENTIAL_CLEANUP_UNAVAILABLE')
        }
        const session = operation.action === 'capture' || operation.action === 'resolve-tenant'
          ? this.open(operation.sessionId, generation)
          : this.sessions.get(operation.sessionId)
        if (!session || session.retiring || session.generation !== generation || session.expires <= this.now()) {
          return fail('DRAFT_UNAVAILABLE')
        }
        if (operation.action === 'capture' || operation.action === 'resolve-tenant') {
          const descriptor = await this.descriptor(session.service)
          if (!descriptor.writable) return fail('PERMISSION_DENIED')
          if (descriptor.revision !== operation.expectedRevision) {
            return { status: 'conflict', code: 'REVISION_CONFLICT' }
          }
        }
        if (this.denied(operation.sessionId) || session.retiring || generation !== this.input.generation()) {
          return fail('STALE_GENERATION')
        }
        const { kind: _kind, sessionId: _sessionId, action, ...request } = operation
        void _kind
        void _sessionId
        if ('serviceGeneration' in request) delete (request as { serviceGeneration?: string }).serviceGeneration
        mutationAttempted = action === 'commit' || action === 'resolve-tenant'
        const response = await session.broker.handle(
          { operation: action, owner: session.documentId, ...request },
          session.documentId,
        )
        session.expires = this.now() + SESSION_MS
        if (
          mutationAttempted && response.status === 'rejected'
          && !['INVALID_REQUEST', 'TARGET_UNAVAILABLE', 'UNSUPPORTED_SELECTOR', 'PERMISSION_DENIED', 'STALE_GENERATION']
            .includes(response.code)
        ) {
          return { status: 'unknown', code: 'RESULT_UNKNOWN' }
        }
        return response as ChannelCredentialDraftResult
      })
      return result ?? fail('CHANNEL_OWNER_UNAVAILABLE')
    } catch {
      return mutationAttempted
        ? { status: 'unknown', code: 'RESULT_UNKNOWN' }
        : fail('CHANNEL_CREDENTIAL_OPERATION_FAILED')
    }
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    const results = await Promise.all([...this.sessions.keys()].map(id => this.retireSession(id)))
    if (results.some(result => !result)) throw new Error('CREDENTIAL_CLEANUP_UNAVAILABLE')
  }
}
