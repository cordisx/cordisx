import { createHash } from 'node:crypto'
import path from 'node:path'
import { build as viteBuild, normalizePath, type Plugin, type Rollup, type UserConfig } from 'vite'
import {
  assertNoPrivateReactModules,
  CONTRACTS_MODULE_PATH,
  CORDISX_REACT_JSX_DEV_RUNTIME_MODULE,
  CORDISX_REACT_JSX_RUNTIME_MODULE,
  CORDISX_REACT_MODULE,
  CORDISX_UI_MODULE,
  cordisXSharedModuleSource,
} from './react-virtual-modules.js'

export const CORDISX_PLUGIN_GENERATION_ARTIFACT_CONTRACT = 'cordisx.plugin-generation-artifact/v1' as const
export const CORDISX_PLUGIN_GENERATION_ARTIFACT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-generation-artifact.v1.schema.json' as const

export type PluginGenerationArtifactFileKind = 'module' | 'stylesheet' | 'asset'
export type PluginGenerationSharedImportV1 =
  | 'cordisx/contracts'
  | 'cordisx/react'
  | 'cordisx/react/jsx-dev-runtime'
  | 'cordisx/react/jsx-runtime'
  | 'cordisx/ui'
  | 'react'
  | 'react/jsx-dev-runtime'
  | 'react/jsx-runtime'
  | 'react-dom'
  | 'react-dom/client'

interface PluginGenerationArtifactFileBaseV1 {
  readonly path: `./${string}`
  readonly digest: `sha256:${string}`
  readonly byteLength: number
}

export interface PluginGenerationArtifactModuleV1 extends PluginGenerationArtifactFileBaseV1 {
  readonly kind: 'module'
  readonly mediaType: 'text/javascript'
  readonly imports: readonly `./${string}`[]
  readonly dynamicImports: readonly `./${string}`[]
  readonly styles: readonly `./${string}`[]
  readonly assets: readonly `./${string}`[]
}

export interface PluginGenerationArtifactStylesheetV1 extends PluginGenerationArtifactFileBaseV1 {
  readonly kind: 'stylesheet'
  readonly mediaType: 'text/css'
  readonly assets: readonly `./${string}`[]
}

export interface PluginGenerationArtifactAssetV1 extends PluginGenerationArtifactFileBaseV1 {
  readonly kind: 'asset'
  readonly mediaType:
    | 'application/wasm'
    | 'font/woff'
    | 'font/woff2'
    | `image/${'avif' | 'gif' | 'jpeg' | 'png' | 'svg+xml' | 'webp'}`
}

export type PluginGenerationArtifactFileV1 =
  | PluginGenerationArtifactModuleV1
  | PluginGenerationArtifactStylesheetV1
  | PluginGenerationArtifactAssetV1

export interface PluginGenerationArtifactV1 {
  readonly $schema: typeof CORDISX_PLUGIN_GENERATION_ARTIFACT_SCHEMA
  readonly contract: typeof CORDISX_PLUGIN_GENERATION_ARTIFACT_CONTRACT
  readonly schemaVersion: 1
  readonly format: 'browser-esm-graph'
  readonly entry: `./${string}`
  readonly initialStyles: readonly `./${string}`[]
  readonly sharedImports: readonly PluginGenerationSharedImportV1[]
  readonly files: readonly PluginGenerationArtifactFileV1[]
}

export interface BuiltPluginGenerationArtifact {
  readonly manifest: PluginGenerationArtifactV1
  readonly files: ReadonlyMap<`./${string}`, Uint8Array>
  readonly moduleSource: string
  readonly inputModules: readonly string[]
}

export interface CordisXPluginViteConfigOptions {
  /** Absolute plugin package root. */
  readonly root: string
  /** Package-root-relative or absolute browser entry. */
  readonly entry: string
  /** Package-root-relative or absolute output directory. Defaults to `dist`. */
  readonly outDir?: string
  /** URL-safe root entry filename. Defaults to `module.js`. */
  readonly entryFileName?: `${string}.js` | `${string}.mjs`
  /** Internal/testing seam; normal author builds write the graph. */
  readonly write?: boolean
}

