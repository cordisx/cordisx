import { afterEach, expect, it, vi } from 'vitest'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { localWalletBytes } from '@cordisx/protocol/local-wallet/v1'
import { managedSourceBytes } from '@cordisx/protocol/managed-source/v1'
import { PluginHttpAuthority } from '../packages/cli/src/launcher/plugin-http-authority.js'
import {
  LOCAL_WALLET_KEYCHAIN_SERVICE,
  localWalletRealm,
  LocalWalletRegistry,
} from '../packages/cli/src/launcher/local-wallet-registry.js'
import { MANAGED_SOURCE_KEYCHAIN_SERVICE } from '../packages/cli/src/launcher/managed-source-authority.js'
import { createPluginHttpClients } from '../packages/cli/src/renderer/plugin-http.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { binding, owner, principal, secret, snapshot } from './fixtures/managed-source-http.js'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0)) await close()
})
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'host-local-wallet-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const root = generateKeyPairSync('ed25519'),
    server = generateKeyPairSync('ed25519'),
    workServer = generateKeyPairSync('ed25519'),
    keyRef = randomBytes(32).toString('base64url')
  const secrets = new Map([[
    MANAGED_SOURCE_KEYCHAIN_SERVICE + ':' + keyRef,
    root.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  ]])
  let upsertHold: Promise<void> | undefined,
    upsertKind = '',
    upsertStarted = false,
    upsertFinished = false,
    retireAfterFence = false,
    localKeyRead = false,
    localFenceCalls = 0
  const keychain = {
    read: async (service: string, key: string) => {
      const value = secrets.get(service + ':' + key)
      if (!value) throw new Error('missing key')
      if (service === LOCAL_WALLET_KEYCHAIN_SERVICE && retireAfterFence) localKeyRead = true
      return value
    },
    upsert: async (service: string, key: string, value: string) => {
      if (
        (upsertKind === 'key' && service === LOCAL_WALLET_KEYCHAIN_SERVICE)
        || (upsertKind === 'session' && value === 'local-session-secret')
      ) {
        upsertStarted = true
        await upsertHold
        upsertFinished = true
      }
      secrets.set(service + ':' + key, value)
    },
    remove: async (service: string, key: string) => {
      secrets.delete(service + ':' + key)
    },
    status: async (service: string, key: string) =>
      secrets.has(service + ':' + key) ? 'set' as const : 'unset' as const,
  }
  const registry = new LocalWalletRegistry(home, principal.profileId, keychain)
  let trustLive = true, retireTrustAt = 0, postTrustReads = 0, workResponseReturned = false
  const trusts = () => {
    if (!trustLive) return []
    if (workResponseReturned && retireTrustAt && ++postTrustReads === retireTrustAt) {
      queueMicrotask(() => {
        trustLive = false
      })
    }
    if (retireAfterFence && localKeyRead && ++localFenceCalls === 2) {
      queueMicrotask(() => {
        live = false
      })
    }
    return ['source-account', 'work-income'].map(audience => ({
      binding: { ...binding, audience: audience as 'source-account' | 'work-income' },
      owner,
      signingKeyRef: keyRef,
      serverPublicKey: (audience === 'work-income' ? workServer : server).publicKey.export({
        type: 'spki',
        format: 'pem',
      }).toString(),
    }))
  }
  let alias: { subject: string; key: string } | undefined,
    native: string | null = 'original-native',
    live = true,
    hold: Promise<void> | undefined,
    wrongAccount = false,
    observed = 100,
    badSettlementPolicy = false
  let workLease = { allow: true }, challengeHold: Promise<void> | undefined, workChallengeStarted = false
  let settlementReplies = 0
  let workProfileLive = true
  const permissionListeners = new Set<() => void>()
  const nativeRead = vi.fn(async () => native)
  const seen: Record<string, unknown>[] = []
  const signed = (payload: unknown, local: boolean, work = false) => ({
    payload,
    signature: sign(
      null,
      local ? localWalletBytes(payload) : managedSourceBytes(payload),
      (work ? workServer : server).privateKey,
    ).toString('base64url'),
  })
  const transport = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(raw)),
      audience = url.searchParams.get('audience'),
      local = audience?.startsWith('local-')
    if (url.pathname === '/v1/auth/host/challenge') {
      if (audience === 'local-work-income') {
        workChallengeStarted = true
        await challengeHold
      }
      return Response.json(
        signed(
          {
            ...binding,
            audience,
            contract: local ? 'cordisx.local-wallet-challenge/v1' : 'cordisx.managed-source-challenge/v1',
            nonce: randomBytes(32).toString('base64url'),
            expiresAt: Date.now() + 20_000,
          },
          !!local,
          audience === 'local-work-income',
        ),
      )
    }
    if (url.pathname === '/v1/me') {
      return Response.json({ account: { id: 'original-account' }, available: 731, reserved: 9 })
    }
    if (url.pathname === '/v1/ledger') return Response.json({ entries: [{ id: 'original-ledger', amount: 731 }] })
    if (url.pathname === '/v1/exchange') return Response.json({ token: 'derived-local-secret' })
    const envelope = JSON.parse(String(init?.body)),
      payload = envelope.payload as Record<string, unknown>,
      isLocal = String(payload.contract).startsWith('cordisx.local-'),
      work = payload.audience === 'local-work-income'
    seen.push(payload)
    if (payload.contract === 'cordisx.local-wallet-enrollment/v1') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer original-session-secret')
      expect(verify(null, localWalletBytes(payload), root.publicKey, Buffer.from(envelope.signature, 'base64url')))
        .toBe(true)
      expect(payload.nativeSubject).toBe('codex:' + createHash('sha256').update('original-native').digest('base64url'))
      const der = Buffer.from(String(payload.publicKey), 'base64')
      expect(payload.subject).toBe('host-local:' + createHash('sha256').update(der).digest('base64url'))
      alias = { subject: String(payload.subject), key: String(payload.publicKey) }
    } else if (isLocal) {
      expect(alias?.subject).toBe(payload.subject)
      expect(
        verify(
          null,
          localWalletBytes(payload),
          createPublicKey({ key: Buffer.from(alias!.key, 'base64'), type: 'spki', format: 'der' }),
          Buffer.from(envelope.signature, 'base64url'),
        ),
      ).toBe(true)
    } else {expect(
        verify(null, managedSourceBytes(payload), root.publicKey, Buffer.from(envelope.signature, 'base64url')),
      ).toBe(true)}
    await hold
    const account = { id: wrongAccount ? 'wrong-account' : 'original-account' }
    const result = payload.contract === 'cordisx.local-wallet-enrollment/v1'
      ? { enrolled: true, instanceId: binding.instanceId, account }
      : work
      ? {
        wallet: {
          origin: binding.origin,
          instanceId: binding.instanceId,
          accountId: account.id,
          available: 731,
          reserved: 9,
        },
        receipt: payload.contract === 'cordisx.local-work-settlement/v1'
          ? {
            eventId: 'work:' + 'a'.repeat(64),
            binding: { instanceId: binding.instanceId, accountId: account.id, scopeId: snapshot.scopeId },
            amount: 0,
            remainder: 0,
            cursor: {
              scopeId: snapshot.scopeId,
              sourceId: snapshot.sourceId,
              epoch: snapshot.epoch,
              revision: snapshot.revision,
              tokens: observed,
              observedThrough: snapshot.observedThrough,
            },
            coverage: 'partial',
            policy: badSettlementPolicy ? 'leased' : 'durable-admitted-v1',
          }
          : { amount: 0 },
      }
      : {
        instanceId: binding.instanceId,
        account,
        sessionToken: isLocal ? 'local-session-secret' : 'original-session-secret',
      }
    if (payload.contract === 'cordisx.local-work-settlement/v1') workResponseReturned = true
    return Response.json(signed(
      {
        ...binding,
        audience: payload.audience,
        contract: isLocal ? 'cordisx.local-wallet-result/v1' : 'cordisx.managed-source-result/v1',
        nonce: payload.nonce,
        subject: payload.subject,
        ...(payload.nativeSubject === undefined ? {} : { nativeSubject: payload.nativeSubject }),
        result,
      },
      isLocal,
      work,
    ))
  })
  const diagnostics: unknown[] = []
  const authority = new PluginHttpAuthority({
    onDiagnostic: event => diagnostics.push(event),
    secret,
    profileId: principal.profileId,
    generation: principal.generation,
    principalAllowed: () => live,
    keychain,
    fetch: transport as typeof fetch,
    managedSources: async () => trusts(),
    managedSourcesNow: trusts,
    localWalletHomeDir: home,
  })
  cleanups.push(() => authority.dispose())
  const token = issueOwnerDocumentPrincipalToken(secret, principal)
  const { http: client, workSettlement } = createPluginHttpClients({
    active: () => live,
    principal: { ...owner, moduleGeneration: principal.moduleGeneration, token },
    authorizeWork: async () => workLease.allow,
    workPermissionFence: () => {
      const lease = workLease
      return () => lease === workLease && lease.allow
    },
    subscribeWorkPermission: listener => {
      permissionListeners.add(listener)
      return () => {
        permissionListeners.delete(listener)
      }
    },
    bridge: {
      request: async (_: string, input: Record<string, unknown>) => {
        const result = await authority.handle(
          { ...input, token },
          nativeRead,
          Object.assign(async () => ({ ...snapshot, eligibleTokens: observed, inputTokens: observed - 10 }), {
            current: () => workProfileLive,
          }),
        )
        if (input.operation === 'plugin-http-settle-local-work') settlementReplies++
        return result
      },
    } as never,
  })
  cleanups.push(async () => client.dispose())
  const localBinding = { ...binding, audience: 'local-wallet' as const }
  const enroll = async () => {
    const connected = await client.connectAccount(binding)
    if (connected.status !== 'accepted') throw new Error('original login failed')
    const enrolled = await client.enrollLocalWallet({
      binding: { ...binding, audience: 'local-wallet-enrollment' },
      connection: connected.value.connection,
    })
    await client.revoke(connected.value.connection)
    return enrolled
  }
  return {
    retireWorkProfile: () => {
      workProfileLive = false
    },
    diagnostics,
    home,
    retireTrustOnPostRead: (read: number) => {
      retireTrustAt = read
    },
    postTrustReads: () => postTrustReads,
    settlementReplies: () => settlementReplies,
    workChallengeStarted: () => workChallengeStarted,
    holdChallenge: (hold: Promise<void>) => {
      challengeHold = hold
    },
    permission: (allow: boolean) => {
      workLease = { allow }
      for (const changed of permissionListeners) changed()
    },
    workSettlement,
    badSettlementPolicy: () => {
      badSettlementPolicy = true
    },
    upsertHold: (kind: string, promise: Promise<void>) => {
      upsertKind = kind
      upsertHold = promise
    },
    upsertStarted: () => upsertStarted,
    upsertFinished: () => upsertFinished,
    retireAfterFence: () => {
      retireAfterFence = true
    },
    localFenceCalls: () => localFenceCalls,
    client,
    authority,
    transport,
    registry,
    keychain,
    secrets,
    seen,
    nativeRead,
    localBinding,
    enroll,
    hold: (value?: Promise<void>) => {
      hold = value
    },
    wrongAccount: (value = true) => {
      wrongAccount = value
    },
    native: (value: string | null) => {
      native = value
    },
    retire: () => {
      live = false
    },
    observed: (value: number) => {
      observed = value
    },
  }
}
it.each(['before transport', 'after body'] as const)(
  'fences local revocation committed during the awaited account check %s',
  async boundary => {
    const f = await fixture()
    expect(await f.enroll()).toMatchObject({ status: 'accepted' })
    const connected = await f.client.connectLocalAccount(f.localBinding)
    if (connected.status !== 'accepted') throw new Error('local connect failed')
    vi.useFakeTimers()
    // Model the registry revision becoming stale in the microtask between a
    // successful local check and its await continuation, without timer polling.
    const grants = (f.authority as unknown as {
      grants: Map<string, { localFence?: () => boolean }>
    }).grants
    const grant = grants.get(connected.value.connection.id)!
    let current = true, checks = 0, transported = false
    grant.localFence = () => {
      const matched = current
      if (
        (boundary === 'before transport' && ++checks === 2)
        || (boundary === 'after body' && transported)
      ) {
        queueMicrotask(() => {
          current = false
        })
      }
      return matched
    }
    f.transport.mockClear()
    f.transport.mockImplementationOnce(async () => {
      transported = true
      return Response.json({ privateResult: 'must not escape revoked grant' })
    })
    const result = await f.client.request({
      connection: connected.value.connection,
      method: 'POST',
      path: '/v1/exchange',
      body: '{}',
      deadline: Date.now() + 2000,
    })
    expect(f.transport).toHaveBeenCalledTimes(boundary === 'before transport' ? 0 : 1)
    expect(result).toEqual({ status: 'unavailable', code: 'aborted' })
  },
)
it('opens only an explicitly enrolled original balance and ledger without Native reads, with a persistent local key', async () => {
  const f = await fixture()
  expect(await f.client.connectLocalAccount(f.localBinding)).toEqual({
    status: 'unavailable',
    code: 'local-wallet-not-enrolled',
  })
  expect(f.nativeRead).not.toHaveBeenCalled()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  const retained = f.registry.read()!
  f.native(null)
  f.nativeRead.mockClear()
  const connected = await f.client.connectLocalAccount(f.localBinding)
  expect(connected.status).toBe('accepted')
  if (connected.status !== 'accepted') throw new Error('local connect failed')
  expect(connected.value.response.body).not.toContain('sessionToken')
  const me = await f.client.request({
    connection: connected.value.connection,
    method: 'GET',
    path: '/v1/me',
    deadline: Date.now() + 2000,
  })
  const ledger = await f.client.request({
    connection: connected.value.connection,
    method: 'GET',
    path: '/v1/ledger',
    deadline: Date.now() + 2000,
  })
  expect(me).toMatchObject({
    status: 'accepted',
    value: { body: JSON.stringify({ account: { id: 'original-account' }, available: 731, reserved: 9 }) },
  })
  expect(ledger).toMatchObject({
    status: 'accepted',
    value: { body: JSON.stringify({ entries: [{ id: 'original-ledger', amount: 731 }] }) },
  })
  expect(await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })).toMatchObject({
    status: 'accepted',
  })
  f.observed(150)
  expect(await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })).toMatchObject({
    status: 'accepted',
  })
  expect(f.seen.filter(p => p.audience === 'local-work-income').map(p => p.continuity)).toEqual([
    'baseline',
    'continuous',
  ])
  expect(f.nativeRead).not.toHaveBeenCalled()
  expect(f.registry.read()?.publicKey).toBe(retained.publicKey)
  expect(
    await f.client.retain(connected.value.connection, {
      sourceId: 'local',
      instanceId: binding.instanceId,
      audience: 'source-account',
      accountId: 'original-account',
    }),
  ).toMatchObject({ code: 'unsupported' })
  expect(f.nativeRead).not.toHaveBeenCalled()
})
it('refuses arbitrary bearer authority, caller-selected identity and retired original grant for enrollment', async () => {
  const f = await fixture()
  const connected = await f.client.connectAccount(binding)
  if (connected.status !== 'accepted') throw new Error('original login')
  expect(
    await f.client.enrollLocalWallet({
      binding: { ...binding, audience: 'local-wallet-enrollment', accountId: 'forged' } as never,
      connection: connected.value.connection,
    }),
  ).toMatchObject({ status: 'unavailable' })
  expect(f.registry.read()).toBeUndefined()
  f.native('other-native')
  expect(
    await f.client.enrollLocalWallet({
      binding: { ...binding, audience: 'local-wallet-enrollment' },
      connection: connected.value.connection,
    }),
  ).toMatchObject({ status: 'unavailable' })
  expect(f.seen.filter(p => p.contract === 'cordisx.local-wallet-enrollment/v1')).toHaveLength(0)
})
it('preserves submitted state on a wrong-account signed receipt and never reports it as unbound', async () => {
  const f = await fixture(), connected = await f.client.connectAccount(binding)
  if (connected.status !== 'accepted') throw new Error('original login')
  f.wrongAccount()
  expect(
    await f.client.enrollLocalWallet({
      binding: { ...binding, audience: 'local-wallet-enrollment' },
      connection: connected.value.connection,
    }),
  ).toMatchObject({ status: 'unavailable' })
  expect(f.registry.read()?.entries[0]?.status).toBe('submitted')
  expect(await f.client.connectLocalAccount(f.localBinding)).toEqual({
    status: 'unavailable',
    code: 'local-wallet-reconciliation-required',
  })
})
it('missing enrolled private key fails closed without recreating a key or attempting Native enrollment', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  const profile = f.registry.read()!
  f.secrets.delete(LOCAL_WALLET_KEYCHAIN_SERVICE + ':' + profile.keyRef)
  f.nativeRead.mockClear()
  expect(await f.client.connectLocalAccount(f.localBinding)).toMatchObject({ status: 'unavailable' })
  expect(f.registry.read()?.keyRef).toBe(profile.keyRef)
  expect(f.nativeRead).not.toHaveBeenCalled()
})
it('explicit local registry revoke retires parent and exchanged child grants without Native reads', async () => {
  const f = await fixture()
  await f.enroll()
  const connected = await f.client.connectLocalAccount(f.localBinding)
  if (connected.status !== 'accepted') throw new Error('local login')
  const exchanged = await f.client.exchange({
    connection: connected.value.connection,
    path: '/v1/exchange',
    body: '{}',
    credentialField: 'token',
    deadline: Date.now() + 2000,
  })
  if (exchanged.status !== 'accepted') throw new Error('local exchange')
  const profile = f.registry.read()!
  await f.registry.transition(profile, localWalletRealm(f.localBinding), 'revoked')
  f.nativeRead.mockClear()
  for (const connection of [connected.value.connection, exchanged.value.connection]) {
    expect(await f.client.request({ connection, method: 'GET', path: '/v1/me', deadline: Date.now() + 2000 }))
      .toMatchObject({ status: 'unavailable' })
  }
  expect(await f.client.connectLocalAccount(f.localBinding)).toEqual({
    status: 'unavailable',
    code: 'local-wallet-revoked',
  })
  expect(f.nativeRead).not.toHaveBeenCalled()
})
it('a late enrollment reply after client disposal never activates the delegation', async () => {
  const f = await fixture(), connected = await f.client.connectAccount(binding)
  if (connected.status !== 'accepted') throw new Error('original login')
  let release!: () => void
  f.hold(
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  const enrolling = f.client.enrollLocalWallet({
    binding: { ...binding, audience: 'local-wallet-enrollment' },
    connection: connected.value.connection,
  })
  await vi.waitFor(() => expect(f.registry.read()?.entries[0]?.status).toBe('submitted'))
  f.client.dispose()
  release()
  expect(await enrolling).toMatchObject({ status: 'unavailable' })
  expect(f.registry.read()?.entries[0]?.status).toBe('submitted')
})

it('unknown work acceptance clears continuity so the next observation starts a baseline', async () => {
  const f = await fixture()
  await f.enroll()
  expect(await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })).toMatchObject({
    status: 'accepted',
  })
  f.observed(150)
  f.wrongAccount()
  expect(await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })).toMatchObject({
    status: 'unavailable',
  })
  f.wrongAccount(false)
  f.observed(200)
  expect(await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })).toMatchObject({
    status: 'accepted',
  })
  expect(f.seen.filter(p => p.audience === 'local-work-income').map(p => p.continuity)).toEqual([
    'baseline',
    'continuous',
    'baseline',
  ])
})
it('local connection revoke clears work continuity without changing the persistent wallet', async () => {
  const f = await fixture()
  await f.enroll()
  const connected = await f.client.connectLocalAccount(f.localBinding)
  if (connected.status !== 'accepted') throw new Error('local connect')
  const key = f.registry.read()!.keyRef
  await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })
  await f.client.revoke(connected.value.connection)
  f.observed(150)
  await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })
  expect(f.seen.filter(p => p.audience === 'local-work-income').map(p => p.continuity)).toEqual([
    'baseline',
    'baseline',
  ])
  expect(f.registry.read()!.keyRef).toBe(key)
})
it('a local login result arriving after client disposal cannot create an exposed credential', async () => {
  const f = await fixture()
  await f.enroll()
  let release!: () => void
  f.hold(
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  const login = f.client.connectLocalAccount(f.localBinding)
  await vi.waitFor(() => expect(f.seen.some(p => p.contract === 'cordisx.local-wallet-assertion/v1')).toBe(true))
  f.client.dispose()
  release()
  expect(await login).toMatchObject({ status: 'unavailable' })
  expect([...f.secrets.values()]).not.toContain('local-session-secret')
  expect(f.registry.read()?.entries[0]?.status).toBe('active')
})

it('held local credential allocation shares the original deadline and cleans its exact late grant', async () => {
  const f = await fixture()
  await f.enroll()
  let release!: () => void
  f.upsertHold(
    'session',
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  vi.useFakeTimers()
  const login = f.client.connectLocalAccount(f.localBinding)
  await vi.waitFor(() => expect(f.upsertStarted()).toBe(true))
  await vi.advanceTimersByTimeAsync(15_001)
  expect(await login).toEqual({ status: 'unavailable', code: 'deadline-exceeded' })
  release()
  await vi.waitFor(() => expect(f.upsertFinished()).toBe(true))
  await vi.waitFor(() => expect([...f.secrets.values()]).not.toContain('local-session-secret'))
})
it('held first local key allocation after deadline leaves no late profile or retained signer', async () => {
  const f = await fixture(), connected = await f.client.connectAccount(binding)
  if (connected.status !== 'accepted') throw new Error('original login')
  let release!: () => void
  f.upsertHold(
    'key',
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  vi.useFakeTimers()
  const enrollment = f.client.enrollLocalWallet({
    binding: { ...binding, audience: 'local-wallet-enrollment' },
    connection: connected.value.connection,
  })
  await vi.waitFor(() => expect(f.upsertStarted()).toBe(true))
  await vi.advanceTimersByTimeAsync(15_001)
  expect(await enrollment).toEqual({ status: 'unavailable', code: 'deadline-exceeded' })
  release()
  await vi.waitFor(() => expect(f.upsertFinished()).toBe(true))
  await vi.waitFor(() =>
    expect([...f.secrets.keys()].some(key => key.startsWith(LOCAL_WALLET_KEYCHAIN_SERVICE + ':'))).toBe(false)
  )
  expect(f.registry.read()).toBeUndefined()
})
it('owner retirement queued by the final asynchronous fence prevents local POST dispatch', async () => {
  const f = await fixture()
  await f.enroll()
  f.retireAfterFence()
  expect(await f.client.connectLocalAccount(f.localBinding)).toMatchObject({ status: 'unavailable' })
  expect(f.localFenceCalls()).toBeGreaterThanOrEqual(2)
  expect(f.seen.filter(payload => payload.contract === 'cordisx.local-wallet-assertion/v1')).toHaveLength(0)
})
it('a queued work deadline cannot delete the active sibling observation continuity', async () => {
  const f = await fixture()
  await f.enroll()
  await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })
  let release!: () => void
  f.hold(
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  const running = f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })
  await vi.waitFor(() => expect(f.seen.filter(payload => payload.audience === 'local-work-income')).toHaveLength(2))
  const queued = await f.authority.handle({
    operation: 'plugin-http-submit-local-work',
    input: { ...f.localBinding, audience: 'local-work-income' },
    clientId: 'queued-work-client',
    token: issueOwnerDocumentPrincipalToken(secret, principal),
    managedDeadline: Date.now() + 30,
  }, async () => {
    throw new Error('Native must not be read')
  }, async () => snapshot)
  expect(queued).toEqual({ status: 'unavailable', code: 'deadline-exceeded' })
  f.hold()
  release()
  expect(await running).toMatchObject({ status: 'accepted' })
  await f.client.submitLocalWorkUsage({ ...f.localBinding, audience: 'local-work-income' })
  expect(f.seen.filter(payload => payload.audience === 'local-work-income').map(payload => payload.continuity)).toEqual(
    ['baseline', 'continuous', 'continuous'],
  )
})

