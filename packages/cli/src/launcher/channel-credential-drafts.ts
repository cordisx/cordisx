import { randomBytes } from 'node:crypto'
import { discoverChannelTenant, validateChannelCredentials } from './channel-credential-validation.js'
import type { JsonValue } from '../config/home-config.js'
import type { HostServiceConfigNarrowApi } from './service-config.js'
import type { LauncherSecretStore } from './secret-store.js'

export type ChannelCredentialRef = { readonly adapterId: string; readonly accountId: string; readonly tenantId: string }
export type ChannelCredentialDraftResult = {
  readonly status: 'applied' | 'conflict' | 'rejected' | 'unavailable'
  readonly code: string
  readonly draftId?: string
  readonly ref?: ChannelCredentialRef
  readonly expiresAt?: string
}
interface Draft {
  readonly id: string
  readonly owner: string
  readonly documentId: string
  readonly purpose: 'create' | 'rotate'
  readonly ref: ChannelCredentialRef
  readonly captureId: string
  readonly journalReference?: string
  readonly revision: number
  readonly expiresAt: number
}
const sameRef = (left: ChannelCredentialRef, right: ChannelCredentialRef) =>
  left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId
const rejected = (code: string): ChannelCredentialDraftResult => ({ status: 'rejected', code })
const undispatchedTenantResults = new WeakSet<ChannelCredentialDraftResult>()
function rejectedUndispatchedTenant(code: string): ChannelCredentialDraftResult {
  const result = Object.freeze(rejected(code))
  undispatchedTenantResults.add(result)
  return result
}
/** Owner-only evidence that this result was produced before configuration mutation. */
export function isUndispatchedTenantResult(result: ChannelCredentialDraftResult): boolean {
  return undispatchedTenantResults.has(result)
}
const TENANT_LOOKUP_TIMEOUT_MS = 5_000
async function boundedTenantLookup(operation: Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TENANT_DISCOVERY_FAILED')), TENANT_LOOKUP_TIMEOUT_MS)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
const text = (value: unknown, maximum = 512): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new Error('INVALID_REQUEST')
  }
  return value
}
const ref = (value: unknown): ChannelCredentialRef => {
  const item = record(value)
  if (Object.keys(item).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))) {
    throw new Error('INVALID_REQUEST')
  }
  const adapterId = text(item.adapterId, 128)
  if (!['feishu', 'lark'].includes(adapterId)) throw new Error('ADAPTER_UNAVAILABLE')
  const accountId = text(item.accountId)
  if (!/^cli_[A-Za-z0-9_]+$/u.test(accountId)) throw new Error('INVALID_APP_ID')
  return {
    adapterId,
    accountId,
    tenantId: item.tenantId === undefined || item.tenantId === '' ? '' : text(item.tenantId),
  }
}

