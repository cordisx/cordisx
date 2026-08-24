import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { transform } from 'esbuild'
import type { RuntimeModuleAccess } from './packages/authority.js'

const MAX_RUNTIME_MODULE_BYTES = 8 * 1024 * 1024

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Load only the immutable module projection authenticated by PackageLifecycleAuthority. */
export async function loadPluginGenerationArtifact(module: RuntimeModuleAccess): Promise<string> {
  if (module.runtimeEntry !== './module.js' || !path.isAbsolute(module.artifactDirectory)) {
    throw new Error('runtime module projection is invalid')
  }
  const root = await realpath(module.artifactDirectory)
  const entry = await realpath(path.resolve(root, module.runtimeEntry))
  if (!inside(root, entry)) throw new Error('runtime module entry escapes its immutable artifact directory')
  const metadata = await stat(entry)
  if (!metadata.isFile() || metadata.size > MAX_RUNTIME_MODULE_BYTES) {
    throw new Error('runtime module entry is not a bounded regular file')
  }
  const source = await readFile(entry, 'utf8')
  const output = await transform(source, {
    format: 'iife',
    globalName: '__cordisxResolvedPluginModuleV1',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    legalComments: 'none',
  })
  return `globalThis.__cordisxPendingPluginModuleFactoryV1 = (console) => {\n${output.code}\nreturn __cordisxResolvedPluginModuleV1;\n};\n`
}