it('a late expired enrollment Native null cannot retire a fresh healthy same-account sibling grant', async () => {
  const f = await fixture(), token = issueOwnerDocumentPrincipalToken(secret, principal)
  const invoke = (
    operation: string,
    input: unknown,
    clientId: string,
    account: () => Promise<string | null>,
    deadline = Date.now() + 15_000,
  ) =>
    f.authority.handle({ operation, input, clientId, token, managedDeadline: deadline }, account, async () => snapshot)
  const original = await invoke(
    'plugin-http-connect-account',
    binding,
    'expired-enrollment',
    async () => 'original-native',
  )
  if (original.status !== 'accepted') throw new Error('original connect')
  const originalConnection =
    (original.value as { connection: import('@cordisx/protocol/plugin-http/v1').HttpConnectionV1 }).connection
  let release!: () => void, started = false, returned = false
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  vi.useFakeTimers()
  const expired = invoke(
    'plugin-http-enroll-local-wallet',
    { binding: { ...binding, audience: 'local-wallet-enrollment' }, connection: originalConnection },
    'expired-enrollment',
    async () => {
      started = true
      await hold
      returned = true
      return null
    },
    Date.now() + 500,
  )
  await vi.waitFor(() => expect(started).toBe(true))
  await vi.advanceTimersByTimeAsync(501)
  expect(await expired).toEqual({ status: 'unavailable', code: 'deadline-exceeded' })
  const healthy = await invoke(
    'plugin-http-connect-account',
    binding,
    'healthy-sibling-client',
    async () => 'original-native',
  )
  if (healthy.status !== 'accepted') throw new Error('healthy connect: ' + JSON.stringify(healthy))
  const connection =
    (healthy.value as { connection: import('@cordisx/protocol/plugin-http/v1').HttpConnectionV1 }).connection
  release()
  await vi.waitFor(() => expect(returned).toBe(true))
  await Promise.resolve()
  await Promise.resolve()
  const me = await f.authority.handle({
    operation: 'plugin-http-request',
    token,
    clientId: 'healthy-sibling-client',
    connection,
    path: '/v1/me',
    method: 'GET',
    deadline: Date.now() + 2000,
    operationId: 'healthy-read',
  }, async () => 'original-native')
  expect(me).toMatchObject({ status: 'accepted' })
  expect(f.registry.read()).toBeUndefined()
})

