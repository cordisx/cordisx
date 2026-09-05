import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadPluginGenerationArtifact,
  loadPluginGenerationArtifactForRuntime,
  MAX_PLUGIN_RUNTIME_MODULE_BYTES,
  parsePluginGenerationArtifactV1,
  type PluginGenerationArtifactServer,
  startPluginGenerationArtifactServer,
} from '../packages/cli/src/launcher/plugin-generation-loader.js'

const temporary = new Set<string>()
const servers = new Set<PluginGenerationArtifactServer>()

afterEach(async () => {
  await Promise.all([...servers].map(async server => await server.close()))
  servers.clear()
  await Promise.all([...temporary].map(async directory => await rm(directory, { recursive: true, force: true })))
  temporary.clear()
})

async function artifactDirectory(source = 'export const value = 1\n'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-generation-loader-'))
  temporary.add(root)
  await mkdir(path.join(root, 'artifact'))
  await writeFile(path.join(root, 'artifact', 'module.js'), source)
  return path.join(root, 'artifact')
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function graphArtifact(initialStyles: readonly string[] = ['./assets/base.css']): Promise<{
  readonly directory: string
  readonly module: string
  readonly chunk: string
  readonly style: string
  readonly asset: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-generation-graph-'))
  temporary.add(root)
  const directory = path.join(root, 'artifact')
  await mkdir(path.join(directory, 'chunks'), { recursive: true })
  await mkdir(path.join(directory, 'assets'), { recursive: true })
  const module = "export const value = 1\nexport const load = () => import('./chunks/lazy-a1.js')\n"
  const chunk =
    'globalThis.__fixtureLazyExecutions = (globalThis.__fixtureLazyExecutions ?? 0) + 1\nexport const lazy = 2\n'
  const style = '.fixture { background-image: url(./pixel.svg); color: red }\n'
  const asset = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n'
  const files = [
    {
      path: './assets/base.css',
      kind: 'stylesheet',
      mediaType: 'text/css',
      digest: sha256(style),
      byteLength: Buffer.byteLength(style),
      assets: ['./assets/pixel.svg'],
    },
    {
      path: './assets/pixel.svg',
      kind: 'asset',
      mediaType: 'image/svg+xml',
      digest: sha256(asset),
      byteLength: Buffer.byteLength(asset),
    },
    {
      path: './chunks/lazy-a1.js',
      kind: 'module',
      mediaType: 'text/javascript',
      digest: sha256(chunk),
      byteLength: Buffer.byteLength(chunk),
      imports: [],
      dynamicImports: [],
      styles: ['./assets/base.css'],
      assets: [],
    },
    {
      path: './module.js',
      kind: 'module',
      mediaType: 'text/javascript',
      digest: sha256(module),
      byteLength: Buffer.byteLength(module),
      imports: [],
      dynamicImports: ['./chunks/lazy-a1.js'],
      styles: [...initialStyles],
      assets: [],
    },
  ]
  await Promise.all([
    writeFile(path.join(directory, 'module.js'), module),
    writeFile(path.join(directory, 'chunks/lazy-a1.js'), chunk),
    writeFile(path.join(directory, 'assets/base.css'), style),
    writeFile(path.join(directory, 'assets/pixel.svg'), asset),
    writeFile(
      path.join(directory, 'artifact.json'),
      `${
        JSON.stringify(
          {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-generation-artifact.v1.schema.json',
            contract: 'cordisx.plugin-generation-artifact/v1',
            schemaVersion: 1,
            format: 'browser-esm-graph',
            entry: './module.js',
            initialStyles,
            sharedImports: [],
            files,
          },
          null,
          2,
        )
      }\n`,
    ),
  ])
  return { directory, module, chunk, style, asset }
}

function accessFor(directory: string) {
  return {
    packageIdentity: {
      pluginId: 'graph-fixture',
      version: '1.0.0',
      integrity: `sha256:${'a'.repeat(64)}` as const,
    },
    artifactDirectory: directory,
    runtimeEntry: './module.js' as const,
  }
}

describe('plugin generation loader', () => {
  it('loads a bounded immutable browser module', async () => {
    const directory = await artifactDirectory()
    const loaded = await loadPluginGenerationArtifact({
      artifactDirectory: directory,
      runtimeEntry: './module.js',
    })

    expect(loaded).toContain('__cordisxPendingPluginModuleFactoryV1')
    expect(loaded).toContain('value')
  })

  it('rejects a regular file above the generic 24 MiB ceiling before reading it', async () => {
    const directory = await artifactDirectory('')
    await truncate(path.join(directory, 'module.js'), MAX_PLUGIN_RUNTIME_MODULE_BYTES + 1)

    await expect(loadPluginGenerationArtifact({
      artifactDirectory: directory,
      runtimeEntry: './module.js',
    })).rejects.toThrow('runtime module entry is not a bounded regular file')
  })

  it('keeps the legacy factory API while projecting graph packages as browser leases', async () => {
    const legacyDirectory = await artifactDirectory()
    const server = await startPluginGenerationArtifactServer()
    servers.add(server)
    await expect(loadPluginGenerationArtifactForRuntime(
      accessFor(legacyDirectory),
      'legacy-generation',
      server,
    )).resolves.toMatchObject({ kind: 'legacy-factory' })

    const graph = await graphArtifact([])
    const loaded = await loadPluginGenerationArtifactForRuntime(
      accessFor(graph.directory),
      'graph-generation',
      server,
    )
    expect(loaded.kind).toBe('browser-esm-graph')
    if (loaded.kind !== 'browser-esm-graph') throw new Error('graph loader returned a legacy artifact')
    expect(loaded.lease.entryUrl).toContain('/module.js')
    expect(loaded.runtimeArtifactSource).toContain('await import(')
    expect(loaded.lease.publishSource).toContain('.publish(')
    expect(loaded.lease.retireSource).toContain('.retire(')
  })

  it('rejects graph manifests with unknown fields, undeclared entries, or invalid initial styles', () => {
    const valid = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-generation-artifact.v1.schema.json',
      contract: 'cordisx.plugin-generation-artifact/v1',
      schemaVersion: 1,
      format: 'browser-esm-graph',
      entry: './module.js',
      initialStyles: [],
      sharedImports: [],
      files: [{
        path: './module.js',
        kind: 'module',
        mediaType: 'text/javascript',
        digest: `sha256:${'a'.repeat(64)}`,
        byteLength: 10,
        imports: [],
        dynamicImports: [],
        styles: [],
        assets: [],
      }],
    }
    expect(parsePluginGenerationArtifactV1(valid)).toMatchObject({ entry: './module.js' })
    expect(() => parsePluginGenerationArtifactV1({ ...valid, authority: 'renderer' }))
      .toThrow('authority is unsupported')
    expect(() => parsePluginGenerationArtifactV1({ ...valid, files: [] }))
      .toThrow('file lists are invalid')
    expect(() => parsePluginGenerationArtifactV1({ ...valid, initialStyles: ['./module.js'] }))
      .toThrow('initialStyles')
    expect(() => parsePluginGenerationArtifactV1({ ...valid, sharedImports: ['react-dom', 'react'] }))
      .toThrow('sharedImports must be closed, unique, and sorted')
    expect(() =>
      parsePluginGenerationArtifactV1({
        ...valid,
        files: [{
          ...valid.files[0],
          dynamicImports: ['./chunks/missing.js'],
        }],
      })
    ).toThrow('references a missing or incompatible file')
  })

  it('stages, publishes, retires, and tombstones generation-owned stylesheet links', async () => {
    const graph = await graphArtifact()
    const server = await startPluginGenerationArtifactServer()
    servers.add(server)
    const loaded = await loadPluginGenerationArtifactForRuntime(accessFor(graph.directory), 'style-generation', server)
    if (loaded.kind !== 'browser-esm-graph') throw new Error('graph loader returned a legacy artifact')
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'dangerously',
      url: 'https://codex.local/native',
    })
    const pending = dom.window.eval(loaded.runtimeArtifactSource) as Promise<unknown>
    await Promise.resolve()
    const registry = (dom.window as unknown as {
      __cordisxPluginGenerationResourcesV1: {
        stage(input: { id: string; baseUrl: string; initialStyles: readonly string[] }): unknown
        publish(id: string): boolean
        retire(id: string): boolean
        dispose(): void
      }
    }).__cordisxPluginGenerationResourcesV1
    const initial = dom.window.document.querySelector<HTMLLinkElement>(
      `link[data-cordisx-plugin-generation="${loaded.lease.leaseId}"]`,
    )
    expect(initial?.media).toBe('not all')
    expect(dom.window.eval(loaded.lease.publishSource)).toBe(true)
    expect(initial?.hasAttribute('media')).toBe(false)
    initial?.dispatchEvent(new dom.window.Event('load'))
    await pending.catch(() => undefined)
    expect(initial?.isConnected).toBe(false)
    expect(dom.window.eval(loaded.lease.retireSource)).toBe(true)
    const id = 'style-lifecycle'
    const styleBaseUrl = 'https://assets.example/style-lifecycle/'
    registry.stage({ id, baseUrl: styleBaseUrl, initialStyles: [] })
    const staged = dom.window.document.createElement('link')
    staged.rel = 'stylesheet'
    staged.href = new URL('assets/lazy.css', styleBaseUrl).href
    dom.window.document.head.append(staged)
    await new Promise(resolve => dom.window.queueMicrotask(resolve))
    expect(staged.media).toBe('not all')
    expect(registry.publish(id)).toBe(true)
    expect(staged.hasAttribute('media')).toBe(false)
    const sibling = dom.window.document.createElement('link')
    sibling.rel = 'stylesheet'
    sibling.href = new URL('assets/sibling.css', styleBaseUrl).href
    dom.window.document.head.append(sibling)
    await new Promise(resolve => dom.window.queueMicrotask(resolve))
    const remove = staged.remove.bind(staged)
    Object.defineProperty(staged, 'remove', { configurable: true, value: () => undefined })
    expect(() => registry.retire(id)).toThrow('stylesheet retirement failed')
    expect(staged.isConnected).toBe(true)
    expect(staged.disabled).toBe(true)
    expect(staged.media).toBe('not all')
    expect(sibling.isConnected).toBe(false)
    Object.defineProperty(staged, 'remove', { configurable: true, value: remove })
    expect(registry.retire(id)).toBe(true)
    expect(staged.isConnected).toBe(false)
    const late = dom.window.document.createElement('link')
    late.rel = 'stylesheet'
    late.href = new URL('assets/late.css', styleBaseUrl).href
    dom.window.document.head.append(late)
    await new Promise(resolve => dom.window.queueMicrotask(resolve))
    expect(late.isConnected).toBe(false)
    expect(late.disabled).toBe(true)
    expect(late.media).toBe('not all')
    registry.dispose()
    expect(() => dom.window.eval(loaded.lease.retireSource)).toThrow('plugin generation resource retirement failed')
    dom.window.close()
  })
})

