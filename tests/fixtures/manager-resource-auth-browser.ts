import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createSessionPluginGraphProjection } from '../../packages/cli/src/independent-manager/plugin-graph-projection.js'
import { startPluginGenerationArtifactServer } from '../../packages/cli/src/launcher/plugin-generation-artifact-server.js'

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const contents = {
  './chunk.js': Buffer.from("export const value = 'nested'\n"),
  './font.woff2': Buffer.from('fixture-font-data'),
  './image.png': pixel,
  './module.js': Buffer.from("import { value } from './chunk.js'; export const result = 'module:' + value\n"),
  './theme.css': Buffer.from(
    "@font-face{font-family:probe;src:url('./font.woff2') format('woff2')} #background{background-image:url('./image.png')}",
  ),
} as const

const page = `
import { createManagerResourceAuthClient } from '/resource-auth-client.js'
let client
window.fixture = {
  async bind(token) {
    client = createManagerResourceAuthClient({
      window,
      sessionToken: token,
      isSessionCurrent: async () => (await fetch('/fixture/session', {
        headers: { authorization: 'Bearer ' + token }, cache: 'no-store'
      })).ok,
    })
    return await client.start()
  },
  recover: async () => await client.recover(),
  isBound: async () => await client.isBound(),
  revoke: async () => await client.revokeLocal(),
  async rawMessage(value) {
    const channel = new MessageChannel()
    return await new Promise(resolve => {
      channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data) }
      navigator.serviceWorker.controller.postMessage(value, [channel.port2])
    })
  },
  async read(url) {
    const result = await fetch(url, { cache: 'no-store' })
    return { status: result.status, text: await result.text() }
  },
  async render(base) {
    const module = await import(base + 'module.js')
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = base + 'theme.css'
    const css = new Promise(resolve => { link.onload = () => resolve(true); link.onerror = () => resolve(false) })
    document.head.append(link)
    const image = document.querySelector('#image')
    const loaded = new Promise(resolve => { image.onload = () => resolve(true); image.onerror = () => resolve(false) })
    image.src = base + 'image.png'
    const style = await css
    try { await document.fonts.load('16px probe') } catch {}
    return { module: module.result, css: style, image: await loaded }
  },
  async bundle() { return (await import('/api/renderer/bundle.js')).result },
}
`

