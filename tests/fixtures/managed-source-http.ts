import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { vi } from 'vitest'
import { managedSourceBytes } from '@cordisx/protocol/managed-source/v1'
import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import { PluginHttpAuthority } from '../../packages/cli/src/launcher/plugin-http-authority.js'
import type { PluginHttpDiagnostic } from '../../packages/cli/src/launcher/plugin-http-diagnostics.js'
import { issueOwnerDocumentPrincipalToken } from '../../packages/cli/src/launcher/owner-document-rpc.js'
import { MANAGED_SOURCE_KEYCHAIN_SERVICE } from '../../packages/cli/src/launcher/managed-source-authority.js'
export const secret = 'test-only-owner-secret'
export const owner = { pluginId: 'wallet', source: 'file:///wallet.ts' }
export const principal = { profileId: 'test', generation: 'g1', moduleGeneration: 'm1', identity: owner }
export const origin = 'http://127.0.0.1:30123'
export const binding = { origin, sourceId: 'local', instanceId: 'formal', audience: 'source-account' as const }
export const snapshot: WorkUsageSnapshotV2 = {
  schemaVersion: 2,
  status: 'ready',
  scopeId: 'scope',
  sourceId: 'rollouts',
  epoch: 'epoch',
  revision: 1,
  policyId: 'codex-local-work-input-output-v2',
  eligibleTokens: 100,
  inputTokens: 90,
  outputTokens: 10,
  enabledAt: 1,
  observedThrough: 2,
  coverage: 'partial',
  diagnostics: [],
  classification: {
    version: 'host-game-cwd-v1',
    hostGameTasks: 'excluded',
    forksAndSubagents: 'excluded',
    unknownSources: 'excluded',
  },
}
export function managedSourceFixture(
  cleanups: (() => Promise<void>)[],
  onDiagnostic?: (event: PluginHttpDiagnostic) => void,
) {
  const host = generateKeyPairSync('ed25519'),
    server = generateKeyPairSync('ed25519'),
    ref = randomBytes(32).toString('base64url')
  const stored = new Map([[
    `${MANAGED_SOURCE_KEYCHAIN_SERVICE}:${ref}`,
    host.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  ]])
  let account: string | null = JSON.stringify(['account-A', 'user-A']), live = true
  let hold: Promise<void> | undefined, wrongResult = false, wrongChallenge = false, workReads = 0
  let workSnapshot = snapshot, holdBearer: Promise<void> | undefined, trustHold: Promise<void> | undefined
  let trustAt = 0, trustCalls = 0, bearerReads = 0, trustsEnabled = true
  let accountCalls = 0,
    accountAt = 0,
    accountHold: Promise<void> | undefined,
    captureAccountAt = 0,
    accountUnavailable = false
  let signerReads = 0, signerAt = 0, signerHold: Promise<void> | undefined
  const seen: { path: string; body?: Record<string, unknown>; authorization?: string | null }[] = []
  const signResult = (payload: unknown) => ({
    payload,
    signature: sign(null, managedSourceBytes(payload), server.privateKey).toString('base64url'),
  })
  const transport = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(raw)), headers = new Headers(init?.headers)
    if (url.pathname === '/v1/auth/host/challenge') {
      const payload = {
        ...binding,
        audience: url.searchParams.get('audience'),
        contract: 'cordisx.managed-source-challenge/v1',
        nonce: randomBytes(32).toString('base64url'),
        expiresAt: Date.now() + 20_000,
      }
      seen.push({ path: url.pathname })
      return Response.json(signResult(wrongChallenge ? { ...payload, instanceId: 'fake' } : payload))
    }
    if (['/v1/me', '/v1/ledger'].includes(url.pathname)) {
      seen.push({ path: url.pathname, authorization: headers.get('authorization') })
      return Response.json(url.pathname === '/v1/me' ? { balance: 0 } : { entries: [] })
    }
    if (url.pathname === '/v1/exchange') {
      seen.push({ path: url.pathname, authorization: headers.get('authorization') })
      return Response.json({ token: 'test-child-secret' })
    }
    const body = JSON.parse(String(init?.body)).payload as Record<string, unknown>
    seen.push({ path: url.pathname, body, authorization: headers.get('authorization') })
    await hold
    const result = url.pathname === '/v1/income/work'
      ? { receipt: { amount: 0 } }
      : { sessionToken: 'test-source-secret', instanceId: binding.instanceId, account: { id: 'canonical-account' } }
    return Response.json(
      signResult({
        ...binding,
        audience: body.audience,
        contract: 'cordisx.managed-source-result/v1',
        nonce: body.nonce,
        subject: wrongResult ? 'wrong-subject' : body.subject,
        result,
      }),
    )
  })
  const keychain = {
    read: async (service: string, key: string) => {
      const value = stored.get(`${service}:${key}`)
      if (!value) throw new Error()
      if (service === MANAGED_SOURCE_KEYCHAIN_SERVICE) {
        signerReads++
        if (signerReads === signerAt) await signerHold
      }
      if (service.startsWith('cordisx/http/')) {
        bearerReads++
        await holdBearer
      }
      return value
    },
    upsert: async (service: string, key: string, value: string) => {
      stored.set(`${service}:${key}`, value)
    },
    remove: async (service: string, key: string) => {
      stored.delete(`${service}:${key}`)
    },
    status: async (service: string, key: string) => stored.has(`${service}:${key}`) ? 'set' as const : 'unset' as const,
  }
  const fixtureHome = mkdtempSync(path.join(tmpdir(), 'managed-work-custody-'))
  const authority = new PluginHttpAuthority({
    localWalletHomeDir: fixtureHome,
    onDiagnostic,
    secret,
    profileId: 'test',
    generation: 'g1',
    keychain,
    principalAllowed: () => live,
    fetch: transport as typeof fetch,
    managedSourcesNow: () =>
      !trustsEnabled ? [] : ['source-account', 'work-income'].map(audience => ({
        binding: { ...binding, audience: audience as 'source-account' | 'work-income' },
        owner,
        serverPublicKey: server.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        signingKeyRef: ref,
      })),
    managedSources: async () => {
      trustCalls++
      if (trustCalls === trustAt) await trustHold
      return !trustsEnabled ? [] : ['source-account', 'work-income'].map(audience => ({
        binding: { ...binding, audience: audience as 'source-account' | 'work-income' },
        owner,
        serverPublicKey: server.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        signingKeyRef: ref,
      }))
    },
  })
  cleanups.push(async () => {
    await authority.dispose()
    await rm(fixtureHome, { recursive: true, force: true })
  })
  const invoke = (operation: string, input: unknown, p = principal, deadline = Date.now() + 15_000) =>
    authority.handle({
      operation,
      input,
      managedDeadline: deadline,
      token: issueOwnerDocumentPrincipalToken(secret, p),
    }, async () => {
      accountCalls++
      if (accountUnavailable) throw new Error('native adapter unavailable')
      const captured = account, capture = accountCalls === captureAccountAt
      if (accountCalls === accountAt) await accountHold
      return capture ? captured : account
    }, async () => {
      workReads++
      return workSnapshot
    })
  return {
    authority,
    invoke,
    seen,
    stored,
    keychain,
    account: (a: string | null) => {
      account = a
    },
    retire: () => {
      live = false
    },
    hold: (p?: Promise<void>) => {
      hold = p
    },
    wrongResult: () => {
      wrongResult = true
    },
    wrongChallenge: () => {
      wrongChallenge = true
    },
    reads: () => workReads,
    usage: (s: WorkUsageSnapshotV2) => {
      workSnapshot = s
    },
    holdBearer: (p: Promise<void>) => {
      holdBearer = p
    },
    bearerReads: () => bearerReads,
    holdTrustAt: (at: number, p: Promise<void>) => {
      trustAt = at
      trustHold = p
    },
    trustCalls: () => trustCalls,
    accountCalls: () => accountCalls,
    nativeUnavailable: (value: boolean) => {
      accountUnavailable = value
    },
    captureAccountAt: (at: number, p: Promise<void>) => {
      captureAccountAt = accountAt = at
      accountHold = p
    },
    holdSignerAt: (at: number, p: Promise<void>) => {
      signerAt = at
      signerHold = p
    },
    signerReads: () => signerReads,
    holdAccountAt: (at: number, p: Promise<void>) => {
      accountAt = at
      accountHold = p
    },
    trusts: (enabled: boolean) => {
      trustsEnabled = enabled
    },
  }
}
