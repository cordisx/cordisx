import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLocalDevelopmentPlugin } from '../packages/cli/src/launcher/development.js'
import {
  PLUGIN_PACKAGE_SCHEMA_V7,
  PLUGIN_PACKAGE_SCHEMA_V8,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8,
} from '../packages/cli/src/launcher/packages/manifest.js'

const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map(async root => await rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function fixture(version: 7 | 8, declarationSchema = version === 7
  ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7
  : PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `cordisx-local-dev-v${version}-`))
  roots.add(root)
  const id = version === 8 ? 'chatroom' : 'canvas-v7'
  const entry = path.join(root, `${id}.ts`)
  const runtime = version === 8
    ? {
        $schema: PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8,
        schemaVersion: 8,
        id,
        name: 'Chatroom',
        capabilities: [{
          name: 'approvals.answer',
          required: false,
          scope: { authorityRequester: { kind: 'approval-authority-requester-route', requester: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } } },
        }],
        services: [],
      }
    : {
        $schema: PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7,
        schemaVersion: 7,
        id,
        capabilities: [],
        services: [],
        execution: { realm: 'isolated-worker', interfaces: ['ui.transient-canvas/v1'] },
      }
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await mkdir(root, { recursive: true })
  await Promise.all([
    writeFile(path.join(root, 'package.json'), JSON.stringify({ name: `${id}-fixture`, version: '0.1.0', type: 'module' })),
    writeFile(entry, 'export function apply() {}\n'),
    writeFile(path.join(root, 'runtime-manifest.json'), runtimeText),
    writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify({
      $schema: version === 7 ? PLUGIN_PACKAGE_SCHEMA_V7 : PLUGIN_PACKAGE_SCHEMA_V8,
      schemaVersion: version,
      id,
      version: '0.1.0',
      entry: `./${id}.ts`,
      canonicalSource: 'https://github.com/cordisx/plugin-chatroom',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      compatibility: { runtimeAbi: 1, protocolSchemas: [declarationSchema] },
      dependencies: [],
      runtimeManifest: {
        path: './runtime-manifest.json',
        schema: declarationSchema,
        digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
      },
    }, null, 2)}\n`),
  ])
  return entry
}

describe('local development package v7/v8 runtime-manifest validation', () => {
  it('accepts the Chatroom-shaped V8 correlated-authority package into the production local-dev runtime path', async () => {
    const build = await buildLocalDevelopmentPlugin(await fixture(8))
    expect(build).toMatchObject({
      id: 'chatroom',
      manifest: { schemaVersion: 8, id: 'chatroom', capabilities: [{ name: 'approvals.answer' }] },
    })
    expect(build.runtimeArtifactSource).toContain('__cordisxPendingPluginModuleFactoryV1')
  })

  it('keeps the V7 predecessor accepted and rejects cross-version or malformed declarations before build', async () => {
    await expect(buildLocalDevelopmentPlugin(await fixture(7))).resolves.toMatchObject({
      id: 'canvas-v7', manifest: { schemaVersion: 7 },
    })
    await expect(buildLocalDevelopmentPlugin(await fixture(7, PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8)))
      .rejects.toThrow('local development runtimeManifest declaration is invalid')
    await expect(buildLocalDevelopmentPlugin(await fixture(8, PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7)))
      .rejects.toThrow('local development runtimeManifest declaration is invalid')
  })
})
