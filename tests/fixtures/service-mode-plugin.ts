import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PluginLifecycleCoordinator } from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import { allowedDecisionV4 } from '../../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { PLUGIN_PACKAGE_SCHEMA_V14 } from '../../packages/cli/src/launcher/packages/manifest.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 } from '../../packages/cli/src/launcher/latest-runtime-manifest.js'
import { CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1 } from '../../packages/cli/src/plugin-lifecycle-contracts.js'
import { declaration, definition } from '../managed-service-runtime-fixture.js'

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
export const backend = `#!/usr/bin/env node
import { createServer } from 'node:http'
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.SERVICE_TOKEN) return response.writeHead(401).end()
  if (request.url === '/health') return response.writeHead(204).end()
  if (request.method !== 'POST' || !request.url.startsWith('/v1/responses')) return response.writeHead(404).end()
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks))
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({model: body.model, output_text: 'local fixture', pid: process.pid, port: server.address().port}))
})
server.listen(Number(process.argv[2]), '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

export async function stageServiceModePlugin(
  root: string,
  homeDir: string,
  profileId: string,
  withService: boolean,
  canonicalSource: string | null = 'https://example.test/fixtures',
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
  const value = definition('gateway')
  const service = `
export async function apply(ctx, input) {
  const handle = await ctx.managedServices.register(${JSON.stringify(value)}, { revision: '${
    digest(JSON.stringify(value))
  }' })
  ctx.effect(() => () => handle.dispose())
  const ready = await handle.ensureReady({ signal: input.signal })
  if (ready.status !== 'ready') throw new Error('Fixture did not start')
  const result = await handle.publishNativeProvider({
    providerId: 'fixture-provider', compositionOrigin: 'api', catalog: ${JSON.stringify(catalog)}
  })
  if (result.status !== 'accepted') throw new Error('Fixture publication was rejected')
}
apply.inject = ['managedServices']
`
  const runtime = JSON.stringify({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
    schemaVersion: 14,
    id,
    capabilities: [],
    services: withService
      ? [{
        ...declaration('gateway', id, []),
        runtimeResources: [{
          path: './server.mjs',
          mode: 'executable',
          byteLength: Buffer.byteLength(backend),
          digest: digest(backend),
        }],
      }]
      : [],
  })
  await Promise.all([
    writeFile(
      path.join(dir, 'index.mjs'),
      'export function apply() { throw new Error("Desktop fixture must never activate") }',
    ),
    writeFile(path.join(dir, 'gateway.mjs'), service),
    writeFile(path.join(dir, 'server.mjs'), backend, { mode: 0o755 }),
    writeFile(path.join(dir, 'runtime.json'), runtime),
    writeFile(
      path.join(dir, 'cordisx-package.json'),
      JSON.stringify({
        $schema: PLUGIN_PACKAGE_SCHEMA_V14,
        schemaVersion: 14,
        id,
        version: '1.0.0',
        ...(canonicalSource === null ? {} : { canonicalSource }),
        entry: './index.mjs',
        distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
        compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V14] },
        dependencies: [],
        runtimeManifest: {
          path: './runtime.json',
          schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
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
  if (!plan || plan.declarations.some(declaration => declaration.decisionRequired)) {
    throw new Error('Unexpected fixture permission review')
  }
  const applied = await coordinator.applyPermissionReviewV4({
    ...identity,
    requestId: crypto.randomUUID(),
    decision: allowedDecisionV4(plan),
  })
  if (applied.outcome !== 'applied') throw new Error(JSON.stringify(applied))
}
