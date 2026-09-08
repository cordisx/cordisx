import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const CHANNEL_COMMIT = '4cee12e3a92eeed557bc9de8cc4792710918327a'
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
  const packageRoot = path.dirname(path.dirname(channel.entry))
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (channel.entry !== path.join(packageRoot, 'dist', 'channel.js') || manifest.name !== '@cordisx/channel') {
    throw new Error('installed cordisx:channel alias did not resolve the external package export')
  }
  await access(path.join(packageRoot, 'dist', 'service.mjs'))
  return config
}