const SHARED_MODULES = new Set<PluginGenerationSharedImportV1>([
  CORDISX_REACT_MODULE,
  CORDISX_REACT_JSX_RUNTIME_MODULE,
  CORDISX_REACT_JSX_DEV_RUNTIME_MODULE,
  CORDISX_UI_MODULE,
])
const PEER_MODULES = new Set<PluginGenerationSharedImportV1>([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
])
const SHARED_PREFIX = '\0cordisx-production-shared:'

function sharedModuleId(specifier: PluginGenerationSharedImportV1): string {
  if (specifier === 'react-dom' || specifier === 'react-dom/client') return `peer:${specifier}`
  return specifier.startsWith('react') ? `cordisx/${specifier}` : specifier
}

function cordisXProductionSharedModules(
  pluginRoot: string,
  sharedImports: Set<PluginGenerationSharedImportV1>,
): Plugin {
  return {
    name: 'cordisx-production-shared-runtime',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'cordisx/contracts') {
        sharedImports.add(source)
        return CONTRACTS_MODULE_PATH
      }
      if (SHARED_MODULES.has(source as PluginGenerationSharedImportV1)) {
        sharedImports.add(source as PluginGenerationSharedImportV1)
        return `${SHARED_PREFIX}${source}`
      }
      if (!PEER_MODULES.has(source as PluginGenerationSharedImportV1) || importer === undefined) return
      const normalized = normalizePath(importer)
      const relative = path.relative(pluginRoot, normalized)
      if (
        !normalized.includes('/node_modules/')
        && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ) return
      sharedImports.add(source as PluginGenerationSharedImportV1)
      return `${SHARED_PREFIX}${sharedModuleId(source as PluginGenerationSharedImportV1)}`
    },
    load(id) {
      if (!id.startsWith(SHARED_PREFIX)) return
      return cordisXSharedModuleSource(id.slice(SHARED_PREFIX.length))
    },
  }
}

function bytes(source: string | Uint8Array): Uint8Array {
  return typeof source === 'string' ? Buffer.from(source) : source
}

function mediaType(
  fileName: string,
): {
  readonly kind: PluginGenerationArtifactFileKind
  readonly mediaType: PluginGenerationArtifactFileV1['mediaType']
} {
  const extension = path.extname(fileName).toLowerCase()
  if (extension === '.js' || extension === '.mjs') return { kind: 'module', mediaType: 'text/javascript' }
  if (extension === '.css') return { kind: 'stylesheet', mediaType: 'text/css' }
  const media = new Map<string, PluginGenerationArtifactAssetV1['mediaType']>([
    ['.avif', 'image/avif'],
    ['.gif', 'image/gif'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.wasm', 'application/wasm'],
  ]).get(extension)
  if (media === undefined) throw new Error(`plugin production graph emitted unsupported asset type: ${fileName}`)
  return { kind: 'asset', mediaType: media }
}

function artifactPath(fileName: string): `./${string}` {
  const normalized = normalizePath(fileName)
  if (
    !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|mjs)|chunks\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|mjs)|assets\/[A-Za-z0-9][A-Za-z0-9._-]*)$/u
      .test(normalized)
  ) {
    throw new Error(`plugin production graph emitted an unsafe path: ${fileName}`)
  }
  return `./${normalized}`
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function outputOf(result: Awaited<ReturnType<typeof viteBuild>>): Rollup.RollupOutput {
  if (Array.isArray(result)) {
    if (result.length !== 1) throw new Error('plugin production build produced multiple output graphs')
    return result[0]!
  }
  if ('output' in result) return result
  throw new Error('plugin production build did not produce a Rollup output graph')
}

