import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CONNECTION_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const CAPTURE_ID = /^[A-Za-z0-9_-]{32,128}$/

export type LauncherSecretStoreState = 'set' | 'unset' | 'unavailable'

/** Deliberately value-free error used at the host/private boundary. */
export class LauncherKeychainError extends Error {
  constructor(readonly code: 'MISSING' | 'UNAVAILABLE') {
    super(code)
    this.name = `CORDISX_KEYCHAIN_${code}`
  }
}

/**
 * The backend is injectable so tests never have to access a user's Keychain.
 * Its `value` arguments must remain confined to the launcher process.
 */
export interface LauncherKeychainBackend {
  read(service: string, account: string): Promise<string>
  upsert(service: string, account: string, value: string): Promise<void>
  remove(service: string, account: string): Promise<void>
  status(service: string, account: string): Promise<'set' | 'unset'>
}

export interface LauncherSecretCapture {
  readonly captureId: string
}

/** Renderer-safe result: never add a reference or captured value here. */
export interface LauncherSecretStoreResult {
  readonly state: LauncherSecretStoreState
  readonly operationToken: string
}

export interface LauncherSecretStoreOptions {
  readonly platform?: NodeJS.Platform
  readonly backend?: LauncherKeychainBackend
}

interface SecretIdentity {
  readonly profileId: string
  readonly connectionId: string
}

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 && !/[\r\n\u0000]/u.test(value)
}

function identity(input: SecretIdentity): SecretIdentity {
  if (!PROFILE_ID.test(input.profileId)) throw new Error('invalid secret profile id')
  if (!CONNECTION_ID.test(input.connectionId)) throw new Error('invalid secret connection id')
  return Object.freeze({ profileId: input.profileId, connectionId: input.connectionId })
}

function keychainLocation(input: SecretIdentity): { readonly service: string; readonly account: string } {
  return { service: `cordisx/channel/${input.profileId}`, account: input.connectionId }
}

/** The opaque keychain reference is for launcher-owned service configuration only. */
export function channelKeychainReference(input: SecretIdentity): string {
  const value = identity(input)
  return `keychain:cordisx/channel/${value.profileId}/${value.connectionId}`
}

/**
 * Host-private capture authority.  The caller first creates a scoped opaque
 * capture id, then submits only that id and the secret.  No result includes a
 * secret or keychain reference, so this shape is safe to return to a renderer.
 */
export class LauncherSecretStore {
  private readonly captures = new Map<string, SecretIdentity>()
  private readonly backend: LauncherKeychainBackend | undefined

  // TODO: bind captures to service generation/owner and add compare-and-swap
  // semantics when this private API is connected to a renderer workflow.

  constructor(options: LauncherSecretStoreOptions = {}) {
    this.backend = (options.platform ?? process.platform) === 'darwin'
      ? (options.backend ?? createMacOSKeychainBackend())
      : undefined
  }

  beginCapture(input: SecretIdentity): LauncherSecretCapture {
    const captureId = randomBytes(32).toString('base64url')
    this.captures.set(captureId, identity(input))
    return Object.freeze({ captureId })
  }

  /** Accepts exactly the Host-issued capture id and a transient secret value. */
  async capture(input: { readonly captureId: string; readonly secret: string }): Promise<LauncherSecretStoreResult> {
    const target = this.lookupCapture(input.captureId)
    if (target === undefined || !validSecret(input.secret)) return this.result('unavailable')
    if (this.backend === undefined) return this.result('unavailable')
    try {
      const location = keychainLocation(target)
      await this.backend.upsert(location.service, location.account, input.secret)
      return this.result('set')
    } catch {
      return this.result('unavailable')
    }
  }

  async remove(captureId: string): Promise<LauncherSecretStoreResult> {
    const target = this.lookupCapture(captureId)
    if (target === undefined || this.backend === undefined) return this.result('unavailable')
    try {
      const location = keychainLocation(target)
      await this.backend.remove(location.service, location.account)
      return this.result('unset')
    } catch (error) {
      if (error instanceof LauncherKeychainError && error.code === 'MISSING') return this.result('unset')
      return this.result('unavailable')
    }
  }

  async status(captureId: string): Promise<LauncherSecretStoreResult> {
    const target = this.lookupCapture(captureId)
    if (target === undefined || this.backend === undefined) return this.result('unavailable')
    try {
      const location = keychainLocation(target)
      return this.result(await this.backend.status(location.service, location.account))
    } catch {
      return this.result('unavailable')
    }
  }

  /** Launcher-only handoff to a service configuration; never project this value. */
  referenceFor(captureId: string): string | undefined {
    const target = this.lookupCapture(captureId)
    return target === undefined ? undefined : channelKeychainReference(target)
  }

  private lookupCapture(value: string): SecretIdentity | undefined {
    return CAPTURE_ID.test(value) ? this.captures.get(value) : undefined
  }

  private result(state: LauncherSecretStoreState): LauncherSecretStoreResult {
    return Object.freeze({ state, operationToken: randomBytes(16).toString('base64url') })
  }
}

