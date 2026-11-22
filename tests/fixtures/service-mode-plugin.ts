import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PluginLifecycleCoordinator } from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import { allowedDecisionV4 } from '../../packages/cli/src/launcher/plugin-lifecycle-model.js'
import {
  PLUGIN_PACKAGE_SCHEMA_V14,
  PLUGIN_PACKAGE_SCHEMA_V15,
} from '../../packages/cli/src/launcher/packages/manifest.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V15,
} from '../../packages/cli/src/launcher/latest-runtime-manifest.js'
import { CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1 } from '../../packages/cli/src/plugin-lifecycle-contracts.js'
import { declaration, definition } from '../managed-service-runtime-fixture.js'

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
export const backend = String.raw`#!/usr/bin/env node
import { createServer } from 'node:http'
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.SERVICE_TOKEN) return response.writeHead(401).end()
  if (request.url === '/health') return response.writeHead(204).end()
  if (request.method !== 'POST' || !['/v1/responses', '/v1/messages'].some(path => request.url.startsWith(path))) {
    return response.writeHead(404).end()
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks))
  if (body.input === 'hold-open-fixture') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: fixture-ready\n\n')
    return
  }
  if (request.url.startsWith('/v1/messages')) {
    response.setHeader('content-type', 'application/json')
    return response.end(JSON.stringify({
      id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'local fixture response' }], stop_reason: 'end_turn',
      stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }))
  }
  if (body.stream) {
    const message = {
      id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'local fixture response', annotations: [] }],
    }
    const completed = {
      id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: body.model,
      output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    const events = [
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: completed },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
    return response.end()
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({model: body.model, output_text: 'local fixture', pid: process.pid, port: server.address().port}))
})
server.listen(Number(process.argv[2]), '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
const authHelper = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const marker = path.join(process.env.HOME, 'fixture-authenticated')
const action = process.argv[2]
appendFileSync(path.join(process.env.HOME, 'fixture-auth-actions'), action + '\n')
if (action === 'login') writeFileSync(marker, 'ready')
if (action === 'logout' && existsSync(marker)) unlinkSync(marker)
process.exit(existsSync(marker) ? 0 : 1)
`

