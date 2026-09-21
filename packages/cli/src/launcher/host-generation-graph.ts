import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'vite'
import type { CordisXConfig } from './config.js'
import { type BuildRendererBundleOptions, buildRendererCompositionSource } from './bundle.js'
import {
  CONTRACTS_MODULE_PATH,
  CORDISX_MANAGED_SERVICE_UI_MODULE,
  CORDISX_REACT_JSX_DEV_RUNTIME_MODULE,
  CORDISX_REACT_JSX_RUNTIME_MODULE,
  CORDISX_REACT_MODULE,
  CORDISX_UI_MODULE,
  cordisXSharedModuleSource,
} from './react-virtual-modules.js'

const ENTRY = 'virtual:cordisx-host-generation-entry'
const COMPOSITION = 'virtual:cordisx-host-generation-composition'
const MAX_BOOTLOADER_BYTES = 16 * 1024

interface RollupOutputFile {
  readonly type: 'asset' | 'chunk'
  readonly fileName: string
  readonly source?: string | Uint8Array
  readonly code?: string
  readonly isEntry?: boolean
}

export interface HostGenerationGraph {
  readonly entryUrl: string
  readonly manifestUrl: string
  readonly bootloader: string
  /** Materialize exact served JavaScript only for repository integration audits. */
  readonly authoritySource: () => string
  readonly eagerBytes: number
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  close(): Promise<void>
}

export interface HostGenerationGraphSource {
  readonly source: string
  readonly authoritySource: () => string
}

export function hostGenerationBootloaderSource(origin: string): string {
  const manifestUrl = `${origin}/manifest.json`
  return `(()=>{const m=${JSON.stringify(manifestUrl)},o=${
    JSON.stringify(origin)
  },e=(s,x)=>{let d=x instanceof Error?x.message:String(x);d=d.split(o).join('[host graph]').replace(/https?:\\/\\/[^\\s)]+/g,'[url]').slice(0,256);return Error('CordisX Host '+s+(d?': '+d:''))},f=async(a=0)=>{try{return await fetch(m)}catch(x){if(a>=2)throw e('manifest fetch failed after 3 attempts',x);await new Promise(r=>setTimeout(r,100*(a+1)));return f(a+1)}};const p=f().then(async r=>{if(!r.ok)throw Error('CordisX Host manifest HTTP '+r.status);try{return await r.json()}catch(x){throw e('manifest JSON invalid',x)}}).then(x=>{if(x?.version!==1||typeof x.entry!=='string'||!/^\\/[^/]/.test(x.entry)||typeof x.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(x.digest))throw Error('CordisX Host manifest schema invalid');return import(o+x.entry).catch(y=>{throw e('entry import failed',y)})}).then(x=>x.runtime);globalThis.__cordisxCompositionBoot=p;void p.catch(x=>console.error('[cordisx] Host graph boot failed',x))})()`
}

export function assertProductionGraphLaunchOwnership(attach: boolean, hasLoopbackGraph: boolean): void {
  if (attach && hasLoopbackGraph) {
    throw new Error('production browser graphs require a launcher-owned native Host; --attach is unsupported')
  }
}

/** Retain every graph admitted by one launch and roll back only graphs from a failed build transaction. */
export class HostGenerationGraphOwner {
  readonly #graphs: HostGenerationGraph[] = []
  #closeTask: Promise<void> | undefined
  #closed = false

  async build(config: CordisXConfig, options: BuildRendererBundleOptions): Promise<HostGenerationGraphSource> {
    if (this.#closed) throw new Error('Host generation graph owner is closed')
    const graph = await buildHostGenerationGraph(config, options)
    if (this.#closed) {
      await graph.close()
      throw new Error('Host generation graph owner closed during build')
    }
    this.#graphs.push(graph)
    return { source: graph.bootloader, authoritySource: graph.authoritySource }
  }

  async transaction<Result>(task: () => Promise<Result>): Promise<Result> {
    const checkpoint = this.#graphs.length
    try {
      return await task()
    } catch (error) {
      await this.#closeFrom(checkpoint)
      throw error
    }
  }

  close(): Promise<void> {
    this.#closed = true
    this.#closeTask ??= this.#closeFrom(0)
    return this.#closeTask
  }

  async #closeFrom(index: number): Promise<void> {
    const graphs = this.#graphs.splice(index)
    await Promise.allSettled(graphs.map(graph => graph.close()))
  }
}

function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Build and serve the Host itself as one immutable, launch-scoped Vite graph.
 * The server deliberately retains no plugin/lifecycle state: the existing
 * generation coordinator remains the sole activation ledger.
 */
