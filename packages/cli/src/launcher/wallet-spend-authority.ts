import type { WalletSpendFailureV1, WalletSpendResultV1, WalletSpendSourceV1 } from '@cordisx/protocol/wallet-spend/v1'
import { createMacOSKeychainBackend } from './secret-store.js'
import { localWalletRealm, LocalWalletRegistry } from './local-wallet-registry.js'
import { loadWalletSpendConfig, persistWalletSpendSource } from './wallet-spend-config.js'
import { WalletSpendIpcClient } from './wallet-spend-ipc-client.js'
import { confirmWalletSpendNative } from './wallet-spend-native-consent.js'
import { fetchWalletSpendSource, verifyWalletSpendSource } from './wallet-spend-source-proof.js'
import { spendCanonical } from './wallet-spend-ipc-wire.js'
import type { OwnerDocumentPrincipal } from './owner-document-rpc.js'
import {
  sameSpendSource,
  spendChallenge,
  spendId,
  spendIdentity,
  spendObject,
  spendPurchaseReceipt,
  spendRecord,
  spendSigned,
  spendSource,
  spendTerms,
} from './wallet-spend-validation.js'

const failure = (code: WalletSpendFailureV1): WalletSpendResultV1<never> => ({ status: 'unavailable', code })
export function isWalletSpendRequest(raw: unknown): boolean {
  return !!raw && typeof raw === 'object'
    && String((raw as Record<string, unknown>).operation).startsWith('wallet-spend-')
}
/** Launcher-only authority. Renderer callbacks cannot confirm, configure, or select a wallet. */
export class WalletSpendAuthority {
  private disposed = false
  private confirming = false
  private readonly retiredClients = new Set<string>()
  private readonly operations = new Map<string, { readonly client: string; readonly abort: AbortController }>()
  constructor(
    private readonly options: {
      readonly homeDir?: string
      readonly profileId: string
      readonly resolve: (token: unknown) => OwnerDocumentPrincipal | undefined
      /** Test injection stays at the privileged process boundary. */
      readonly confirm?: typeof confirmWalletSpendNative
      readonly registry?: LocalWalletRegistry
      readonly verifySource?: typeof verifyWalletSpendSource
      readonly fetchSource?: typeof fetchWalletSpendSource
    },
  ) {}
  async handle(raw: unknown, documentLive: () => boolean = () => true): Promise<WalletSpendResultV1<unknown>> {
    let dispatched = false, releaseConfirmation = false, registeredOperation = false
    let client: WalletSpendIpcClient | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let monitor: ReturnType<typeof setInterval> | undefined, operationKey = ''
    try {
      const request = spendObject(raw)
      if (
        Object.keys(request).some(key =>
          !['version', 'requestId', 'token', 'operation', 'clientId', 'operationId', 'input'].includes(key)
        )
      ) return failure('invalid-request')
      const principal = this.options.resolve(request.token)
      if (!principal || this.disposed || !documentLive()) return failure('stale-generation')
      const ownerKey = JSON.stringify(principal), clientKey = ownerKey + ':' + spendId(request.clientId)
      if (request.operation === 'wallet-spend-dispose' || request.operation === 'wallet-spend-abort') {
        if (request.operation === 'wallet-spend-dispose') {
          if (this.retiredClients.size >= 1024) this.dispose()
          else this.retiredClients.add(clientKey)
        }
        for (const [key, operation] of this.operations) {
          if (
            operation.client === clientKey && (request.operation === 'wallet-spend-dispose'
              || key === clientKey + ':' + request.operationId)
          ) operation.abort.abort()
        }
        return { status: 'accepted', value: null }
      }
      if (this.retiredClients.has(clientKey)) return failure('stale-generation')
      const input = spendObject(request.input), operation = request.operation
      const expected = operation === 'wallet-spend-identity'
        ? []
        : operation === 'wallet-spend-reserve'
        ? ['source', 'terms', 'requestId', 'deadline']
        : operation === 'wallet-spend-bind'
        ? ['source', 'challenge', 'deadline']
        : operation === 'wallet-spend-lookup'
        ? ['source', 'requestId', 'deadline']
        : operation === 'wallet-spend-apply'
        ? ['source', 'decision', 'deadline']
        : undefined
      const commerceExpected = operation === 'wallet-spend-catalog' || operation === 'wallet-spend-orders'
        ? ['storeId', 'deadline']
        : operation === 'wallet-spend-order'
        ? ['storeId', 'requestId', 'deadline']
        : (operation === 'wallet-spend-purchase' || operation === 'wallet-spend-cancel-purchase')
        ? [
          'storeId',
          'itemId',
          'quantity',
          'expectedTotal',
          'requestId',
          'deadline',
          ...(input.fulfillmentTarget === undefined ? [] : ['fulfillmentTarget']),
        ]
        : operation === 'wallet-spend-legacy-receipt'
        ? ['kind', 'requestId', 'input', 'deadline']
        : operation === 'wallet-spend-authorize-source'
        ? ['serviceOrigin', 'deadline']
        : undefined
      if (!expected && !commerceExpected) return failure('invalid-request')
      spendObject(input, expected ?? commerceExpected)
      const deadline = operation === 'wallet-spend-identity' ? Date.now() + 10_000 : input.deadline
      if (!Number.isSafeInteger(deadline) || deadline > Date.now() + 120_000) return failure('invalid-request')
      if (deadline <= Date.now()) return failure('deadline-exceeded')
      if (!this.options.homeDir) return failure('unsupported')
      let config: ReturnType<typeof loadWalletSpendConfig>
      try {
        config = loadWalletSpendConfig(this.options.homeDir, this.options.profileId)
      } catch {
        return failure('provider-unavailable')
      }
      const source: WalletSpendSourceV1 | undefined = input.source === undefined ? undefined : spendSource(input.source)
      if (
        source && !config.services.some(entry =>
          entry.owner.pluginId === principal.identity.pluginId
          && entry.owner.source === principal.identity.source && sameSpendSource(entry.source, source)
          && (!['wallet-spend-bind', 'wallet-spend-reserve'].includes(operation) || entry.status === 'active')
        )
      ) return failure('source-unavailable')
      if (
        input.storeId !== undefined && !config.stores.some(entry =>
          entry.owner.pluginId === principal.identity.pluginId
          && entry.owner.source === principal.identity.source && entry.storeId === spendId(input.storeId)
        )
      ) return failure('source-unavailable')
      const registry = this.options.registry
        ?? new LocalWalletRegistry(this.options.homeDir, this.options.profileId, createMacOSKeychainBackend())
      let profile: ReturnType<LocalWalletRegistry['active']>
      try {
        profile = registry.active(config.binding)
      } catch {
        return failure('wallet-unavailable')
      }
      const accountId = profile.entries.find(entry => entry.realm === localWalletRealm(config.binding))!.accountId!
      const abort = new AbortController()
      operationKey = clientKey + ':' + spendId(request.operationId)
      if (this.operations.size >= 32 || this.operations.has(operationKey)) return failure('invalid-request')
      this.operations.set(operationKey, { client: clientKey, abort })
      registeredOperation = true
      const live = () =>
        !abort.signal.aborted && !this.disposed && documentLive() && !this.retiredClients.has(clientKey)
        && this.options.resolve(request.token) !== undefined && registry.current(profile)
        && loadWalletSpendConfig(this.options.homeDir!, this.options.profileId).fingerprint === config.fingerprint
      const guard = () => {
        if (!live()) throw new Error('retired operation')
      }
      timer = setTimeout(() => abort.abort(), deadline - Date.now())
      monitor = setInterval(() => {
        try {
          guard()
        } catch {
          abort.abort()
        }
      }, 100)
      guard()
      if (operation === 'wallet-spend-authorize-source') {
        if (this.confirming) return failure('denied')
        this.confirming = true
        releaseConfirmation = true
        const prior = config.services.filter(entry =>
          entry.owner.pluginId === principal.identity.pluginId
          && entry.owner.source === principal.identity.source && entry.source.serviceOrigin === input.serviceOrigin
        )
        const operatorLocalPins = prior.filter(entry =>
          entry.status === 'active' && new URL(entry.source.serviceOrigin).protocol === 'http:'
        )
        if (new URL(input.serviceOrigin).protocol !== 'https:' && !operatorLocalPins.length) {
          return failure('source-unavailable')
        }
        let fetched: WalletSpendSourceV1
        try {
          fetched = await (this.options.fetchSource ?? fetchWalletSpendSource)(
            input.serviceOrigin,
            abort.signal,
            operatorLocalPins.length > 0,
          )
        } catch {
          return failure('source-unavailable')
        }
        guard()
        // HTTP only reopens an exact active operator pin; it never onboards or rotates a key.
        if (operatorLocalPins.length && !operatorLocalPins.some(entry => sameSpendSource(entry.source, fetched))) {
          return failure('source-unavailable')
        }
        if (prior.some(entry => entry.status === 'active' && sameSpendSource(entry.source, fetched))) {
          return { status: 'accepted', value: fetched }
        }
        const approved = await (this.options.confirm ?? confirmWalletSpendNative)({
          summary: prior.length
            ? 'This server identity changed. Approve this exact new origin and key? Old pending reservations keep their original key.'
            : 'Allow this exact HTTPS server identity for this plugin? Each future spend requires separate approval.',
          document: JSON.stringify(
            {
              plugin: principal.identity,
              source: fetched,
              previousPins: prior.map(entry => entry.source),
            },
            null,
            2,
          ),
          signal: abort.signal,
        })
        guard()
        if (!approved) return failure('denied')
        persistWalletSpendSource(
          this.options.homeDir,
          this.options.profileId,
          config.fingerprint,
          principal.identity,
          fetched,
          guard,
        )
        return { status: 'accepted', value: fetched }
      }
      client = await WalletSpendIpcClient.open(
        config,
        {
          origin: config.binding.origin,
          instanceId: config.binding.instanceId,
          accountId,
          subject: profile.subject,
          publicKey: profile.publicKey,
        },
        deadline,
        abort.signal,
      )
      guard()
      const identity = spendIdentity(await client.call('identity', {}))
      guard()
      let value: unknown
      if (operation === 'wallet-spend-identity') value = identity
      else if (
        operation === 'wallet-spend-catalog' || operation === 'wallet-spend-orders'
        || operation === 'wallet-spend-order'
      ) {
        value = await client.call(operation.slice('wallet-spend-'.length), {
          storeId: input.storeId,
          ...(operation === 'wallet-spend-order' ? { requestId: spendId(input.requestId) } : {}),
        })
        if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 262_144)) {
          throw new Error('invalid commerce result')
        }
      } else if (operation === 'wallet-spend-legacy-receipt') {
        if (
          !['grant', 'migration', 'purchase'].includes(input.kind) || typeof input.input !== 'string'
          || Buffer.byteLength(input.input) > 65_536
        ) return failure('invalid-request')
        value = await client.call('legacy-receipt', {
          kind: input.kind,
          requestId: spendId(input.requestId),
          input: input.input,
        })
        if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 262_144)) {
          throw new Error('invalid legacy receipt')
        }
      } else if (operation === 'wallet-spend-purchase' || operation === 'wallet-spend-cancel-purchase') {
        spendId(input.itemId)
        spendId(input.requestId)
        if (
          !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000
          || !Number.isSafeInteger(input.expectedTotal) || input.expectedTotal < 0
          || input.expectedTotal > 1_000_000_000_000
        ) return failure('invalid-request')
        if (input.fulfillmentTarget !== undefined) {
          spendObject(input.fulfillmentTarget, ['namespace', 'storeId'])
          if (input.fulfillmentTarget.namespace !== input.storeId) return failure('invalid-request')
          spendId(input.fulfillmentTarget.storeId)
        }
        const purchaseInput = {
          storeId: input.storeId,
          itemId: input.itemId,
          quantity: input.quantity,
          expectedTotal: input.expectedTotal,
          requestId: input.requestId,
          ...(input.fulfillmentTarget === undefined ? {} : { fulfillmentTarget: input.fulfillmentTarget }),
        }
        const previous = await client.call('order', { storeId: input.storeId, requestId: input.requestId })
        guard()
        if (previous !== null) {
          try {
            spendPurchaseReceipt(previous, purchaseInput, config.binding.instanceId, accountId)
          } catch {
            return failure('conflict')
          }
          return { status: 'accepted', value: previous }
        }
        if (this.confirming) return failure('denied')
        this.confirming = true
        releaseConfirmation = true
        const cancelling = operation === 'wallet-spend-cancel-purchase'
        const quoted = spendObject(
          await client.call(cancelling ? 'quote-cancellation' : 'quote-purchase', purchaseInput),
          ['token', 'quote'],
        )
        guard()
        if (typeof quoted.quote !== 'string' || Buffer.byteLength(quoted.quote) > 65_536) {
          return failure('invalid-request')
        }
        if (cancelling) {
          const quote = spendObject(JSON.parse(quoted.quote), ['contract', 'walletId', 'input'])
          if (
            quote.contract !== 'economy.local-purchase-cancellation-quote/v1' || quote.walletId !== identity.walletId
            || spendCanonical(quote.input) !== spendCanonical(purchaseInput)
          ) return failure('invalid-request')
          const approved = await (this.options.confirm ?? confirmWalletSpendNative)({
            summary: 'Cancel this exact local purchase request? If it already committed, recover its existing order.',
            document: JSON.stringify(
              {
                plugin: principal.identity,
                originalWallet: { instanceId: config.binding.instanceId, accountId },
                quote,
              },
              null,
              2,
            ),
            signal: abort.signal,
          })
          guard()
          if (!approved) return failure('denied')
          dispatched = true
          const result = await client.call('cancel-purchase', { token: quoted.token })
          spendPurchaseReceipt(result, purchaseInput, config.binding.instanceId, accountId)
          guard()
          return { status: 'accepted', value: result }
        }
        const q = spendObject(JSON.parse(quoted.quote), [
          'contract',
          'storeId',
          'itemId',
          'title',
          'quantity',
          'unitPrice',
          'total',
          'requestId',
          'walletId',
          ...(input.fulfillmentTarget === undefined ? [] : ['fulfillmentTarget']),
        ])
        if (
          q.contract !== 'economy.local-purchase-quote/v1' || q.storeId !== input.storeId || q.itemId !== input.itemId
          || q.quantity !== input.quantity || q.total !== input.expectedTotal || q.requestId !== input.requestId
          || q.walletId !== identity.walletId || typeof q.title !== 'string' || !Number.isSafeInteger(q.unitPrice)
          || q.unitPrice < 0 || q.total !== q.quantity * q.unitPrice
          || spendCanonical(q.fulfillmentTarget ?? null) !== spendCanonical(input.fulfillmentTarget ?? null)
        ) return failure('invalid-request')
        const approved = await (this.options.confirm ?? confirmWalletSpendNative)({
          summary: `Buy exactly ${q.quantity} item(s) for ${q.total} Token from the local catalog.`,
          document: JSON.stringify(
            {
              plugin: principal.identity,
              originalWallet: { instanceId: config.binding.instanceId, accountId },
              quote: q,
            },
            null,
            2,
          ),
          signal: abort.signal,
        })
        guard()
        dispatched = true
        value = await client.call(approved ? 'purchase' : 'cancel-purchase', { token: quoted.token })
        spendPurchaseReceipt(value, purchaseInput, config.binding.instanceId, accountId)
      } else if (operation === 'wallet-spend-lookup') {
        const result = await client.call('lookup', { source, requestId: spendId(input.requestId) })
        value = result === null ? null : spendRecord(result, identity, source!)
      } else if (operation === 'wallet-spend-apply') {
        const decision = spendSigned(input.decision, 'economy.spend-decision/v1', source!.servicePublicKey, 262_144)
        if (
          !sameSpendSource(
            source!,
            spendSource({
              serviceOrigin: decision.serviceOrigin,
              servicePublicKey: decision.servicePublicKey,
              serverId: decision.serverId,
            }),
          )
        ) return failure('invalid-request')
        guard()
        dispatched = true
        const records = await client.call('apply', { source, decision: input.decision })
        if (!Array.isArray(records) || records.length > 8) throw new Error('invalid records')
        value = records.map(record => spendRecord(record, identity, source!))
      } else {
        if (operation === 'wallet-spend-reserve') {
          const terms = spendTerms(input.terms, source!, identity, false)
          const prior = await client.call('lookup', { source, requestId: spendId(input.requestId) })
          guard()
          if (prior !== null) {
            const record = spendRecord(prior, identity, source!), receipt = JSON.parse(record.reservation).payload
            if (
              receipt.termsHash !== terms.hash || receipt.matchId !== terms.payload.matchId
              || receipt.gameAccountId !== terms.own.gameAccountId || receipt.amount !== terms.own.amount
            ) return failure('conflict')
            return { status: 'accepted', value: record }
          }
        }
        try {
          await (this.options.verifySource ?? verifyWalletSpendSource)(source!, abort.signal)
        } catch {
          return failure('source-unavailable')
        }
        guard()
        if (this.confirming) return failure('denied')
        this.confirming = true
        releaseConfirmation = true
        const binding = operation === 'wallet-spend-bind'
        const original = binding
          ? spendChallenge(input.challenge, source!)
          : spendTerms(input.terms, source!, identity).payload
        const quote = spendObject(
          await client.call(
            binding ? 'quote-binding' : 'quote',
            binding
              ? { challenge: input.challenge }
              : { terms: input.terms, requestId: spendId(input.requestId) },
          ),
          binding ? ['token', 'challenge'] : ['token', 'terms'],
        )
        guard()
        const quoted = binding
          ? spendChallenge(quote.challenge, source!)
          : spendTerms(quote.terms, source!, identity).payload
        if (spendCanonical(original) !== spendCanonical(quoted)) return failure('invalid-request')
        const terms = binding ? undefined : spendTerms(quote.terms, source!, identity)
        const approved = await (this.options.confirm ?? confirmWalletSpendNative)({
          summary: binding
            ? 'Link this logged-in game account to your existing local wallet. This does not spend Token.'
            : `Reserve exactly ${terms!.own.amount} Token. This service may consume 0–${
              terms!.own.amount
            }; the remainder returns to this reservation. No game winnings mint Token. Offline or timeout keeps funds reserved.`,
          document: JSON.stringify(
            {
              plugin: principal.identity,
              originalWallet: { instanceId: config.binding.instanceId, accountId },
              receiptIdentity: identity,
              ...(binding ? {} : { termsHash: terms!.hash }),
              signedPayload: quoted,
              reviewNotice: 'The service-reported review status is not Host verification.',
            },
            null,
            2,
          ),
          signal: abort.signal,
        })
        guard()
        if (!approved) return failure('denied')
        if (binding) spendChallenge(quote.challenge, source!)
        else spendTerms(quote.terms, source!, identity)
        guard()
        dispatched = true
        const result = await client.call(binding ? 'bind' : 'reserve', { token: quote.token })
        if (binding) {
          const receipt = spendSigned(result, 'economy.spend-wallet-binding/v1', identity.walletPublicKey)
          if (
            receipt.walletId !== identity.walletId || receipt.walletPublicKey !== identity.walletPublicKey
            || Object.keys(quoted).some(key => key !== 'contract' && receipt[key] !== quoted[key])
          ) throw new Error('wrong binding')
          value = result
        } else {
          const record = spendRecord(result, identity, source!), receipt = JSON.parse(record.reservation).payload
          if (
            receipt.termsHash !== terms!.hash || receipt.matchId !== quoted.matchId
            || receipt.amount !== terms!.own.amount
            || receipt.gameAccountId !== terms!.own.gameAccountId
          ) throw new Error('wrong reservation')
          value = record
        }
      }
      guard()
      return { status: 'accepted', value }
    } catch {
      return failure(dispatched ? 'outcome-unknown' : 'invalid-request')
    } finally {
      client?.close()
      clearTimeout(timer)
      clearInterval(monitor)
      if (registeredOperation) this.operations.delete(operationKey)
      if (releaseConfirmation) this.confirming = false
    }
  }
  dispose(): void {
    this.disposed = true
    for (const operation of this.operations.values()) operation.abort.abort()
  }
}