function artifactProjection(
  output: readonly (Rollup.OutputAsset | Rollup.OutputChunk)[],
  sharedImports: ReadonlySet<PluginGenerationSharedImportV1>,
): BuiltPluginGenerationArtifact {
  const graphOutput = output.filter(item => item.fileName !== 'artifact.json')
  const outputFiles = new Map<`./${string}`, Uint8Array>()
  const inputModules = new Set<string>()
  const chunkByPath = new Map<`./${string}`, Rollup.OutputChunk>()
  let entry: `./${string}` | undefined
  let moduleSource: string | undefined
  for (const item of graphOutput) {
    const itemBytes = item.type === 'chunk' ? Buffer.from(item.code) : bytes(item.source)
    const itemPath = artifactPath(item.fileName)
    outputFiles.set(itemPath, itemBytes)
    if (item.type !== 'chunk') continue
    chunkByPath.set(itemPath, item)
    for (const id of Object.keys(item.modules)) inputModules.add(normalizePath(id))
    if (!item.isEntry) continue
    if (entry !== undefined) throw new Error('plugin production build emitted multiple entries')
    entry = itemPath
    moduleSource = item.code
  }
  if (entry === undefined || moduleSource === undefined) throw new Error('plugin production build emitted no entry')
  assertNoPrivateReactModules([...inputModules], 'plugin production graph')
  if ([...inputModules].some(input => input.includes('/node_modules/@deepseek-ai/cordis/'))) {
    throw new Error('plugin production graph must not bundle a second @deepseek-ai/cordis runtime')
  }
  const stylesFor = (chunk: Rollup.OutputChunk): readonly `./${string}`[] => {
    const metadata =
      (chunk as typeof chunk & { readonly viteMetadata?: { readonly importedCss?: ReadonlySet<string> } }).viteMetadata
    return [...metadata?.importedCss ?? []].map(artifactPath).sort()
  }
  const assetsFor = (chunk: Rollup.OutputChunk): readonly `./${string}`[] => {
    const metadata =
      (chunk as typeof chunk & { readonly viteMetadata?: { readonly importedAssets?: ReadonlySet<string> } })
        .viteMetadata
    return [...metadata?.importedAssets ?? []].map(artifactPath).sort()
  }
  const stylesheetAssets = (filePath: `./${string}`, value: Uint8Array): readonly `./${string}`[] => {
    const source = Buffer.from(value).toString('utf8')
    const found = new Set<`./${string}`>()
    for (const match of source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gu)) {
      const reference = match[2]?.trim()
      if (reference === undefined || /^(?:data:|https?:|blob:|#)/iu.test(reference)) continue
      const withoutSuffix = reference.split(/[?#]/u, 1)[0]
      if (withoutSuffix === undefined) continue
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filePath.slice(2)), withoutSuffix))
      found.add(artifactPath(resolved))
    }
    return [...found].sort()
  }
  const files = [...outputFiles].map(([filePath, value]): PluginGenerationArtifactFileV1 => {
    const identity = mediaType(filePath)
    const common = { path: filePath, digest: sha256(value), byteLength: value.byteLength }
    if (identity.kind === 'module') {
      const chunk = chunkByPath.get(filePath)
      if (chunk === undefined) throw new Error(`plugin production module metadata is missing: ${filePath}`)
      return {
        ...common,
        kind: 'module',
        mediaType: 'text/javascript',
        imports: chunk.imports.map(artifactPath).sort(),
        dynamicImports: chunk.dynamicImports.map(artifactPath).sort(),
        styles: stylesFor(chunk),
        assets: assetsFor(chunk),
      }
    }
    if (identity.kind === 'stylesheet') {
      return { ...common, kind: 'stylesheet', mediaType: 'text/css', assets: stylesheetAssets(filePath, value) }
    }
    return { ...common, kind: 'asset', mediaType: identity.mediaType as PluginGenerationArtifactAssetV1['mediaType'] }
  }).sort((left, right) => left.path.localeCompare(right.path))
  const initialStyles = new Set<`./${string}`>()
  const visited = new Set<string>()
  const visitStatic = (modulePath: `./${string}`): void => {
    if (visited.has(modulePath)) return
    visited.add(modulePath)
    const descriptor = files.find(file => file.path === modulePath)
    if (descriptor?.kind !== 'module') throw new Error(`plugin production static import is missing: ${modulePath}`)
    for (const style of descriptor.styles) initialStyles.add(style)
    for (const imported of descriptor.imports) visitStatic(imported)
  }
  visitStatic(entry)
  for (const style of initialStyles) {
    if (files.find(file => file.path === style)?.kind !== 'stylesheet') {
      throw new Error(`plugin production initial stylesheet is missing: ${style}`)
    }
  }
  return Object.freeze({
    manifest: Object.freeze({
      $schema: CORDISX_PLUGIN_GENERATION_ARTIFACT_SCHEMA,
      contract: CORDISX_PLUGIN_GENERATION_ARTIFACT_CONTRACT,
      schemaVersion: 1,
      format: 'browser-esm-graph',
      entry,
      initialStyles: Object.freeze([...initialStyles].sort()),
      sharedImports: Object.freeze([...sharedImports].sort()),
      files: Object.freeze(files.map(file => Object.freeze(file))),
    }),
    files: outputFiles,
    moduleSource,
    inputModules: Object.freeze([...inputModules].sort()),
  })
}

