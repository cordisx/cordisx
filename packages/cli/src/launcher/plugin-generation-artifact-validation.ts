import { init, parse } from 'es-module-lexer'
import { transform } from 'lightningcss'
import path from 'node:path'
import type {
  PluginGenerationArtifactModuleV1,
  PluginGenerationArtifactStylesheetV1,
  PluginGenerationArtifactV1,
  PluginGenerationSharedImportV1,
} from './plugin-generation-artifact-server.js'

function equalPaths(left: ReadonlySet<string>, right: readonly string[]): boolean {
  return left.size === right.length && right.every(item => left.has(item))
}

function artifactReference(importer: `./${string}`, specifier: string, label: string): `./${string}` {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error(`${label} is not an artifact-relative reference`)
  }
  if (specifier.includes('?') || specifier.includes('#') || specifier.includes('%')) {
    throw new Error(`${label} contains an unsupported URL component`)
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer.slice(2)), specifier))
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new Error(`${label} escapes the artifact root`)
  }
  return `./${resolved}`
}

function assertModuleTarget(
  artifact: PluginGenerationArtifactV1,
  importer: PluginGenerationArtifactModuleV1,
  specifier: string,
): `./${string}` | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    if (!artifact.sharedImports.includes(specifier as PluginGenerationSharedImportV1)) {
      throw new Error(`${importer.path} contains an undeclared bare or external module import: ${specifier}`)
    }
    return undefined
  }
  const target = artifactReference(importer.path, specifier, `${importer.path} module import`)
  if (artifact.files.find(file => file.path === target)?.kind !== 'module') {
    throw new Error(`${importer.path} module import is missing from the graph: ${specifier}`)
  }
  return target
}

async function assertModuleReferences(
  artifact: PluginGenerationArtifactV1,
  file: PluginGenerationArtifactModuleV1,
  value: Uint8Array,
): Promise<void> {
  await init
  const source = Buffer.from(value).toString('utf8')
  let imports: ReturnType<typeof parse>[0]
  try {
    ;[imports] = parse(source, file.path)
  } catch (error) {
    throw new Error(`${file.path} is not valid browser ESM`, { cause: error })
  }
  const staticImports = new Set<`./${string}`>()
  const dynamicImports = new Set<`./${string}`>()
  for (const imported of imports) {
    if (imported.d === -2) continue
    if (imported.n === undefined) throw new Error(`${file.path} contains a computed module import`)
    const target = assertModuleTarget(artifact, file, imported.n)
    if (target === undefined) continue
    ;(imported.d >= 0 ? dynamicImports : staticImports).add(target)
  }
  if (!equalPaths(staticImports, file.imports)) {
    throw new Error(`${file.path} static imports differ from its graph descriptor`)
  }
  if (!equalPaths(dynamicImports, file.dynamicImports)) {
    throw new Error(`${file.path} dynamic imports differ from its graph descriptor`)
  }
}

function assertStylesheetReferences(
  artifact: PluginGenerationArtifactV1,
  file: PluginGenerationArtifactStylesheetV1,
  value: Uint8Array,
): void {
  let dependencies
  try {
    dependencies = transform({
      filename: file.path,
      code: Buffer.from(value),
      analyzeDependencies: true,
    }).dependencies ?? []
  } catch (error) {
    throw new Error(`${file.path} is not valid closed-graph CSS`, { cause: error })
  }
  const assets = new Set<`./${string}`>()
  for (const dependency of dependencies) {
    if (dependency.type !== 'url') throw new Error(`${file.path} contains an unsupported stylesheet import`)
    const target = artifactReference(file.path, dependency.url, `${file.path} stylesheet resource`)
    if (artifact.files.find(item => item.path === target)?.kind !== 'asset') {
      throw new Error(`${file.path} stylesheet resource is missing from the graph: ${dependency.url}`)
    }
    assets.add(target)
  }
  if (!equalPaths(assets, file.assets)) {
    throw new Error(`${file.path} stylesheet assets differ from its graph descriptor`)
  }
}

/** Validate emitted ESM/CSS bytes against the declared closed graph before evaluation. */
export async function assertPluginGenerationArtifactFileReferences(
  artifact: PluginGenerationArtifactV1,
  files: ReadonlyMap<`./${string}`, Uint8Array>,
): Promise<void> {
  for (const file of artifact.files) {
    const value = files.get(file.path)
    if (value === undefined) throw new Error(`plugin generation artifact bytes are missing: ${file.path}`)
    if (file.kind === 'module') await assertModuleReferences(artifact, file, value)
    else if (file.kind === 'stylesheet') assertStylesheetReferences(artifact, file, value)
  }
}
