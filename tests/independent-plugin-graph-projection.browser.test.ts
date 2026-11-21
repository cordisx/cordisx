import { accessSync, constants } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, directories, fixture, projections } from './fixtures/independent-plugin-graph.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import {
  createSessionPluginGraphProjection,
  type SessionPluginGraphProjection,
} from '../packages/cli/src/independent-manager/plugin-graph-projection.js'
import { resourceRegistryInstallSource } from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { createStandaloneRuntimeGraph } from '../packages/cli/src/launcher/standalone-runtime-graph.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
} from '../packages/cli/src/contracts.js'

afterEach(cleanup)

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

describe('independent renderer plugin graph projection in a browser', () => {
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
