import { afterEach, describe, expect, it } from 'vitest'
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { connect } from 'node:net'
import { createServer } from 'node:http'
import { WalletSpendAuthority } from '../packages/cli/src/launcher/wallet-spend-authority.js'
import { listenWalletSpendProvider } from '../packages/cli/src/launcher/wallet-spend-ipc-server.js'
import {
  decodeSpendFrame,
  encodeSpendFrame,
  spendCanonical,
} from '../packages/cli/src/launcher/wallet-spend-ipc-wire.js'
import { createWalletSpendClient } from '../packages/cli/src/renderer/wallet-spend.js'
import { WALLET_SPEND_NATIVE_SCRIPT } from '../packages/cli/src/launcher/wallet-spend-native-consent.js'
import { fetchWalletSpendSource } from '../packages/cli/src/launcher/wallet-spend-source-proof.js'
import type { LocalWalletRegistry } from '../packages/cli/src/launcher/local-wallet-registry.js'
import type { WalletSpendProviderSessionV1 } from '../packages/cli/src/launcher/wallet-spend-ipc-types.js'
import type { BrowserOwnerDocumentBridge } from '../packages/cli/src/renderer/owner-documents.js'

const key = (seed: string) =>
  createPrivateKey({
    key: Buffer.from('302e020100300506032b657004220420' + seed.repeat(32), 'hex'),
    type: 'pkcs8',
    format: 'der',
  })
const serviceKey = key('11'), receiptKey = key('22'), hostKey = key('33')
const publicKey = (k: ReturnType<typeof key>) =>
  createPublicKey(k).export({ format: 'der', type: 'spki' }).toString('base64url')
const source = { serviceOrigin: 'https://game.example', servicePublicKey: publicKey(serviceKey), serverId: 'server-1' }
const identity = { walletId: 'wallet-1', walletPublicKey: publicKey(receiptKey) }
const signed = (payload: Record<string, unknown>, k = serviceKey) =>
  JSON.stringify({
    payload,
    signature: sign(null, Buffer.from(payload.contract + '\0' + spendCanonical(payload)), k).toString('base64url'),
  })
const digest = (payload: unknown) => createHash('sha256').update(spendCanonical(payload)).digest('hex')
const termsPayload = () => ({
  contract: 'economy.spend-terms/v1',
  ...source,
  matchId: 'match-1',
  game: { id: 'gomoku', version: '1', digest: 'a'.repeat(64), reviewStatus: 'unreviewed' },
  participants: [{ gameAccountId: 'game-account-1', ...identity, amount: 10 }],
  policy: 'capture-and-release',
  acceptBefore: Date.now() + 60_000,
})
const resources: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of resources.splice(0)) await close()
})

