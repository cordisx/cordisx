import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LauncherKeychainError } from '../packages/cli/src/launcher/secret-store.js'
import {
  canonicalPublisherGrantSigningInput,
  CORDISX_PUBLISHER_GRANT_SCHEMA_V1,
  type DeviceKeyProvider,
  devicePublicKeyHash,
  DirectPublisherGrantAuthority,
  DirectPublisherGrantStore,
  evaluatePublisherGrantTime,
  MacOSMachineIdentityProvider,
  parsePublisherGrantStatement,
  PublisherGrantLifecycleGate,
  type PublisherGrantStatement,
  publisherGrantVersionMatches,
  type PublisherKeyRegistry,
  type TrustedTimeStore,
  verifyPublisherGrantStatement,
} from '../packages/cli/src/launcher/publisher-grants.js'

const publisher = generateKeyPairSync('ed25519')
const device = generateKeyPairSync('ed25519')
const devicePublicKey = device.publicKey.export({ type: 'spki', format: 'der' })
const issuer = { id: 'example.publisher', keyId: 'live-2026-01', environment: 'live' as const }

function statement(overrides: Partial<Record<string, unknown>> = {}): PublisherGrantStatement {
  const unsigned = {
    $schema: CORDISX_PUBLISHER_GRANT_SCHEMA_V1,
    schemaVersion: 1 as const,
    kind: 'grant' as const,
    issuer,
    statementId: 'grant-000000000001',
    issuedAt: '2026-08-26T00:00:00Z',
    payload: {
      grantId: 'grant-000000000001',
      pluginId: 'example.paid-plugin',
      offerId: 'pro-annual',
      devicePublicKeyHash: devicePublicKeyHash(devicePublicKey),
      nonce: '0123456789abcdefghijklmnopqrstuv',
      notBefore: '2026-08-26T00:00:00Z',
      expiresAt: '2026-09-25T00:00:00Z',
      refreshAfter: '2026-09-18T00:00:00Z',
      offlineGraceSeconds: 604800,
      versionRange: '>=1.0.0 <2.0.0',
      features: ['sync', 'export'],
    },
    ...overrides,
  }
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519',
      value: sign(
        null,
        canonicalPublisherGrantSigningInput(unsigned as Omit<PublisherGrantStatement, 'signature'>),
        publisher.privateKey,
      ).toString('base64url'),
    },
  } as PublisherGrantStatement
}

const keys: PublisherKeyRegistry = {
  async resolve(input) {
    return input.id === issuer.id && input.keyId === issuer.keyId && input.environment === issuer.environment
      ? publisher.publicKey
      : undefined
  },
}
const devices: DeviceKeyProvider = {
  async current() {
    return {
      keyId: 'host-device-key-1',
      publicKey: devicePublicKey,
      async sign(input) {
        return sign(null, input, device.privateKey)
      },
    }
  },
}
const target = { pluginId: 'example.paid-plugin', version: '1.2.3' }

function clock(initial?: string): TrustedTimeStore & { state: { lastTrustedAt?: string } } {
  const state: { lastTrustedAt?: string } = { lastTrustedAt: initial }
  return {
    state,
    async read() {
      return { ...state }
    },
    async write(value) {
      state.lastTrustedAt = value.lastTrustedAt
    },
  }
}

