import { createHash } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import {
  createSessionPluginGraphProjection,
  MAX_SESSION_PLUGIN_GRAPH_GENERATIONS,
  type SessionPluginGraphProjection,
} from '../packages/cli/src/independent-manager/plugin-graph-projection.js'
import {
  MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES,
  type PluginGenerationArtifactServer,
  type PluginGenerationGraphLease,
  resourceRegistryInstallSource,
  startPluginGenerationArtifactServer,
} from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { createStandaloneRuntimeGraph } from '../packages/cli/src/launcher/standalone-runtime-graph.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
} from '../packages/cli/src/contracts.js'

const directories = new Set<string>()
const servers = new Set<PluginGenerationArtifactServer>()
const projections = new Set<SessionPluginGraphProjection>()
const managerOrigin = 'http://127.0.0.1:43123'

afterEach(async () => {
  for (const projection of projections) projection.close()
  projections.clear()
  await Promise.all([...servers].map(async server => await server.close()))
  servers.clear()
  await Promise.all([...directories].map(async directory => await rm(directory, { recursive: true, force: true })))
  directories.clear()
})

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function fixture(): Promise<{
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

function projection(
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

function target(url: string): string {
  return new URL(url).pathname
}

function chromeExecutable(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...(process.env.PATH ?? '').split(path.delimiter).flatMap(directory =>
      ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].map(name => path.join(directory, name))
    ),
  ]
  return candidates.find(candidate => {
    if (candidate === undefined || !path.isAbsolute(candidate)) return false
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

describe('independent renderer plugin graph projection', () => {
  it('projects verified JS, relative lazy imports, CSS and images into distinct non-cacheable sessions', async () => {
    const input = await fixture()
    const first = projection(input.server)
    const second = projection(input.server)
    const graph = first.project(input.lease, () => true)
    const otherGraph = second.project(input.lease, () => true)
    expect(first.project(input.lease, () => true)).toBe(graph)
    expect(otherGraph.baseUrl).not.toBe(graph.baseUrl)
    expect(graph.importSource).toContain(graph.entryUrl)
    expect(graph.importSource).toContain(graph.initialStyleUrls[0])
    expect(graph.importSource).not.toContain(input.lease.baseUrl)
    expect(graph.publishSource).toBe(input.lease.publishSource)
    expect(graph.retireSource).toBe(input.lease.retireSource)

    const expected = [
      [graph.entryUrl, input.module, 'text/javascript'],
      [new URL('./chunks/lazy.js', graph.entryUrl).href, input.chunk, 'text/javascript'],
      [graph.initialStyleUrls[0]!, input.style, 'text/css'],
      [new URL('./pixel.svg', graph.initialStyleUrls[0]).href, input.image, 'image/svg+xml'],
    ] as const
    for (const [url, value, media] of expected) {
      const response = await first.resolve({ method: 'GET', target: target(url) })
      expect(response.status).toBe(200)
      expect(new TextDecoder().decode(response.body)).toBe(value)
      expect(response.headers).toMatchObject({
        'content-type': media,
        'cache-control': 'private, no-store, max-age=0',
        'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
      })
      expect(response.headers).not.toHaveProperty('etag')
      expect((await second.resolve({ method: 'GET', target: target(url) })).status).toBe(404)
    }
    const head = await first.resolve({ method: 'HEAD', target: target(graph.entryUrl) })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(input.module)))
    expect(head.body).toBeUndefined()
  })

  it('rejects path normalization, encoded traversal, absolute URLs, unknown files and methods before proxying', async () => {
    const input = await fixture()
    const session = projection(input.server)
    const graph = session.project(input.lease, () => true)
    const base = target(graph.baseUrl)
    const cases = [
      `${base}../module.js`,
      `${base}a/../module.js`,
      `${base}%2e%2e/module.js`,
      `${base}%252e%252e/module.js`,
      `${base}a%2fmodule.js`,
      `${base}a\\module.js`,
      `${base}//module.js`,
      `${base}module.js?x=1`,
      `${base}module.js#x`,
      `${base}.hidden.js`,
      `${base}module.json`,
      graph.entryUrl,
      '//example.com/module.js',
    ]
    for (const candidate of cases) {
      expect((await session.resolve({ method: 'GET', target: candidate })).status, candidate).toBe(404)
    }
    expect((await session.resolve({ method: 'POST', target: target(graph.entryUrl) })).status).toBe(405)
    expect(input.server.requestTrace()).toEqual([])
  })

  it('rejects addresses outside the configured artifact server and invalid lease source layouts', async () => {
    const input = await fixture()
    const session = projection(input.server)
    expect(() =>
      session.project({
        ...input.lease,
        baseUrl: input.lease.baseUrl.replace(input.server.origin, 'http://127.0.0.1:1'),
      }, () => true)
    ).toThrow('plugin-graph-lease-invalid')
    expect(() =>
      session.project({
        ...input.lease,
        entryUrl: `${input.lease.baseUrl}%2e%2e/module.js`,
      }, () => true)
    ).toThrow('plugin-graph-lease-invalid')
    expect(() =>
      session.project({
        ...input.lease,
        importSource: 'not a valid lease expression',
      }, () => true)
    ).toThrow('plugin-graph-lease-invalid')
    expect(() =>
      createSessionPluginGraphProjection({
        managerOrigin: 'http://example.com:8000',
        artifactServer: input.server,
      })
    ).toThrow('plugin-graph-origin-invalid')
    expect(input.server.requestTrace()).toEqual([])
  })

  it('does not follow redirects or accept incorrect MIME and unbounded bodies', async () => {
    const input = await fixture()
    const responders = [
      () => new Response(null, { status: 302, headers: { location: 'http://example.com/' } }),
      () => new Response('bad', { headers: { 'content-type': 'text/html', 'content-length': '3' } }),
      () => new Response('bad', { headers: { 'content-type': 'text/javascript' } }),
      () =>
        new Response('bad', {
          headers: {
            'content-type': 'text/javascript',
            'content-length': String(MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES + 1),
          },
        }),
      () => new Response('bad', { headers: { 'content-type': 'text/javascript', 'content-length': '1' } }),
    ]
    for (const responder of responders) {
      const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
        expect(options?.redirect).toBe('error')
        expect(options?.credentials).toBe('omit')
        return responder()
      }) as typeof fetch
      const session = projection(input.server, fetcher)
      const graph = session.project(input.lease, () => true)
      const response = await session.resolve({ method: 'GET', target: target(graph.entryUrl) })
      expect(response.status).toBe(404)
      expect(response.headers).not.toHaveProperty('location')
      expect(fetcher).toHaveBeenCalledOnce()
    }
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true
      },
    })
    const fetcher = vi.fn(async () =>
      new Response(stream, {
        headers: { 'content-type': 'text/html', 'content-length': '100' },
      })
    ) as typeof fetch
    const session = projection(input.server, fetcher)
    const graph = session.project(input.lease, () => true)
    expect((await session.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(404)
    expect(cancelled).toBe(true)
  })

  it('revokes one projection without retiring a shared lease, and rejects closed or stale sessions', async () => {
    const input = await fixture()
    const first = projection(input.server)
    const second = projection(input.server)
    let current = true
    const graph = first.project(input.lease, () => current)
    const other = second.project(input.lease, () => true)
    current = false
    expect((await first.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(404)
    current = true
    expect((await first.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(404)
    expect(() => first.project(input.lease, () => true)).toThrow('plugin-graph-lease-stale')
    graph.retire()
    expect((await first.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(404)
    expect((await second.resolve({ method: 'GET', target: target(other.entryUrl) })).status).toBe(200)
    second.close()
    expect((await second.resolve({ method: 'GET', target: target(other.entryUrl) })).status).toBe(404)
    expect(() => second.project(input.lease, () => true)).toThrow('plugin-graph-session-closed')
  })

  it('bounds active graphs and retired generation tombstones together', async () => {
    const input = await fixture()
    const session = projection(input.server)
    const generatedLease = (number: number): PluginGenerationGraphLease => {
      const id = number.toString(16).padStart(64, '0')
      const change = (value: string) => value.replaceAll(input.lease.leaseId, id)
      return {
        ...input.lease,
        leaseId: id,
        baseUrl: change(input.lease.baseUrl),
        entryUrl: change(input.lease.entryUrl),
        initialStyleUrls: input.lease.initialStyleUrls.map(change),
        importSource: change(input.lease.importSource),
      }
    }
    for (let number = 0; number < MAX_SESSION_PLUGIN_GRAPH_GENERATIONS; number++) {
      // This tests bookkeeping only: no fabricated lease is ever fetched.
      const graph = session.project(generatedLease(number), () => true)
      if (number % 2 === 0) graph.retire()
    }
    expect(() => session.project(generatedLease(MAX_SESSION_PLUGIN_GRAPH_GENERATIONS), () => true))
      .toThrow('plugin-graph-session-limit')
    expect(input.server.requestTrace()).toEqual([])
  })

  it('aborts an in-flight fetch and never returns bytes after the session is revoked', async () => {
    const input = await fixture()
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => release = resolve)
    const began = new Promise<void>(resolve => started = resolve)
    let signal: AbortSignal | null | undefined
    const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      signal = options?.signal
      started()
      await waiting // Deliberately ignore cancellation as an adversarial transport.
      return new Response('data', { headers: { 'content-type': 'text/javascript', 'content-length': '4' } })
    }) as typeof fetch
    const session = projection(input.server, fetcher)
    const graph = session.project(input.lease, () => true)
    const pending = session.resolve({ method: 'GET', target: target(graph.entryUrl) })
    await began
    graph.retire()
    expect(signal?.aborted).toBe(true)
    release()
    expect((await pending).status).toBe(404)
  })

  it('honors the artifact server integrity check after a verified file changes', async () => {
    const input = await fixture()
    const session = projection(input.server)
    const graph = session.project(input.lease, () => true)
    await writeFile(path.join(input.directory, 'module.js'), 'export const modified = true\n')
    const result = await session.resolve({ method: 'GET', target: target(graph.entryUrl) })
    expect(result.status).toBe(404)
    expect(result.body).toBeUndefined()
    expect(input.server.requestTrace().at(-1)?.status).toBe(409)
  })

  it('discards a partially read body if the owner revokes the generation', async () => {
    const input = await fixture()
    let continueStream!: () => void
    let firstChunk!: () => void
    const firstRead = new Promise<void>(resolve => firstChunk = resolve)
    const resume = new Promise<void>(resolve => continueStream = resolve)
    const fetcher = vi.fn(async () => {
      let chunk = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (chunk++ === 0) {
            controller.enqueue(new TextEncoder().encode('aa'))
            firstChunk()
          } else {
            await resume
            controller.enqueue(new TextEncoder().encode('bb'))
            controller.close()
          }
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/javascript', 'content-length': '4' } })
    }) as typeof fetch
    const session = projection(input.server, fetcher)
    let current = true
    const graph = session.project(input.lease, () => current)
    const pending = session.resolve({ method: 'GET', target: target(graph.entryUrl) })
    await firstRead
    current = false
    continueStream()
    const result = await pending
    expect(result.status).toBe(404)
    expect(result.body).toBeUndefined()
  })

  it('actively cancels a blocked response reader on projection retirement', async () => {
    const input = await fixture()
    let readingNext!: () => void
    let cancelled!: () => void
    const blocked = new Promise<void>(resolve => readingNext = resolve)
    const didCancel = new Promise<void>(resolve => cancelled = resolve)
    const fetcher = vi.fn(async () => {
      let chunk = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (chunk++ === 0) controller.enqueue(new TextEncoder().encode('aa'))
            else {
              readingNext()
              await new Promise<void>(() => undefined)
            }
          },
          cancel() {
            cancelled()
          },
        }),
        { headers: { 'content-type': 'text/javascript', 'content-length': '4' } },
      )
    }) as typeof fetch
    const session = projection(input.server, fetcher)
    const graph = session.project(input.lease, () => true)
    const pending = session.resolve({ method: 'GET', target: target(graph.entryUrl) })
    await blocked
    graph.retire()
    await didCancel
    expect((await pending).status).toBe(404)
  })

  it('loads a projected native ESM graph and CSS under strict CSP in an isolated browser', async () => {
    const chrome = chromeExecutable()
    if (chrome === undefined) return
    const input = await fixture()
    const profile = await mkdtemp(path.join(os.tmpdir(), 'cordisx-projection-browser-'))
    directories.add(profile)
    let session: SessionPluginGraphProjection | undefined
    let bootstrap = ''
    let hostBundle = ''
    // This fixture explicitly bypasses authentication to test the resource
    // responses only. Production must authenticate and select its session first.
    const http = createServer((request, response) => {
      if (request.url === '/' || request.url === '/host') {
        response.setHeader(
          'content-security-policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'",
        )
        response.setHeader('content-type', 'text/html')
        response.end(
          request.url === '/'
            ? '<!doctype html><title>Projection fixture</title><div class="icon">fixture</div><script type="module" src="/bootstrap.js"></script>'
            : '<!doctype html><title>Owner Host fixture</title><script type="module" src="/host-entry.js"></script>',
        )
        return
      }
      if (request.url === '/bootstrap.js') {
        response.setHeader('content-type', 'text/javascript')
        response.end(bootstrap)
        return
      }
      if (request.url === '/host.js') {
        response.setHeader('content-type', 'text/javascript')
        response.end(hostBundle)
        return
      }
      if (request.url === '/host-entry.js') {
        response.setHeader('content-type', 'text/javascript')
        response.end(`import { startStandaloneManagerComposition } from '/host.js';
          globalThis.__beforeOwnerStart = { runtime: !!globalThis.__cordisxRuntime, plugin: !!globalThis.__fixturePluginMounted };
          await startStandaloneManagerComposition(new AbortController().signal);`)
        return
      }
      if (request.url === '/manager-host.css') {
        response.setHeader('content-type', 'text/css')
        response.end('')
        return
      }
      void (async () => {
        const result = await session!.resolve({ method: request.method ?? '', target: request.url ?? '' })
        response.writeHead(result.status, result.headers)
        response.end(result.body)
      })().catch(() => response.destroy())
    })
    let browser: ChildProcess | undefined
    let cdp: CdpClient | undefined
    try {
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
      const manager = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
      session = createSessionPluginGraphProjection({ managerOrigin: manager, artifactServer: input.server })
      projections.add(session)
      const graph = session.project(input.lease, () => true)
      const { leaseId, pluginId, moduleGeneration, baseUrl, entryUrl, initialStyleUrls } = graph
      const descriptor = { leaseId, pluginId, moduleGeneration, baseUrl, entryUrl, initialStyleUrls }
      const loaderPath = path.resolve('packages/cli/src/independent-manager/graph-stage-loader.ts')
      const bundle = await build({
        stdin: {
          contents: `import { createManagerRendererGraphLoader } from ${JSON.stringify(loaderPath)};
            ${resourceRegistryInstallSource()};
            const descriptor = ${JSON.stringify(descriptor)};
            const graphLoader = createManagerRendererGraphLoader({
              origin: location.origin, registry: globalThis.__cordisxPluginGenerationResourcesV1, initialGraphs: [],
            });
            const previous = { profileId: 'fixture', runtimeGeneration: 'owner-1', plugins: [] };
            const candidate = { ...previous, plugins: [{ id: descriptor.pluginId, enabled: true, moduleGeneration: descriptor.moduleGeneration }] };
            const rendererId = 'a'.repeat(64);
            const stage = await graphLoader.load({ rendererId, operation: 'install', targetId: descriptor.pluginId,
              previous, candidate, affectedPluginIds: [descriptor.pluginId], graphs: [descriptor] },
              { rendererId, profileId: 'fixture', generation: 'owner-1', signal: new AbortController().signal });
            await stage.publish();
            const lazy = await stage.modules[descriptor.pluginId].load();
            globalThis.__projectionResult = { value: lazy.value, color: getComputedStyle(document.querySelector('.icon')).color };`,
          resolveDir: process.cwd(),
          sourcefile: 'projection-bootstrap.ts',
          loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        write: false,
      })
      bootstrap = bundle.outputFiles[0]!.text
      const digest = `sha256:${'a'.repeat(64)}` as const
      const activationItem = {
        id: pluginId,
        version: '1.0.0',
        digest,
        moduleGeneration,
        enabled: true,
        dependencies: [],
      }
      const active = {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1 as const,
        recordKind: 'active' as const,
        profileId: 'fixture',
        revision: 1,
        lastGoodRevision: 1,
        runtimeGeneration: 'owner-1',
        plugins: [activationItem],
      }
      const manifest = {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1 as const,
        id: pluginId,
        name: 'Graph fixture',
        capabilities: [],
      }
      const config = {
        version: 1 as const,
        rootDir: path.resolve('.'),
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [{
          id: pluginId,
          entry: path.join(input.directory, 'module.js'),
          enabled: true,
          config: {},
          manifest,
          package: { version: '1.0.0', digest, moduleGeneration, dependencies: [] },
          runtimeGraph: createStandaloneRuntimeGraph(descriptor, manager),
        }],
      }
      hostBundle = await buildRendererBundle(config, {
        managerPresentationMode: 'standalone',
        standaloneOwner: {
          rendererId: 'e'.repeat(64),
          profileId: 'fixture',
          generation: 'owner-1',
          managerOrigin: manager,
          isCurrent: () => true,
        },
        profileId: 'fixture',
        generation: 'owner-1',
        pluginActivation: active,
        initialRegistryEpoch: 0,
        permission: { profileId: 'fixture', policies: [] },
      })
      const launched = launchChrome(chrome, profile)
      browser = launched.browser
      cdp = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
      await cdp.send('Page.enable')
      await cdp.send('Page.navigate', { url: manager })
      await expect.poll(() => cdp!.evaluate('document.readyState')).toBe('complete')
      await expect.poll(() => cdp!.evaluate('globalThis.__projectionResult ?? null'))
        .toEqual({ value: 2, color: 'rgb(1, 2, 3)' })
      await expect.poll(() => input.server.requestTrace().some(item => item.artifactPath === './assets/pixel.svg'))
        .toBe(true)
      // Load the generated owner-scoped Host as an external same-origin script.
      // Dynamic Host style elements remain a separate CSP/visual limitation.
      await cdp.send('Page.navigate', { url: manager + '/host' })
      await expect.poll(() => cdp!.evaluate('document.documentElement.dataset.cordisxReady')).toBe('true')
      expect(await cdp.evaluate('globalThis.__beforeOwnerStart')).toEqual({ runtime: false, plugin: false })
      expect(await cdp.evaluate('globalThis.__fixturePluginMounted === true')).toBe(true)
      expect(await cdp.evaluate('document.querySelector("[data-manager-surface=standalone]") !== null')).toBe(true)
      // Opening a projected SVG as a document must not give it script execution.
      await cdp.send('Page.navigate', { url: new URL('./pixel.svg', graph.initialStyleUrls[0]).href })
      await expect.poll(() => cdp!.evaluate('document.readyState')).toBe('complete')
      expect(await cdp.evaluate('globalThis.svgExecuted === true')).toBe(false)
    } finally {
      await cdp?.close()
      if (browser !== undefined) await stopChrome(browser)
      http.closeAllConnections()
      await new Promise<void>(resolve => http.close(() => resolve()))
    }
  }, 60_000)
})
