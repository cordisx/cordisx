import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const CLI_PROXY_COMMIT = '1428ee205aab31df2779398cc8491879b303d1d0'
const CLI_PROXY_DEPENDENCY = `github:cordisx/plugin-cli-proxy-api#${CLI_PROXY_COMMIT}`

/** Verify the installed convenience alias and its sibling service artifact. */
export async function verifyInstalledCliProxy(input) {
  if (input.cordisxManifest.dependencies?.['@cordisx/plugin-cli-proxy-api'] !== CLI_PROXY_DEPENDENCY) {
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
  ) {
    throw new Error('installed cordisx:cli-proxy-api alias did not resolve the external package export')
  }
  const exact = new Set([
    'tasks.content.read',
    'tasks.create',
    'tasks.control',
    'turns.submit',
    'turns.control',
  ])
  if (
    packageManifest.schemaVersion !== 13 || runtimeManifest.schemaVersion !== 13
    || packageManifest.runtimeManifest.schema !== runtimeManifest.$schema
    || packageManifest.runtimeManifest.digest !== `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`
    || runtimeManifest.capabilities.length !== 7
    || runtimeManifest.capabilities.some(capability => (
      JSON.stringify(capability.scope) !== JSON.stringify(
        exact.has(capability.name)
          ? { runtime: 'exact-request' }
          : {},
      )
    ))
  ) throw new Error('installed CLIProxy package-v13 permission artifact is invalid')
  await access(path.join(packageRoot, runtimeManifest.services[0].entry))
  return config
}
