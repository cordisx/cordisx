import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { CliProxyProviderConfig, LocalCodexProviderConfig } from './contracts.js'
import { JsonLineRpcClient } from './json-line-rpc.js'

export interface CodexAppServerOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly spawnProcess?: typeof spawn
  /** Resolve a Host-owned keychain/secret reference without exposing its value to the renderer. */
  readonly resolveSecretReference?: (reference: string) => Promise<string | undefined>
}

export interface CodexAppServerRpc {
  readonly generation: string
  request<Result>(method: string, params: unknown, signal?: AbortSignal): Promise<Result>
  subscribeNotifications?(listener: (method: string, params: unknown) => void): () => void
  subscribeRequests?(listener: (method: string, params: unknown) => unknown | Promise<unknown>): () => void
  close(): Promise<void>
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Build argv without credential values. The gateway remains an external provider, never the native current connection. */
export function codexAppServerArguments(
  config: CliProxyProviderConfig,
  credentialEnvironmentKey = config.apiKeyEnv,
): readonly string[] {
  if (credentialEnvironmentKey === undefined) throw new Error(`provider ${config.id} credential reference is unavailable`)
  const provider = `{ ${tomlString(config.id)} = { name = ${tomlString(config.displayName)}, base_url = ${tomlString(config.baseUrl)}, env_key = ${tomlString(credentialEnvironmentKey)}, wire_api = "responses" } }`
  return Object.freeze([
    'app-server',
    '--stdio',
    '-c', `model_provider=${tomlString(config.id)}`,
    '-c', `model_providers=${provider}`,
    '-c', 'analytics.enabled=false',
  ])
}

/** Local App Server uses the existing Codex login/configuration and receives no injected credential. */
export function localCodexAppServerArguments(): readonly string[] {
  return Object.freeze(['app-server', '--stdio', '-c', 'analytics.enabled=false'])
}

class SpawnedCodexAppServer implements CodexAppServerRpc {
  readonly generation = randomUUID()
  private closed = false
  private readonly rpc: JsonLineRpcClient
  private readonly notifications = new Set<(method: string, params: unknown) => void>()
  private readonly requests = new Set<(method: string, params: unknown) => unknown | Promise<unknown>>()

  constructor(private readonly child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    child.stderr.resume()
    this.rpc = new JsonLineRpcClient({
      input: child.stdout,
      output: child.stdin,
      timeoutMs,
      onNotification: (method, params) => {
        for (const listener of this.notifications) listener(method, params)
      },
      onRequest: async (method, params) => {
        const listener = this.requests.values().next().value as ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined
        if (listener === undefined) throw new Error(`Unsupported App Server request: ${method}`)
        return await listener(method, params)
      },
    })
    child.once('error', error => this.rpc.close(`Codex app-server process failed: ${error.message}`))
    child.once('exit', (code, signal) => {
      this.rpc.close(`Codex app-server exited (${code === null ? signal ?? 'unknown' : String(code)})`)
    })
  }

  request<Result>(method: string, params: unknown, signal?: AbortSignal): Promise<Result> {
    return this.rpc.request<Result>(method, params, signal)
  }

  subscribeNotifications(listener: (method: string, params: unknown) => void): () => void {
    this.notifications.add(listener)
    return () => this.notifications.delete(listener)
  }

  subscribeRequests(listener: (method: string, params: unknown) => unknown | Promise<unknown>): () => void {
    this.requests.add(listener)
    return () => this.requests.delete(listener)
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'cordisx', title: 'CordisX Provider Fleet', version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    })
    await this.rpc.notify('initialized')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.rpc.close()
    this.notifications.clear()
    this.requests.clear()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()))
    this.child.kill('SIGTERM')
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 2_000)),
    ])
    if (!graceful && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL')
      await exited
    }
  }
}

/** Start one App Server against the already authenticated local Codex home. */
export async function startLocalCodexAppServer(
  config: LocalCodexProviderConfig,
  options: CodexAppServerOptions = {},
): Promise<CodexAppServerRpc> {
  const environment = options.environment ?? process.env
  await mkdir(config.codexHome, { recursive: true, mode: 0o700 })
  const launch = options.spawnProcess ?? spawn
  const child = launch(config.codexExecutable, localCodexAppServerArguments(), {
    cwd: config.codexHome,
    env: { ...environment, CODEX_HOME: config.codexHome },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  const server = new SpawnedCodexAppServer(child, config.timeoutMs)
  try {
    await server.initialize()
    return server
  } catch (error) {
    await server.close().catch(() => undefined)
    throw error
  }
}

/** Start one provider-specific, CODEX_HOME-isolated stable App Server client. */
export async function startCodexAppServer(
  config: CliProxyProviderConfig,
  options: CodexAppServerOptions = {},
): Promise<CodexAppServerRpc> {
  const environment = options.environment ?? process.env
  let credentialEnvironmentKey = config.apiKeyEnv
  let credentialValue = credentialEnvironmentKey === undefined ? undefined : environment[credentialEnvironmentKey]
  if (config.credentialRef !== undefined) {
    const environmentMatch = /^host-secret:env\/([A-Z_][A-Z0-9_]{0,127})$/.exec(config.credentialRef)
    if (environmentMatch !== null) {
      const environmentKey = environmentMatch[1]!
      credentialEnvironmentKey = environmentKey
      credentialValue = environment[environmentKey]
    } else if (options.resolveSecretReference !== undefined) {
      credentialEnvironmentKey = 'CORDISX_PROVIDER_CREDENTIAL'
      credentialValue = await options.resolveSecretReference(config.credentialRef)
    } else {
      throw new Error(`provider ${config.id} Host credential reference is unavailable`)
    }
  }
  if (credentialEnvironmentKey === undefined || credentialValue === undefined) {
    throw new Error(`provider ${config.id} credential is not configured`)
  }
  if (credentialValue.trim() === '') throw new Error(`provider ${config.id} credential is empty`)
  await mkdir(config.codexHome, { recursive: true, mode: 0o700 })
  const launch = options.spawnProcess ?? spawn
  const child = launch(config.codexExecutable, codexAppServerArguments(config, credentialEnvironmentKey), {
    cwd: config.codexHome,
    env: { ...environment, [credentialEnvironmentKey]: credentialValue, CODEX_HOME: config.codexHome },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  const server = new SpawnedCodexAppServer(child, config.timeoutMs)
  try {
    await server.initialize()
    return server
  } catch (error) {
    await server.close().catch(() => undefined)
    throw error
  }
}
