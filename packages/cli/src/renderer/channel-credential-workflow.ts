import type {
  ChannelManagerRequestV2,
  ChannelManagerResultV2,
  ChannelManagerTargetRequestV1,
  ChannelManagerTargetResultV1,
} from '@cordisx/protocol/channel-manager/v2'
import type { ChannelCredentialDraftResult, ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'

export type ChannelCredentialAuthorizer = (account: ChannelCredentialRef) => Promise<boolean>

/** Host-only combined-form intent; never part of a plugin operation document. */
export interface ChannelCredentialConfigurationWrite {
  readonly expectedServiceRevision: number
  readonly patch: { readonly displayName: string; readonly selectors: readonly string[] }
}

interface Draft {
  readonly kind: 'capture' | 'credential' | 'connection'
  readonly owner: string
  readonly purpose: 'create' | 'rotate'
  readonly adapterKind: 'feishu' | 'lark'
  readonly revision: number
  readonly serviceRevision?: number
  readonly expiresAt: number
  readonly connectionToken?: string
  readonly account?: ChannelCredentialRef
  readonly privateDraft?: string
}
export interface ChannelCredentialWorkflowInput {
  readonly revision: () => number
  /** Capture the owner configuration revision when opening a creation flow. */
  readonly serviceRevision?: () => number
  readonly advance: () => void
  readonly target: (token: string) => ChannelCredentialRef | undefined
  readonly connectionToken: (ref: ChannelCredentialRef) => string
  readonly rekeyConnection?: (pending: ChannelCredentialRef, resolved: ChannelCredentialRef) => void
  readonly available: () => boolean
  readonly prompt: (
    input: {
      adapterKind: 'feishu' | 'lark'
      owner: string
      account?: ChannelCredentialRef
      signal: AbortSignal
      submit(
        account: ChannelCredentialRef,
        secret: string,
        signal: AbortSignal,
        reportFailure?: (code: string) => void,
      ): Promise<boolean>
    },
  ) => Promise<boolean>
  readonly request: (input: Record<string, unknown>) => Promise<ChannelCredentialDraftResult & { projection?: unknown }>
  readonly adopt: (projection: unknown) => void
  readonly now?: () => number
}
const opaque = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `chm1_${btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`
}

