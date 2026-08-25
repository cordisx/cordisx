import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createMacOSKeychainBackend, LauncherKeychainError, type LauncherKeychainBackend } from './secret-store.js'

export const CORDISX_PUBLISHER_GRANT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/publisher-grant.v1.schema.json' as const

type StatementKind = 'grant' | 'renew' | 'revoke' | 'transfer'
type Environment = 'sandbox' | 'live'

export interface PublisherIssuer { readonly id: string; readonly keyId: string; readonly environment: Environment }
export interface PublisherGrantAuthorization {
  readonly grantId: string; readonly pluginId: string; readonly offerId: string; readonly devicePublicKeyHash: string; readonly nonce: string
  readonly notBefore: string; readonly expiresAt: string; readonly refreshAfter: string; readonly offlineGraceSeconds: number; readonly versionRange: string; readonly features: readonly string[]
}
export interface PublisherGrantStatement {
  readonly $schema: typeof CORDISX_PUBLISHER_GRANT_SCHEMA_V1; readonly schemaVersion: 1; readonly kind: StatementKind; readonly issuer: PublisherIssuer; readonly statementId: string; readonly issuedAt: string
  readonly payload: PublisherGrantAuthorization | { readonly grantId: string; readonly effectiveAt: string; readonly reason?: string } | { readonly grantId: string; readonly fromDevicePublicKeyHash: string; readonly toDevicePublicKeyHash: string; readonly nonce: string; readonly notBefore: string; readonly expiresAt: string }
  readonly signature: { readonly algorithm: 'Ed25519'; readonly value: string }
}

/** Host registration is the sole source of active issuer keys; sandbox and live are separate. */
export interface PublisherKeyRegistry { resolve(input: PublisherIssuer): Promise<KeyObject | undefined> }
/** Explicit Host registration; Marketplace metadata never supplies signing keys. */
export interface PublisherRegisteredKey extends PublisherIssuer { readonly publicKeySpki: string }
export class StaticPublisherKeyRegistry implements PublisherKeyRegistry {
  private readonly keys = new Map<string, KeyObject>()
  constructor(entries: readonly PublisherRegisteredKey[]) {
    for (const entry of entries) {
      const key = `${entry.environment}:${entry.id}:${entry.keyId}`
      if (this.keys.has(key)) throw new Error(`duplicate PublisherGrant issuer key registration: ${key}`)
      this.keys.set(key, createPublicKey({ key: Buffer.from(entry.publicKeySpki, 'base64url'), format: 'der', type: 'spki' }))
    }
  }
  async resolve(input: PublisherIssuer): Promise<KeyObject | undefined> { return this.keys.get(`${input.environment}:${input.id}:${input.keyId}`) }
}
export interface DeviceKeyIdentity {
  readonly keyId: string
  /** DER SubjectPublicKeyInfo bytes; this is not a hardware serial or fingerprint. */
  readonly publicKey: Uint8Array
  /** Hardware/secure-store implementations retain private material outside the renderer. */
  sign(input: Uint8Array): Promise<Uint8Array>
}
/** No local-file fallback: loss/reinstall means a new device and needs a publisher transfer. */
export interface DeviceKeyProvider { current(): Promise<DeviceKeyIdentity | undefined> }
export interface PublisherGrantActivationRequest {
  readonly issuer: PublisherIssuer; readonly grantId: string; readonly pluginId: string; readonly devicePublicKeyHash: string; readonly devicePublicKey: string; readonly nonce: string; readonly proof: string; readonly idempotencyKey: string
}
export interface PublisherGrantActivationResponse { readonly status: 'activated' | 'already-activated' | 'bound-to-other-device' | 'rejected' | 'unavailable'; readonly trustedAt?: string }
/** Service data is limited to issuer/grant -> plugin/device hash/status and idempotency/environment state. */
export interface PublisherGrantActivationRegistry { activate(input: PublisherGrantActivationRequest): Promise<PublisherGrantActivationResponse> }
export interface TrustedTimeState { readonly lastTrustedAt?: string }
export interface TrustedTimeStore { read(): Promise<TrustedTimeState>; write(value: TrustedTimeState): Promise<void> }
/** The package/lifecycle owner supplies this Host-resolved target; never trust a renderer plugin id. */
export interface PublisherGrantTarget { readonly pluginId: string; readonly version: string; readonly requestedFeatures?: readonly string[] }
export type PublisherGrantDecision =
  | { readonly state: 'active' | 'grace'; readonly effectiveNow: string; readonly refreshDue: boolean; readonly clockRollbackDetected: boolean }
  | { readonly state: 'not-yet-valid' | 'expired' | 'invalid'; readonly effectiveNow?: string; readonly reason: string }

