import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import react from '@vitejs/plugin-react'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { createPlaygroundSession } from '../session.js'

const COMPOSITION_ID = 'virtual:cordisx-composition'
const RESOLVED_COMPOSITION_ID = `\0${COMPOSITION_ID}`
const FIXTURE_ID = 'virtual:cordisx-playground-fixture'
const RESOLVED_FIXTURE_ID = `\0${FIXTURE_ID}`
const GENERATED_OUTPUT_ROOT = fileURLToPath(new URL('../../../dist/', import.meta.url))

function isGeneratedOutput(file: string): boolean {
  const path = relative(GENERATED_OUTPUT_ROOT, file)
  return path !== '' && !path.startsWith('..') && !path.startsWith('/')
}

export interface VitePlaygroundOptions {
  readonly configPath: string
  readonly homeDir?: string
  readonly port?: number
  readonly host?: '127.0.0.1' | '::1'
}

export interface VitePlaygroundHandle {
  readonly url: string
  readonly homeDir: string
  close(): Promise<void>
}

async function requestBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.byteLength
    if (size > 1_048_576) throw new Error('request is too large')
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

/** Vite transport around the same isolated composition/session used by production parity tests. */
export async function startVitePlayground(options: VitePlaygroundOptions): Promise<VitePlaygroundHandle> {
  let vite: ViteDevServer | undefined
  const session = await createPlaygroundSession(options.configPath, {
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    onEffectiveConfigCommitted() {
      const composition = vite?.moduleGraph.getModuleById(RESOLVED_COMPOSITION_ID)
      if (composition !== undefined) vite?.moduleGraph.invalidateModule(composition)
    },
  })
  const clientRoot = fileURLToPath(new URL('../client', import.meta.url))
  const runtimePath = fileURLToPath(new URL('../../renderer/runtime.ts', import.meta.url))
  const runtimeImport = `/@fs/${runtimePath}`
  const previewResetInstanceId = randomUUID()
  let previewResetGeneration = 0
  const previewResetState = () => Object.freeze({
    version: 1 as const,
    instanceId: previewResetInstanceId,
    generation: previewResetGeneration,
  })

  const compositionPlugin: Plugin = {
    name: 'cordisx-playground-composition',
    resolveId(id) {
      if (id === COMPOSITION_ID) return RESOLVED_COMPOSITION_ID
      if (id === FIXTURE_ID) return RESOLVED_FIXTURE_ID
      return undefined
    },
    async load(id) {
      if (id === RESOLVED_FIXTURE_ID) return `export default ${JSON.stringify(session.fixture)}`
      if (id !== RESOLVED_COMPOSITION_ID) return undefined
      const composition = await session.buildComposition(runtimeImport)
      for (const file of composition.watchFiles) this.addWatchFile(file)
      return composition.source
    },
    handleHotUpdate(context) {
      // `npm run build` writes the CLI package's generated dist tree while a
      // Playground server may be running from src. Those files are not part of
      // the composition's source graph. Rebuilding the virtual composition for
      // them disposes the active plugin generation and can leave the review
      // surface blank during a browser reload.
      if (isGeneratedOutput(context.file)) return []
      const composition = context.server.moduleGraph.getModuleById(RESOLVED_COMPOSITION_ID)
      if (composition !== undefined) context.server.moduleGraph.invalidateModule(composition)
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          if (request.method === 'POST' && url.pathname === '/api/config') {
            sendJson(response, 200, await session.handleConfigRequest(await requestBody(request)))
            return
          }
          if (request.method === 'POST' && url.pathname === '/api/agent-sessions') {
            sendJson(response, 200, await session.handleAgentSessionStoreRequest(await requestBody(request)))
            return
          }
          if (request.method === 'POST' && url.pathname === '/api/documents') {
            sendJson(response, 200, await session.handleOwnerDocumentRequest(await requestBody(request)))
            return
          }
          if (request.method === 'POST' && url.pathname === '/api/service-config') {
            sendJson(response, 200, await session.handleServiceConfigRequest(await requestBody(request)))
            return
          }
          if (request.method === 'POST' && url.pathname === '/api/channel-credential') {
            sendJson(response, 200, await session.handleChannelCredentialRequest(await requestBody(request)))
            return
          }
          if (request.method === 'POST' && url.pathname === '/api/provider') {
            sendJson(response, 200, await session.handleProviderRequest(await requestBody(request)))
            return
          }
          if (request.method === 'POST' && url.pathname === '/api/reset') {
            await session.reset()
            previewResetGeneration += 1
            const composition = server.moduleGraph.getModuleById(RESOLVED_COMPOSITION_ID)
            if (composition !== undefined) server.moduleGraph.invalidateModule(composition)
            const reset = previewResetState()
            sendJson(response, 200, { ok: true, reset })
            server.ws.send({ type: 'custom', event: 'cordisx:playground-preview-reset', data: reset })
            if (url.searchParams.get('client') !== 'playground-reset-v1') server.ws.send({ type: 'full-reload' })
            return
          }
          if (request.method === 'GET' && url.pathname === '/api/reset-state') {
            sendJson(response, 200, previewResetState())
            return
          }
          next()
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      })
    },
  }

  const rendererAssetPlugin: Plugin = {
    name: 'cordisx-renderer-text-assets',
    enforce: 'pre',
    transform(source, id) {
      if (!/\.[cm]?[jt]sx?$/.test(id)) return undefined
      const code = source
        .replace(/(from\s+['"][^'"]+\.css)(['"])/g, '$1?inline$2')
        .replace(/(from\s+['"][^'"]+\.svg)(['"])/g, '$1?raw$2')
      return code === source ? undefined : { code, map: null }
    },
  }

  try {
    const host = options.host ?? '127.0.0.1'
    vite = await createServer({
      configFile: false,
      root: clientRoot,
      appType: 'spa',
      plugins: [rendererAssetPlugin, react(), compositionPlugin],
      server: {
        host,
        port: options.port ?? 0,
        strictPort: options.port !== undefined,
        watch: {
          ignored: [`${GENERATED_OUTPUT_ROOT.replaceAll('\\', '/')}/**`],
        },
      },
      clearScreen: false,
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('Vite Playground did not expose a TCP address')
    }
    return {
      url: `http://${host}:${address.port}/`,
      homeDir: session.homeDir,
      async close() {
        await vite?.close()
        await session.close()
      },
    }
  } catch (error) {
    await vite?.close()
    await session.close()
    throw error
  }
}