async function setup(
  confirm: ConstructorParameters<typeof WalletSpendAuthority>[0]['confirm'] = async () => true,
  fetchSource: typeof fetchWalletSpendSource = async () => source,
) {
  const homeDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wsp-'))), socketPath = path.join(homeDir, 's')
  const secretFile = path.join(homeDir, 'secret'), secret = randomBytes(32)
  writeFileSync(secretFile, secret, { mode: 0o600 })
  const state = {
    mutations: 0,
    closes: 0,
    live: true,
    mismatchedQuote: false,
    loseAck: false,
    approvals: [] as string[],
  }
  const principal = {
    profileId: 'p',
    generation: 'r1',
    moduleGeneration: 'm1',
    identity: { pluginId: 'wallet', source: 'file:///wallet.tsx' },
  }
  const configFile = path.join(homeDir, 'state/profiles/p/wallet-spend.json')
  mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
  const binding = { origin: 'http://127.0.0.1:8788', sourceId: 'local', instanceId: 'local', audience: 'local-wallet' }
  writeFileSync(
    configFile,
    JSON.stringify({
      contract: 'cordisx.wallet-spend-config/v1',
      socketPath,
      secretFile,
      walletBinding: binding,
      services: [{ owner: principal.identity, source }],
      stores: [{ owner: principal.identity, storeId: 'pet' }],
    }),
    { mode: 0o600 },
  )
  const profile = {
    revision: 'rev',
    subject: 'host-local:' + digest('host'),
    publicKey: createPublicKey(hostKey).export({ format: 'der', type: 'spki' }).toString('base64'),
    entries: [{ realm: JSON.stringify([binding.origin, binding.instanceId]), accountId: 'original-account' }],
  }
  // Valid 43-character subject; no existing user's keychain or ledger is touched.
  profile.subject = 'host-local:'
    + createHash('sha256').update(Buffer.from(profile.publicKey, 'base64')).digest('base64url')
  const reservations = new Map<string, { reservation: string; state: 'pending' }>(), orders = new Map<string, string>()
  const server = await listenWalletSpendProvider({
    socketPath,
    secretFile,
    openSession(wallet, live) {
      expect(wallet.accountId).toBe('original-account')
      expect(wallet.publicKey).toBe(profile.publicKey)
      let active = true
      const guard = () => {
        if (!active || !live()) throw new Error('retired')
      }
      return {
        identity: () => {
          guard()
          return identity
        },
        quote: (text, requestId) => {
          guard()
          const envelope = JSON.parse(text)
          if (state.mismatchedQuote) {
            envelope.payload.participants[0].amount = 99
            text = signed(envelope.payload)
          }
          return { handle: { payload: envelope.payload, requestId }, terms: text }
        },
        reserve: (handle: object) => {
          guard()
          const h = handle as { payload: ReturnType<typeof termsPayload>; requestId: string }
          const value = {
            reservation: signed({
              contract: 'economy.spend-reservation/v1',
              ...source,
              matchId: h.payload.matchId,
              termsHash: digest(h.payload),
              reservationId: 'reservation-1',
              nonce: 'b'.repeat(64),
              ...h.payload.participants[0],
            }, receiptKey),
            state: 'pending' as const,
          }
          state.mutations++
          reservations.set(h.requestId, value)
          if (state.loseAck) throw new Error('ACK lost after commit')
          return value
        },
        quoteBinding: challenge => ({ handle: JSON.parse(challenge).payload, challenge }),
        bindGameAccount: handle => {
          guard()
          state.mutations++
          return signed({ ...handle, contract: 'economy.spend-wallet-binding/v1', ...identity }, receiptKey)
        },
        lookup: (_source, requestId) => {
          guard()
          return reservations.get(requestId) ?? null
        },
        applyDecision: () => {
          guard()
          return []
        },
        catalog: () => '[]',
        orders: () => JSON.stringify([...orders.values()].map(x => JSON.parse(x))),
        order: (_store, requestId) => orders.get(requestId) ?? null,
        quotePurchase: input => ({
          handle: input,
          quote: JSON.stringify({
            contract: 'economy.local-purchase-quote/v1',
            ...input,
            title: 'Food',
            unitPrice: 5,
            total: 5 * input.quantity,
            walletId: identity.walletId,
            expectedTotal: undefined,
          }),
        }),
        quoteCancellation: input => ({
          handle: input,
          quote: JSON.stringify({
            contract: 'economy.local-purchase-cancellation-quote/v1',
            walletId: identity.walletId,
            input,
          }),
        }),
        cancelPurchase: handle => {
          guard()
          const input = handle as { storeId: string; requestId: string }
          const prior = orders.get(input.requestId)
          if (prior) return prior
          const receipt = JSON.stringify({
            contract: 'economy.local-purchase-cancelled/v1',
            state: 'cancelled',
            instanceId: 'local',
            accountId: 'original-account',
            storeId: input.storeId,
            requestId: input.requestId,
            input,
            inputHash: digest(input),
          })
          orders.set(input.requestId, receipt)
          return receipt
        },
        purchase: handle => {
          guard()
          state.mutations++
          const input = handle as { itemId: string; quantity: number; requestId: string }
          const order = JSON.stringify({
            instanceId: 'local',
            accountId: 'original-account',
            id: 'order-1',
            itemId: input.itemId,
            quantity: input.quantity,
            total: input.quantity * 5,
          })
          orders.set(input.requestId, order)
          return order
        },
        legacyReceipt: () => null,
        close: () => {
          active = false
          state.closes++
        },
      } satisfies WalletSpendProviderSessionV1
    },
  })
  const authority = new WalletSpendAuthority({
    homeDir,
    profileId: 'p',
    resolve: token => token === 'token' && state.live ? principal : undefined,
    registry: { active: () => profile, current: () => state.live } as unknown as LocalWalletRegistry,
    verifySource: async () => {},
    fetchSource,
    confirm: async input => {
      state.approvals.push(input.document)
      return await confirm!(input)
    },
  })
  resources.push(async () => {
    authority.dispose()
    await server.close()
    rmSync(homeDir, { recursive: true, force: true })
  })
  const request = (operation: string, input: unknown) => ({
    operation: 'wallet-spend-' + operation,
    token: 'token',
    clientId: 'client',
    operationId: randomBytes(8).toString('hex'),
    input,
  })
  const reserve = (terms = signed(termsPayload())) =>
    authority.handle(request('reserve', { source, terms, requestId: 'spend:1', deadline: Date.now() + 30_000 }))
  return { homeDir, configFile, secretFile, secret, socketPath, state, authority, request, reserve }
}

