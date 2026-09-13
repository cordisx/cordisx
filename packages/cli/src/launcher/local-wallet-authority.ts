import type { LocalWorkSettlementCustody } from './local-work-settlement-custody.js'
import { localWorkSettlementReceipt } from '@cordisx/protocol/local-work-settlement/v1'
import { createHash, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { localWalletBinding, localWalletBytes, localWalletChallenge } from '@cordisx/protocol/local-wallet/v1'
import type { LocalWalletBindingV1 } from '@cordisx/protocol/local-wallet/v1'
import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import type { WorkUsageReader } from './work-usage.js'
import type { OwnerDocumentPrincipal } from './owner-document-rpc.js'
import type { LauncherKeychainBackend } from './secret-store.js'
import { MANAGED_SOURCE_KEYCHAIN_SERVICE, type ManagedSourceTrust } from './managed-source-authority.js'
import {
  type HttpNativeAccountValue,
  HttpNativeCallingContextUnavailableError,
} from './plugin-http-native-account-diagnostics.js'
import {
  LOCAL_WALLET_KEYCHAIN_SERVICE,
  localWalletPrivateKey,
  type LocalWalletProfile,
  localWalletRealm,
  LocalWalletRegistry,
} from './local-wallet-registry.js'
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid local wallet object')
  return value as Record<string, unknown>
}
function signature(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(value)) {
    throw new Error('invalid local wallet signature')
  }
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) throw new Error('invalid local wallet signature')
  return bytes
}
/** Independent local authority. Native reads occur exclusively during original-account enrollment. */
export class LocalWalletAuthority {
  private disposed = false
  private readonly operations = new Set<AbortController>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly leases = new Map<string, { id: string; observed: number; revision: string }>()
  constructor(
    private readonly options: {
      readonly custody?: LocalWorkSettlementCustody
      readonly registry: LocalWalletRegistry
      readonly keychain: LauncherKeychainBackend
      readonly fetch: typeof fetch
      readonly trusts: () => Promise<readonly ManagedSourceTrust[]>
      readonly trustsNow: () => readonly ManagedSourceTrust[]
      readonly live: (principal: OwnerDocumentPrincipal) => boolean
    },
  ) {}
  private trust(
    principal: OwnerDocumentPrincipal,
    binding: LocalWalletBindingV1,
    trusts: readonly ManagedSourceTrust[],
  ) {
    const audience = binding.audience === 'local-work-income' ? 'work-income' : 'source-account'
    const trust = trusts.find(entry =>
      entry.owner.pluginId === principal.identity.pluginId && entry.owner.source === principal.identity.source
      && entry.binding.origin === binding.origin && entry.binding.instanceId === binding.instanceId
      && entry.binding.sourceId === binding.sourceId && entry.binding.audience === audience
    )
    if (!trust) throw new Error('local wallet owner not provisioned')
    return trust
  }
  current(profile: LocalWalletProfile) {
    return !this.disposed && this.options.registry.current(profile)
  }
  closeOwner(principal: OwnerDocumentPrincipal) {
    const prefix = JSON.stringify(principal)
    for (const key of this.leases.keys()) if (key.startsWith(prefix + ':')) this.leases.delete(key)
  }
  async execute(
    principal: OwnerDocumentPrincipal,
    raw: unknown,
    deadline: number,
    active: () => boolean,
    enrollment?: {
      readonly originalAccountId: string
      readonly account: () => Promise<HttpNativeAccountValue>
      readonly bearer: () => Promise<string>
    },
    readWork?: WorkUsageReader,
    settlement = false,
  ) {
    const input = object(raw)
    if (
      Object.keys(input).some(key =>
        !(settlement
          ? ['origin', 'sourceId', 'instanceId', 'audience']
          : ['origin', 'sourceId', 'instanceId', 'audience', 'baseline']).includes(key)
      )
      || (input.baseline !== undefined && (input.baseline !== true || settlement))
    ) throw new Error('invalid local wallet input')
    const binding = localWalletBinding(input), work = binding.audience === 'local-work-income'
    if (
      !!enrollment !== (binding.audience === 'local-wallet-enrollment') || (!work && input.baseline !== undefined)
      || (settlement && !work)
    ) {
      throw new Error('invalid local wallet operation')
    }
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 15_000) {
      throw new Error('invalid local wallet deadline')
    }
    const queueKey = localWalletRealm(binding)
    if (this.queues.size >= 64 && !this.queues.has(queueKey)) throw new Error('local wallet queue limit')
    const abort = new AbortController()
    this.operations.add(abort)
    let reject!: (error: Error) => void
    const expired = new Promise<never>((_, fail) => {
      reject = fail
    })
    const timeout = setTimeout(() => abort.abort(), deadline - Date.now())
    const retire = () => reject(new Error('local wallet operation retired'))
    abort.signal.addEventListener('abort', retire, { once: true })
    const leaseKey = JSON.stringify(principal) + ':' + queueKey
    let operationLease: { id: string; observed: number; revision: string } | undefined
    const clearOperationLease = () => {
      if (operationLease && this.leases.get(leaseKey) === operationLease) this.leases.delete(leaseKey)
    }
    const prior = this.queues.get(queueKey) ?? Promise.resolve()
    const run = prior.catch(() => {}).then(async () => {
      const live = () => {
        if (
          abort.signal.aborted || this.disposed || !active() || !this.options.live(principal) || Date.now() >= deadline
        ) throw new Error('local wallet operation retired')
      }
      live()
      const trust = this.trust(principal, binding, await this.options.trusts())
      live()
      let profile: LocalWalletProfile, nativeAccount: string | undefined
      if (enrollment) {
        const account = await enrollment.account()
        live()
        if (account instanceof HttpNativeCallingContextUnavailableError) throw account
        if (!account) throw new Error('original account unavailable')
        nativeAccount = account
        const preparationGuard = () => {
          live()
          const currentTrust = this.trust(principal, binding, this.options.trustsNow())
          if (
            currentTrust.signingKeyRef !== trust.signingKeyRef || currentTrust.serverPublicKey !== trust.serverPublicKey
          ) throw new Error('local wallet server trust retired')
        }
        const preparationFence = async () => {
          preparationGuard()
          const current = await enrollment.account()
          preparationGuard()
          if (current instanceof HttpNativeCallingContextUnavailableError) throw current
          if (current !== nativeAccount) throw new Error('original account retired')
        }
        profile = await this.options.registry.prepare(
          binding,
          'codex:' + createHash('sha256').update(account).digest('base64url'),
          trust.serverPublicKey,
          preparationFence,
          preparationGuard,
        )
      } else profile = this.options.registry.active(binding)
      let custodyGuard: (() => void) | undefined
      let workProfileGuard: (() => void) | undefined
      const publicationGuard = () => {
        if (abort.signal.aborted || this.disposed || !this.options.live(principal) || Date.now() >= deadline) {
          throw new Error('local wallet publication retired')
        }
        custodyGuard?.()
        workProfileGuard?.()
        if (!this.current(profile)) throw new Error('local wallet delegation retired')
        const currentTrust = this.trust(principal, binding, this.options.trustsNow())
        if (
          currentTrust.signingKeyRef !== trust.signingKeyRef || currentTrust.serverPublicKey !== trust.serverPublicKey
        ) throw new Error('local wallet server trust retired')
        const entry = profile.entries.find(entry => entry.realm === localWalletRealm(binding))!
        if (!work && entry.serverPublicKey !== trust.serverPublicKey) throw new Error('local wallet realm key mismatch')
      }
      const synchronousFence = () => {
        live()
        publicationGuard()
      }
      const fence = async () => {
        synchronousFence()
        if (enrollment) {
          const current = await enrollment.account()
          synchronousFence()
          if (current instanceof HttpNativeCallingContextUnavailableError) throw current
          if (current !== nativeAccount) throw new Error('original account retired')
        }
      }
      const monitor = setInterval(() => {
        try {
          synchronousFence()
        } catch {
          abort.abort()
        }
      }, 100)
      const stop = () => clearInterval(monitor)
      abort.signal.addEventListener('abort', stop, { once: true })
      if (work && !settlement) operationLease = this.leases.get(leaseKey)
      try {
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
              ...(bearer === undefined ? {} : { authorization: 'Bearer ' + bearer }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          if (response.status < 200 || response.status >= 300) {
            await response.body?.cancel()
            throw new Error('local wallet server rejected')
          }
          const reader = response.body?.getReader(), chunks: Uint8Array[] = []
          let size = 0
          if (reader) {
            while (true) {
              const next = await reader.read()
              if (next.done) break
              size += next.value.byteLength
              if (size > 1_048_576) {
                await reader.cancel()
                throw new Error('local wallet response too large')
              }
              chunks.push(next.value)
            }
          }
          await fence()
          synchronousFence()
          return { body: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))), statusCode: response.status }
        }
        const challengeResponse = await request(
          '/v1/auth/host/challenge?'
            + new URLSearchParams({
              sourceId: binding.sourceId,
              instanceId: binding.instanceId,
              audience: binding.audience,
            }).toString(),
        )
        const envelope = challengeResponse.body
        if (Object.keys(envelope).some(key => !['payload', 'signature'].includes(key))) {
          throw new Error('invalid local challenge envelope')
        }
        const challenge = localWalletChallenge(envelope.payload, binding)
        if (!verify(null, localWalletBytes(challenge), trust.serverPublicKey, signature(envelope.signature))) {
          throw new Error('invalid local challenge signature')
        }
        let workSnapshot: Extract<WorkUsageSnapshotV2, { status: 'ready' }> | undefined
        let payload: Record<string, unknown> = {
          ...challenge,
          contract: 'cordisx.local-wallet-assertion/v1',
          subject: profile.subject,
        }
        if (enrollment) {
          payload = {
            ...payload,
            contract: 'cordisx.local-wallet-enrollment/v1',
            nativeSubject: 'codex:' + createHash('sha256').update(nativeAccount!).digest('base64url'),
            publicKey: profile.publicKey,
          }
        } else if (work) {
          if (!readWork) throw new Error('classified work unavailable')
          const snapshot = await readWork()
          await fence()
          if (snapshot.status !== 'ready') throw new Error('classified work unavailable')
          workSnapshot = snapshot
          workProfileGuard = () => {
            if (readWork.current?.(snapshot) === false) throw new Error('work profile continuity retired')
          }
          synchronousFence()
          const custody = this.options.custody
          if (settlement) {
            if (!custody) throw new Error('settlement custody unavailable')
            const accountId = profile.entries.find(entry => entry.realm === localWalletRealm(binding))!.accountId!
            await custody.claim(snapshot.scopeId, binding, accountId, profile.subject, synchronousFence)
            custodyGuard = () => custody.assert(snapshot.scopeId, binding, accountId, profile.subject)
            synchronousFence()
            payload = { ...payload, contract: 'cordisx.local-work-settlement/v1', snapshot }
          } else {
            await custody?.claimLegacy(snapshot.scopeId, synchronousFence)
            custodyGuard = () => {
              if (custody && !custody.legacyAllowed(snapshot.scopeId)) {
                throw new Error('durable settlement policy conflict')
              }
            }
            synchronousFence()
            const priorLease = this.leases.get(leaseKey), now = Date.now()
            const baseline = input.baseline === true || !priorLease || priorLease.revision !== profile.revision
              || now - priorLease.observed > 15_000
            if (this.leases.size >= 128 && !priorLease) throw new Error('local work lease limit')
            const lease = baseline
              ? { id: randomBytes(32).toString('base64url'), observed: now, revision: profile.revision }
              : { ...priorLease, observed: now }
            payload = {
              ...payload,
              contract: 'cordisx.local-work-observation/v1',
              snapshot,
              leaseId: lease.id,
              continuity: baseline ? 'baseline' : 'continuous',
            }
            lease.observed = now
            this.leases.set(leaseKey, lease)
            operationLease = lease
          }
        }
        const privateKey = await this.options.keychain.read(
          enrollment ? MANAGED_SOURCE_KEYCHAIN_SERVICE : LOCAL_WALLET_KEYCHAIN_SERVICE,
          enrollment ? trust.signingKeyRef : profile.keyRef,
        )
        await fence()
        const key = localWalletPrivateKey(privateKey)
        if (
          !enrollment
          && createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') !== profile.publicKey
        ) throw new Error('local wallet key mismatch')
        localWalletChallenge(challenge, binding)
        const signed = { payload, signature: sign(null, localWalletBytes(payload), key).toString('base64url') }
        let bearer: string | undefined
        if (enrollment) {
          bearer = await enrollment.bearer()
          await fence()
          profile = await this.options.registry.transition(
            profile,
            localWalletRealm(binding),
            'submitted',
            undefined,
            undefined,
            fence,
            synchronousFence,
          )
          await fence()
        }
        const response = await request(
          enrollment
            ? '/v1/auth/host/local-wallet/enroll'
            : settlement
            ? '/v1/income/work/settle'
            : work
            ? '/v1/income/work'
            : '/v1/auth/host/session',
          signed,
          bearer,
        )
        const result = object(response.body.payload)
        if (
          Object.keys(response.body).some(key => !['payload', 'signature'].includes(key))
          || Object.keys(result).some(key =>
            !['contract', 'origin', 'sourceId', 'instanceId', 'audience', 'nonce', 'subject', 'nativeSubject', 'result']
              .includes(key)
          ) || result.contract !== 'cordisx.local-wallet-result/v1' || result.nonce !== challenge.nonce
          || result.subject !== profile.subject
          || (enrollment ? result.nativeSubject !== payload.nativeSubject : result.nativeSubject !== undefined)
          || Object.keys(binding).some(key => result[key] !== binding[key as keyof LocalWalletBindingV1])
          || !verify(null, localWalletBytes(result), trust.serverPublicKey, signature(response.body.signature))
        ) throw new Error('invalid local wallet result signature')
        await fence()
        if (
          enrollment
          && (object(result.result).enrolled !== true || object(result.result).instanceId !== binding.instanceId
            || object(object(result.result).account).id !== enrollment.originalAccountId)
        ) throw new Error('local wallet enrollment account mismatch')
        if (enrollment) {
          profile = await this.options.registry.transition(
            profile,
            localWalletRealm(binding),
            'active',
            JSON.stringify(response.body),
            enrollment.originalAccountId,
            fence,
            synchronousFence,
          )
        }
        if (
          !enrollment && !work
          && (object(result.result).instanceId !== binding.instanceId
            || object(object(result.result).account).id
              !== profile.entries.find(entry => entry.realm === localWalletRealm(binding))!.accountId)
        ) throw new Error('local wallet account mismatch')
        if (work) {
          const wallet = object(object(result.result).wallet)
          if (
            wallet.origin !== binding.origin || wallet.instanceId !== binding.instanceId
            || wallet.accountId !== profile.entries.find(entry => entry.realm === localWalletRealm(binding))!.accountId
          ) throw new Error('local work wallet mismatch')
          if (settlement) {
            localWorkSettlementReceipt(object(result.result).receipt, workSnapshot!, binding, String(wallet.accountId))
          }
        }
        synchronousFence()
        return { body: object(result.result), statusCode: response.statusCode, profile, publicationGuard }
      } catch (error) {
        if (work) clearOperationLease()
        throw error
      } finally {
        stop()
        abort.signal.removeEventListener('abort', stop)
      }
    })
    this.queues.set(queueKey, run)
    void run.finally(() => {
      if (this.queues.get(queueKey) === run) this.queues.delete(queueKey)
    }).catch(() => {})
    try {
      return await Promise.race([run, expired])
    } finally {
      clearTimeout(timeout)
      abort.signal.removeEventListener('abort', retire)
      this.operations.delete(abort)
      if (work && abort.signal.aborted) clearOperationLease()
    }
  }
  dispose() {
    this.disposed = true
    for (const abort of this.operations) abort.abort()
    this.leases.clear()
  }
}
