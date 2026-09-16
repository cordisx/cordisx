import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHostGenerationGraph,
  type HostGenerationGraph,
} from '../packages/cli/src/launcher/host-generation-graph.js'

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
})
