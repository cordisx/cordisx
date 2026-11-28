import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createSessionPluginGraphProjection,
  type SessionPluginGraphProjection,
} from '../../packages/cli/src/independent-manager/plugin-graph-projection.js'
import {
  type PluginGenerationArtifactServer,
  type PluginGenerationGraphLease,
  startPluginGenerationArtifactServer,
} from '../../packages/cli/src/launcher/plugin-generation-artifact-server.js'

export const directories = new Set<string>()
const servers = new Set<PluginGenerationArtifactServer>()
export const projections = new Set<SessionPluginGraphProjection>()
const managerOrigin = 'http://127.0.0.1:43123'

export async function cleanup(): Promise<void> {
  for (const projection of projections) projection.close()
  projections.clear()
  await Promise.all([...servers].map(async server => await server.close()))
  servers.clear()
  // Chrome's child processes can finish flushing the isolated profile just
  // after the browser exits, especially on a busy CI runner.
  await Promise.all(
    [...directories].map(async directory =>
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    ),
  )
  directories.clear()
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export async function fixture(): Promise<{
  readonly directory: string
  readonly server: PluginGenerationArtifactServer
  readonly lease: PluginGenerationGraphLease
  readonly module: string
  readonly chunk: string
  readonly style: string
  readonly image: string
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-independent-graph-'))
  directories.add(directory)
  await mkdir(path.join(directory, 'assets'))
  await mkdir(path.join(directory, 'chunks'))
  const module =
    "export function apply() { globalThis.__fixturePluginMounted = true }\nexport const load = () => import('./chunks/lazy.js')\n"
  const chunk = 'export const value = 2\n'
  const style = '.icon { background-image: url(./pixel.svg); color: rgb(1, 2, 3) }\n'
  const image = '<svg xmlns="http://www.w3.org/2000/svg"><script>globalThis.svgExecuted = true</script></svg>\n'
  const files = [
    {
      path: './assets/base.css',
      kind: 'stylesheet',
      mediaType: 'text/css',
      digest: digest(style),
      byteLength: Buffer.byteLength(style),
      assets: ['./assets/pixel.svg'],
    },
    {
      path: './assets/pixel.svg',
      kind: 'asset',
      mediaType: 'image/svg+xml',
      digest: digest(image),
      byteLength: Buffer.byteLength(image),
    },
    {
      path: './chunks/lazy.js',
      kind: 'module',
      mediaType: 'text/javascript',
      digest: digest(chunk),
      byteLength: Buffer.byteLength(chunk),
      imports: [],
      dynamicImports: [],
      styles: [],
      assets: [],
    },
    {
      path: './module.js',
      kind: 'module',
      mediaType: 'text/javascript',
      digest: digest(module),
      byteLength: Buffer.byteLength(module),
      imports: [],
      dynamicImports: ['./chunks/lazy.js'],
      styles: ['./assets/base.css'],
      assets: [],
    },
  ]
  await Promise.all([
    writeFile(path.join(directory, 'module.js'), module),
    writeFile(path.join(directory, 'chunks/lazy.js'), chunk),
    writeFile(path.join(directory, 'assets/base.css'), style),
    writeFile(path.join(directory, 'assets/pixel.svg'), image),
    writeFile(
      path.join(directory, 'artifact.json'),
      JSON.stringify({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-generation-artifact.v1.schema.json',
        contract: 'cordisx.plugin-generation-artifact/v1',
        schemaVersion: 1,
        format: 'browser-esm-graph',
        entry: './module.js',
        initialStyles: ['./assets/base.css'],
        sharedImports: [],
        files,
      }),
    ),
  ])
  const server = await startPluginGenerationArtifactServer()
  servers.add(server)
  const lease = await server.lease({
    packageIdentity: {
      pluginId: 'graph-fixture',
      version: '1.0.0',
      integrity: `sha256:${'a'.repeat(64)}`,
    },
    artifactDirectory: directory,
    runtimeEntry: './module.js',
  }, 'generation-1')
  return { directory, server, lease, module, chunk, style, image }
}

export function projection(
  server: PluginGenerationArtifactServer,
  fetchOverride?: typeof fetch,
): SessionPluginGraphProjection {
  const result = createSessionPluginGraphProjection({
    managerOrigin,
    artifactServer: server,
    ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
  })
  projections.add(result)
  return result
}

export function target(url: string): string {
  return new URL(url).pathname
}
