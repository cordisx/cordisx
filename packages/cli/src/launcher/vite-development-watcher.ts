import type { ServerOptions, ViteDevServer } from 'vite'

/** Backend and readiness belong together: startup must cover the first edit. */
export function nativeViteWatchOptions(generatedRoot?: string): NonNullable<ServerOptions['watch']> {
  return {
    // Chokidar's macOS FSEvents path emits ready before its asynchronous
    // native registration completes. fs.watch registers before readiness.
    ...(process.platform === 'darwin' ? { useFsEvents: false } : {}),
    ignoreInitial: true,
    ignored: [...(generatedRoot === undefined ? [] : [`${generatedRoot}**`]), '**/node_modules/**', '**/.git/**'],
  }
}

export async function listenNativeViteServer(server: ViteDevServer, watchFiles: readonly string[]): Promise<void> {
  const ready = new Promise<void>(resolve => server.watcher.once('ready', resolve))
  // Add canonical inputs before listen can finish the first readiness epoch.
  server.watcher.add([...watchFiles])
  await server.listen()
  await ready
}