const MACHINE_IDENTITY_SERVICE = 'cordisx/machine-identity/v1'
const MACHINE_IDENTITY_ACCOUNT = 'ed25519-pkcs8'
const DIRECT_STATE_CONTRACT = 'cordisx.publisher-grants/direct-device-bound/v1'

/** macOS Keychain-backed machine key. Its location deliberately does not contain CORDISX_HOME. */
export class MacOSMachineIdentityProvider implements DeviceKeyProvider {
  private readonly backend: LauncherKeychainBackend | undefined
  constructor(options: { readonly platform?: NodeJS.Platform; readonly backend?: LauncherKeychainBackend } = {}) {
    this.backend = (options.platform ?? process.platform) === 'darwin' ? (options.backend ?? createMacOSKeychainBackend()) : undefined
  }
  async current(): Promise<DeviceKeyIdentity | undefined> {
    if (this.backend === undefined) return undefined
    let serialized: string
    try {
      serialized = await this.backend.read(MACHINE_IDENTITY_SERVICE, MACHINE_IDENTITY_ACCOUNT)
    } catch (error) {
      if (!(error instanceof LauncherKeychainError) || error.code !== 'MISSING') return undefined
      const pair = generateKeyPairSync('ed25519')
      serialized = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      try { await this.backend.upsert(MACHINE_IDENTITY_SERVICE, MACHINE_IDENTITY_ACCOUNT, serialized) } catch { return undefined }
    }
    try {
      const privateKey = createPrivateKey(serialized)
      const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
      return Object.freeze({
        keyId: devicePublicKeyHash(publicKey).slice('sha256:'.length, 32),
        publicKey,
        async sign(input: Uint8Array) { return sign(null, input, privateKey) },
      })
    } catch { return undefined }
  }
}

export interface DeviceChallenge {
  readonly schemaVersion: 1
  readonly devicePublicKey: string
  readonly devicePublicKeyHash: string
  readonly nonce: string
  readonly issuedAt: string
  readonly proof: string
}

/** Publisher-safe public data. The private key stays inside the machine identity provider. */
export async function createDeviceChallenge(provider: DeviceKeyProvider, now = new Date()): Promise<DeviceChallenge> {
  const device = await provider.current()
  if (device === undefined) throw new Error('a machine identity key is unavailable')
  const digest = devicePublicKeyHash(device.publicKey)
  const unsigned = { schemaVersion: 1 as const, devicePublicKey: Buffer.from(device.publicKey).toString('base64url'), devicePublicKeyHash: digest, nonce: randomBytes(32).toString('base64url'), issuedAt: now.toISOString() }
  return Object.freeze({ ...unsigned, proof: Buffer.from(await device.sign(Buffer.from(JSON.stringify(unsigned), 'utf8'))).toString('base64url') })
}

