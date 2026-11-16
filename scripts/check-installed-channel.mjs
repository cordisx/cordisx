import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const CHANNEL_COMMIT = '5afcc0a3c5be1045b0fbb9a4a6cd9117b88c2e65'
const CHANNEL_DEPENDENCY = `github:cordisx/plugin-channel#${CHANNEL_COMMIT}`

export function enableInstalledChannel(config) {
  config.plugins.push({ id: 'channel', entry: 'cordisx:channel', enabled: true, config: {} })
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
  return config
}
