import {
  type HttpNativeAccountValue,
  HttpNativeCallingContextUnavailableError,
} from './plugin-http-native-account-diagnostics.js'
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { managedSourceBinding, managedSourceBytes, managedSourceChallenge } from '@cordisx/protocol/managed-source/v1'
import type { ManagedSourceBindingV1 } from '@cordisx/protocol/managed-source/v1'
import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import type { OwnerDocumentPrincipal } from './owner-document-rpc.js'
import type { LauncherKeychainBackend } from './secret-store.js'

export interface ManagedSourceTrust {
  readonly binding: ManagedSourceBindingV1
  readonly owner: { readonly pluginId: string; readonly source: string }
  readonly serverPublicKey: string
  readonly signingKeyRef: string
}
export const MANAGED_SOURCE_KEYCHAIN_SERVICE = 'cordisx/managed-source/v1'
export class ManagedSourceCredentialUnavailableError extends Error {}
export class ManagedSourceTrustUnavailableError extends Error {}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid managed source response')
  return value as Record<string, unknown>
}
function signature(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(value)) throw new Error('invalid signature')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) throw new Error('noncanonical signature')
  return bytes
}
/** Host-private canonical PKCS8 DER, encoded on one line for the normal Secret Store. */
function signingKey(value: string) {
  if (!/^[A-Za-z0-9+/]{64}$/u.test(value)) throw new Error('invalid managed signing key')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== 48 || bytes.toString('base64') !== value) throw new Error('noncanonical managed signing key')
  const key = createPrivateKey({ key: bytes, type: 'pkcs8', format: 'der' })
  if (
    key.asymmetricKeyType !== 'ed25519'
    || !key.export({ type: 'pkcs8', format: 'der' }).equals(bytes)
  ) throw new Error('invalid managed signing key type or encoding')
  return key
}
/** Trust entries come exclusively from Launcher provisioning, never renderer configuration or RPC. */
export class ManagedSourceAuthority {
  private disposed = false
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly operations = new Set<AbortController>()
  private readonly operationEpochs = new WeakMap<AbortController, number>()
  private readonly leases = new Map<string, { id: string; observed: number; account: string; owner: string }>()
  private readonly accounts = new Map<string, string | null>()
  private readonly accountEpochs = new Map<string, number>()
  constructor(
    private readonly options: {
      readonly trusts: readonly ManagedSourceTrust[]
      readonly getTrusts?: () => Promise<readonly ManagedSourceTrust[]>
      readonly keychain: LauncherKeychainBackend
      readonly fetch: typeof fetch
      readonly live: (principal: OwnerDocumentPrincipal) => boolean
      readonly readWork?: (principal: OwnerDocumentPrincipal) => Promise<WorkUsageSnapshotV2>
      readonly trusted?: (trust: ManagedSourceTrust) => Promise<boolean>
      readonly trustedNow?: (trust: ManagedSourceTrust) => boolean
    },
  ) {}
  private lifetime<T>(
    principal: OwnerDocumentPrincipal,
    work: boolean,
    run: (abort: AbortController, expired: Promise<never>) => Promise<T>,
  ) {
    const abort = new AbortController()
    this.operationEpochs.set(abort, this.accountEpochs.get(JSON.stringify(principal)) ?? 0)
    let reject!: (error: Error) => void
    const expired = new Promise<never>((_, fail) => {
      reject = fail
    })
    const retire = () => {
      const reason: unknown = abort.signal.reason
      if (work) this.closeCurrentOperation(principal, abort, reason)
      reject(reason instanceof HttpNativeCallingContextUnavailableError ? reason : new Error('managed source retired'))
    }
    abort.signal.addEventListener('abort', retire, { once: true })
    const timeout = setTimeout(() => abort.abort(), 15_000)
    this.operations.add(abort)
    const operation = Promise.resolve().then(() => run(abort, expired))
    return Promise.race([operation, expired]).finally(() => {
      clearTimeout(timeout)
      abort.signal.removeEventListener('abort', retire)
      this.operations.delete(abort)
    })
  }
  private async execute(
    principal: OwnerDocumentPrincipal,
    abort: AbortController,
    raw: unknown,
    readAccount: () => Promise<HttpNativeAccountValue>,
    work: boolean,
    previousBearer?: string,
    active: () => boolean = () => true,
  ) {
    const input = object(raw)
    if (abort.signal.aborted || this.disposed || !active() || !this.options.live(principal)) {
      throw new Error('managed source retired')
    }
    if (
      Object.keys(input).some(key =>
        !['origin', 'sourceId', 'instanceId', 'audience', work ? 'baseline' : 'displayName'].includes(key)
      )
    ) {
      throw new Error('invalid managed source input')
    }
    if (work && input.baseline !== undefined && input.baseline !== true) throw new Error('invalid baseline')
    const binding = managedSourceBinding(input)
    if (binding.audience !== (work ? 'work-income' : 'source-account')) {
      throw new Error('invalid managed source audience')
    }
    const trusts = this.options.getTrusts ? await this.options.getTrusts() : this.options.trusts
    if (abort.signal.aborted || this.disposed || !active() || !this.options.live(principal)) {
      throw new Error('managed source retired')
    }
    const trust = trusts.find(entry =>
      entry.owner.pluginId === principal.identity.pluginId && entry.owner.source === principal.identity.source
      && Object.keys(binding).every(key =>
        binding[key as keyof ManagedSourceBindingV1] === entry.binding[key as keyof ManagedSourceBindingV1]
      )
    )
    if (!trust) throw new ManagedSourceTrustUnavailableError('managed source not provisioned for owner')
    const account = await readAccount()
    if (abort.signal.aborted || this.disposed || !active() || !this.options.live(principal)) {
      throw new Error('managed source retired')
    }
    if (account instanceof HttpNativeCallingContextUnavailableError) throw account
    if (!account) throw new ManagedSourceCredentialUnavailableError('native account unavailable')
    this.observeAccount(principal, account)
    const ownerKey = JSON.stringify(principal), accountEpoch = this.accountEpochs.get(ownerKey) ?? 0
    this.operationEpochs.set(abort, accountEpoch)
    const synchronousFence = () => {
      if (
        abort.signal.aborted || this.disposed || !active() || !this.options.live(principal)
        || (this.accountEpochs.get(ownerKey) ?? 0) !== accountEpoch
      ) throw new Error('managed source retired')
      if (this.options.trustedNow && !this.options.trustedNow(trust)) throw new Error('managed source trust retired')
    }
    const fence = async () => {
      synchronousFence()
      if (this.options.trusted) {
        const trusted = await this.options.trusted(trust)
        synchronousFence()
        if (!trusted) throw new Error('managed source trust retired')
      }
      // Native identity is the final asynchronous authority read before a send or acceptance.
      const currentAccount = await readAccount()
      synchronousFence()
      if (currentAccount instanceof HttpNativeCallingContextUnavailableError) throw currentAccount
      this.observeAccount(principal, currentAccount)
      synchronousFence()
      if (currentAccount !== account) throw new Error('native account retired')
    }
    const request = async (path: string, body?: unknown, bearer?: string) => {
      await fence()
      synchronousFence()
      const response = await this.options.fetch(binding.origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        credentials: 'omit',
        signal: abort.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel()
        throw new Error('managed source request rejected')
      }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 1_048_576) {
            await reader.cancel()
            throw new Error('managed source response too large')
          }
          chunks.push(chunk.value)
        }
      }
      await fence()
      return { body: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))), statusCode: response.status }
    }
    let checking = false
    const retirement = setInterval(() => {
      if (checking) return
      checking = true
      void fence().catch(error => {
        abort.abort(error instanceof HttpNativeCallingContextUnavailableError ? error : undefined)
      }).finally(() => {
        checking = false
      })
    }, 1000)
    const stopRetirement = () => clearInterval(retirement)
    abort.signal.addEventListener('abort', stopRetirement, { once: true })
    let leaseKey: string | undefined,
      installedLease: { id: string; observed: number; account: string; owner: string } | undefined
    try {
      await fence()
      const query = new URLSearchParams({
        sourceId: binding.sourceId,
        instanceId: binding.instanceId,
        audience: binding.audience,
      })
      const challengeResponse = await request('/v1/auth/host/challenge?' + query.toString())
      const envelope = challengeResponse.body
      if (Object.keys(envelope).some(key => !['payload', 'signature'].includes(key))) {
        throw new Error('invalid challenge envelope')
      }
      const challenge = managedSourceChallenge(envelope.payload, binding)
      if (
        !verify(
          null,
          managedSourceBytes(challenge),
          createPublicKey(trust.serverPublicKey),
          signature(envelope.signature),
        )
      ) {
        throw new Error('managed source challenge signature invalid')
      }
      let payload: Record<string, unknown> = {
        ...binding,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        subject: 'codex:' + createHash('sha256').update(account).digest('base64url'),
        contract: 'cordisx.managed-source-assertion/v1',
      }
      if (work) {
        leaseKey = JSON.stringify([principal, binding])
        if (!this.options.readWork) throw new Error('classified work usage unavailable')
        const snapshot = await this.options.readWork(principal)
        await fence()
        if (snapshot.status !== 'ready') throw new Error('classified work usage unavailable')
        const prior = this.leases.get(leaseKey), now = Date.now()
        const baseline = input.baseline === true || !prior || prior.account !== account || now - prior.observed > 15_000
        const lease = baseline
          ? { id: randomBytes(32).toString('base64url'), observed: now, account, owner: JSON.stringify(principal) }
          : prior
        if (this.leases.size >= 128 && !this.leases.has(leaseKey)) throw new Error('managed work lease limit')
        payload = {
          ...payload,
          contract: 'cordisx.managed-work-observation/v1',
          leaseId: lease.id,
          continuity: baseline ? 'baseline' : 'continuous',
          snapshot,
        }
        // Commit observation continuity before send: uncertain sends must never create catch-up income.
        lease.observed = now
        this.leases.set(leaseKey, lease)
        installedLease = lease
      } else if (input.displayName !== undefined) {
        if (
          typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 120
          || /[\u0000-\u001f\u007f]/u.test(input.displayName)
        ) throw new Error('invalid display name')
        payload.displayName = input.displayName.trim()
      }
      const privateKey = await this.options.keychain.read(MANAGED_SOURCE_KEYCHAIN_SERVICE, trust.signingKeyRef)
      await fence()
      managedSourceChallenge(challenge, binding)
      const signed = {
        payload,
        signature: sign(null, managedSourceBytes(payload), signingKey(privateKey)).toString('base64url'),
      }
      synchronousFence()
      const response = await request(work ? '/v1/income/work' : '/v1/auth/host/session', signed, previousBearer)
      const resultEnvelope = response.body, resultPayload = object(resultEnvelope.payload)
      if (
        Object.keys(resultEnvelope).some(key => !['payload', 'signature'].includes(key))
        || Object.keys(resultPayload).some(key =>
          !['contract', 'origin', 'sourceId', 'instanceId', 'audience', 'nonce', 'subject', 'result'].includes(key)
        )
        || resultPayload.contract !== 'cordisx.managed-source-result/v1' || resultPayload.nonce !== challenge.nonce
        || resultPayload.subject !== payload.subject
        || Object.keys(binding).some(key => resultPayload[key] !== binding[key as keyof ManagedSourceBindingV1])
        || !verify(null, managedSourceBytes(resultPayload), trust.serverPublicKey, signature(resultEnvelope.signature))
      ) {
        throw new Error('managed source result signature invalid')
      }
      synchronousFence()
      return { body: object(resultPayload.result), statusCode: response.statusCode, account, accountEpoch }
    } catch (error) {
      if (leaseKey && installedLease && this.leases.get(leaseKey) === installedLease) this.leases.delete(leaseKey)
      throw error
    } finally {
      clearInterval(retirement)
      abort.signal.removeEventListener('abort', stopRetirement)
    }
  }
  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.queues.size >= 128 && !this.queues.has(key)) throw new Error('managed source request limit')
    const prior = this.queues.get(key) ?? Promise.resolve()
    const current = prior.catch(() => {}).then(run)
    this.queues.set(key, current)
    try {
      return await current
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key)
    }
  }
  connect(
    principal: OwnerDocumentPrincipal,
    input: unknown,
    account: () => Promise<HttpNativeAccountValue>,
    previousBearer?: string,
    active?: () => boolean,
  ) {
    return this.lifetime(principal, false, (abort, expired) =>
      this.serial(
        JSON.stringify([principal, input]),
        () => Promise.race([this.execute(principal, abort, input, account, false, previousBearer, active), expired]),
      ))
  }
  submit(
    principal: OwnerDocumentPrincipal,
    input: unknown,
    account: () => Promise<HttpNativeAccountValue>,
    active?: () => boolean,
  ) {
    let binding: ManagedSourceBindingV1
    try {
      binding = managedSourceBinding(input)
    } catch (error) {
      this.closeOwner(principal)
      throw error
    }
    return this.lifetime(
      principal,
      true,
      (abort, expired) =>
        this.serial(JSON.stringify([principal, binding]), async () => {
          try {
            return await Promise.race([
              this.execute(principal, abort, input, account, true, undefined, active),
              expired,
            ])
          } catch (error) {
            this.closeCurrentOperation(principal, abort, error)
            throw error
          }
        }),
    )
  }
  private closeCurrentOperation(principal: OwnerDocumentPrincipal, abort: AbortController, error?: unknown) {
    if (error instanceof HttpNativeCallingContextUnavailableError) return
    if ((this.accountEpochs.get(JSON.stringify(principal)) ?? 0) === this.operationEpochs.get(abort)) {
      this.closeOwner(principal)
    }
  }
  epoch(principal: OwnerDocumentPrincipal) {
    return this.accountEpochs.get(JSON.stringify(principal)) ?? 0
  }
  observeAccount(principal: OwnerDocumentPrincipal, account: string | null) {
    const owner = JSON.stringify(principal)
    if (!this.accounts.has(owner) || this.accounts.get(owner) !== account) this.closeOwner(principal)
    this.accounts.set(owner, account)
  }
  closeOwner(principal: OwnerDocumentPrincipal) {
    const owner = JSON.stringify(principal)
    for (const [key, lease] of this.leases) if (lease.owner === owner) this.leases.delete(key)
    this.accounts.delete(owner)
    this.accountEpochs.set(owner, (this.accountEpochs.get(owner) ?? 0) + 1)
  }
  dispose() {
    this.disposed = true
    for (const operation of this.operations) operation.abort()
    this.leases.clear()
    this.accounts.clear()
    this.accountEpochs.clear()
  }
}
