import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHostGenerationGraph,
  type HostGenerationGraph,
} from '../packages/cli/src/launcher/host-generation-graph.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'

let graph: HostGenerationGraph | undefined

afterEach(async () => {
  await graph?.close()
  graph = undefined
})

describe('Host generation graph', () => {
  it('serves only a bounded manifest bootloader and an exact entry graph', async () => {
    graph = await buildHostGenerationGraph({
      version: 1,
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      configRoot: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    })

    expect(Buffer.byteLength(graph.bootloader)).toBeLessThan(16 * 1024)
    expect(graph.bootloader).toContain('__cordisxCompositionBoot')
    const manifest = await fetch(graph.manifestUrl)
    expect(manifest.status).toBe(200)
    const value = await manifest.json() as { readonly entry: string; readonly digest: string }
    expect(value.entry).toMatch(/^\/host-[A-Za-z0-9_-]+\.js$/u)
    expect(value.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(await fetch(graph.entryUrl).then(response => response.status)).toBe(200)
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
  })

  it('closes initial and rebuilt production graphs through one idempotent lifecycle owner', async () => {
    const config = {
      version: 1 as const,
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      configRoot: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    }
    const composition = await buildRendererComposition(config, () => undefined, { productionGraph: true })
    const initialManifest = composition.source.match(/http:\/\/127\.0\.0\.1:\d+\/[^";]+\/manifest\.json/u)?.[0]
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