const HELPER_SOURCE = String.raw`
import Foundation
import Security

func fail() -> Never { exit(1) }
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let operation = object["operation"] as? String,
      let service = object["service"] as? String,
      let account = object["account"] as? String else { fail() }
var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: service,
                            kSecAttrAccount as String: account]
switch operation {
case "set":
  guard let value = object["value"] as? String, let data = value.data(using: .utf8) else { fail() }
  let update = [kSecValueData as String: data]
  let changed = SecItemUpdate(query as CFDictionary, update as CFDictionary)
  if changed == errSecSuccess { exit(0) }
  guard changed == errSecItemNotFound else { fail() }
  query[kSecValueData as String] = data
  if SecItemAdd(query as CFDictionary, nil) != errSecSuccess { fail() }
case "read":
  query[kSecReturnData as String] = true
  var result: CFTypeRef?
  if SecItemCopyMatching(query as CFDictionary, &result) != errSecSuccess { fail() }
  guard let data = result as? Data else { fail() }
  FileHandle.standardOutput.write(data)
case "status":
  let result = SecItemCopyMatching(query as CFDictionary, nil)
  if result == errSecSuccess { FileHandle.standardOutput.write(Data("set".utf8)); exit(0) }
  if result == errSecItemNotFound { FileHandle.standardOutput.write(Data("unset".utf8)); exit(0) }
  fail()
case "remove":
  let result = SecItemDelete(query as CFDictionary)
  if result != errSecSuccess && result != errSecItemNotFound { fail() }
default: fail()
}
`

let helperSourceHash = createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 24)
let helperDirectory = path.join(os.tmpdir(), 'cordisx-keychain-helper-v1')
let helperPath = path.join(helperDirectory, helperSourceHash)
let helperBuild = new Map<string, Promise<string>>()

async function run(command: string, args: readonly string[], input?: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const output: Buffer[] = []
    child.stdout.on('data', value => output.push(Buffer.from(value)))
    child.once('error', () => reject(new LauncherKeychainError('UNAVAILABLE')))
    child.once('exit', code => code === 0 ? resolve(Buffer.concat(output)) : reject(new LauncherKeychainError('UNAVAILABLE')))
    child.stdin.end(input)
  })
}

async function macOSHelper(): Promise<string> {
  const prior = helperBuild.get(helperPath)
  if (prior !== undefined) return await prior
  const building = (async () => {
    await mkdir(helperDirectory, { recursive: true, mode: 0o700 })
    try {
      await stat(helperPath)
      return helperPath
    } catch {
      const nonce = randomBytes(8).toString('hex')
      const source = `${helperPath}-${nonce}.swift`
      const output = `${helperPath}-${nonce}`
      try {
        await writeFile(source, HELPER_SOURCE, { mode: 0o600 })
        await run('xcrun', ['--sdk', 'macosx', 'swiftc', source, '-framework', 'Security', '-o', output])
        await chmod(output, 0o700)
        await rename(output, helperPath)
      } finally {
        // A failed build is deliberately reported only as unavailable.  The
        // source is fixed and never contains captured input.
        await unlink(source).catch(() => undefined)
        await unlink(output).catch(() => undefined)
      }
      return helperPath
    }
  })()
  helperBuild.set(helperPath, building)
  try {
    return await building
  } catch (error) {
    helperBuild.delete(helperPath)
    throw error
  }
}

async function invokeMacOSHelper(operation: 'set' | 'read' | 'status' | 'remove', service: string, account: string, value?: string): Promise<Buffer> {
  const helper = await macOSHelper()
  const request = Buffer.from(JSON.stringify({ operation, service, account, ...(value === undefined ? {} : { value }) }))
  return await run(helper, [], request)
}

/** Native Security.framework backend; secret input is written only to helper stdin. */
export function createMacOSKeychainBackend(): LauncherKeychainBackend {
  return {
    read: async (service, account) => {
      try {
        const value = (await invokeMacOSHelper('read', service, account)).toString('utf8')
        if (!validSecret(value)) throw new LauncherKeychainError('MISSING')
        return value
      } catch (error) {
        if (error instanceof LauncherKeychainError) throw error
        throw new LauncherKeychainError('UNAVAILABLE')
      }
    },
    upsert: async (service, account, value) => {
      if (!validSecret(value)) throw new LauncherKeychainError('UNAVAILABLE')
      await invokeMacOSHelper('set', service, account, value)
    },
    remove: async (service, account) => { await invokeMacOSHelper('remove', service, account) },
    status: async (service, account) => {
      try {
        const result = (await invokeMacOSHelper('status', service, account)).toString('utf8')
        if (result === 'set' || result === 'unset') return result
        throw new LauncherKeychainError('UNAVAILABLE')
      } catch (error) {
        if (error instanceof LauncherKeychainError) throw error
        throw new LauncherKeychainError('UNAVAILABLE')
      }
    },
  }
}
