import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { CliProxyProviderConfig } from './contracts.js'
import { JsonLineRpcClient } from './json-line-rpc.js'

export interface CodexAppServerOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly spawnProcess?: typeof spawn
}

export interface CodexAppServerRpc {
  readonly generation: string
  request<Result>(method: string, params: unknown, signal?: AbortSignal): Promise<Result>
  close(): Promise<void>
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Build argv without credential values. The gateway remains an external provider, never the native current connection. */
export function codexAppServerArguments(config: CliProxyProviderConfig): readonly string[] {
  const provider = `{ ${tomlString(config.id)} = { name = ${tomlString(config.displayName)}, base_url = ${tomlString(config.baseUrl)}, env_key = ${tomlString(config.apiKeyEnv)}, wire_api = "responses" } }`
  return Object.freeze([
    'app-server',
    '--stdio',
    '-c', `model_provider=${tomlString(config.id)}`,
    '-c', `model_providers=${provider}`,
    '-c', 'analytics.enabled=false',
  ])
}

class SpawnedCodexAppServer implements CodexAppServerRpc {
  readonly generation = randomUUID()
  private closed = false
  private readonly rpc: JsonLineRpcClient

  constructor(private readonly child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    child.stderr.resume()
    this.rpc = new JsonLineRpcClient({
      input: child.stdout,
      output: child.stdin,
      timeoutMs,
    })
    child.once('error', error => this.rpc.close(`Codex app-server process failed: ${error.message}`))
    child.once('exit', (code, signal) => {
      this.rpc.close(`Codex app-server exited (${code === null ? signal ?? 'unknown' : String(code)})`)
    })
  }

  request<Result>(method: string, params: unknown, signal?: AbortSignal): Promise<Result> {
    return this.rpc.request<Result>(method, params, signal)
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

/** Start one provider-specific, CODEX_HOME-isolated stable App Server client. */
export async function startCodexAppServer(
  config: CliProxyProviderConfig,
  options: CodexAppServerOptions = {},
): Promise<CodexAppServerRpc> {
  const environment = options.environment ?? process.env
  if (environment[config.apiKeyEnv]?.trim() === '') throw new Error(`provider ${config.id} credential environment variable is empty`)
  if (environment[config.apiKeyEnv] === undefined) throw new Error(`provider ${config.id} credential environment variable is not set`)
  await mkdir(config.codexHome, { recursive: true, mode: 0o700 })
  const launch = options.spawnProcess ?? spawn
  const child = launch(config.codexExecutable, codexAppServerArguments(config), {
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