export async function buildHostGenerationGraph(
  config: CordisXConfig,
  options: BuildRendererBundleOptions = {},
): Promise<HostGenerationGraph> {
  // The graph entry is virtual, so a path relative to a user's config root
  // would resolve relative to that virtual id. Pin this private import to the
  // Host package instead; plugin paths remain configuration-owned below.
  const runtimeExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const runtimeImport = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    `../renderer/runtime.${runtimeExtension}`,
  )
  const reactRuntimeImport = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    `../renderer/react-runtime.${runtimeExtension}`,
  )
  const baseComposition = await buildRendererCompositionSource(config, options, { awaitBoot: true, runtimeImport })
  const virtualModules = new Set([
    CORDISX_MANAGED_SERVICE_UI_MODULE,
    CORDISX_REACT_MODULE,
    CORDISX_REACT_JSX_RUNTIME_MODULE,
    CORDISX_REACT_JSX_DEV_RUNTIME_MODULE,
    CORDISX_UI_MODULE,
  ])
  const plugin: Plugin = {
    name: 'cordisx-host-generation',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (id === ENTRY) return `\0${ENTRY}`
      if (id === COMPOSITION) return `\0${COMPOSITION}`
      if (id === 'cordisx/contracts') return CONTRACTS_MODULE_PATH
      if (virtualModules.has(id) && importer?.includes('/renderer/')) {
        const suffix = id === CORDISX_REACT_MODULE
          ? 'react'
          : id === CORDISX_REACT_JSX_RUNTIME_MODULE
          ? 'react-jsx-runtime'
          : id === CORDISX_REACT_JSX_DEV_RUNTIME_MODULE
          ? 'react-jsx-dev-runtime'
          : 'ui'
        return path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../${suffix}.${runtimeExtension}`)
      }
      if (virtualModules.has(id)) return `\0cordisx-host:${id}`
      // Vite 8's Rolldown production adapter currently does not materialize
      // CSS `?inline` requests. `?raw` preserves the same string-valued Host
      // contract without emitting a stylesheet side effect.
      if (id.endsWith('?inline')) {
        const resolved = await this.resolve(id.slice(0, -'?inline'.length), importer, { skipSelf: true })
        return resolved === null ? undefined : `${resolved.id}?raw`
      }
      return undefined
    },
    load(id) {
      if (id === `\0${ENTRY}`) {
        return `import { installSharedReactRuntime } from ${JSON.stringify(reactRuntimeImport)};
if (!globalThis.__cordisxSharedReactRuntime) installSharedReactRuntime(document);
export const runtime = (await import(${JSON.stringify(COMPOSITION)})).runtime;`
      }
      if (id === `\0${COMPOSITION}`) return baseComposition.source
      if (id.startsWith('\0cordisx-host:')) return cordisXSharedModuleSource(id.slice('\0cordisx-host:'.length))
      return undefined
    },
    transform(source, id) {
      // Preserve the legacy esbuild loader contract: Host styles and SVG
      // marks are source text, not emitted asset URLs. BrandMark parses SVG
      // geometry during startup, so URL semantics are observably incorrect.
      if (!/\.[cm]?[jt]sx?(?:\?|$)/u.test(id)) return undefined
      const code = source
        .replace(/(from\s+['"][^'"]+\.css)(['"])/gu, '$1?raw$2')
        .replace(/(from\s+['"][^'"]+\.svg)(['"])/gu, '$1?raw$2')
      return code === source ? undefined : { code, map: null }
    },
  }
  const result = await build({
    configFile: false,
    root: config.rootDir,
    base: './',
    plugins: [plugin],
    build: {
      write: false,
      sourcemap: false,
      target: 'chrome120',
      rollupOptions: {
        input: ENTRY,
        output: {
          entryFileNames: 'host-[hash].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  })
  const output = (Array.isArray(result)
    ? result.flatMap(item => (item as { readonly output: readonly RollupOutputFile[] }).output)
    : (result as { readonly output: readonly RollupOutputFile[] }).output) as readonly RollupOutputFile[]
  const files = new Map<string, { readonly body: Uint8Array; readonly contentType: string }>()
  let entry: RollupOutputFile | undefined
  for (const item of output) {
    const body = item.type === 'chunk'
      ? new TextEncoder().encode(item.code ?? '')
      : new TextEncoder().encode(typeof item.source === 'string' ? item.source : '')
    const fileName = item.fileName
    files.set(`/${fileName}`, {
      body,
      contentType: fileName.endsWith('.css')
        ? 'text/css'
        : fileName.endsWith('.js')
        ? 'text/javascript'
        : 'application/octet-stream',
    })
    if (item.type === 'chunk' && item.isEntry) entry = item
  }
  if (entry === undefined) throw new Error('Vite produced no Host graph entry')
  const manifest = JSON.stringify({
    version: 1,
    entry: `/${entry.fileName}`,
    digest: `sha256:${digest(entry.code ?? '')}`,
  })
  files.set('/manifest.json', { body: new TextEncoder().encode(manifest), contentType: 'application/json' })
  const secret = randomBytes(32).toString('hex')
  let origin = ''
  let closed = false
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin)
    const prefix = `/cordisx-host-generation/${secret}`
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') || url.search !== '' || !url.pathname.startsWith(prefix)
    ) {
      response.statusCode = 404
      response.end()
      return
    }
    const file = files.get(url.pathname.slice(prefix.length) || '/')
    if (file === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    response.statusCode = 200
    response.setHeader('content-type', file.contentType)
    // The exact native app:// document reads this launch-scoped immutable
    // graph after CDP grants loopback access. No other origin receives a
    // route, but CORS is still required for the browser Fetch gate.
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('cache-control', 'public, max-age=31536000, immutable')
    response.setHeader('content-length', String(file.body.byteLength))
    response.end(request.method === 'HEAD' ? undefined : file.body)
  })
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cordisx-host-generation/${secret}`
  const bootloader = hostGenerationBootloaderSource(origin)
  if (Buffer.byteLength(bootloader) >= MAX_BOOTLOADER_BYTES) {
    await close()
    throw new Error('Host graph bootloader exceeds 16 KiB')
  }
  return {
    entryUrl: `${origin}/${entry.fileName}`,
    manifestUrl: `${origin}/manifest.json`,
    bootloader,
    authoritySource: () =>
      [...files.entries()]
        .filter(([name]) => name.endsWith('.js'))
        .map(([, file]) => new TextDecoder().decode(file.body))
        .join('\n'),
    eagerBytes: [...files.entries()].filter(([name]) => name.endsWith('.js')).reduce(
      (total, [, file]) => total + file.body.byteLength,
      0,
    ),
    files: [...files.entries()].map(([file, value]) => ({ path: file, bytes: value.body.byteLength })),
    close,
  }
}