interface DirectGrantRecord { readonly statement: PublisherGrantStatement; readonly importedAt: string; readonly revokedAt?: string }
interface DirectGrantState { readonly contract: typeof DIRECT_STATE_CONTRACT; readonly revision: number; readonly lastTrustedAt?: string; readonly statements: Readonly<Record<string, string>>; readonly grants: Readonly<Record<string, DirectGrantRecord>> }
export type DirectPublisherGrantStatus = 'authorized' | 'refresh-due' | 'grace' | 'expired' | 'not-yet-valid' | 'revoked' | 'device-mismatch' | 'unavailable'
export interface DirectPublisherGrantProjection { readonly status: DirectPublisherGrantStatus; readonly grantId?: string; readonly features: readonly string[]; readonly expiresAt?: string; readonly refreshAfter?: string }

function grantRecordKey(statement: PublisherGrantStatement, grantId: string): string { return `${statement.issuer.environment}:${statement.issuer.id}:${grantId}` }
function directInitial(): DirectGrantState { return { contract: DIRECT_STATE_CONTRACT, revision: 0, statements: {}, grants: {} } }
function storedTime(previous: string | undefined, statement: PublisherGrantStatement): string | undefined {
  const candidate = Date.parse(statement.issuedAt)
  const prior = previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous)
  return candidate > prior ? new Date(candidate).toISOString() : previous
}

/** Home-scoped signed-statement state; never stores the machine private key. */
export class DirectPublisherGrantStore implements TrustedTimeStore {
  private readonly file: string
  private tail: Promise<void> = Promise.resolve()
  private constructor(readonly homeDir: string) { this.file = path.join(homeDir, 'state', 'publisher-grants', 'direct-device-bound.v1.json') }
  static async open(homeDir: string): Promise<DirectPublisherGrantStore> {
    const store = new DirectPublisherGrantStore(homeDir)
    await mkdir(path.dirname(store.file), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(path.dirname(store.file), 0o700)
    try { await store.readState() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await store.writeState(directInitial()) }
    return store
  }
  async read(): Promise<TrustedTimeState> { const state = await this.readState(); return state.lastTrustedAt === undefined ? {} : { lastTrustedAt: state.lastTrustedAt } }
  async write(value: TrustedTimeState): Promise<void> { await this.update(state => ({ ...state, ...(value.lastTrustedAt === undefined ? {} : { lastTrustedAt: value.lastTrustedAt }) })) }
  async import(statement: PublisherGrantStatement): Promise<void> {
    const fingerprint = createHash('sha256').update(JSON.stringify(statement)).digest('hex')
    await this.update(state => {
      const known = state.statements[statement.statementId]
      if (known !== undefined && known !== fingerprint) throw new Error('PublisherGrant statementId replay differs from the accepted statement')
      const statements = { ...state.statements, [statement.statementId]: fingerprint }
      if (statement.kind === 'transfer') throw new Error('transfer requires a publisher-signed grant for the new device')
      if (statement.kind === 'revoke') {
        const payload = statement.payload as { readonly grantId: string; readonly effectiveAt: string }
        const key = grantRecordKey(statement, payload.grantId)
        const current = state.grants[key]
        const lastTrustedAt = storedTime(state.lastTrustedAt, statement)
        return { ...state, revision: state.revision + 1, ...(lastTrustedAt === undefined ? {} : { lastTrustedAt }), statements, grants: current === undefined ? state.grants : { ...state.grants, [key]: { ...current, revokedAt: payload.effectiveAt } } }
      }
      const grant = grantPayload(statement)
      const key = grantRecordKey(statement, grant.grantId)
      const lastTrustedAt = storedTime(state.lastTrustedAt, statement)
      return { ...state, revision: state.revision + 1, ...(lastTrustedAt === undefined ? {} : { lastTrustedAt }), statements, grants: { ...state.grants, [key]: { statement, importedAt: new Date().toISOString() } } }
    })
  }
  async records(): Promise<readonly DirectGrantRecord[]> { return Object.values((await this.readState()).grants) }
  private async readState(): Promise<DirectGrantState> {
    const meta = await lstat(this.file)
    if (!meta.isFile() || meta.isSymbolicLink()) throw new Error('PublisherGrant state must be a regular file')
    const value = JSON.parse(await readFile(this.file, 'utf8')) as DirectGrantState
    if (value.contract !== DIRECT_STATE_CONTRACT || !Number.isInteger(value.revision) || value.statements === null || value.grants === null) throw new Error('PublisherGrant state is invalid')
    return value
  }
  private async update(mutate: (state: DirectGrantState) => DirectGrantState): Promise<void> {
    const previous = this.tail.catch(() => undefined)
    const operation = previous.then(async () => await this.writeState(mutate(await this.readState())))
    this.tail = operation.then(() => undefined, () => undefined)
    await operation
  }
  private async writeState(state: DirectGrantState): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); await handle.close(); await rename(temporary, this.file) } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined) }
  }
}