export async function startManagerResourceFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-resource-'))
  const cleanup: Array<() => Promise<void>> = [async () => await rm(directory, { recursive: true, force: true })]
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    let failure: unknown
    for (const retire of [...cleanup].reverse()) {
      try {
        await retire()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
  try {
    const files = Object.entries(contents).map(([name, value]) => {
      const kind = name.endsWith('.js') ? 'module' : name.endsWith('.css') ? 'stylesheet' : 'asset'
      const mediaType = kind === 'module' ? 'text/javascript' : kind === 'stylesheet'
        ? 'text/css'
        : name.endsWith('.png')
        ? 'image/png'
        : 'font/woff2'
      return {
        path: name,
        kind,
        mediaType,
        digest: `sha256:${createHash('sha256').update(value).digest('hex')}`,
        byteLength: value.length,
        ...(kind === 'module'
          ? {
            imports: name === './module.js' ? ['./chunk.js'] : [],
            dynamicImports: [],
            styles: name === './module.js' ? ['./theme.css'] : [],
            assets: [],
          }
          : kind === 'stylesheet'
          ? { assets: ['./font.woff2', './image.png'] }
          : {}),
      }
    })
    await Promise.all(
      Object.entries(contents).map(async ([name, value]) => {
        await writeFile(path.join(directory, name), value)
      }),
    )
    await writeFile(
      path.join(directory, 'artifact.json'),
      JSON.stringify({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-generation-artifact.v1.schema.json',
        contract: 'cordisx.plugin-generation-artifact/v1',
        schemaVersion: 1,
        format: 'browser-esm-graph',
        entry: './module.js',
        initialStyles: ['./theme.css'],
        sharedImports: [],
        files,
      }),
    )
    const artifactServer = await startPluginGenerationArtifactServer()
    cleanup.push(async () => await artifactServer.close())
    const lease = await artifactServer.lease({
      packageIdentity: { pluginId: 'auth-fixture', version: '1', integrity: `sha256:${'a'.repeat(64)}` },
      artifactDirectory: directory,
      runtimeEntry: './module.js',
    }, 'generation')
    const clientBundle = await build({
      entryPoints: ['packages/cli/src/independent-manager/resource-auth-client.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    })
    const worker = await readFile('packages/cli/assets/manager/manager-resource-worker.js')
    const active = new Set(['A', 'B'])
    const events: Array<{ label: string; path: string; accepted: boolean }> = []
    let origin = ''
    let slow = false
    const projections = new Map<string, ReturnType<typeof createSessionPluginGraphProjection>>()
    cleanup.push(async () => {
      for (const projection of projections.values()) projection.close()
    })
    const server = createServer((request, response) => {
      void (async () => {
        const requestUrl = new URL(request.url ?? '/', origin)
        response.setHeader('cache-control', 'no-store')
        response.setHeader('x-content-type-options', 'nosniff')
        const label = request.headers.authorization === `Bearer ${'a'.repeat(64)}`
          ? 'A'
          : request.headers.authorization === `Bearer ${'b'.repeat(64)}`
          ? 'B'
          : ''
        if (requestUrl.pathname === '/') {
          response.setHeader(
            'content-security-policy',
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          )
          response.setHeader('content-type', 'text/html')
          return response.end(
            '<!doctype html><script type="module" src="/fixture.js"></script><div id="background"></div><img id="image">',
          )
        }
        if (
          requestUrl.pathname === '/fixture.js' || requestUrl.pathname === '/resource-auth-client.js'
          || requestUrl.pathname === '/manager-resource-worker.js'
        ) {
          response.setHeader('content-type', 'text/javascript')
          return response.end(
            requestUrl.pathname === '/fixture.js'
              ? page
              : requestUrl.pathname === '/resource-auth-client.js'
              ? clientBundle.outputFiles[0]!.contents
              : worker,
          )
        }
        if (requestUrl.pathname === '/fixture/session') {
          response.statusCode = label && active.has(label) ? 200 : 401
          return response.end()
        }
        if (requestUrl.pathname === '/outside') {
          events.push({ label, path: requestUrl.pathname, accepted: label !== '' })
          return response.end('outside')
        }
        if (
          requestUrl.pathname === '/api/renderer/bundle.js' || requestUrl.pathname.startsWith('/api/renderer/graphs/')
        ) {
          const authorized = !!label && active.has(label)
          events.push({ label, path: requestUrl.pathname, accepted: authorized })
          if (!authorized) {
            response.statusCode = 401
            return response.end()
          }
          if (requestUrl.pathname === '/api/renderer/bundle.js') {
            const data = Buffer.from(`export const result = 'bundle:${label}'`)
            response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': String(data.length) })
            return response.end(data)
          }
          const value = await projections.get(label)!.resolve({
            method: request.method ?? '',
            target: request.url ?? '',
          })
          response.writeHead(value.status, value.headers)
          if (slow && label === 'B' && requestUrl.pathname.endsWith('/chunk.js') && value.body) {
            response.write(value.body.slice(0, 4))
            const timer = setTimeout(() => response.end(value.body!.slice(4)), 750)
            timer.unref()
            response.on('close', () => clearTimeout(timer))
            return
          }
          return response.end(value.body)
        }
        response.statusCode = 404
        return response.end()
      })().catch(() => response.destroy())
    })
    cleanup.push(async () => {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const label of ['A', 'B']) {
      projections.set(label, createSessionPluginGraphProjection({ managerOrigin: origin, artifactServer }))
    }
    const graphA = projections.get('A')!.project(lease, () => active.has('A'))
    const graphB = projections.get('B')!.project(lease, () => active.has('B'))
    return {
      origin,
      graphA,
      graphB,
      events,
      revoke: (label: string) => active.delete(label),
      slow: () => slow = true,
      close,
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}
