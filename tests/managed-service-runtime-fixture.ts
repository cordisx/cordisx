import type { PluginManifestManagedBackendServiceV14 } from '@cordisx/protocol/plugin-manifest/v14'
import { createHash } from 'node:crypto'
import type { ManagedServiceDefinitionV1, ManagedServiceOwnerV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ManagedServiceRuntime,
  type ManagedServiceRuntimeOptions,
} from '../packages/cli/src/launcher/managed-service-runtime.js'
import { ManagedServiceSchemaRegistry } from '../packages/cli/src/launcher/managed-service-schema.js'

export const DEFINITION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-definition.v1.schema.json'
export const MODELS_SCHEMA = 'https://schemas.example.test/models.v1.json'
export const SOURCES_SCHEMA = 'https://schemas.example.test/sources.v1.json'

const CONFIG_JSON = '{"sources":null,"model":"gateway-model","port":null}\n'

function sha256(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

const serverSource = `#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
const configFlag = process.argv.indexOf('--config')
const config = configFlag < 0 ? undefined : JSON.parse(await readFile(process.argv[configFlag + 1], 'utf8'))
const port = Number(config?.port ?? process.argv[2])
const token = process.env.SERVICE_TOKEN
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + token) {
    response.writeHead(401).end()
    return
  }
  if (request.url === '/health') {
    response.writeHead(204).end()
    return
  }
  if (request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ models: [{ id: config?.model ?? 'model-one' }] }))
    return
  }
  response.writeHead(404).end()
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

const portFileServerSource = `#!/usr/bin/env node
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
const token = process.env.SERVICE_TOKEN
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + token) return response.writeHead(401).end()
  response.writeHead(request.url === '/health' ? 204 : 404).end()
})
server.listen(0, '127.0.0.1', async () => {
  const address = server.address()
  if (address === null || typeof address === 'string') process.exit(2)
  await writeFile(path.join(process.env.HOME, 'service.port'), String(address.port))
  await writeFile(path.join(process.env.HOME, 'environment.json'), JSON.stringify({
    home: process.env.HOME,
    declaredServiceHomeFile: process.env.SERVICE_HOME_FILE,
    authRoot: process.env.SYNTHETIC_AUTH_ROOT,
  }))
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

export function owner(pluginId: string, pluginGeneration: string): ManagedServiceOwnerV1 {
  return {
    ownerHandle: `mso_${pluginId}_${pluginGeneration}`,
    pluginId,
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    hostGeneration: 'host-one',
    pluginGeneration,
  }
}

export function declaration(
  id: string,
  pluginId: string,
  grants: readonly { readonly pluginId: string; readonly operations: readonly string[] }[],
): PluginManifestManagedBackendServiceV14 {
  return {
    id,
    kind: 'managed-backend',
    owner: 'host',
    entry: `./${id}.mjs`,
    definitionSchema: DEFINITION_SCHEMA,
    runtimeResources: [
      {
        path: './server.mjs',
        mode: 'executable',
        byteLength: Buffer.byteLength(serverSource),
        digest: sha256(serverSource),
      },
      {
        path: './port-file-server.mjs',
        mode: 'executable',
        byteLength: Buffer.byteLength(portFileServerSource),
        digest: sha256(portFileServerSource),
      },
      {
        path: './config.json',
        mode: 'data',
        byteLength: Buffer.byteLength(CONFIG_JSON),
        digest: sha256(CONFIG_JSON),
      },
    ],
    consumerGrants: grants,
  }
}

export function definition(
  serviceId: string,
  options: {
    readonly assignedInConfiguration?: boolean
    readonly configured?: boolean
    readonly fixedPort?: number
    readonly hostSecret?: boolean
  } = {},
): ManagedServiceDefinitionV1 {
  return {
    $schema: DEFINITION_SCHEMA,
    contract: 'cordisx.managed-service-definition/v1',
    schemaVersion: 1,
    serviceId,
    launch: {
      executable: { kind: 'package-relative', path: './server.mjs' },
      arguments: options.assignedInConfiguration || options.fixedPort !== undefined
        ? []
        : [{ kind: 'host-assigned-loopback', serialization: 'port' }],
      startupTimeoutMs: 5_000,
    },
    ...(options.configured
      ? {
        configuration: {
          template: './config.json',
          format: 'json',
          delivery: { kind: 'generation-private-process-file', argument: '--config' },
        },
      }
      : {}),
    compositionOrigins: [{ id: 'api', path: '/v1' }],
    protectedBindings: options.configured
      ? [
        {
          slot: 'sources',
          source: 'composition',
          target: 'configuration',
          pointer: '/sources',
          valueSchema: SOURCES_SCHEMA,
        },
        { slot: 'target_key', source: 'generated-local-key', target: 'environment', variable: 'SERVICE_TOKEN' },
        ...(options.assignedInConfiguration
          ? [{
            slot: 'listen_port',
            source: 'host-assigned-loopback' as const,
            target: 'configuration' as const,
            pointer: '/port' as const,
            serialization: 'port' as const,
          }]
          : []),
      ]
      : [{
        slot: 'service_key',
        source: options.hostSecret ? 'host-secret' : 'generated-local-key',
        target: 'environment',
        variable: 'SERVICE_TOKEN',
      }],
    authentication: { mode: 'none' },
    httpAuthentication: {
      mode: 'authorization-header',
      scheme: 'Bearer',
      slot: options.configured ? 'target_key' : 'service_key',
    },
    discovery: options.fixedPort === undefined
      ? { kind: 'host-assigned-loopback' }
      : { kind: 'fixed-loopback', port: options.fixedPort },
    operations: [{
      operationId: 'models.list',
      method: 'GET',
      path: '/v1/models',
      responseSchema: MODELS_SCHEMA,
      timeoutMs: 2_000,
    }],
    health: { path: '/health', intervalMs: 250, timeoutMs: 500 },
  }
}

export function cliDefinition(serviceId: string, timeoutMs = 5_000): ManagedServiceDefinitionV1 {
  const authenticatedAction = {
    executable: { kind: 'named-command' as const, command: 'synthetic-auth' },
    arguments: [] as const,
    timeoutMs,
    outcomes: [{ exitCode: 0, state: 'authenticated' as const }],
  }
  const logoutAction = {
    executable: { kind: 'named-command' as const, command: 'synthetic-auth' },
    arguments: [] as const,
    timeoutMs,
    outcomes: [{ exitCode: 0, state: 'authentication-required' as const }],
  }
  return {
    ...definition(serviceId, { fixedPort: 41_231 }),
    authentication: {
      mode: 'cli',
      status: authenticatedAction,
      login: authenticatedAction,
      refresh: authenticatedAction,
      logout: logoutAction,
    },
  }
}

export function restrictedPortDefinition(serviceId: string): ManagedServiceDefinitionV1 {
  return {
    ...definition(serviceId, { fixedPort: 41_231 }),
    launch: {
      executable: { kind: 'package-relative', path: './port-file-server.mjs' },
      arguments: [],
      startupTimeoutMs: 5_000,
    },
    discovery: {
      kind: 'restricted-port-file',
      root: 'service-home',
      file: './service.port',
      format: 'decimal-port',
    },
  }
}

export function syntheticChild(options: { readonly exitOnKill?: NodeJS.Signals } = {}): {
  readonly child: ChildProcess
  readonly signals: NodeJS.Signals[]
  readonly exit: (code: number) => void
  readonly fail: (error: Error) => void
} {
  const emitter = new EventEmitter() as EventEmitter & {
    pid: number | undefined
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill(signal?: NodeJS.Signals): boolean
  }
  const signals: NodeJS.Signals[] = []
  emitter.pid = 12_345
  emitter.exitCode = null
  emitter.signalCode = null
  const exit = (code: number): void => {
    emitter.exitCode = code
    emitter.emit('exit', code, null)
  }
  emitter.kill = (signal = 'SIGTERM') => {
    signals.push(signal)
    if (signal === options.exitOnKill) {
      queueMicrotask(() => {
        emitter.signalCode = signal
        emitter.emit('exit', null, signal)
      })
    }
    return true
  }
  return {
    child: emitter as unknown as ChildProcess,
    signals,
    exit,
    fail: error => emitter.emit('error', error),
  }
}

export async function fixture(): Promise<{ readonly root: string; readonly home: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-service-'))
  const home = path.join(root, 'home')
  await writeFile(path.join(root, 'server.mjs'), serverSource)
  await chmod(path.join(root, 'server.mjs'), 0o700)
  await writeFile(path.join(root, 'port-file-server.mjs'), portFileServerSource)
  await chmod(path.join(root, 'port-file-server.mjs'), 0o700)
  await writeFile(path.join(root, 'config.json'), CONFIG_JSON)
  return { root, home }
}

export function schemaRegistry(): ManagedServiceSchemaRegistry {
  return new ManagedServiceSchemaRegistry({
    schemas: {
      [MODELS_SCHEMA]: {
        $id: MODELS_SCHEMA,
        type: 'object',
        additionalProperties: false,
        required: ['models'],
        properties: {
          models: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id'],
              properties: { id: { type: 'string' } },
            },
          },
        },
      },
      [SOURCES_SCHEMA]: {
        $id: SOURCES_SCHEMA,
        type: 'object',
        additionalProperties: false,
        required: ['id', 'baseUrl', 'apiKey'],
        properties: {
          id: { type: 'string' },
          baseUrl: { type: 'null' },
          apiKey: { type: 'null' },
        },
      },
    },
  })
}

export function runtime(
  homeDir: string,
  options: Omit<ManagedServiceRuntimeOptions, 'homeDir'> = {},
): ManagedServiceRuntime {
  return new ManagedServiceRuntime({
    resolveSecret: async () => 'shared-borrowed-token',
    schemas: schemaRegistry(),
    ...options,
    homeDir,
  })
}

export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => resolve = done), resolve }
}