export async function stageServiceModePlugin(
  root: string,
  homeDir: string,
  profileId: string,
  withService: boolean,
  canonicalSource: string | null = 'https://example.test/fixtures',
  browserSource = 'export function apply() { throw new Error("Desktop fixture must never activate") }',
  options: {
    readonly version?: 14 | 15
    readonly uiPoints?: readonly string[]
    readonly authentication?: boolean
    readonly logout?: boolean
  } = {},
) {
  const id = withService ? 'fixture-service' : 'fixture-desktop'
  const dir = path.join(root, id)
  await mkdir(dir)
  const routes = [{ alias: 'fixture', gatewayModelId: 'fixture-model' }]
  const catalog = {
    generation: 'fixture',
    digest: digest(JSON.stringify(['fixture', 'fixture', [['fixture', 'fixture-model']]])),
    defaultAlias: 'fixture',
    routes,
  }
  const authAction = (action: string) => ({
    executable: { kind: 'package-relative' as const, path: './auth.mjs' as const },
    arguments: [action],
    timeoutMs: 5_000,
    outcomes: [
      { exitCode: 0, state: 'authenticated' as const },
      { exitCode: 1, state: 'authentication-required' as const },
    ],
  })
  const value = {
    ...definition('gateway'),
    ...(options.authentication
      ? {
        authentication: {
          mode: 'cli' as const,
          status: authAction('status'),
          login: authAction('login'),
          ...(options.logout ? { logout: authAction('logout') } : {}),
        },
      }
      : {}),
  }
  const version = options.version ?? 14
  const registration = `
export async function apply(ctx, input) {
  const handle = await ctx.managedServices.register(${JSON.stringify(value)}, { revision: '${
    digest(JSON.stringify(value))
  }' })
  ctx.effect(() => () => handle.dispose())
  ${
    version === 15 || options.authentication ? '' : `
  const ready = await handle.ensureReady({ signal: input.signal })
  if (ready.status !== 'ready') throw new Error('Fixture did not start')
  const result = await handle.publishNativeProvider({
    providerId: 'fixture-provider', compositionOrigin: 'api', catalog: ${JSON.stringify(catalog)}
  })
  if (result.status !== 'accepted') throw new Error('Fixture publication was rejected')
  `
  }
}
apply.inject = ['managedServices']
`
  const service = version === 14 ? registration : `${registration}
export async function prepare(ctx, input) {
  const ready = await input.registration.ensureReady({ signal: input.signal })
  if (ready.status !== 'ready') throw new Error('Fixture did not start')
  await input.startup.reportCatalog({
    contract: 'cordisx.startup-catalog-report/v1',
    target: { pluginId: input.owner.pluginId, capabilityId: input.capability.id },
    generation: input.generation, sequence: 1,
    catalog: { state: 'known', generation: 'fixture', modelIds: ['fixture'], digest: '${
    digest(JSON.stringify(['fixture', ['fixture']]))
  }' },
  })
  const result = await input.registration.publishNativeProvider({
    providerId: input.capability.providerId, compositionOrigin: 'api', catalog: ${JSON.stringify(catalog)}
  })
  if (result.status !== 'accepted') throw new Error('Fixture publication was rejected')
}
`
  const runtimeSchema = version === 15 ? CORDISX_PLUGIN_MANIFEST_SCHEMA_V15 : CORDISX_PLUGIN_MANIFEST_SCHEMA_V14
  const runtime = JSON.stringify({
    $schema: runtimeSchema,
    schemaVersion: version,
    id,
    capabilities: options.uiPoints === undefined ? [] : [{
      name: 'ui.extension-points.render',
      required: true,
      scope: { extensionPoints: options.uiPoints },
    }],
    services: withService
      ? [{
        ...declaration('gateway', id, []),
        runtimeResources: [
          {
            path: './server.mjs',
            mode: 'executable',
            byteLength: Buffer.byteLength(backend),
            digest: digest(backend),
          },
          ...(options.authentication
            ? [{
              path: './auth.mjs',
              mode: 'executable',
              byteLength: Buffer.byteLength(authHelper),
              digest: digest(authHelper),
            }]
            : []),
        ],
      }]
      : [],
    ...(version === 15
      ? {
        startup: {
          contract: 'cordisx.startup-declaration/v1',
          pages: [],
          capabilities: withService
            ? [{
              id: 'provider',
              serviceId: 'gateway',
              kind: 'provider',
              providerId: 'fixture-provider',
              compositionOrigin: 'api',
              dependsOn: [],
              milestones: [],
              wait: { interactive: 'background', command: 'when-selected' },
              success: {
                allOf: [{ kind: 'service-ready' }, { kind: 'catalog-known' }, { kind: 'provider-published' }],
              },
            }]
            : [],
        },
      }
      : {}),
  })
  await Promise.all([
    writeFile(
      path.join(dir, 'index.mjs'),
      browserSource,
    ),
    writeFile(path.join(dir, 'gateway.mjs'), service),
    writeFile(path.join(dir, 'server.mjs'), backend, { mode: 0o755 }),
    ...(options.authentication ? [writeFile(path.join(dir, 'auth.mjs'), authHelper, { mode: 0o755 })] : []),
    writeFile(path.join(dir, 'runtime.json'), runtime),
    writeFile(
      path.join(dir, 'cordisx-package.json'),
      JSON.stringify({
        $schema: version === 15 ? PLUGIN_PACKAGE_SCHEMA_V15 : PLUGIN_PACKAGE_SCHEMA_V14,
        schemaVersion: version,
        id,
        version: '1.0.0',
        ...(canonicalSource === null ? {} : { canonicalSource }),
        entry: './index.mjs',
        distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
        compatibility: { runtimeAbi: 1, protocolSchemas: [runtimeSchema] },
        dependencies: [],
        runtimeManifest: {
          path: './runtime.json',
          schema: runtimeSchema,
          digest: digest(runtime),
        },
      }),
    ),
  ])
  const runtimeGeneration = 'offline-fixture'
  const coordinator = new PluginLifecycleCoordinator({
    homeDir,
    profileId,
    runtimeGeneration,
    permissionPolicies: [],
    runtime: { async stage() {}, async commit() {}, async abort() {}, async reload() {} },
  })
  const active = await coordinator.store.bindRuntimeGeneration()
  const identity = { requestId: crypto.randomUUID(), profileId, runtimeGeneration, expectedRevision: active.revision }
  const staged = await coordinator.handle({
    $schema: CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
    schemaVersion: 1,
    ...identity,
    operation: { kind: 'inspect-local', sourceDirectory: dir },
  })
  if (staged.outcome !== 'planned' || !staged.candidateId) throw new Error(JSON.stringify(staged))
  const plan = await coordinator.permissionReviewPlanV4({
    ...identity,
    target: { kind: 'candidate', candidateId: staged.candidateId },
  })
  if (!plan || options.uiPoints === undefined && plan.declarations.some(declaration => declaration.decisionRequired)) {
    throw new Error('Unexpected fixture permission review')
  }
  const applied = await coordinator.applyPermissionReviewV4({
    ...identity,
    requestId: crypto.randomUUID(),
    decision: allowedDecisionV4(plan),
  })
  if (applied.outcome !== 'applied') throw new Error(JSON.stringify(applied))
}
