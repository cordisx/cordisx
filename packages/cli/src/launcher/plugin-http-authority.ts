import { createHash, randomBytes } from 'node:crypto'
import type {
  HttpConnectionV1,
  HttpFailureCodeV1,
  HttpResponseV1,
  HttpResultV1,
} from '@cordisx/protocol/plugin-http/v1'
import { createMacOSKeychainBackend, type LauncherKeychainBackend } from './secret-store.js'
import { type OwnerDocumentPrincipal, verifyOwnerDocumentPrincipalToken } from './owner-document-rpc.js'

interface Grant {
  readonly connection: HttpConnectionV1
  readonly principal: OwnerDocumentPrincipal
  readonly owner: string
  readonly keychainService: string
  readonly requests: Map<string, AbortController>
}
export interface PluginHttpAuthorityOptions {
  readonly secret: string
  readonly profileId: string
  readonly generation: string
  readonly principalAllowed: (principal: OwnerDocumentPrincipal) => boolean
  readonly keychain?: LauncherKeychainBackend | null
  readonly fetch?: typeof fetch
}
const fail = (code: HttpFailureCodeV1): HttpResultV1<never> => ({ status: 'unavailable', code })
const accepted = <T>(value: T): HttpResultV1<T> => ({ status: 'accepted', value })
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-request')
  return value as Record<string, unknown>
}
const key = (principal: OwnerDocumentPrincipal): string =>
  JSON.stringify([
    principal.profileId,
    principal.generation,
    principal.moduleGeneration,
    principal.identity.source,
    principal.identity.pluginId,
  ])
export function canonicalHttpOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid-request')
  const url = new URL(value)
  if (
    !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || (value !== url.origin && value !== `${url.origin}/`)
  ) throw new Error('invalid-request')
  return url.origin
}
export function isPluginHttpRequest(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && String((value as Record<string, unknown>).operation).startsWith('plugin-http-')
}

