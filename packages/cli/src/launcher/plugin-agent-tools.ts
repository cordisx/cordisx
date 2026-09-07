import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deployAgentToolResources, readAgentToolResources } from './plugin-agent-tool-resources.js'
import { type OwnerDocumentPrincipal, verifyOwnerDocumentPrincipalToken } from './owner-document-rpc.js'

export type AgentToolDispatch = (request: Record<string, unknown>) => Promise<unknown>
interface Registration {
  readonly id: string
  readonly principal: OwnerDocumentPrincipal
  readonly commandId: string
  readonly dispatch: AgentToolDispatch
  readonly entry: string
  readonly deployment: Awaited<ReturnType<typeof deployAgentToolResources>>
}
interface Binding {
  readonly id: string
  readonly token: string
  readonly registration: Registration
  readonly sessionId: string
  readonly scope: unknown
  readonly expiresAt: string
  readonly directory: string
  readonly bindingPath: string
  readonly deployment: Awaited<ReturnType<typeof deployAgentToolResources>>
  revoked: boolean
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid agent tool request')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('invalid agent tool identifier')
  }
  return value
}
function principalKey(principal: OwnerDocumentPrincipal): string {
  return JSON.stringify([
    principal.profileId,
    principal.generation,
    principal.identity.source,
    principal.identity.pluginId,
    principal.moduleGeneration,
  ])
}
export function isAgentToolRequest(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'operation' in value
    && String(value.operation).startsWith('agent-tools-')
}

/** Ephemeral call routing only; plugin storage remains the sole business fact ledger. */
export class PluginAgentToolAuthority {
  private registrations = new Map<string, Registration>()
  private bindings = new Map<string, Binding>()
  private server?: Server
  private directory?: string
  private starting?: Promise<void>
  private closed = false
  constructor(
    private readonly options: {
      readonly secret: string
      readonly profileId: string
      readonly generation: string
      readonly principalAllowed: (principal: OwnerDocumentPrincipal) => boolean
      readonly plugins: readonly {
        readonly id: string
        readonly entry: string
        readonly source?: string
        readonly enabled: boolean
        readonly package?: { readonly moduleGeneration: string }
      }[]
    },
  ) {}

