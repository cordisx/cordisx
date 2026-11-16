import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { CordisXConfigPlugin } from './config.js'
import { normalizeLatestRuntimeManifest } from './latest-runtime-manifest.js'
import { JsonPackageManifestV2Resolver } from './packages/manifest.js'

/** Resolve direct package entries through the same digest/containment boundary as installed packages. */
export async function configuredPluginManifest(plugin: CordisXConfigPlugin): Promise<CordisXConfigPlugin> {
  if (!plugin.enabled || plugin.manifest) return plugin
  let directory = path.dirname(plugin.entry)
  while (true) {
    const descriptor = path.join(directory, 'cordisx-package.json')
    const text = await readFile(descriptor, 'utf8').catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
      throw error
    })
    if (text !== undefined) {
      const declared = JSON.parse(text) as { entry?: unknown; runtimeManifest?: { schema?: unknown } }
      const schema = declared.runtimeManifest?.schema
      // Legacy source-only compositions retain their existing admission path.
      // They cannot supply an owned-service association from unvalidated metadata.
      if (typeof schema !== 'string' || !/\/plugin-manifest\.v(?:12|13|14|15|16)\.schema\.json$/u.test(schema)) {
        return plugin
      }
      if (typeof declared.entry !== 'string') throw new Error('Configured package entry is invalid')
      const entry = declared.entry
      // A source-mode entry must not acquire the authority of a different built entry.
      const declaredEntry = await realpath(path.resolve(directory, entry)).catch(error => {
        if (
          path.resolve(directory, entry) !== plugin.entry
          && (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) return undefined
        throw error
      })
      if (declaredEntry !== await realpath(plugin.entry)) return plugin
      const resolved = await new JsonPackageManifestV2Resolver({
        runtimeValidators: {
          [schema]: value => {
            const manifest = normalizeLatestRuntimeManifest(value, plugin.id)
            if (!manifest) throw new Error('Unsupported configured runtime manifest')
            return manifest
          },
        },
      }).resolve(directory)
      if (resolved.packageManifest.pluginId !== plugin.id) throw new Error('Configured package identity mismatch')
      const manifest = normalizeLatestRuntimeManifest(resolved.runtimeManifest, plugin.id)!
      return {
        ...plugin,
        manifest,
        manifestFiles: [descriptor, path.resolve(directory, resolved.packageManifest.runtimeManifest.path)],
      }
    }
    // Do not borrow a parent workspace package's service declaration.
    const packageFile = await readFile(path.join(directory, 'package.json'), 'utf8').catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
      throw error
    })
    const parent = path.dirname(directory)
    if (packageFile !== undefined || parent === directory) return plugin
    directory = parent
  }
}