/** Direct-device-bound authorization owns import, renew/revoke recovery, and Host-only feature projection. */
export class DirectPublisherGrantAuthority {
  constructor(private readonly keys: PublisherKeyRegistry, private readonly device: DeviceKeyProvider, private readonly store: DirectPublisherGrantStore) {}
  async challenge(now = new Date()): Promise<DeviceChallenge> { return await createDeviceChallenge(this.device, now) }
  async import(value: unknown): Promise<DirectPublisherGrantProjection> {
    const statement = await verifyPublisherGrantStatement(value, this.keys)
    if (statement.kind === 'grant' || statement.kind === 'renew') {
      const current = await this.device.current()
      if (current === undefined || devicePublicKeyHash(current.publicKey) !== grantPayload(statement).devicePublicKeyHash) return { status: 'device-mismatch', features: [] }
    }
    await this.store.import(statement)
    if (statement.kind === 'revoke') return { status: 'revoked', grantId: (statement.payload as { readonly grantId: string }).grantId, features: [] }
    if (statement.kind === 'transfer') return { status: 'unavailable', features: [] }
    const grant = grantPayload(statement)
    const evaluated = evaluatePublisherGrantTime(grant, await this.store.read())
    return evaluated.state === 'active'
      ? { status: evaluated.refreshDue ? 'refresh-due' : 'authorized', grantId: grant.grantId, features: grant.features, expiresAt: grant.expiresAt, refreshAfter: grant.refreshAfter }
      : evaluated.state === 'grace'
        ? { status: 'grace', grantId: grant.grantId, features: grant.features, expiresAt: grant.expiresAt, refreshAfter: grant.refreshAfter }
        : { status: evaluated.state === 'expired' ? 'expired' : 'not-yet-valid', grantId: grant.grantId, features: [], expiresAt: grant.expiresAt, refreshAfter: grant.refreshAfter }
  }
  async status(target: PublisherGrantTarget, now = new Date()): Promise<DirectPublisherGrantProjection> {
    const device = await this.device.current()
    if (device === undefined) return { status: 'unavailable', features: [] }
    const digest = devicePublicKeyHash(device.publicKey)
    const state = await this.store.read()
    const records = await this.store.records()
    const candidates = records.filter(record => record.statement.kind === 'grant' || record.statement.kind === 'renew')
      .map(record => ({ record, grant: grantPayload(record.statement) }))
      .filter(({ grant }) => grant.pluginId === target.pluginId && publisherGrantVersionMatches(grant.versionRange, target.version))
      .sort((left, right) => Date.parse(right.grant.expiresAt) - Date.parse(left.grant.expiresAt))
    const candidate = candidates[0]
    if (candidate === undefined) return { status: 'unavailable', features: [] }
    if (candidate.grant.devicePublicKeyHash !== digest) return { status: 'device-mismatch', grantId: candidate.grant.grantId, features: [] }
    const effectiveNow = evaluatePublisherGrantTime(candidate.grant, state, now)
    const features = target.requestedFeatures === undefined ? candidate.grant.features : target.requestedFeatures.filter(feature => candidate.grant.features.includes(feature))
    if (candidate.record.revokedAt !== undefined && Date.parse(candidate.record.revokedAt) <= Date.parse(effectiveNow.effectiveNow ?? now.toISOString())) return { status: 'revoked', grantId: candidate.grant.grantId, features: [], expiresAt: candidate.grant.expiresAt, refreshAfter: candidate.grant.refreshAfter }
    if (effectiveNow.state === 'active') return { status: effectiveNow.refreshDue ? 'refresh-due' : 'authorized', grantId: candidate.grant.grantId, features, expiresAt: candidate.grant.expiresAt, refreshAfter: candidate.grant.refreshAfter }
    if (effectiveNow.state === 'grace') return { status: 'grace', grantId: candidate.grant.grantId, features, expiresAt: candidate.grant.expiresAt, refreshAfter: candidate.grant.refreshAfter }
    return { status: effectiveNow.state === 'expired' ? 'expired' : 'not-yet-valid', grantId: candidate.grant.grantId, features: [], expiresAt: candidate.grant.expiresAt, refreshAfter: candidate.grant.refreshAfter }
  }
}