  private principal(raw: Record<string, unknown>): OwnerDocumentPrincipal {
    const principal = verifyOwnerDocumentPrincipalToken(this.options.secret, text(raw.token))
    if (
      this.closed || principal === undefined || principal.profileId !== this.options.profileId
      || principal.generation !== this.options.generation || !this.options.principalAllowed(principal)
    ) throw new Error('agent tool principal is stale')
    return principal
  }
  private registration(raw: Record<string, unknown>, principal: OwnerDocumentPrincipal): Registration {
    const registration = this.registrations.get(text(raw.registrationId))
    if (registration === undefined || principalKey(principal) !== principalKey(registration.principal)) {
      throw new Error('agent tool registration unavailable')
    }
    return registration
  }
  private async check(binding: Binding): Promise<void> {
    const registration = binding.registration
    if (
      this.closed || binding.revoked || Date.parse(binding.expiresAt) <= Date.now()
      || this.registrations.get(registration.id) !== registration
      || !this.options.principalAllowed(registration.principal)
    ) throw new Error('agent tool binding is stale')
    if (
      await registration.dispatch({ action: 'validate', registrationId: registration.id, sessionId: binding.sessionId })
        !== true
    ) throw new Error('agent tool Session is unavailable')
  }
  private async start(): Promise<void> {
    if (this.starting !== undefined) return await this.starting
    this.starting = (async () => {
      this.directory = await mkdtemp(path.join(tmpdir(), 'cx-tools-'))
      await chmod(this.directory, 0o700)
      this.server = createServer((request, response) => {
        void (async () => {
          const token = request.headers.authorization?.replace(/^Bearer /, '')
          const binding = token === undefined ? undefined : this.bindings.get(token)
          if (request.method !== 'POST' || request.url !== '/invoke' || binding === undefined) {
            throw new Error('unauthorized')
          }
          let source = ''
          for await (const chunk of request) {
            source += String(chunk)
            if (Buffer.byteLength(source) > 65_536) throw new Error('input too large')
          }
          const body = object(JSON.parse(source))
          if (Object.keys(body).some(key => key !== 'input')) throw new Error('invalid invocation')
          await this.check(binding)
          const invocationId = randomUUID()
          const registration = binding.registration
          let finished = false
          const cancel = (): void => {
            if (!finished) {
              void registration.dispatch({ action: 'cancel', registrationId: registration.id, invocationId }).catch(
                () => undefined,
              )
            }
          }
          response.once('close', cancel)
          const timer = setTimeout(() => {
            cancel()
            response.destroy()
          }, 25_000)
          try {
            const value = await registration.dispatch({
              action: 'invoke',
              registrationId: registration.id,
              invocationId,
              bindingId: binding.id,
              input: body.input,
              binding: { sessionId: binding.sessionId, scope: binding.scope },
              expiresAt: binding.expiresAt,
            })
            finished = true
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ ok: true, value }))
          } finally {
            clearTimeout(timer)
            response.removeListener('close', cancel)
          }
        })().catch(() => {
          if (!response.headersSent) response.writeHead(403, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false }))
        })
      })
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(path.join(this.directory!, 'rpc.sock'), () => resolve())
      })
    })()
    return await this.starting
  }

  async handle(value: unknown, dispatch: AgentToolDispatch): Promise<unknown> {
    const raw = object(value)
    const principal = this.principal(raw)
    if (raw.operation === 'agent-tools-register') {
      if (this.registrations.size >= 64) throw new Error('agent tool registration limit reached')
      const commandId = text(raw.commandId)
      const plugin = this.options.plugins.find(item => item.enabled && item.id === principal.identity.pluginId)
      if (
        plugin === undefined
        || (plugin.package !== undefined && plugin.package.moduleGeneration !== principal.moduleGeneration)
      ) throw new Error('agent tool plugin generation unavailable')
      const resources = await readAgentToolResources(plugin.entry)
      if (!resources?.commands.some(command => command.id === commandId)) {
        throw new Error('agent tool command is undeclared')
      }
      const registrationId = text(raw.registrationId)
      if (this.registrations.has(registrationId)) throw new Error('agent tool registration duplicate')
      for (const prior of this.registrations.values()) {
        if (principalKey(prior.principal) === principalKey(principal) && prior.commandId === commandId) {
          throw new Error('agent tool command already active')
        }
      }
      await this.start()
      const deployment = await deployAgentToolResources(
        plugin.entry,
        commandId,
        await mkdtemp(path.join(this.directory!, 'resources-')),
      )
      this.registrations.set(registrationId, {
        deployment,
        id: registrationId,
        commandId,
        principal,
        dispatch,
        entry: plugin.entry,
      })
      return null
    }
    const registration = this.registration(raw, principal)
    if (raw.operation === 'agent-tools-unregister') {
      this.registrations.delete(registration.id)
      for (const binding of this.bindings.values()) if (binding.registration === registration) binding.revoked = true
      return null
    }
    if (raw.operation === 'agent-tools-bind') {
      const sessionId = text(raw.sessionId)
      if (await registration.dispatch({ action: 'validate', registrationId: registration.id, sessionId }) !== true) {
        throw new Error('agent tool Session owner mismatch')
      }
      if (JSON.stringify(raw.scope).length > 16_384) throw new Error('agent tool scope too large')
      await this.start()
      if (this.bindings.size >= 1024) throw new Error('agent tool binding limit reached')
      for (const prior of this.bindings.values()) {
        if (prior.sessionId === sessionId && prior.registration === registration) prior.revoked = true
      }
      const bindingId = randomUUID()
      const directory = await mkdtemp(path.join(this.directory!, 'binding-'))
      const deployment = registration.deployment
      const token = randomBytes(32).toString('base64url')
      const bindingPath = path.join(directory, 'binding.json')
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
      const binding: Binding = {
        id: bindingId,
        token,
        registration,
        sessionId,
        scope: JSON.parse(JSON.stringify(raw.scope)),
        expiresAt,
        bindingPath,
        directory,
        deployment,
        revoked: false,
      }
      await writeFile(
        bindingPath,
        JSON.stringify({
          contract: 'cordisx.agent-tool-binding/v1',
          token,
          socketPath: path.join(this.directory!, 'rpc.sock'),
        }),
        { flag: 'wx', mode: 0o600 },
      )
      this.bindings.set(token, binding)
      return { bindingId, sessionId, expiresAt }
    }
    const binding = [...this.bindings.values()].find(item =>
      item.id === raw.bindingId && item.registration === registration
    )
    if (binding === undefined) throw new Error('agent tool binding unavailable')
    if (raw.operation === 'agent-tools-revoke') {
      binding.revoked = true
      return null
    }
    if (raw.operation !== 'agent-tools-setup') throw new Error('unknown agent tool operation')
    await this.check(binding)
    const content = await readFile(binding.deployment.skill.path, 'utf8')
    if (content !== binding.deployment.skill.content) throw new Error('agent tool Skill changed')
    return {
      skills: [{ ...binding.deployment.skill, content }],
      commands: [{
        id: registration.commandId,
        argv: [process.execPath, binding.deployment.commandPath, '--binding', binding.bindingPath],
        bindingPath: binding.bindingPath,
        expiresAt: binding.expiresAt,
      }],
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const binding of this.bindings.values()) binding.revoked = true
    this.registrations.clear()
    if (this.starting !== undefined) await this.starting.catch(() => undefined)
    if (this.server !== undefined) {
      this.server.closeAllConnections()
      await new Promise<void>(resolve => this.server!.close(() => resolve()))
    }
    if (this.directory !== undefined) await rm(this.directory, { recursive: true, force: true })
  }
}
