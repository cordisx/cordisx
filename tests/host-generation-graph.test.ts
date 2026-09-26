import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { transform } from 'esbuild'
import { init, parse } from 'es-module-lexer'
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
    const workspacePreview = await buildRendererCompositionSource(configured('stable-a', 'artifact-a'), {
      managerPresentationMode: 'workspace',
    })

    expect(newLaunch.hostGraphStableIdentity).toBe(first.hostGraphStableIdentity)
    expect(changedConfig.hostGraphStableIdentity).not.toBe(first.hostGraphStableIdentity)
    expect(changedArtifact.hostGraphStableIdentity).not.toBe(first.hostGraphStableIdentity)
    expect(workspacePreview.hostGraphStableIdentity).not.toBe(first.hostGraphStableIdentity)
    expect(first.metadataSource).not.toContain('managerPresentationMode')
    expect(workspacePreview.metadataSource).toContain('managerPresentationMode: "workspace"')
    expect(first.hostGraphStableIdentity).not.toContain('launch-token-a')
    expect(first.hostGraphLaunchSource).toContain('launch-token-a')
    expect(newLaunch.hostGraphLaunchSource).toContain('future-document-token')
  })

  it('serves only a bounded manifest bootloader and an exact entry graph', async () => {
    const root = await cacheRoot()
    const composition = await buildRendererCompositionSource(config)
    const legacyKey = createHash('sha256')
      .update('cordisx.host-generation-static.v1.deferred-boot\0')
      .update(composition.hostGraphStableIdentity)
      .digest('hex')
    const legacyBody = Buffer.from('export {}')
    const legacyFile = `${legacyKey}.json`
    // A valid pre-fix cache entry must not survive the export-contract change.
    await writeFile(
      path.join(root, legacyFile),
      JSON.stringify({
        schemaVersion: 1,
        key: legacyKey,
        entryFileName: 'host-legacy.js',
        files: [{
          path: '/host-legacy.js',
          contentType: 'text/javascript',
          bytes: legacyBody.length,
          sha256: createHash('sha256').update(legacyBody).digest('hex'),
          body: legacyBody.toString('base64'),
        }],
      }),
      { mode: 0o600 },
    )
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
    const entrySource = await fetch(graph.entryUrl).then(response => response.text())
    expect(entrySource).toContain('./launch.js')
    // Inspect the real Vite output, not a fixture that supplies the missing export.
    await init
    expect(parse(entrySource)[1].map(item => item.n)).toEqual(['boot'])
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
    expect(await fetch(reused.entryUrl).then(response => response.text())).toBe(entrySource)
    expect(graph.authoritySource()).toContain('first-launch-token')
    expect(graph.authoritySource()).not.toContain('second-launch-token')
    expect(shared.authoritySource()).toContain('second-launch-token')
    expect(shared.authoritySource()).toContain('future-document-token')
    expect(reused.authoritySource()).toContain('third-launch-token')

    expect(await readdir(root)).toContain(legacyFile)
    const cacheFiles = (await readdir(root)).filter(file => file !== legacyFile)
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
    const recoveredSource = await fetch(recovered.entryUrl).then(response => response.text())
    expect(parse(recoveredSource)[1].map(item => item.n)).toEqual(['boot'])
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

  it('invalidates a same-path cache entry when installed Host source content changes', async () => {
    const root = await cacheRoot()
    const sourceIdentityRoot = path.join(root, 'installed-cli-source')
    await mkdir(sourceIdentityRoot)
    const marker = path.join(sourceIdentityRoot, 'host.js')
    await writeFile(marker, 'export const revision = 1\n')

    const first = await buildHostGenerationGraph(config, {}, { cacheRoot: root, sourceIdentityRoot })
    const unchanged = await buildHostGenerationGraph(config, {}, { cacheRoot: root, sourceIdentityRoot })
    graphs.push(first, unchanged)
    expect(first.cacheStatus).toBe('built')
    expect(unchanged.cacheStatus).toBe('disk')

    await writeFile(marker, 'export const revision = 2\n')
    const changed = await buildHostGenerationGraph(config, {}, { cacheRoot: root, sourceIdentityRoot })
    const changedUnchanged = await buildHostGenerationGraph(config, {}, { cacheRoot: root, sourceIdentityRoot })
    graphs.push(changed, changedUnchanged)
    expect(changed.cacheStatus).toBe('built')
    expect(changedUnchanged.cacheStatus).toBe('disk')
  }, 30_000)
})
