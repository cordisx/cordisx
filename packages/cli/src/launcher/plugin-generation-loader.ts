import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { transform } from 'esbuild'
import type { RuntimeModuleAccess } from './packages/authority.js'
import {
  readPluginGenerationArtifactV1,
  type PluginGenerationArtifactServer,
  type PluginGenerationGraphLease,
} from './plugin-generation-artifact-server.js'

/** Maximum immutable browser runtime entry accepted from any plugin generation. */
export const MAX_PLUGIN_RUNTIME_MODULE_BYTES = 24 * 1024 * 1024

export type LoadedPluginGenerationArtifact =
  | {
      readonly kind: 'legacy-factory'
      readonly runtimeArtifactSource: string
    }
  | {
      readonly kind: 'browser-esm-graph'
      /** Awaitable browser expression returning the plugin module namespace. */
      readonly runtimeArtifactSource: string
      readonly lease: PluginGenerationGraphLease
    }

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
  if (!metadata.isFile() || metadata.size > MAX_PLUGIN_RUNTIME_MODULE_BYTES) {
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

/**
 * Resolve either an existing single-file package or a generation-qualified
 * browser graph. The caller owns graph publication/retirement alongside the
 * renderer transaction and must close the launch-scoped server at shutdown.
 */
export async function loadPluginGenerationArtifactForRuntime(
  module: RuntimeModuleAccess,
  moduleGeneration: string,
  server: PluginGenerationArtifactServer,
): Promise<LoadedPluginGenerationArtifact> {
  const artifact = await readPluginGenerationArtifactV1(module.artifactDirectory)
  if (artifact === undefined) {
    return Object.freeze({
      kind: 'legacy-factory',
      runtimeArtifactSource: await loadPluginGenerationArtifact(module),
    })
  }
  const lease = await server.lease(module, moduleGeneration, artifact)
  return Object.freeze({
    kind: 'browser-esm-graph',
    runtimeArtifactSource: lease.importSource,
    lease,
  })
}

export {
  parsePluginGenerationArtifactV1,
  readPluginGenerationArtifactV1,
  startPluginGenerationArtifactServer,
  type PluginGenerationArtifactAssetV1,
  type PluginGenerationArtifactFileKind,
  type PluginGenerationArtifactFileV1,
  type PluginGenerationArtifactModuleV1,
  type PluginGenerationArtifactRequestTrace,
  type PluginGenerationArtifactServer,
  type PluginGenerationArtifactStylesheetV1,
  type PluginGenerationArtifactV1,
  type PluginGenerationAssetMediaTypeV1,
  type PluginGenerationGraphLease,
  type PluginGenerationSharedImportV1,
} from './plugin-generation-artifact-server.js'
