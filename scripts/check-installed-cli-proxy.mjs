import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const CLI_PROXY_COMMIT = '25ff53db12e51e66b304f9f2139c706af0b0c761'
const CLI_PROXY_DEPENDENCY = `github:cordisx/plugin-cli-proxy-api#${CLI_PROXY_COMMIT}`

export function installedCliProxyBridge(resources, platform = process.platform, architecture = process.arch) {
  const target = platform === 'linux' && architecture === 'x64'
    ? './runtime/cli-proxy-plugins/linux/amd64/cordisx-gateway-bridge.so'
    : platform === 'darwin' && architecture === 'arm64'
    ? './runtime/cli-proxy-plugins/darwin/arm64/cordisx-gateway-bridge.dylib'
    : undefined
  if (target === undefined) return undefined
  const matches = resources.filter(resource => resource.path === target)
  const resource = matches[0]
  if (
    matches.length !== 1 || resource.mode !== 'executable'
    || !resource.platforms?.includes(platform) || !resource.architectures?.includes(architecture)
  ) throw new Error('installed CLIProxy bridge does not match native discovery')
  return resource
}

/** Verify the installed convenience alias and its sibling service artifact. */
export async function verifyInstalledCliProxy(input) {
  if (input.cordisxManifest.cordisxSources?.['@cordisx/plugin-cli-proxy-api'] !== CLI_PROXY_DEPENDENCY) {
    throw new Error('installed cordisx must pin the standalone CLIProxy plugin')
  }
  const config = await input.loadConfig(input.configPath)
  const plugin = config.plugins.find(item => item.id === 'cli-proxy-api')
  if (plugin === undefined) throw new Error('installed cordisx:cli-proxy-api alias is missing')
  const packageRoot = path.resolve(path.dirname(plugin.entry), '..', '..')
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'cordisx-package.json'), 'utf8'))
  const runtimeText = await readFile(path.join(packageRoot, 'runtime-manifest.json'), 'utf8')
  const runtimeManifest = JSON.parse(runtimeText)
  if (
    plugin.entry !== path.join(packageRoot, 'dist', 'runtime', 'module.js')
    || manifest.name !== '@cordisx/plugin-cli-proxy-api'
    || manifest.exports?.['./extensions/v1']?.default !== './dist/extensions.mjs'
  ) {
    throw new Error('installed cordisx:cli-proxy-api alias did not resolve the bundled package export')
  }
  const exact = new Set([
    'tasks.content.read',
    'tasks.create',
    'tasks.control',
    'turns.submit',
    'turns.control',
  ])
  if (
    packageManifest.schemaVersion !== 14 || runtimeManifest.schemaVersion !== 14
    || packageManifest.runtimeManifest.schema !== runtimeManifest.$schema
    || packageManifest.runtimeManifest.digest !== `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`
    || runtimeManifest.capabilities.length !== 7
    || !runtimeManifest.services.some(service => (
      service.id === 'gateway-runtime'
      && service.runtimeResources?.some(resource => (
        resource.path.includes('/runtime/cli-proxy-plugins/') && resource.mode === 'executable'
      ))
    ))
    || runtimeManifest.capabilities.some(capability => (
      JSON.stringify(capability.scope) !== JSON.stringify(
        exact.has(capability.name)
          ? { runtime: 'exact-request' }
          : {},
      )
    ))
  ) throw new Error('installed CLIProxy package-v14 permission artifact is invalid')
  const resources = runtimeManifest.services.find(service => service.id === 'gateway-runtime').runtimeResources
  const nativeBridge = installedCliProxyBridge(resources)
  if (nativeBridge !== undefined) {
    const bytes = await readFile(path.join(packageRoot, nativeBridge.path))
    if (
      bytes.length !== nativeBridge.byteLength
      || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== nativeBridge.digest
    ) throw new Error('installed CLIProxy bridge integrity mismatch')
  }
  await Promise.all(runtimeManifest.services.map(service => access(path.join(packageRoot, service.entry))))
  const artwork = await readFile(path.join(packageRoot, 'assets', 'icon.png'))
  if (
    manifest.cordisxSource !== CLI_PROXY_DEPENDENCY
    || createHash('sha256').update(artwork).digest('hex')
      !== '15295b1c1634e631b5e1d11a4b17838778c3d4cba03cca95b8bf5d13c13ff0d4'
  ) throw new Error('installed CLIProxy must carry the selected brand artwork from its pinned source')
  return config
}