/** Launcher-only authority. Plaintext is accepted only from the Host capture UI. */
export class PluginHttpAuthority {
  private readonly grants = new Map<string, Grant>()
  private readonly keychain: LauncherKeychainBackend | undefined
  private readonly transport: typeof fetch
  private disposed = false
  private readonly retirement: ReturnType<typeof setInterval>
  constructor(private readonly options: PluginHttpAuthorityOptions) {
    this.keychain = options.keychain === null
      ? undefined
      : options.keychain ?? (process.platform === 'darwin' ? createMacOSKeychainBackend() : undefined)
    this.transport = options.fetch ?? fetch
    this.retirement = setInterval(() => {
      for (const [id, grant] of this.grants) {
        if (!this.options.principalAllowed(grant.principal)) void this.retire(id, grant).catch(() => {})
      }
    }, 250)
    this.retirement.unref()
  }
  private principal(token: unknown): OwnerDocumentPrincipal | undefined {
    if (this.disposed || typeof token !== 'string') return undefined
    const value = verifyOwnerDocumentPrincipalToken(this.options.secret, token)
    return value?.profileId === this.options.profileId && value.generation === this.options.generation
        && this.options.principalAllowed(value)
      ? value
      : undefined
  }
  async handle(raw: unknown): Promise<HttpResultV1<unknown>> {
    try {
      const input = record(raw)
      const principal = this.principal(input.token)
      if (principal === undefined) return fail('stale-generation')
      if (input.operation === 'plugin-http-authorize') return await this.authorize(principal, input)
      if (input.operation === 'plugin-http-dispose') {
        for (const [id, grant] of this.grants) if (grant.owner === key(principal)) await this.retire(id, grant)
        return accepted(null)
      }
      const connection = record(input.connection)
      const grant = this.grants.get(String(connection.id))
      if (
        grant === undefined || grant.owner !== key(principal)
        || connection.contract !== grant.connection.contract || connection.origin !== grant.connection.origin
        || connection.credential !== grant.connection.credential
      ) return fail('connection-unavailable')
      if (input.operation === 'plugin-http-revoke') {
        try {
          await this.retire(grant.connection.id, grant)
        } catch {
          return fail('credential-unavailable')
        }
        return accepted(null)
      }
      if (input.operation === 'plugin-http-abort') {
        grant.requests.get(String(input.operationId))?.abort()
        return accepted(null)
      }
      if (input.operation !== 'plugin-http-request') return fail('invalid-request')
      return await this.request(grant, input)
    } catch {
      return fail('invalid-request')
    }
  }
  private async authorize(principal: OwnerDocumentPrincipal, input: Record<string, unknown>) {
    const origin = canonicalHttpOrigin(input.origin)
    if (input.credential !== 'none' && input.credential !== 'bearer') return fail('invalid-request')
    const url = new URL(origin)
    if (
      input.credential === 'bearer' && url.protocol !== 'https:'
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) return fail('invalid-request')
    if (this.grants.size >= 128) return fail('unsupported')
    const id = randomBytes(32).toString('base64url')
    const connection: HttpConnectionV1 = {
      contract: 'cordisx.http-connection/v1',
      id,
      origin,
      credential: input.credential,
    }
    const owner = key(principal)
    const keychainService = `cordisx/http/${createHash('sha256').update(owner).digest('hex')}`
    if (input.credential === 'bearer') {
      if (this.keychain === undefined) return fail('unsupported')
      if (
        typeof input.secret !== 'string' || input.secret.length < 1 || input.secret.length > 16_384
        || /[\r\n\u0000]/u.test(input.secret)
      ) return fail('invalid-request')
      try {
        await this.keychain.upsert(keychainService, id, input.secret)
      } catch {
        return fail('credential-unavailable')
      }
    } else if (input.secret !== undefined) return fail('invalid-request')
    if (this.disposed || !this.options.principalAllowed(principal)) {
      if (input.credential === 'bearer') await this.keychain?.remove(keychainService, id).catch(() => {})
      return fail('stale-generation')
    }
    this.grants.set(id, { connection, principal, owner, keychainService, requests: new Map() })
    return accepted(connection)
  }
  private async request(grant: Grant, input: Record<string, unknown>): Promise<HttpResultV1<HttpResponseV1>> {
    const operationId = input.operationId
    if (
      typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/u.test(operationId)
      || grant.requests.has(operationId) || grant.requests.size >= 8
    ) return fail('invalid-request')
    if (
      typeof input.path !== 'string' || input.path.length > 8192 || !input.path.startsWith('/')
      || input.path.startsWith('//') || /[\\#\r\n]/u.test(input.path)
    ) return fail('invalid-request')
    const url = new URL(input.path, grant.connection.origin)
    if (url.origin !== grant.connection.origin || url.username || url.password) return fail('invalid-request')
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(input.method))) return fail('invalid-request')
    if (typeof input.deadline !== 'number' || !Number.isSafeInteger(input.deadline)) return fail('invalid-request')
    if (input.deadline <= Date.now()) return fail('deadline-exceeded')
    if (
      input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 1_048_576
        || input.method === 'GET')
    ) return fail('invalid-request')
    const headers: Record<string, string> = {}
    if (input.headers !== undefined) {
      for (const [name, value] of Object.entries(record(input.headers))) {
        if (
          !['accept', 'content-type', 'idempotency-key'].includes(name) || typeof value !== 'string'
          || value.length > 4096 || /[\r\n]/u.test(value)
        ) return fail('invalid-request')
        headers[name] = value
      }
    }
    const abort = new AbortController()
    grant.requests.set(operationId, abort)
    let expired = false
    const deadline = setTimeout(() => {
      expired = true
      abort.abort()
    }, Math.min(30_000, input.deadline - Date.now()))
    const fence = setInterval(() => {
      if (!this.options.principalAllowed(grant.principal) || this.grants.get(grant.connection.id) !== grant) {
        abort.abort()
      }
    }, 100)
    try {
      if (grant.connection.credential === 'bearer') {
        try {
          headers.authorization = `Bearer ${await this.keychain!.read(grant.keychainService, grant.connection.id)}`
        } catch {
          return fail('credential-unavailable')
        }
      }
      if (abort.signal.aborted) return fail(expired ? 'deadline-exceeded' : 'aborted')
      const response = await this.transport(url, {
        method: String(input.method),
        headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: abort.signal,
        ...(input.body === undefined ? {} : { body: input.body as string }),
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        return fail('redirect-denied')
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader !== undefined) {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.byteLength
          if (bytes > 1_048_576) {
            await reader.cancel()
            abort.abort()
            return fail('response-too-large')
          }
          chunks.push(next.value)
        }
      }
      if (
        abort.signal.aborted || this.disposed || !this.options.principalAllowed(grant.principal)
        || this.grants.get(grant.connection.id) !== grant
      ) return fail(expired ? 'deadline-exceeded' : 'aborted')
      return accepted({
        statusCode: response.status,
        contentType: response.headers.get('content-type'),
        body: Buffer.concat(chunks).toString('utf8'),
      })
    } catch {
      return fail(expired ? 'deadline-exceeded' : abort.signal.aborted ? 'aborted' : 'network-error')
    } finally {
      clearTimeout(deadline)
      clearInterval(fence)
      grant.requests.delete(operationId)
    }
  }
  private async retire(id: string, grant: Grant): Promise<void> {
    this.grants.delete(id)
    for (const abort of grant.requests.values()) abort.abort()
    if (grant.connection.credential === 'bearer') await this.keychain?.remove(grant.keychainService, id)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.retirement)
    await Promise.allSettled([...this.grants].map(([id, grant]) => this.retire(id, grant)))
  }
}
