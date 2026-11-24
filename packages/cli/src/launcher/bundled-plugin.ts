import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type CordisXBundledPlugin = 'channel' | 'plugin-cli-proxy-api'

export function bundledPluginRoot(name: CordisXBundledPlugin): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const sourceOrDistRoot = path.resolve(moduleDirectory, '../..')
  const cliRoot = path.basename(sourceOrDistRoot) === 'dist'
    ? path.dirname(sourceOrDistRoot)
    : sourceOrDistRoot
  return path.join(cliRoot, 'dist', 'bundled-plugins', '@cordisx', name)
}

export function bundledPluginEntry(name: CordisXBundledPlugin): string {
  return path.join(
    bundledPluginRoot(name),
    name === 'channel' ? 'dist/channel.js' : 'dist/runtime/module.js',
  )
}

/** The packaged Channel archive and its build-time integrity record. */
export function bundledChannelArchive(): string {
  return path.join(path.dirname(bundledPluginRoot('channel')), 'channel.archive')
}