function record(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void { const allowed = new Set(keys); const unknown = Object.keys(value).find(key => !allowed.has(key)); if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`) }
function string(value: unknown, label: string, pattern?: RegExp): string { if (typeof value !== 'string' || value.length === 0 || (pattern !== undefined && !pattern.test(value))) throw new Error(`${label} is invalid`); return value }
function time(value: unknown, label: string): string { const result = string(value, label); if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be an RFC 3339 timestamp`); return result }

function authorization(value: unknown): PublisherGrantAuthorization {
  const input = record(value, 'PublisherGrant authorization')
  exact(input, ['grantId', 'pluginId', 'offerId', 'devicePublicKeyHash', 'nonce', 'notBefore', 'expiresAt', 'refreshAfter', 'offlineGraceSeconds', 'versionRange', 'features'], 'PublisherGrant authorization')
  const features = input.features
  if (!Array.isArray(features) || features.some(item => typeof item !== 'string') || new Set(features).size !== features.length) throw new Error('PublisherGrant features are invalid')
  if (!Number.isInteger(input.offlineGraceSeconds)) throw new Error('offlineGraceSeconds is invalid')
  const result = { grantId: string(input.grantId, 'grantId', /^[A-Za-z0-9._-]{16,160}$/), pluginId: string(input.pluginId, 'pluginId', /^[a-z0-9][a-z0-9._-]{0,95}$/), offerId: string(input.offerId, 'offerId', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), devicePublicKeyHash: string(input.devicePublicKeyHash, 'devicePublicKeyHash', /^sha256:[a-f0-9]{64}$/), nonce: string(input.nonce, 'nonce', /^[A-Za-z0-9_-]{32,128}$/), notBefore: time(input.notBefore, 'notBefore'), expiresAt: time(input.expiresAt, 'expiresAt'), refreshAfter: time(input.refreshAfter, 'refreshAfter'), offlineGraceSeconds: input.offlineGraceSeconds as number, versionRange: string(input.versionRange, 'versionRange'), features: Object.freeze([...features]) }
  if (!Number.isInteger(result.offlineGraceSeconds) || result.offlineGraceSeconds < 0 || result.offlineGraceSeconds > 2_592_000) throw new Error('offlineGraceSeconds is invalid')
  const start = Date.parse(result.notBefore); const refresh = Date.parse(result.refreshAfter); const expiry = Date.parse(result.expiresAt)
  if (!(start < expiry && start <= refresh && refresh < expiry)) throw new Error('PublisherGrant authorization timing is invalid')
  return Object.freeze(result)
}

/** Deterministic RFC 8785-compatible serialization for v1's finite JSON claims. */
export function canonicalPublisherGrantSigningInput(value: Omit<PublisherGrantStatement, 'signature'>): Uint8Array {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string') return JSON.stringify(item)
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    const object = record(item, 'canonical value')
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return Buffer.from(canonical(value), 'utf8')
}