/** Launcher-only drafts. Raw credentials and Keychain references never leave this broker. */
export class ChannelCredentialDraftBroker {
  private readonly drafts = new Map<string, Draft>()
  private readonly retiredDocuments = new Set<string>()
  private disposed = false
  private tail: Promise<void> = Promise.resolve()
  private readonly timer: ReturnType<typeof setInterval>
  constructor(
    private readonly input: {
      readonly profileId: string
      readonly store: LauncherSecretStore
      readonly service: Pick<HostServiceConfigNarrowApi, 'descriptor' | 'mutate' | 'privateConfiguration'>
      readonly projection?: () => Promise<unknown>
      readonly now?: () => number
      readonly discoverTenant?: typeof discoverChannelTenant
      readonly validateCredentials?: typeof validateChannelCredentials
      /** Optional Host-private crash recovery journal; never receives a secret value. */
      readonly recordDraft?: (reference: string) => Promise<void>
      readonly retireDraft?: (reference: string) => Promise<void>
      readonly cleanupDraft?: (reference: string) => Promise<boolean>
    },
  ) {
    this.timer = setInterval(() => {
      void this.serial(() => this.expire()).catch(() => undefined)
    }, 30_000)
    this.timer.unref()
  }
  private now() {
    return this.input.now?.() ?? Date.now()
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  handle(value: unknown, documentId: string): Promise<ChannelCredentialDraftResult & { projection?: unknown }> {
    return this.serial(() => this.handleSerial(value, documentId))
  }
  private live(documentId: string): boolean {
    return !this.disposed && !this.retiredDocuments.has(documentId)
  }
  private async handleSerial(
    value: unknown,
    documentId: string,
  ): Promise<ChannelCredentialDraftResult & { projection?: unknown }> {
    try {
      await this.expire()
      const request = record(value)
      const owner = text(request.owner, 2048)
      const allowed = request.operation === 'capture'
        ? ['version', 'token', 'requestId', 'operation', 'owner', 'purpose', 'account', 'secret', 'expectedRevision']
        : request.operation === 'resolve-tenant'
        ? ['version', 'token', 'requestId', 'operation', 'owner', 'account', 'tenantId', 'expectedRevision']
        : [
          'version',
          'token',
          'requestId',
          'operation',
          'owner',
          'draftId',
          ...(request.operation === 'commit' ? ['draft'] : []),
        ]
      if (Object.keys(request).some(key => !allowed.includes(key))) return rejected('INVALID_REQUEST')
      if (!this.live(documentId)) return rejected('STALE_GENERATION')
      if (request.operation === 'capture') return await this.capture(request, owner, documentId)
      if (request.operation === 'resolve-tenant') return await this.resolveTenant(request, documentId)
      const id = text(request.draftId, 128)
      const draft = this.drafts.get(id)
      if (!draft || draft.owner !== owner || draft.documentId !== documentId || draft.expiresAt <= this.now()) {
        return rejected('TARGET_UNAVAILABLE')
      }
      if (request.operation === 'discard') {
        if (!await this.remove(draft)) return { status: 'unavailable', code: 'CREDENTIAL_CLEANUP_UNAVAILABLE' }
        return { status: 'applied', code: 'DISCARDED' }
      }
      if (request.operation !== 'commit') return rejected('OPERATION_UNAVAILABLE')
      const configuration = await this.input.service.descriptor()
      if (configuration.revision !== draft.revision || !configuration.writable) {
        return { status: 'conflict', code: 'REVISION_CONFLICT' }
      }
      const current = record(configuration.configuration)
      const connections = (current.connections as Array<Record<string, unknown>>).map(item => ({ ...item }))
      const pendingConnections = Array.isArray(current.pendingConnections)
        ? (current.pendingConnections as Array<Record<string, unknown>>).map(item => ({ ...item }))
        : []
      const index = connections.findIndex(item => sameRef(item.ref as ChannelCredentialRef, draft.ref))
      const pendingIndex = pendingConnections.findIndex(item => {
        const account = item.account as ChannelCredentialRef
        return account.adapterId === draft.ref.adapterId && account.accountId === draft.ref.accountId
      })
      if (
        draft.purpose === 'create'
          ? index >= 0 || pendingIndex >= 0 || connections.length + pendingConnections.length >= 64
          : draft.ref.tenantId
          ? index < 0
          : pendingIndex < 0
      ) {
        return rejected('TARGET_UNAVAILABLE')
      }
      const reference = this.input.store.referenceFor(draft.captureId)
      if (!reference) return rejected('CREDENTIAL_UNAVAILABLE')
      const patch = draft.purpose === 'create' || request.draft !== undefined ? record(request.draft) : {}
      if (Object.keys(patch).some(key => !['displayName', 'selectors'].includes(key))) {
        return rejected('INVALID_REQUEST')
      }
      if (patch.displayName !== undefined) text(patch.displayName, 240)
      if (
        patch.selectors !== undefined && (!Array.isArray(patch.selectors) || !patch.selectors.length
          || patch.selectors.some(item => !['direct', 'group', 'mentions', 'replies'].includes(item))
          || new Set(patch.selectors).size !== patch.selectors.length)
      ) return rejected('UNSUPPORTED_SELECTOR')
      if (draft.purpose === 'create' && !draft.ref.tenantId) {
        pendingConnections.push({
          account: { adapterId: draft.ref.adapterId, accountId: draft.ref.accountId },
          adapterKind: draft.ref.adapterId,
          secretRef: reference,
          displayName: text(patch.displayName, 240),
          ...(patch.selectors === undefined ? {} : { selectors: patch.selectors }),
        })
      } else if (draft.purpose === 'create') {
        connections.push({
          ref: draft.ref,
          adapterKind: draft.ref.adapterId,
          enabled: true,
          transport: { mode: 'websocket' },
          secretRef: reference,
          displayName: text(patch.displayName, 240),
          ...(patch.selectors === undefined ? {} : { selectors: patch.selectors }),
        })
      } else if (!draft.ref.tenantId) {
        pendingConnections[pendingIndex] = { ...pendingConnections[pendingIndex]!, ...patch, secretRef: reference }
      } else connections[index] = { ...connections[index]!, ...patch, secretRef: reference }
      // Existing opaque references are restored by the narrow API's normal CAS normalization.
      if (!this.live(documentId) || draft.expiresAt <= this.now()) return rejected('STALE_GENERATION')
      const result = await this.input.service.mutate({
        contract: 'cordisx.service-config-mutation/v1',
        schemaVersion: 1,
        identity: configuration.identity,
        scope: configuration.scope,
        expectedRevision: draft.revision,
        configuration: (current.schemaVersion === 3 || pendingConnections.length > 0
          ? { contract: 'cordisx.channel-service-config/v3', schemaVersion: 3, connections, pendingConnections }
          : { contract: 'cordisx.channel-service-config/v2', schemaVersion: 2, connections }) as JsonValue,
      })
      if (result.status !== 'applied') {
        return {
          status: result.status === 'conflict' ? 'conflict' : 'rejected',
          code: result.status === 'staged'
            ? 'OPERATION_UNAVAILABLE'
            : result.error.code.toUpperCase().replaceAll('-', '_'),
        }
      }
      this.drafts.delete(id)
      this.input.store.forget(draft.captureId)
      if (draft.journalReference !== undefined) {
        await this.input.retireDraft?.(draft.journalReference).catch(() => undefined)
      }
      const projection = await this.input.projection?.().catch(() => undefined)
      return { status: 'applied', code: 'APPLIED', ref: draft.ref, ...(projection === undefined ? {} : { projection }) }
    } catch (error) {
      return rejected(
        error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message)
          ? error.message
          : 'CREDENTIAL_OPERATION_FAILED',
      )
    }
  }
  private async resolveTenant(
    request: Record<string, unknown>,
    documentId: string,
  ): Promise<ChannelCredentialDraftResult & { projection?: unknown }> {
    const account = ref(request.account)
    if (
      account.tenantId || !Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0
    ) {
      return rejected('INVALID_REQUEST')
    }
    const descriptor = await this.input.service.descriptor()
    if (!descriptor.writable) return rejected('PERMISSION_DENIED')
    if (descriptor.revision !== request.expectedRevision) return { status: 'conflict', code: 'REVISION_CONFLICT' }
    const stored = await this.input.service.privateConfiguration()
    if (stored.revision !== descriptor.revision) return { status: 'conflict', code: 'REVISION_CONFLICT' }
    const configuration = record(stored.configuration)
    if (
      configuration.schemaVersion !== 3 || !Array.isArray(configuration.pendingConnections)
      || !Array.isArray(configuration.connections)
    ) return rejected('TARGET_UNAVAILABLE')
    const pending = configuration.pendingConnections as Array<Record<string, unknown>>
    const index = pending.findIndex(item => {
      const value = item.account as ChannelCredentialRef
      return value.adapterId === account.adapterId && value.accountId === account.accountId
    })
    if (index < 0) return rejected('TARGET_UNAVAILABLE')
    const entry = pending[index]!
    let tenantId: string
    if (request.tenantId === undefined || request.tenantId === '') {
      try {
        tenantId = await boundedTenantLookup((this.input.discoverTenant ?? discoverChannelTenant)({
          adapterId: account.adapterId,
          accountId: account.accountId,
          secret: await this.input.store.readChannelReference(text(entry.secretRef), this.input.profileId),
        }))
      } catch (error) {
        if (!this.live(documentId)) return rejected('STALE_GENERATION')
        const code = error instanceof Error && [
            'CREDENTIAL_UNAVAILABLE',
            'TENANT_DISCOVERY_PERMISSION_DENIED',
            'TENANT_DISCOVERY_FAILED',
          ].includes(error.message)
          ? error.message
          : 'TENANT_DISCOVERY_FAILED'
        return rejectedUndispatchedTenant(code)
      }
    } else {
      tenantId = text(request.tenantId)
      let discovered: string | undefined
      let checking = true
      try {
        discovered = text(
          await boundedTenantLookup((async () => {
            const secret = await this.input.store.readChannelReferenceSilently(
              text(entry.secretRef),
              this.input.profileId,
            )
            if (!checking || !this.live(documentId)) throw new Error('TENANT_DISCOVERY_FAILED')
            return await (this.input.discoverTenant ?? discoverChannelTenant)({
              adapterId: account.adapterId,
              accountId: account.accountId,
              secret,
            })
          })()),
        )
      } catch {
        /* Manual identity remains available when silent verification is unavailable. */
      } finally {
        checking = false
      }
      if (!this.live(documentId)) return rejected('STALE_GENERATION')
      if (discovered !== undefined && tenantId !== discovered) return rejectedUndispatchedTenant('TENANT_MISMATCH')
    }
    if (!this.live(documentId)) return rejected('STALE_GENERATION')
    const resolved = {
      ref: { ...account, tenantId },
      adapterKind: entry.adapterKind,
      enabled: true,
      transport: { mode: 'websocket' },
      secretRef: entry.secretRef,
      displayName: entry.displayName,
      ...(entry.selectors === undefined ? {} : { selectors: entry.selectors }),
    }
    const result = await this.input.service.mutate({
      contract: 'cordisx.service-config-mutation/v1',
      schemaVersion: 1,
      identity: descriptor.identity,
      scope: descriptor.scope,
      expectedRevision: descriptor.revision,
      configuration: {
        ...configuration,
        connections: [...configuration.connections, resolved],
        pendingConnections: pending.filter((_, candidate) => candidate !== index),
      } as JsonValue,
    })
    if (result.status !== 'applied') {
      return {
        status: result.status === 'conflict' ? 'conflict' : 'rejected',
        code: result.status === 'conflict' ? 'REVISION_CONFLICT' : 'TENANT_RESOLUTION_FAILED',
      }
    }
    const projection = await this.input.projection?.().catch(() => undefined)
    return {
      status: 'applied',
      code: 'APPLIED',
      ref: resolved.ref,
      ...(projection === undefined ? {} : { projection }),
    }
  }
  private async capture(
    request: Record<string, unknown>,
    owner: string,
    documentId: string,
  ): Promise<ChannelCredentialDraftResult> {
    if (this.drafts.size >= 16) return rejected('DRAFT_LIMIT')
    let account = ref(request.account)
    const secret = text(request.secret, 16 * 1024)
    if (!['create', 'rotate'].includes(String(request.purpose))) return rejected('INVALID_REQUEST')
    await (this.input.validateCredentials ?? validateChannelCredentials)({
      adapterId: account.adapterId,
      accountId: account.accountId,
      secret,
    })
    let discovered: string | undefined
    if (request.purpose === 'create') {
      try {
        discovered = text(
          await boundedTenantLookup((this.input.discoverTenant ?? discoverChannelTenant)({
            adapterId: account.adapterId,
            accountId: account.accountId,
            secret,
          })),
        )
      } catch { /* Authenticated credentials remain useful while tenant metadata is unavailable. */ }
    }
    if (!this.live(documentId)) return rejected('STALE_GENERATION')
    if (discovered !== undefined) {
      if (account.tenantId && account.tenantId !== discovered) return rejected('TENANT_MISMATCH')
      account = { ...account, tenantId: discovered }
    }
    const configuration = await this.input.service.descriptor()
    if (!configuration.writable) return rejected('PERMISSION_DENIED')
    if (request.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0) {
        return rejected('INVALID_REQUEST')
      }
      if (configuration.revision !== request.expectedRevision) return { status: 'conflict', code: 'REVISION_CONFLICT' }
    }
    // This is a redacted descriptor; validate its identities without ever retrieving previous keys.
    const current = record(configuration.configuration)
    const connections = current.connections as Array<Record<string, unknown>>
    const pending = Array.isArray(current.pendingConnections)
      ? current.pendingConnections as Array<Record<string, unknown>>
      : []
    const pendingExists = pending.some(item => {
      const value = item.account as ChannelCredentialRef
      return value.adapterId === account.adapterId && value.accountId === account.accountId
    })
    const exists = account.tenantId
      ? connections.some(item => sameRef(item.ref as ChannelCredentialRef, account))
      : pendingExists
    const duplicate = pendingExists || connections.some(item => {
      const value = item.ref as ChannelCredentialRef
      return value.adapterId === account.adapterId && value.accountId === account.accountId
    })
    if (request.purpose === 'rotate' ? !exists : duplicate) return rejected('TARGET_UNAVAILABLE')
    const id = randomBytes(32).toString('base64url')
    const capture = this.input.store.beginCapture({
      profileId: this.input.profileId,
      connectionId: `draft-${randomBytes(20).toString('hex')}`,
    })
    const journalReference = this.input.recordDraft === undefined
      ? undefined
      : this.input.store.referenceFor(capture.captureId)
    if (this.input.recordDraft !== undefined) {
      if (journalReference === undefined) {
        this.input.store.forget(capture.captureId)
        return { status: 'unavailable', code: 'CREDENTIAL_UNAVAILABLE' }
      }
      try {
        await this.input.recordDraft(journalReference)
      } catch {
        this.input.store.forget(capture.captureId)
        return { status: 'unavailable', code: 'DRAFT_JOURNAL_UNAVAILABLE' }
      }
    }
    const draft: Draft = {
      id,
      owner,
      documentId,
      purpose: request.purpose as 'create' | 'rotate',
      ref: account,
      captureId: capture.captureId,
      ...(journalReference === undefined ? {} : { journalReference }),
      revision: configuration.revision,
      expiresAt: this.now() + 10 * 60_000,
    }
    this.drafts.set(id, draft)
    const captured = await this.input.store.capture({ captureId: capture.captureId, secret })
    if (captured.state !== 'set' || !this.live(documentId)) {
      await this.remove(draft)
      return rejected('CREDENTIAL_UNAVAILABLE')
    }
    return {
      status: 'applied',
      code: 'CAPTURED',
      draftId: id,
      ref: account,
      expiresAt: new Date(draft.expiresAt).toISOString(),
    }
  }
  private async remove(draft: Draft): Promise<boolean> {
    if (draft.journalReference !== undefined && this.input.cleanupDraft !== undefined) {
      if (!await this.input.cleanupDraft(draft.journalReference)) return false
    } else {
      const result = await this.input.store.remove(draft.captureId)
      if (result.state !== 'unset') return false
    }
    this.drafts.delete(draft.id)
    this.input.store.forget(draft.captureId)
    if (draft.journalReference !== undefined) {
      await this.input.retireDraft?.(draft.journalReference).catch(() => undefined)
    }
    return true
  }
  private async expire() {
    for (const draft of this.drafts.values()) {
      if (
        draft.expiresAt <= this.now()
        || this.retiredDocuments.has(draft.documentId)
      ) await this.remove(draft)
    }
  }
  retireDocument(documentId: string): Promise<void> {
    this.retiredDocuments.add(documentId)
    return this.serial(async () => {
      for (const draft of this.drafts.values()) {
        if (draft.documentId === documentId && !await this.remove(draft)) {
          throw new Error('CREDENTIAL_CLEANUP_UNAVAILABLE')
        }
      }
    })
  }
  dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.timer)
    return this.serial(async () => {
      for (const draft of this.drafts.values()) {
        if (!await this.remove(draft)) throw new Error('CREDENTIAL_CLEANUP_UNAVAILABLE')
      }
    })
  }
}