it('settles a Host-private durable snapshot without Native, lease or baseline across a reconnect gap', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  f.native(null)
  f.nativeRead.mockClear()
  vi.useFakeTimers()
  const binding = { ...f.localBinding, audience: 'local-work-income' as const }
  expect(f.client.contract).toBe('cordisx.http-client/v4')
  expect(f.workSettlement.contract).toBe('cordisx.local-work-settlement/v1')
  expect(await f.workSettlement.settle(binding)).toMatchObject({ status: 'accepted' })
  await vi.advanceTimersByTimeAsync(20_000)
  f.observed(11_000)
  expect(await f.workSettlement.settle(binding)).toMatchObject({ status: 'accepted' })
  const submitted = f.seen.filter(p => p.contract === 'cordisx.local-work-settlement/v1')
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toMatchObject({ snapshot: { eligibleTokens: 11_000 } })
  for (const payload of submitted) {
    expect(payload).not.toHaveProperty('leaseId')
    expect(payload).not.toHaveProperty('continuity')
    expect(payload).not.toHaveProperty('baseline')
  }
  expect(f.transport.mock.calls.some(([url]) => String(url).endsWith('/v1/income/work/settle'))).toBe(true)
  expect(f.nativeRead).not.toHaveBeenCalled()
})
it.each(['baseline', 'snapshot', 'amount', 'cursor', 'accountId', 'leaseId'])(
  'rejects caller-selected settlement %s before POST',
  async name => {
    const f = await fixture()
    expect(await f.enroll()).toMatchObject({ status: 'accepted' })
    const before = f.seen.length
    expect(await f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income', [name]: true } as never))
      .toMatchObject({ status: 'unavailable' })
    expect(f.seen).toHaveLength(before)
  },
)
it('rejects a signed settlement receipt from a different financial policy', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  f.badSettlementPolicy()
  expect(await f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' }))
    .toMatchObject({ status: 'unavailable' })
})
it('retiring the shared HTTP client rejects settlement and discards its late response', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  let release!: () => void
  f.hold(
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  const pending = f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' })
  await vi.waitFor(() => expect(f.seen.some(p => p.contract === 'cordisx.local-work-settlement/v1')).toBe(true))
  f.client.dispose()
  release()
  expect(await pending).toMatchObject({ status: 'unavailable' })
  const before = f.seen.length
  expect(await f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' }))
    .toMatchObject({ status: 'unavailable', code: 'stale-generation' })
  expect(f.seen).toHaveLength(before)
})

it('settlement requires usage authorization even when no permission callback is provided', async () => {
  const request = vi.fn()
  const { workSettlement } = createPluginHttpClients({
    active: () => true,
    principal: {} as never,
    bridge: { request } as never,
  })
  expect(await workSettlement.settle({ ...binding, audience: 'local-work-income' }))
    .toMatchObject({ status: 'unavailable', code: 'denied' })
  expect(request).not.toHaveBeenCalled()
})
it('settlement permission wait consumes the original attempt deadline', async () => {
  vi.useFakeTimers()
  let authorize!: (value: boolean) => void
  const request = vi.fn(), subscribe = vi.fn(() => () => {})
  const { workSettlement } = createPluginHttpClients({
    active: () => true,
    principal: {} as never,
    bridge: { request } as never,
    subscribeWorkPermission: subscribe,
    authorizeWork: () =>
      new Promise<boolean>(resolve => {
        authorize = resolve
      }),
  })
  const pending = workSettlement.settle({ ...binding, audience: 'local-work-income' })
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await pending).toMatchObject({ status: 'unavailable', code: 'deadline-exceeded' })
  authorize(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(request).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
})

it('permission retirement during a held challenge prevents POST and regrant cannot revive that attempt', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  let release!: () => void
  f.holdChallenge(
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  const pending = f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' })
  await vi.waitFor(() => expect(f.workChallengeStarted()).toBe(true))
  f.permission(false)
  expect(await pending).toMatchObject({ status: 'unavailable', code: 'denied' })
  f.permission(true)
  release()
  await vi.waitFor(() => expect(f.settlementReplies()).toBe(1))
  expect(f.seen.filter(p => p.contract === 'cordisx.local-work-settlement/v1')).toHaveLength(0)
  expect(await f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' }))
    .toMatchObject({ status: 'accepted' })
})
it('permission retirement rejects a late settlement response while local balance remains usable', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  let release!: () => void
  f.hold(
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  const pending = f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' })
  await vi.waitFor(() => expect(f.seen.some(p => p.contract === 'cordisx.local-work-settlement/v1')).toBe(true))
  f.permission(false)
  expect(await pending).toMatchObject({ status: 'unavailable', code: 'denied' })
  f.permission(true)
  release()
  f.hold()
  expect(await f.client.connectLocalAccount(f.localBinding)).toMatchObject({ status: 'accepted' })
  expect(await f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' })).toMatchObject({
    status: 'accepted',
  })
})
it('work profile retirement rejects a late signed settlement without retiring balance', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  let release!: () => void
  f.hold(
    new Promise<void>(resolve => {
      release = resolve
    }),
  )
  const pending = f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' })
  await vi.waitFor(() => expect(f.seen.some(p => p.contract === 'cordisx.local-work-settlement/v1')).toBe(true))
  f.retireWorkProfile()
  release()
  f.hold()
  expect(await pending).toMatchObject({ status: 'unavailable' })
  const sent = f.seen.filter(p => p.contract === 'cordisx.local-work-settlement/v1').length
  expect(await f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' }))
    .toMatchObject({ status: 'unavailable' })
  expect(f.seen.filter(p => p.contract === 'cordisx.local-work-settlement/v1')).toHaveLength(sent)
  expect(await f.client.connectLocalAccount(f.localBinding)).toMatchObject({ status: 'accepted' })
})
it('durable custody excludes both leased local and Native work channels without affecting balance', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  const income = { ...f.localBinding, audience: 'local-work-income' as const }
  expect(await f.workSettlement.settle(income)).toMatchObject({ status: 'accepted' })
  const before = f.seen.length
  expect(await f.client.submitLocalWorkUsage({ ...income, baseline: true })).toMatchObject({ status: 'unavailable' })
  expect(await f.client.submitWorkUsage({ ...binding, audience: 'work-income', baseline: true })).toMatchObject({
    status: 'unavailable',
  })
  expect(f.seen).toHaveLength(before)
  expect(await f.client.connectLocalAccount(f.localBinding)).toMatchObject({ status: 'accepted' })
})

it('rechecks the original trust tuple after the final inner guard before publishing a settlement', async () => {
  const f = await fixture()
  expect(await f.enroll()).toMatchObject({ status: 'accepted' })
  vi.useFakeTimers()
  f.retireTrustOnPostRead(4)
  expect(await f.workSettlement.settle({ ...f.localBinding, audience: 'local-work-income' })).toMatchObject({
    status: 'unavailable',
  })
  expect(f.postTrustReads()).toBe(4)
})