/** Parse an untrusted statement before looking up or using any issuer key. */
export function parsePublisherGrantStatement(value: unknown): PublisherGrantStatement {
  const input = record(value, 'PublisherGrant statement')
  exact(input, ['$schema', 'schemaVersion', 'kind', 'issuer', 'statementId', 'issuedAt', 'payload', 'signature'], 'PublisherGrant statement')
  if (input.$schema !== CORDISX_PUBLISHER_GRANT_SCHEMA_V1 || input.schemaVersion !== 1) throw new Error('PublisherGrant schema is unsupported')
  const kind = string(input.kind, 'kind')
  if (!(['grant', 'renew', 'revoke', 'transfer'] as const).includes(kind as StatementKind)) throw new Error('PublisherGrant kind is unsupported')
  const issuerInput = record(input.issuer, 'issuer'); exact(issuerInput, ['id', 'keyId', 'environment'], 'issuer')
  const environment = issuerInput.environment
  if (environment !== 'sandbox' && environment !== 'live') throw new Error('issuer.environment is invalid')
  const issuer: PublisherIssuer = Object.freeze({ id: string(issuerInput.id, 'issuer.id', /^[a-z0-9][a-z0-9._-]{0,127}$/), keyId: string(issuerInput.keyId, 'issuer.keyId', /^[A-Za-z0-9._-]{1,128}$/), environment })
  const signatureInput = record(input.signature, 'signature'); exact(signatureInput, ['algorithm', 'value'], 'signature')
  if (signatureInput.algorithm !== 'Ed25519') throw new Error('PublisherGrant signature algorithm is unsupported')
  const signature = Object.freeze({ algorithm: 'Ed25519' as const, value: string(signatureInput.value, 'signature.value', /^[A-Za-z0-9_-]{86}$/) })
  const base = { $schema: CORDISX_PUBLISHER_GRANT_SCHEMA_V1, schemaVersion: 1 as const, kind: kind as StatementKind, issuer, statementId: string(input.statementId, 'statementId', /^[A-Za-z0-9._-]{16,128}$/), issuedAt: time(input.issuedAt, 'issuedAt') }
  if (kind === 'grant' || kind === 'renew') return Object.freeze({ ...base, payload: authorization(input.payload), signature })
  const payload = record(input.payload, `${kind} payload`)
  if (kind === 'revoke') {
    exact(payload, ['grantId', 'effectiveAt', 'reason'], 'revoke payload'); const effectiveAt = time(payload.effectiveAt, 'effectiveAt')
    if (Date.parse(effectiveAt) < Date.parse(base.issuedAt)) throw new Error('revoke effectiveAt predates issuedAt')
    return Object.freeze({ ...base, payload: Object.freeze({ grantId: string(payload.grantId, 'grantId', /^[A-Za-z0-9._-]{16,160}$/), effectiveAt, ...(payload.reason === undefined ? {} : { reason: string(payload.reason, 'reason') }) }), signature })
  }
  exact(payload, ['grantId', 'fromDevicePublicKeyHash', 'toDevicePublicKeyHash', 'nonce', 'notBefore', 'expiresAt'], 'transfer payload')
  const transfer = Object.freeze({ grantId: string(payload.grantId, 'grantId', /^[A-Za-z0-9._-]{16,160}$/), fromDevicePublicKeyHash: string(payload.fromDevicePublicKeyHash, 'fromDevicePublicKeyHash', /^sha256:[a-f0-9]{64}$/), toDevicePublicKeyHash: string(payload.toDevicePublicKeyHash, 'toDevicePublicKeyHash', /^sha256:[a-f0-9]{64}$/), nonce: string(payload.nonce, 'nonce', /^[A-Za-z0-9_-]{32,128}$/), notBefore: time(payload.notBefore, 'notBefore'), expiresAt: time(payload.expiresAt, 'expiresAt') })
  if (transfer.fromDevicePublicKeyHash === transfer.toDevicePublicKeyHash || Date.parse(transfer.notBefore) >= Date.parse(transfer.expiresAt)) throw new Error('transfer is invalid')
  return Object.freeze({ ...base, payload: transfer, signature })
}