async function operatorSourceSetup() {
  const s = await setup(async () => false, fetchWalletSpendSource)
  let origin = '', requests = 0
  const metadata = { contract: 'economy.spend-service/v1', ...source }
  const server = createServer((request, response) => {
    requests += 1
    expect(request.url).toBe('/v1/spend/identity')
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers.cookie).toBeUndefined()
    response.end(JSON.stringify(metadata))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  metadata.serviceOrigin = origin
  const config = JSON.parse(readFileSync(s.configFile, 'utf8'))
  config.services[0].source.serviceOrigin = origin
  writeFileSync(s.configFile, JSON.stringify(config), { mode: 0o600 })
  resources.push(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return {
    ...s,
    origin,
    metadata,
    config,
    requests: () => requests,
    authorize: (serviceOrigin = origin) =>
      s.authority.handle(s.request('authorize-source', { serviceOrigin, deadline: Date.now() + 10_000 })),
  }
}

describe('wallet spend trusted boundary', () => {
  it('reopens an exact active owner operator loopback pin after actual metadata verification without confirmation or writes', async () => {
    const s = await operatorSourceSetup(), before = readFileSync(s.configFile, 'utf8')
    expect(await s.authorize()).toEqual({ status: 'accepted', value: { ...source, serviceOrigin: s.origin } })
    expect(s.requests()).toBe(1)
    expect(readFileSync(s.configFile, 'utf8')).toBe(before)
    expect(s.state.approvals).toHaveLength(0)
    expect(s.state.mutations).toBe(0)
    expect(s.state.closes).toBe(0)
  })
  it.each(['missing', 'foreign-owner', 'recovery-only', 'non-loopback'] as const)(
    'rejects %s HTTP before metadata fetch and never persists a new pin',
    async reason => {
      const s = await operatorSourceSetup()
      if (reason === 'missing') s.config.services = []
      if (reason === 'foreign-owner') s.config.services[0].owner.pluginId = 'foreign'
      if (reason === 'recovery-only') s.config.services[0].status = 'recovery-only'
      writeFileSync(s.configFile, JSON.stringify(s.config), { mode: 0o600 })
      const before = readFileSync(s.configFile, 'utf8')
      expect(await s.authorize(reason === 'non-loopback' ? 'http://192.0.2.1' : s.origin)).toEqual({
        status: 'unavailable',
        code: 'source-unavailable',
      })
      expect(s.requests()).toBe(0)
      expect(readFileSync(s.configFile, 'utf8')).toBe(before)
      expect(s.state.approvals).toHaveLength(0)
      expect(s.state.mutations).toBe(0)
    },
  )
  it.each(['key', 'server', 'origin'] as const)(
    'rejects changed HTTP metadata %s without key rotation or consent',
    async field => {
      const s = await operatorSourceSetup(), before = readFileSync(s.configFile, 'utf8')
      if (field === 'key') s.metadata.servicePublicKey = publicKey(hostKey)
      if (field === 'server') s.metadata.serverId = 'changed-server'
      if (field === 'origin') s.metadata.serviceOrigin = 'https://foreign.example'
      expect(await s.authorize()).toEqual({ status: 'unavailable', code: 'source-unavailable' })
      expect(s.requests()).toBe(1)
      expect(readFileSync(s.configFile, 'utf8')).toBe(before)
      expect(s.state.approvals).toHaveLength(0)
      expect(s.state.mutations).toBe(0)
    },
  )
  it('authenticates UDS, shows the exact complete terms, persists one reservation and recovers lost ACK', async () => {
    const s = await setup(), terms = signed(termsPayload())
    s.state.loseAck = true
    expect(await s.reserve(terms)).toEqual({ status: 'unavailable', code: 'outcome-unknown' })
    s.state.loseAck = false
    expect((await s.reserve(terms)).status).toBe('accepted')
    expect(s.state.mutations).toBe(1)
    expect(s.state.approvals).toHaveLength(1)
    const document = JSON.parse(s.state.approvals[0]!)
    expect(document.signedPayload).toEqual(JSON.parse(terms).payload)
    expect(document.termsHash).toBe(digest(JSON.parse(terms).payload))
    expect(document.originalWallet.accountId).toBe('original-account')
  })
  it('denial performs no financial mutation', async () => {
    const s = await setup(async () => false)
    expect(await s.reserve()).toEqual({ status: 'unavailable', code: 'denied' })
    expect(s.state.mutations).toBe(0)
  })
  it('rejects validly signed but substituted quoted terms before approval', async () => {
    const s = await setup()
    s.state.mismatchedQuote = true
    expect(await s.reserve()).toEqual({ status: 'unavailable', code: 'invalid-request' })
    expect(s.state.approvals).toHaveLength(0)
    expect(s.state.mutations).toBe(0)
  })
  it('rejects renderer approval, account selectors and impersonated origin/key', async () => {
    const s = await setup()
    const input = {
      source,
      terms: signed(termsPayload()),
      requestId: 'spend:1',
      deadline: Date.now() + 30_000,
      approved: true,
      accountId: 'other',
    }
    expect(await s.authority.handle(s.request('reserve', input))).toEqual({
      status: 'unavailable',
      code: 'invalid-request',
    })
    const impersonated = { ...source, serviceOrigin: 'https://google.com' }
    expect(
      await s.authority.handle(
        s.request('reserve', {
          terms: input.terms,
          requestId: input.requestId,
          deadline: input.deadline,
          source: impersonated,
        }),
      ),
    ).not.toHaveProperty('status', 'accepted')
    expect(s.state.mutations).toBe(0)
  })
  it('rejects altered signatures and same request ID with differing terms', async () => {
    const s = await setup(), payload = termsPayload(), text = signed(payload)
    expect((await s.reserve(text)).status).toBe('accepted')
    payload.participants[0]!.amount = 11
    expect(await s.reserve(signed(payload))).toEqual({ status: 'unavailable', code: 'conflict' })
    expect(await s.reserve(JSON.stringify({ ...JSON.parse(text), signature: 'A'.repeat(86) }))).toEqual({
      status: 'unavailable',
      code: 'invalid-request',
    })
    expect(s.state.mutations).toBe(1)
  })
  it('principal retirement while native consent is pending never dispatches reserve', async () => {
    let approve!: (value: boolean) => void, entered!: () => void
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    const s = await setup(async () => {
      entered()
      return new Promise(resolve => {
        approve = resolve
      })
    })
    const attempt = s.reserve()
    await ready
    s.state.live = false
    approve(true)
    expect((await attempt).status).toBe('unavailable')
    expect(s.state.mutations).toBe(0)
  })
  it('retires a disposed client, closes sessions, and cannot use another caller to abort it', async () => {
    const s = await setup()
    await s.authority.handle({ operation: 'wallet-spend-dispose', token: 'token', clientId: 'client' })
    expect(await s.reserve()).toEqual({ status: 'unavailable', code: 'stale-generation' })
    expect(s.state.mutations).toBe(0)
  })
  it('a duplicate operation ID cannot remove the original pending operation from abort tracking', async () => {
    let entered!: () => void
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    const s = await setup(async input => {
      entered()
      return new Promise<boolean>(resolve =>
        input.signal.addEventListener('abort', () => resolve(false), { once: true })
      )
    })
    const request = s.request('reserve', {
      source,
      terms: signed(termsPayload()),
      requestId: 'spend:1',
      deadline: Date.now() + 30_000,
    })
    const pending = s.authority.handle(request)
    await ready
    expect(await s.authority.handle(request)).toEqual({ status: 'unavailable', code: 'invalid-request' })
    await s.authority.handle({
      operation: 'wallet-spend-abort',
      token: 'token',
      clientId: 'client',
      operationId: request.operationId,
    })
    expect((await pending).status).toBe('unavailable')
    expect(s.state.mutations).toBe(0)
  })
  it('rejects an unauthenticated/replayed local frame without opening a financial session', async () => {
    const s = await setup(), frame = { session: 'a'.repeat(64), sequence: 0, operation: 'open', payload: {} }
    const encoded = encodeSpendFrame(s.secret, frame)
    expect(decodeSpendFrame(s.secret, encoded.trim())).toEqual(frame)
    expect(() => decodeSpendFrame(randomBytes(32), encoded.trim())).toThrow()
    const socket = connect(s.socketPath)
    await new Promise<void>(resolve => {
      socket.once('close', resolve)
      socket.write(encodeSpendFrame(randomBytes(32), frame))
    })
    expect(s.state.mutations).toBe(0)
    expect(s.state.closes).toBe(0)
  })
  it('rejects an unsafe shared secret file', async () => {
    const s = await setup()
    chmodSync(s.secretFile, 0o644)
    expect((await s.reserve()).status).toBe('unavailable')
    expect(s.state.mutations).toBe(0)
  })
  it('requires TLS-fetched identity/native approval to persist a new source and preserves old pins', async () => {
    const s = await setup()
    const config = JSON.parse(readFileSync(s.configFile, 'utf8'))
    config.services = []
    writeFileSync(s.configFile, JSON.stringify(config), { mode: 0o600 })
    expect(
      await s.authority.handle(
        s.request('authorize-source', { serviceOrigin: source.serviceOrigin, deadline: Date.now() + 30_000 }),
      ),
    )
      .toEqual({ status: 'accepted', value: source })
    expect(JSON.parse(readFileSync(s.configFile, 'utf8')).services[0].owner.pluginId).toBe('wallet')
    expect(s.state.approvals).toHaveLength(1)
  })
  it('fixed local catalog purchase confirms engine price and retries without duplicate debit', async () => {
    const s = await setup(),
      input = {
        storeId: 'pet',
        itemId: 'food',
        quantity: 1,
        expectedTotal: 5,
        requestId: 'order:1',
        deadline: Date.now() + 30_000,
      }
    expect((await s.authority.handle(s.request('purchase', input))).status).toBe('accepted')
    expect((await s.authority.handle(s.request('purchase', input))).status).toBe('accepted')
    expect(s.state.mutations).toBe(1)
    expect(s.state.approvals).toHaveLength(1)
    expect(await s.authority.handle(s.request('purchase', { ...input, expectedTotal: 6 }))).toEqual({
      status: 'unavailable',
      code: 'conflict',
    })
  })
  it('native purchase denial persists an authoritative cancellation and permits a new request', async () => {
    const s = await setup(async () => false),
      input = {
        storeId: 'pet',
        itemId: 'food',
        quantity: 1,
        expectedTotal: 5,
        requestId: 'order:cancel',
        deadline: Date.now() + 30_000,
      }
    const result = await s.authority.handle(s.request('purchase', input))
    expect(result.status).toBe('accepted')
    if (result.status === 'accepted') expect(JSON.parse(result.value as string).state).toBe('cancelled')
    const retry = await s.authority.handle(s.request('purchase', input))
    expect(retry).toEqual(result)
    expect(s.state.mutations).toBe(0)
    expect(s.state.approvals).toHaveLength(1)
    const recovered = await s.authority.handle(
      s.request('order', { storeId: 'pet', requestId: input.requestId, deadline: input.deadline }),
    )
    expect(recovered).toEqual(result)
  })
  it('explicit cancellation binds the exact original body and never consumes inventory', async () => {
    const s = await setup(),
      input = {
        storeId: 'pet',
        itemId: 'food',
        quantity: 1,
        expectedTotal: 5,
        requestId: 'order:explicitcancel',
        deadline: Date.now() + 30_000,
      }
    const result = await s.authority.handle(s.request('cancel-purchase', input))
    expect(result.status).toBe('accepted')
    if (result.status === 'accepted') {
      expect(JSON.parse(result.value as string).inputHash).toBe(
        digest({ storeId: 'pet', itemId: 'food', quantity: 1, expectedTotal: 5, requestId: input.requestId }),
      )
    }
    expect(s.state.mutations).toBe(0)
  })
  it('fixed legacy missing receipt returns null with no new write', async () => {
    const s = await setup()
    expect(
      await s.authority.handle(
        s.request('legacy-receipt', {
          kind: 'grant',
          requestId: 'legacy:1',
          input: '{}',
          deadline: Date.now() + 30_000,
        }),
      ),
    )
      .toEqual({ status: 'accepted', value: null })
    expect(s.state.mutations).toBe(0)
    expect(s.state.approvals).toHaveLength(0)
  })
  it('renderer snapshots data, preserves stable request ID separately from bridge correlation and never receives an approval', async () => {
    const captures: Record<string, unknown>[] = []
    const api = createWalletSpendClient({
      principal: { token: 'token', source: 'file:///wallet.tsx', pluginId: 'wallet', moduleGeneration: 'm' },
      active: () => true,
      bridge: {
        request: async (_token: string, request: Record<string, unknown>) => {
          captures.push(request)
          return { status: 'accepted', value: null }
        },
      } as unknown as BrowserOwnerDocumentBridge,
    })
    await api.lookup({ source, requestId: 'spend:stable', deadline: Date.now() + 10_000 })
    expect((captures[0]!.input as { requestId: string }).requestId).toBe('spend:stable')
    expect(captures[0]).not.toHaveProperty('requestId')
    expect(api).not.toHaveProperty('sign')
    expect(api).not.toHaveProperty('mint')
    api.dispose()
    expect((await api.identity()).status).toBe('unavailable')
  })
  it('native confirmation owns a complete scrollable document and receives data without source interpolation', () => {
    expect(WALLET_SPEND_NATIVE_SCRIPT).toContain('NSScrollView')
    expect(WALLET_SPEND_NATIVE_SCRIPT).toContain('text.editable = false')
    expect(WALLET_SPEND_NATIVE_SCRIPT).toContain('JSON.parse(argv[0])')
    expect(WALLET_SPEND_NATIVE_SCRIPT).not.toContain('eval(')
  })
})
