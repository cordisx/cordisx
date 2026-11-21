import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const CHANNEL_COMMIT = '44f4bc9302e7acf4b9e34ae04de26a6c9034ae7b'
const CHANNEL_DEPENDENCY = `github:cordisx/plugin-channel#${CHANNEL_COMMIT}`

export function enableInstalledChannel(config) {
  config.plugins.push({ id: 'channel', entry: 'cordisx:channel', enabled: true, config: {} })
}

/** Check the graph and stylesheet actually shipped inside the installed Host. */
export async function verifyBundledChannelBrowserGraph(packageRoot) {
  const descriptor = JSON.parse(await readFile(path.join(packageRoot, 'cordisx-package.json'), 'utf8'))
  const graphRoot = path.join(packageRoot, 'dist/browser')
  const graph = JSON.parse(await readFile(path.join(graphRoot, 'artifact.json'), 'utf8'))
  if (
    descriptor.entry !== './dist/browser/module.js' || graph.contract !== 'cordisx.plugin-generation-artifact/v1'
    || graph.entry !== './module.js' || !Array.isArray(graph.files) || graph.files.length === 0
    || graph.files.length > 256 || !Array.isArray(graph.initialStyles) || graph.initialStyles.length === 0
  ) throw new Error('installed Channel browser graph is incomplete')
  const files = new Map()
  for (const file of graph.files) {
    if (
      !file || typeof file.path !== 'string' || !/^\.\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(file.path)
      || file.path.slice(2).split('/').some(segment => segment === '.' || segment === '..')
      || files.has(file.path) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0
      || typeof file.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(file.digest)
    ) throw new Error('installed Channel browser graph is invalid')
    files.set(file.path, file)
  }
  if (
    files.get(graph.entry)?.kind !== 'module'
    || graph.initialStyles.some(style => typeof style !== 'string' || files.get(style)?.kind !== 'stylesheet')
  ) throw new Error('installed Channel browser graph is incomplete')
  for (const file of files.values()) {
    const data = await readFile(path.join(graphRoot, file.path.slice(2)))
    if (
      data.byteLength !== file.byteLength || `sha256:${createHash('sha256').update(data).digest('hex')}` !== file.digest
    ) {
      throw new Error('installed Channel browser graph failed integrity readback')
    }
  }
}

/** Verify the installed convenience alias without assuming npm's dependency layout. */
export async function verifyInstalledChannel(input) {
  if (input.cordisxManifest.cordisxSources?.['@cordisx/channel'] !== CHANNEL_DEPENDENCY) {
    throw new Error('installed cordisx must pin the standalone Channel package')
  }
  const config = await input.loadConfig(input.configPath)
  const channel = config.plugins.find(plugin => plugin.id === 'channel')
  if (channel === undefined) throw new Error('installed cordisx:channel alias is missing')
  const packageRoot = path.resolve(path.dirname(channel.entry), '..')
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (channel.entry !== path.join(packageRoot, 'dist', 'channel.js') || manifest.name !== '@cordisx/channel') {
    throw new Error('installed cordisx:channel alias did not resolve the bundled package export')
  }
  await access(path.join(packageRoot, 'dist', 'service.mjs'))
  const artwork = await readFile(path.join(packageRoot, 'assets', 'channel.png'))
  if (
    manifest.cordisxSource !== CHANNEL_DEPENDENCY
    || createHash('sha256').update(artwork).digest('hex')
      !== '8a989a7a2c83d66d4b10381e77bf596222f8301980518a86b4fbbcad006c1e0d'
  ) throw new Error('installed Channel must carry the selected brand artwork from its pinned source')
  await verifyBundledChannelBrowserGraph(packageRoot)
  return config
}