export async function verifyPublisherGrantStatement(value: unknown, registry: PublisherKeyRegistry): Promise<PublisherGrantStatement> {
  const statement = parsePublisherGrantStatement(value); const key = await registry.resolve(statement.issuer)
  if (key === undefined) throw new Error('PublisherGrant issuer key is unavailable or retired')
  const { signature: _signature, ...unsigned } = statement
  if (!verify(null, canonicalPublisherGrantSigningInput(unsigned), key, Buffer.from(statement.signature.value, 'base64url'))) throw new Error('PublisherGrant signature is invalid')
  return statement
}
export function devicePublicKeyHash(publicKey: Uint8Array): string { return `sha256:${createHash('sha256').update(publicKey).digest('hex')}` }
function grantPayload(statement: PublisherGrantStatement): PublisherGrantAuthorization { if (statement.kind !== 'grant' && statement.kind !== 'renew') throw new Error('statement does not authorize a plugin'); return statement.payload as PublisherGrantAuthorization }
export async function buildPublisherGrantActivationRequest(statement: PublisherGrantStatement, deviceProvider: DeviceKeyProvider): Promise<PublisherGrantActivationRequest> {
  const grant = grantPayload(statement); const device = await deviceProvider.current(); if (device === undefined) throw new Error('a secure device key is unavailable')
  const hash = devicePublicKeyHash(device.publicKey); if (hash !== grant.devicePublicKeyHash) throw new Error('PublisherGrant belongs to a different device key')
  const idempotencyKey = randomBytes(32).toString('base64url'); const proofInput = Buffer.from(JSON.stringify({ issuer: statement.issuer, grantId: grant.grantId, pluginId: grant.pluginId, nonce: grant.nonce, devicePublicKeyHash: hash, idempotencyKey }), 'utf8')
  return Object.freeze({ issuer: statement.issuer, grantId: grant.grantId, pluginId: grant.pluginId, devicePublicKeyHash: hash, devicePublicKey: Buffer.from(device.publicKey).toString('base64url'), nonce: grant.nonce, proof: Buffer.from(await device.sign(proofInput)).toString('base64url'), idempotencyKey })
}
export function evaluatePublisherGrantTime(grant: PublisherGrantAuthorization, state: TrustedTimeState, now = new Date()): PublisherGrantDecision {
  const systemNow = now.getTime(); const trusted = state.lastTrustedAt === undefined ? undefined : Date.parse(state.lastTrustedAt)
  if (trusted !== undefined && !Number.isFinite(trusted)) return { state: 'invalid', reason: 'stored trusted time is invalid' }
  const effective = Math.max(systemNow, trusted ?? Number.NEGATIVE_INFINITY); const notBefore = Date.parse(grant.notBefore); const expiresAt = Date.parse(grant.expiresAt)
  if (effective < notBefore) return { state: 'not-yet-valid', effectiveNow: new Date(effective).toISOString(), reason: 'grant is not yet valid' }
  const clockRollbackDetected = trusted !== undefined && systemNow < trusted
  if (effective <= expiresAt) return { state: 'active', effectiveNow: new Date(effective).toISOString(), refreshDue: effective >= Date.parse(grant.refreshAfter), clockRollbackDetected }
  if (effective <= expiresAt + grant.offlineGraceSeconds * 1000) return { state: 'grace', effectiveNow: new Date(effective).toISOString(), refreshDue: true, clockRollbackDetected }
  return { state: 'expired', effectiveNow: new Date(effective).toISOString(), reason: 'grant expired beyond offline grace' }
}
function versionTuple(value: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}
function compareVersion(left: readonly number[], right: readonly number[]): number { for (let index = 0; index < 3; index += 1) { if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1 }; return 0 }
/** v1 accepts explicit SemVer or whitespace-separated >=, >, <=, and < comparators; unknown syntax fails closed. */
export function publisherGrantVersionMatches(range: string, version: string): boolean {
  const candidate = versionTuple(version); if (candidate === undefined) return false
  if (range === '*') return true
  const clauses = range.trim().split(/\s+/u); if (clauses.length === 0) return false
  return clauses.every(clause => {
    const match = /^(>=|>|<=|<|=)?(.+)$/.exec(clause); const bound = match === null ? undefined : versionTuple(match[2]!)
    if (match === null || bound === undefined) return false
    const result = compareVersion(candidate, bound); const operator = match[1] ?? '='
    return operator === '>=' ? result >= 0 : operator === '>' ? result > 0 : operator === '<=' ? result <= 0 : operator === '<' ? result < 0 : result === 0
  })
}
/** Launcher-only gate. A pre-bound direct grant works without the optional activation registry. */
export class PublisherGrantLifecycleGate {
  constructor(private readonly keys: PublisherKeyRegistry, private readonly device: DeviceKeyProvider, private readonly trustedTime: TrustedTimeStore, private readonly registry?: PublisherGrantActivationRegistry) {}
  async activate(value: unknown, target: PublisherGrantTarget, now = new Date()): Promise<{ readonly state: 'activated' | 'grace' | 'rejected' | 'unavailable'; readonly features: readonly string[] }> {
    let statement: PublisherGrantStatement; try { statement = await verifyPublisherGrantStatement(value, this.keys) } catch { return { state: 'rejected', features: [] } }
    const grant = grantPayload(statement)
    if (grant.pluginId !== target.pluginId || !publisherGrantVersionMatches(grant.versionRange, target.version)) return { state: 'rejected', features: [] }
    const features = target.requestedFeatures === undefined ? grant.features : target.requestedFeatures.filter(feature => grant.features.includes(feature))
    const local = evaluatePublisherGrantTime(grant, await this.trustedTime.read(), now)
    if (local.state === 'expired' || local.state === 'not-yet-valid' || local.state === 'invalid') return { state: 'rejected', features: [] }
    if (this.registry === undefined) {
      const before = await this.trustedTime.read()
      const prior = before.lastTrustedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(before.lastTrustedAt)
      const issued = Date.parse(statement.issuedAt)
      if (issued > prior) await this.trustedTime.write({ lastTrustedAt: new Date(issued).toISOString() })
      const evaluated = evaluatePublisherGrantTime(grant, await this.trustedTime.read(), now)
      return evaluated.state === 'active' ? { state: 'activated', features } : evaluated.state === 'grace' ? { state: 'grace', features } : { state: 'rejected', features: [] }
    }
    let response: PublisherGrantActivationResponse; try { response = await this.registry.activate(await buildPublisherGrantActivationRequest(statement, this.device)) } catch { return { state: 'unavailable', features: [] } }
    if (response.status !== 'activated' && response.status !== 'already-activated') return { state: response.status === 'unavailable' ? 'unavailable' : 'rejected', features: [] }
    if (response.trustedAt === undefined || !Number.isFinite(Date.parse(response.trustedAt))) return { state: 'rejected', features: [] }
    const before = await this.trustedTime.read(); const prior = before.lastTrustedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(before.lastTrustedAt); const received = Date.parse(response.trustedAt)
    if (received > prior) await this.trustedTime.write({ lastTrustedAt: new Date(received).toISOString() })
    const evaluated = evaluatePublisherGrantTime(grant, await this.trustedTime.read(), now)
    return evaluated.state === 'active' ? { state: 'activated', features } : evaluated.state === 'grace' ? { state: 'grace', features } : { state: 'rejected', features: [] }
  }
}
