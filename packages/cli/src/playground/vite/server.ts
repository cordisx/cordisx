import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { createPlaygroundSession } from '../session.js'

const COMPOSITION_ID = 'virtual:cordisx-composition'
const RESOLVED_COMPOSITION_ID = `\0${COMPOSITION_ID}`
const FIXTURE_ID = 'virtual:cordisx-playground-fixture'
const RESOLVED_FIXTURE_ID = `\0${FIXTURE_ID}`

export interface VitePlaygroundOptions {
  readonly configPath: string
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
  const session = await createPlaygroundSession(options.configPath)
  const clientRoot = fileURLToPath(new URL('../client', import.meta.url))
  const runtimePath = fileURLToPath(new URL('../../renderer/runtime.ts', import.meta.url))
  const runtimeImport = `/@fs/${runtimePath}`
  let vite: ViteDevServer | undefined

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
            const composition = server.moduleGraph.getModuleById(RESOLVED_COMPOSITION_ID)
            if (composition !== undefined) server.moduleGraph.invalidateModule(composition)
            sendJson(response, 200, { ok: true })
            server.ws.send({ type: 'full-reload' })
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