describe('PublisherGrant launcher gate', () => {
  it('verifies a Host-registered issuer key and rejects altered claims', async () => {
    const valid = statement()
    await expect(verifyPublisherGrantStatement(valid, keys)).resolves.toMatchObject({ kind: 'grant', issuer })
    await expect(
      verifyPublisherGrantStatement(
        { ...valid, payload: { ...valid.payload as object, pluginId: 'other.plugin' } },
        keys,
      ),
    ).rejects.toThrow('signature')
  })

  it('rejects unknown fields, invalid timing, and self-transfers before key use', () => {
    const valid = statement()
    expect(() => parsePublisherGrantStatement({ ...valid, extra: true })).toThrow('unsupported')
    expect(() =>
      parsePublisherGrantStatement({
        ...valid,
        payload: { ...valid.payload as object, refreshAfter: '2026-10-01T00:00:00Z' },
      })
    ).toThrow('timing')
    expect(() =>
      parsePublisherGrantStatement({
        ...valid,
        kind: 'transfer',
        payload: {
          grantId: 'grant-000000000001',
          fromDevicePublicKeyHash: devicePublicKeyHash(devicePublicKey),
          toDevicePublicKeyHash: devicePublicKeyHash(devicePublicKey),
          nonce: '0123456789abcdefghijklmnopqrstuv',
          notBefore: '2026-08-26T00:00:00Z',
          expiresAt: '2026-08-27T00:00:00Z',
        },
      })
    ).toThrow('transfer')
  })

  it('uses a non-decreasing trusted clock and only permits bounded offline grace', () => {
    const grant = statement().payload as Extract<PublisherGrantStatement['payload'], { readonly expiresAt: string }>
    expect(
      evaluatePublisherGrantTime(grant, { lastTrustedAt: '2026-09-20T00:00:00Z' }, new Date('2026-09-01T00:00:00Z')),
    ).toMatchObject({ state: 'active', clockRollbackDetected: true })
    expect(
      evaluatePublisherGrantTime(grant, { lastTrustedAt: '2026-09-26T00:00:00Z' }, new Date('2026-09-26T00:00:00Z')),
    ).toMatchObject({ state: 'grace' })
    expect(
      evaluatePublisherGrantTime(grant, { lastTrustedAt: '2026-10-03T00:00:01Z' }, new Date('2026-10-03T00:00:01Z')),
    ).toMatchObject({ state: 'expired' })
  })

  it('matches only auditable SemVer ranges and Host-resolved plugin targets', () => {
    expect(publisherGrantVersionMatches('>=1.0.0 <2.0.0', '1.2.3')).toBe(true)
    expect(publisherGrantVersionMatches('>=1.0.0 <2.0.0', '2.0.0')).toBe(false)
    expect(publisherGrantVersionMatches('^1.0.0', '1.2.3')).toBe(false)
  })

  it('accepts a pre-bound direct grant without a registry and still rejects registry conflicts when selected', async () => {
    const direct = new PublisherGrantLifecycleGate(keys, devices, clock())
    await expect(direct.activate(statement(), target, new Date('2026-08-27T00:00:00Z'))).resolves.toEqual({
      state: 'activated',
      features: ['sync', 'export'],
    })
    const boundElsewhere = new PublisherGrantLifecycleGate(keys, devices, clock(), {
      async activate() {
        return { status: 'bound-to-other-device' as const }
      },
    })
    await expect(boundElsewhere.activate(statement(), target, new Date('2026-08-27T00:00:00Z'))).resolves.toEqual({
      state: 'rejected',
      features: [],
    })
  })

  it('uses proof of possession, persists only registry-attested time, and projects features after atomic activation', async () => {
    const trusted = clock()
    let request: { proof: string; nonce: string; devicePublicKeyHash: string } | undefined
    const gate = new PublisherGrantLifecycleGate(keys, devices, trusted, {
      async activate(input) {
        request = input
        return { status: 'activated', trustedAt: '2026-08-27T00:00:00Z' }
      },
    })
    await expect(gate.activate(statement(), target, new Date('2026-08-27T00:00:00Z'))).resolves.toEqual({
      state: 'activated',
      features: ['sync', 'export'],
    })
    expect(request).toMatchObject({
      nonce: '0123456789abcdefghijklmnopqrstuv',
      devicePublicKeyHash: devicePublicKeyHash(devicePublicKey),
    })
    expect(request?.proof).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(trusted.state.lastTrustedAt).toBe('2026-08-27T00:00:00.000Z')
  })

  it('keeps one machine identity outside home-scoped direct grant records and rejects copied grants on another key', async () => {
    const values = new Map<string, string>()
    const backend = {
      async read(service: string, account: string) {
        const value = values.get(`${service}:${account}`)
        if (value === undefined) throw new LauncherKeychainError('MISSING')
        return value
      },
      async upsert(service: string, account: string, value: string) {
        values.set(`${service}:${account}`, value)
      },
      async remove() {},
      async status() {
        return 'set' as const
      },
    }
    const identity = new MacOSMachineIdentityProvider({ platform: 'darwin', backend })
    const first = await identity.current()
    const second = await identity.current()
    expect(first?.publicKey).toEqual(second?.publicKey)
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-direct-grant-'))
    try {
      const authority = new DirectPublisherGrantAuthority(
        keys,
        devices,
        await DirectPublisherGrantStore.open(path.join(root, 'one')),
      )
      await expect(authority.import(statement())).resolves.toMatchObject({
        status: 'authorized',
        grantId: 'grant-000000000001',
      })
      await expect(authority.status(target, new Date('2026-08-27T00:00:00Z'))).resolves.toMatchObject({
        status: 'authorized',
        features: ['sync', 'export'],
      })
      const foreign = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })
      const foreignGrant = statement({
        payload: { ...(statement().payload as object), devicePublicKeyHash: devicePublicKeyHash(foreign) },
      })
      await expect(authority.import(foreignGrant)).resolves.toEqual({ status: 'device-mismatch', features: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