describe('plugin generation artifact HTTP server', () => {
  it('rejects source references that disagree with an otherwise integrity-valid graph', async () => {
    const graph = await graphArtifact([])
    const source = 'export const load = () => import(globalThis.__untrustedPluginUrl)\n'
    const artifactPath = path.join(graph.directory, 'artifact.json')
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
      files: Array<{ path: string; digest: string; byteLength: number }>
    }
    const entry = artifact.files.find(file => file.path === './module.js')
    if (entry === undefined) throw new Error('graph fixture entry is missing')
    entry.digest = sha256(source)
    entry.byteLength = Buffer.byteLength(source)
    await Promise.all([
      writeFile(path.join(graph.directory, 'module.js'), source),
      writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`),
    ])
    const server = await startPluginGenerationArtifactServer()
    servers.add(server)

    await expect(server.lease(accessFor(graph.directory), 'computed-reference'))
      .rejects.toThrow('contains a computed module import')
    expect(server.requestTrace()).toEqual([])
  })

  it('records entry-only startup, first-trigger lazy resources, and a cached second trigger', async () => {
    const graph = await graphArtifact([])
    const server = await startPluginGenerationArtifactServer()
    servers.add(server)
    const lease = await server.lease(accessFor(graph.directory), 'lazy-evidence')
    expect(server.requestTrace()).toEqual([])

    await expect(fetch(lease.entryUrl).then(response => response.text())).resolves.toBe(graph.module)
    expect(server.requestTrace().map(request => request.artifactPath)).toEqual(['./module.js'])

    const moduleCache = new Map<string, unknown>()
    const trigger = async (): Promise<unknown> => {
      const cached = moduleCache.get('./chunks/lazy-a1.js')
      if (cached !== undefined) return cached
      const chunkResponse = await fetch(new URL('chunks/lazy-a1.js', lease.baseUrl))
      const chunkSource = await chunkResponse.text()
      const styleResponse = await fetch(new URL('assets/base.css', lease.baseUrl))
      await styleResponse.text()
      await fetch(new URL('assets/pixel.svg', lease.baseUrl)).then(response => response.arrayBuffer())
      Function(chunkSource.replace('export const lazy = 2', 'return 2'))()
      const loaded = { lazy: 2 }
      moduleCache.set('./chunks/lazy-a1.js', loaded)
      return loaded
    }
    delete (globalThis as { __fixtureLazyExecutions?: number }).__fixtureLazyExecutions
    await expect(trigger()).resolves.toEqual({ lazy: 2 })
    expect((globalThis as { __fixtureLazyExecutions?: number }).__fixtureLazyExecutions).toBe(1)
    const firstTriggerTrace = server.requestTrace().map(request => request.artifactPath)
    expect(firstTriggerTrace).toEqual([
      './module.js',
      './chunks/lazy-a1.js',
      './assets/base.css',
      './assets/pixel.svg',
    ])

    await expect(trigger()).resolves.toEqual({ lazy: 2 })
    expect((globalThis as { __fixtureLazyExecutions?: number }).__fixtureLazyExecutions).toBe(1)
    expect(server.requestTrace().map(request => request.artifactPath)).toEqual(firstTriggerTrace)
    delete (globalThis as { __fixtureLazyExecutions?: number }).__fixtureLazyExecutions

    lease.retire()
    await expect(fetch(new URL('chunks/lazy-a1.js', lease.baseUrl)).then(response => response.status)).resolves.toBe(
      404,
    )
  })

  it('serves only verified allowlisted files and retires a generation route', async () => {
    const graph = await graphArtifact()
    const server = await startPluginGenerationArtifactServer()
    servers.add(server)
    const lease = await server.lease(accessFor(graph.directory), 'http-generation')
    const secondLease = await server.lease(accessFor(graph.directory), 'http-generation')
    expect(secondLease.baseUrl).not.toBe(lease.baseUrl)
    secondLease.retire()

    const entry = await fetch(lease.entryUrl)
    expect(entry.status).toBe(200)
    expect(entry.headers.get('content-type')).toBe('text/javascript')
    expect(entry.headers.get('cache-control')).toContain('immutable')
    expect(entry.headers.get('access-control-allow-origin')).toBe('*')
    expect(entry.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(entry.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(entry.text()).resolves.toBe(graph.module)

    const chunkUrl = new URL('chunks/lazy-a1.js', lease.baseUrl)
    const head = await fetch(chunkUrl, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(graph.chunk)))
    await expect(head.text()).resolves.toBe('')
    await expect(fetch(new URL('chunks/undeclared.js', lease.baseUrl)).then(response => response.status)).resolves.toBe(
      404,
    )
    await expect(fetch(`${lease.entryUrl}?cache-bust=1`).then(response => response.status)).resolves.toBe(404)
    await expect(fetch(lease.entryUrl, { method: 'POST' }).then(response => response.status)).resolves.toBe(405)

    await writeFile(path.join(graph.directory, 'chunks/lazy-a1.js'), graph.chunk.replace('2', '3'))
    await expect(fetch(chunkUrl).then(response => response.status)).resolves.toBe(409)
    lease.retire()
    await expect(fetch(lease.entryUrl).then(response => response.status)).resolves.toBe(404)
    expect(server.requestTrace()).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', artifactPath: './module.js', status: 200 }),
      expect.objectContaining({ method: 'HEAD', artifactPath: './chunks/lazy-a1.js', status: 200 }),
      expect.objectContaining({ method: 'GET', artifactPath: './chunks/lazy-a1.js', status: 409 }),
    ]))
  })
})
