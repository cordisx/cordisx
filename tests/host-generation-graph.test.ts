import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { transform } from 'esbuild'
import {
  buildHostGenerationGraph,
  type HostGenerationGraph,
} from '../packages/cli/src/launcher/host-generation-graph.js'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'

let graphs: HostGenerationGraph[] = []
let cacheRoots: string[] = []

afterEach(async () => {
  await Promise.all(graphs.map(async graph => await graph.close()))
  await Promise.all(cacheRoots.map(async root => await rm(root, { recursive: true, force: true })))
  graphs = []
  cacheRoots = []
})

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-host-graph-cache-'))
  cacheRoots.push(root)
  return root
}

const config = {
  version: 1 as const,
  rootDir: process.cwd(),
  projectRoot: process.cwd(),
  configRoot: process.cwd(),
  codex: { debugPort: 9229 },
  providers: [],
  plugins: [],
}

function graphOrigin(source: string): string {
  const origin = source.match(/http:\/\/127\.0\.0\.1:\d+\/cordisx-host-generation\/[a-f0-9]{64}/u)?.[0]
  if (origin === undefined) throw new Error('Host graph origin is unavailable')
  return origin
}

describe('Host generation graph', () => {
  it('keys the stable graph by configuration and plugin artifact while excluding launch tokens', async () => {
    const root = await cacheRoot()
    const entry = path.join(root, 'plugin.js')
    await writeFile(entry, 'export default {}\n')
    const configured = (pluginConfig: string, artifact: string) => ({
      ...config,
      rootDir: root,
      projectRoot: root,
      configRoot: root,
      plugins: [{
        id: 'fixture',
        entry,
        enabled: true,
        config: { value: pluginConfig },
        moduleFactorySource: `var __cordisxPluginModule = { marker: ${JSON.stringify(artifact)} }`,
      }],
    })
    const first = await buildRendererCompositionSource(configured('stable-a', 'artifact-a'), {
      providerBridgeToken: 'launch-token-a',
    })
    const newLaunch = await buildRendererCompositionSource(configured('stable-a', 'artifact-a'), {
      providerBridgeToken: 'launch-token-b',
      certifiedPermissionChannelToken: 'future-document-token',
    })
    const changedConfig = await buildRendererCompositionSource(configured('stable-b', 'artifact-a'))
    const changedArtifact = await buildRendererCompositionSource(configured('stable-a', 'artifact-b'))

    expect(newLaunch.hostGraphStableIdentity).toBe(first.hostGraphStableIdentity)
    expect(changedConfig.hostGraphStableIdentity).not.toBe(first.hostGraphStableIdentity)
    expect(changedArtifact.hostGraphStableIdentity).not.toBe(first.hostGraphStableIdentity)
    expect(first.hostGraphStableIdentity).not.toContain('launch-token-a')
    expect(first.hostGraphLaunchSource).toContain('launch-token-a')
    expect(newLaunch.hostGraphLaunchSource).toContain('future-document-token')
  })

  it('serves only a bounded manifest bootloader and an exact entry graph', async () => {
    const root = await cacheRoot()
    const [graph, shared] = await Promise.all([
      buildHostGenerationGraph(config, { providerBridgeToken: 'first-launch-token' }, { cacheRoot: root }),
      buildHostGenerationGraph(config, {
        providerBridgeToken: 'second-launch-token',
        certifiedPermissionChannelToken: 'future-document-token',
      }, { cacheRoot: root }),
    ])
    graphs.push(graph, shared)

    expect([graph.cacheStatus, shared.cacheStatus].sort()).toEqual(['built', 'memory'])
    expect(Buffer.byteLength(graph.bootloader)).toBeLessThan(16 * 1024)
    expect(graph.bootloader).toContain('__cordisxCompositionBoot')
    const manifest = await fetch(graph.manifestUrl)
    expect(manifest.status).toBe(200)
    const value = await manifest.json() as { readonly entry: string; readonly digest: string }
    expect(value.entry).toMatch(/^\/host-[A-Za-z0-9_-]+\.js$/u)
    expect(value.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(await fetch(graph.entryUrl).then(response => response.status)).toBe(200)
    expect(await fetch(graph.entryUrl).then(response => response.text())).toContain('./launch.js')
    await expect(
      fetch(`${graphOrigin(graph.bootloader)}/launch.js`)
        .then(async response => await response.text())
        .then(async source => await transform(source, { loader: 'js', format: 'esm', target: 'chrome120' })),
    ).resolves.toMatchObject({ code: expect.stringContaining('bootCordisXComposition') })
    expect(graph.files.some(file => file.path === value.entry)).toBe(true)
    const graphBase = new URL('.', graph.manifestUrl)
    const source = (await Promise.all(
      graph.files
        .filter(file => file.path.endsWith('.js'))
        .map(async file => await fetch(new URL(file.path.slice(1), graphBase)).then(response => response.text())),
    )).join('\n')
    expect(source.match(/<line\b/gu)?.length).toBeGreaterThanOrEqual(1_440)
    // Accounting is intentionally observable. Its current value is not a
    // phase-2 pass criterion; feature-boundary reduction belongs to phase 3.
    expect(graph.eagerBytes).toBeGreaterThan(0)

    const reused = await buildHostGenerationGraph(config, { providerBridgeToken: 'third-launch-token' }, {
      cacheRoot: root,
    })
    graphs.push(reused)
    expect(reused.cacheStatus).toBe('disk')
    expect(graph.authoritySource()).toContain('first-launch-token')
    expect(graph.authoritySource()).not.toContain('second-launch-token')
    expect(shared.authoritySource()).toContain('second-launch-token')
    expect(shared.authoritySource()).toContain('future-document-token')
    expect(reused.authoritySource()).toContain('third-launch-token')

    const cacheFiles = await readdir(root)
    expect(cacheFiles).toHaveLength(1)
    const cacheFile = path.join(root, cacheFiles[0]!)
    const cachedSource = await readFile(cacheFile, 'utf8')
    expect(cachedSource).not.toContain('first-launch-token')
    expect(cachedSource).not.toContain('second-launch-token')
    expect(cachedSource).not.toContain('third-launch-token')
    expect(cachedSource).not.toContain('future-document-token')

    await writeFile(cacheFile, '{"schemaVersion":1,"corrupt":true}', { mode: 0o600 })
    const recovered = await buildHostGenerationGraph(config, {}, { cacheRoot: root })
    graphs.push(recovered)
    expect(recovered.cacheStatus).toBe('recovered')
  })

  it('closes initial and rebuilt production graphs through one idempotent lifecycle owner', async () => {
    const composition = await buildRendererComposition(config, () => undefined, {
      productionGraph: true,
      productionGraphCacheRoot: await cacheRoot(),
      certifiedPermissionChannelToken: 'future-document-token',
    })
    const initialManifest = composition.source.match(/http:\/\/127\.0\.0\.1:\d+\/[^";]+\/manifest\.json/u)?.[0]
    expect(composition.newDocumentSource).toBeDefined()
    expect(composition.source).not.toContain('future-document-token')
    expect(composition.authoritySource()).not.toContain('future-document-token')
    expect(await fetch(`${graphOrigin(composition.source)}/launch.js`).then(response => response.text())).not.toContain(
      'future-document-token',
    )
    expect(
      await fetch(`${graphOrigin(composition.newDocumentSource!)}/launch.js`).then(response => response.text()),
    ).toContain('future-document-token')
    const rebuilt = await composition.rebuild(config, {
      version: 1,
      revision: 0,
      generation: 'test-generation',
      plugins: [],
    }, 0)
    const rebuiltManifest = rebuilt.source.match(/http:\/\/127\.0\.0\.1:\d+\/[^";]+\/manifest\.json/u)?.[0]
    expect(initialManifest).toBeDefined()
    expect(rebuiltManifest).toBeDefined()
    await expect(fetch(initialManifest!)).resolves.toMatchObject({ status: 200 })
    await expect(fetch(rebuiltManifest!)).resolves.toMatchObject({ status: 200 })

    await composition.close()
    await composition.close()

    await expect(fetch(initialManifest!, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()
    await expect(fetch(rebuiltManifest!, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()
  }, 30_000)
})