/** Expiring one-shot public intents, separate from the launcher's private material/draft authority. */
export class ChannelCredentialWorkflow {
  private readonly drafts = new Map<string, Draft>()
  private readonly lifetime = new AbortController()
  private readonly pendingDiscards = new Set<Promise<void>>()
  private cleanupFailed = false
  private busy = false
  constructor(private readonly input: ChannelCredentialWorkflowInput) {}
  private now() {
    return this.input.now?.() ?? Date.now()
  }
  private fail(code: string, status: 'rejected' | 'unavailable' | 'conflict' = 'rejected') {
    return { status, code } as const
  }
  private live(draft: Draft | undefined, owner: string, kind: Draft['kind']): draft is Draft {
    return draft?.kind === kind && draft.owner === owner && draft.revision === this.input.revision()
      && draft.expiresAt > this.now() && !this.lifetime.signal.aborted
  }
  private discard(owner: string, draftId: string): Promise<void> {
    let pending: Promise<void>
    pending = Promise.resolve().then(async () => {
      const result = await this.input.request({ operation: 'discard', owner, draftId })
      if (result.status !== 'applied' || result.code !== 'DISCARDED') this.cleanupFailed = true
    }).catch(() => {
      this.cleanupFailed = true
    }).finally(() => {
      this.pendingDiscards.delete(pending)
    })
    this.pendingDiscards.add(pending)
    return pending
  }
  private async prune(): Promise<boolean> {
    for (const [token, draft] of this.drafts) {
      if (draft.expiresAt > this.now() && draft.revision === this.input.revision()) continue
      this.drafts.delete(token)
      if (draft.privateDraft) void this.discard(draft.owner, draft.privateDraft)
    }
    while (this.pendingDiscards.size) await Promise.all(this.pendingDiscards)
    return !this.cleanupFailed
  }
  /** Resolve a saved pending account without exposing its stored credential to the renderer. */
  async resolveTenant(input: {
    owner: string
    account: ChannelCredentialRef
    tenantId: string
    expectedServiceRevision: number
    signal: AbortSignal
    authorize: ChannelCredentialAuthorizer
    live: () => boolean
  }): Promise<{ status: 'applied' | 'conflict' | 'rejected' | 'unavailable'; code: string }> {
    if (!await this.prune()) return this.fail('CREDENTIAL_CLEANUP_UNAVAILABLE', 'unavailable')
    if (this.busy || input.signal.aborted || !input.live() || this.lifetime.signal.aborted) {
      return this.fail('STALE_GENERATION', 'unavailable')
    }
    this.busy = true
    try {
      if (!await input.authorize(input.account)) return this.fail('PERMISSION_DENIED')
      if (input.signal.aborted || !input.live()) return this.fail('STALE_GENERATION', 'unavailable')
      const result = await this.input.request({
        operation: 'resolve-tenant',
        owner: input.owner,
        account: input.account,
        tenantId: input.tenantId,
        expectedRevision: input.expectedServiceRevision,
      })
      if (result.status === 'applied' && !input.signal.aborted && input.live()) {
        if (result.projection && result.ref) this.input.rekeyConnection?.(input.account, result.ref)
        if (result.projection) this.input.adopt(result.projection)
        this.input.advance()
      }
      return { status: result.status, code: result.code }
    } finally {
      this.busy = false
    }
  }
  async issue(request: ChannelManagerTargetRequestV1, owner: string): Promise<Partial<ChannelManagerTargetResultV1>> {
    if (!await this.prune()) return this.fail('CREDENTIAL_CLEANUP_UNAVAILABLE', 'unavailable')
    if (!this.input.available() || this.lifetime.signal.aborted) {
      return this.fail('OPERATION_UNAVAILABLE', 'unavailable')
    }
    if (this.busy || this.drafts.size >= 16) return this.fail('DRAFT_LIMIT')
    let value: Draft
    if (request.operation === 'target.credential.capture.create') {
      if (!['feishu', 'lark'].includes(request.adapterKind)) return this.fail('ADAPTER_UNAVAILABLE', 'unavailable')
      const serviceRevision = this.input.serviceRevision?.()
      if (serviceRevision !== undefined && (!Number.isSafeInteger(serviceRevision) || serviceRevision < 0)) {
        return this.fail('STALE_GENERATION', 'unavailable')
      }
      value = {
        kind: 'capture',
        owner,
        purpose: 'create',
        adapterKind: request.adapterKind as 'feishu' | 'lark',
        revision: request.expectedRevision,
        ...(serviceRevision === undefined ? {} : { serviceRevision }),
        expiresAt: this.now() + 10 * 60_000,
      }
    } else if (request.operation === 'target.credential.capture.rotate') {
      const account = this.input.target(request.target.connectionToken)
      if (!account || !['feishu', 'lark'].includes(account.adapterId)) return this.fail('TARGET_UNAVAILABLE')
      value = {
        kind: 'capture',
        owner,
        purpose: 'rotate',
        adapterKind: account.adapterId as 'feishu' | 'lark',
        revision: request.expectedRevision,
        expiresAt: this.now() + 10 * 60_000,
        connectionToken: request.target.connectionToken,
        account,
      }
    } else if (request.operation === 'target.connection.create') {
      const current = this.drafts.get(request.target.credentialDraftToken)
      if (!this.live(current, owner, 'credential') || current.purpose !== 'create') {
        return this.fail('TARGET_UNAVAILABLE')
      }
      value = { ...current, kind: 'connection' }
      this.drafts.delete(request.target.credentialDraftToken)
    } else return this.fail('OPERATION_UNAVAILABLE', 'unavailable')
    const token = opaque()
    this.drafts.set(token, value)
    const applied = {
      status: 'applied',
      code: 'APPLIED',
      expiresAt: new Date(value.expiresAt).toISOString(),
    } as const
    if (value.kind === 'capture') {
      return { ...applied, target: { kind: 'credential-capture', captureToken: token } }
    }
    return { ...applied, target: { kind: 'connection-draft', connectionDraftToken: token } }
  }
  async execute(
    request: ChannelManagerRequestV2,
    owner: string,
    active: () => boolean,
    authorize: ChannelCredentialAuthorizer,
    ownerSignal: AbortSignal = this.lifetime.signal,
    prompt: ChannelCredentialWorkflowInput['prompt'] = this.input.prompt,
    configuration?: ChannelCredentialConfigurationWrite,
  ): Promise<Partial<ChannelManagerResultV2>> {
    if (!await this.prune()) return this.fail('CREDENTIAL_CLEANUP_UNAVAILABLE', 'unavailable')
    if (!this.input.available() || !active() || ownerSignal.aborted || this.lifetime.signal.aborted) {
      return this.fail('STALE_GENERATION', 'unavailable')
    }
    if (this.busy) return this.fail('OPERATION_IN_PROGRESS', 'conflict')
    if (request.operation === 'credential.capture') {
      const draft = this.drafts.get(request.target.captureToken)
      if (!this.live(draft, owner, 'capture')) return this.fail('TARGET_UNAVAILABLE')
      this.busy = true
      let captured: (ChannelCredentialDraftResult & { projection?: unknown }) | undefined
      const signal = AbortSignal.any([ownerSignal, this.lifetime.signal])
      try {
        const accepted = await prompt({
          adapterKind: draft.adapterKind,
          owner,
          ...(draft.account === undefined ? {} : { account: draft.account }),
          signal,
          submit: async (account, secret, signal, reportFailure) => {
            if (signal.aborted || !active() || !this.live(draft, owner, 'capture')) return false
            // The App ID is not known at entry. Authorize this Host-private account before storing any secret.
            if (!await authorize(account)) return false
            if (signal.aborted || !active() || !this.live(draft, owner, 'capture')) return false
            const result = await this.input.request({
              operation: 'capture',
              owner,
              purpose: draft.purpose,
              account,
              secret,
              ...(configuration !== undefined
                ? { expectedRevision: configuration.expectedServiceRevision }
                : draft.serviceRevision === undefined
                ? {}
                : { expectedRevision: draft.serviceRevision }),
            })
            if (result.status !== 'applied' || !result.draftId || !result.ref) {
              reportFailure?.(result.code)
              return false
            }
            if (signal.aborted || !active() || !this.live(draft, owner, 'capture')) {
              await this.discard(owner, result.draftId)
              return false
            }
            captured = result
            return true
          },
        })
        if (
          !accepted || !captured?.draftId || !captured.ref || signal.aborted || !active()
          || !this.live(draft, owner, 'capture')
        ) {
          if (captured?.draftId) {
            await this.discard(owner, captured.draftId)
          }
          this.drafts.delete(request.target.captureToken)
          return this.fail(
            this.cleanupFailed ? 'CREDENTIAL_CLEANUP_UNAVAILABLE' : accepted ? 'STALE_GENERATION' : 'CAPTURE_CANCELLED',
            this.cleanupFailed ? 'unavailable' : 'rejected',
          )
        }
        this.drafts.delete(request.target.captureToken)
        this.input.advance()
        const token = opaque()
        const expiresAt = Math.min(draft.expiresAt, Date.parse(captured.expiresAt!))
        this.drafts.set(token, {
          ...draft,
          kind: 'credential',
          revision: this.input.revision(),
          expiresAt,
          account: captured.ref,
          privateDraft: captured.draftId,
        })
        return {
          status: 'applied',
          code: 'APPLIED',
          credentialDraftToken: token,
          expiresAt: new Date(expiresAt).toISOString(),
        }
      } finally {
        this.busy = false
      }
    }
    if (request.operation !== 'connection.create' && request.operation !== 'connection.rotate-credential') {
      return this.fail('OPERATION_UNAVAILABLE', 'unavailable')
    }
    const token = request.operation === 'connection.create'
      ? request.target.connectionDraftToken
      : request.draft.credentialDraftToken
    const draft = this.drafts.get(token)
    if (
      !this.live(draft, owner, request.operation === 'connection.create' ? 'connection' : 'credential')
      || draft.purpose !== (request.operation === 'connection.create' ? 'create' : 'rotate')
      || request.operation === 'connection.rotate-credential'
        && draft.connectionToken !== request.target.connectionToken
      || !draft.privateDraft || !draft.account
    ) return this.fail('TARGET_UNAVAILABLE')
    this.busy = true
    try {
      if (!await authorize(draft.account)) return this.fail('PERMISSION_DENIED')
      if (
        !active() || ownerSignal.aborted
        || !this.live(draft, owner, request.operation === 'connection.create' ? 'connection' : 'credential')
      ) {
        return this.fail('STALE_GENERATION', 'unavailable')
      }
      const result = await this.input.request({
        operation: 'commit',
        owner,
        draftId: draft.privateDraft,
        ...(request.operation === 'connection.create'
          ? { draft: request.draft }
          : configuration === undefined
          ? {}
          : { draft: configuration.patch }),
      })
      if (result.status !== 'applied') return this.fail(result.code, result.status)
      this.drafts.delete(token)
      if (active() && !this.lifetime.signal.aborted) {
        if (result.projection) this.input.adopt(result.projection)
        this.input.advance()
      }
      return {
        status: 'applied',
        code: 'APPLIED',
        ...(request.operation === 'connection.create'
          ? { connectionToken: this.input.connectionToken(draft.account) }
          : {}),
      }
    } finally {
      this.busy = false
    }
  }
  retireOwner(owner: string): void {
    for (const [token, draft] of this.drafts) {
      if (draft.owner === owner) {
        this.drafts.delete(token)
        if (draft.privateDraft) {
          void this.discard(owner, draft.privateDraft)
        }
      }
    }
  }
  dispose() {
    this.lifetime.abort()
    for (const draft of this.drafts.values()) {
      if (draft.privateDraft) {
        void this.discard(draft.owner, draft.privateDraft)
      }
    }
    this.drafts.clear()
  }
}
