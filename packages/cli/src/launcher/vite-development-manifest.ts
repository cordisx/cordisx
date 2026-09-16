import type { ViteDevServer } from 'vite'

/** Install the development provider's launch-scoped manifest endpoint. */
export function installNativeViteHostManifest(
  server: ViteDevServer,
  base: string,
  entry: string,
): void {
  server.middlewares.use(`${base}host-manifest.json`, (_request, response) => {
    const body = JSON.stringify({ version: 1, entry })
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.setHeader('cache-control', 'no-store')
    response.end(body)
  })
}