function artifactManifestPlugin(sharedImports: Set<PluginGenerationSharedImportV1>): Plugin {
  return {
    name: 'cordisx-plugin-generation-artifact',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const projected = artifactProjection(Object.values(bundle), sharedImports)
        this.emitFile({
          type: 'asset',
          fileName: 'artifact.json',
          source: `${JSON.stringify(projected.manifest, null, 2)}\n`,
        })
      },
    },
  }
}

function pluginViteBuild(options: CordisXPluginViteConfigOptions): {
  readonly config: UserConfig
  readonly sharedImports: Set<PluginGenerationSharedImportV1>
} {
  if (!path.isAbsolute(options.root)) throw new Error('CordisX plugin Vite root must be absolute')
  const entryFileName = options.entryFileName ?? 'module.js'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|mjs)$/u.test(entryFileName)) {
    throw new Error('CordisX plugin Vite entryFileName is invalid')
  }
  const sharedImports = new Set<PluginGenerationSharedImportV1>()
  return {
    sharedImports,
    config: {
      root: options.root,
      base: './',
      publicDir: false,
      appType: 'custom',
      plugins: [cordisXProductionSharedModules(options.root, sharedImports), artifactManifestPlugin(sharedImports)],
      build: {
        write: options.write ?? true,
        outDir: path.resolve(options.root, options.outDir ?? 'dist'),
        emptyOutDir: true,
        target: 'chrome120',
        cssCodeSplit: true,
        assetsInlineLimit: 0,
        sourcemap: false,
        minify: 'esbuild',
        manifest: false,
        modulePreload: { polyfill: false },
        rollupOptions: {
          input: path.resolve(options.root, options.entry),
          preserveEntrySignatures: 'strict',
          output: {
            format: 'es',
            entryFileNames: entryFileName,
            chunkFileNames: 'chunks/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash][extname]',
          },
        },
      },
      esbuild: { jsx: 'automatic', jsxImportSource: 'cordisx/react' },
      logLevel: 'silent',
    },
  }
}

/** Shared author/Host production config; emits `artifact.json` beside the ESM graph. */
export function cordisXPluginViteConfig(options: CordisXPluginViteConfigOptions): UserConfig {
  return pluginViteBuild(options).config
}

/** Build one formal browser-native ESM graph without changing Vite development/HMR. */
export async function buildProductionPluginGraph(root: string, entry: string): Promise<BuiltPluginGenerationArtifact> {
  const created = pluginViteBuild({ root, entry, write: false })
  const result = outputOf(await viteBuild({ ...created.config, configFile: false }))
  return artifactProjection(result.output, created.sharedImports)
}
