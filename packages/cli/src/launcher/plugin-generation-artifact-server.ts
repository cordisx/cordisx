import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { RuntimeModuleAccess } from './packages/authority.js'
import { assertPluginGenerationArtifactFileReferences } from './plugin-generation-artifact-validation.js'

const ARTIFACT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-generation-artifact.v1.schema.json'
const ARTIFACT_CONTRACT = 'cordisx.plugin-generation-artifact/v1'
const ARTIFACT_FORMAT = 'browser-esm-graph'
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const MODULE_PATH = /^\.\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.(?:js|mjs)$/u
const STYLESHEET_PATH = /^\.\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.css$/u
const ASSET_PATH =
  /^\.\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.(?:avif|gif|jpeg|jpg|png|svg|webp|woff|woff2|wasm)$/u
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_REQUEST_TRACE_ENTRIES = 4096

export const MAX_PLUGIN_GENERATION_GRAPH_FILES = 4096
export const MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES = 64 * 1024 * 1024
export const MAX_PLUGIN_GENERATION_GRAPH_BYTES = 256 * 1024 * 1024

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

export type PluginGenerationAssetMediaTypeV1 =
  | 'application/wasm'
  | 'font/woff'
  | 'font/woff2'
  | 'image/avif'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/png'
  | 'image/svg+xml'
  | 'image/webp'

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
  readonly mediaType: PluginGenerationAssetMediaTypeV1
}

export type PluginGenerationArtifactFileV1 =
  | PluginGenerationArtifactModuleV1
  | PluginGenerationArtifactStylesheetV1
  | PluginGenerationArtifactAssetV1

export interface PluginGenerationArtifactV1 {
  readonly $schema: typeof ARTIFACT_SCHEMA
  readonly contract: typeof ARTIFACT_CONTRACT
  readonly schemaVersion: 1
  readonly format: typeof ARTIFACT_FORMAT
  readonly entry: `./${string}`
  readonly initialStyles: readonly `./${string}`[]
  readonly sharedImports: readonly PluginGenerationSharedImportV1[]
  readonly files: readonly PluginGenerationArtifactFileV1[]
}

export interface PluginGenerationArtifactRequestTrace {
  readonly method: string
  readonly leaseId?: string
  readonly artifactPath?: `./${string}`
  readonly status: number
}

export interface PluginGenerationGraphLease {
  readonly leaseId: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly baseUrl: string
  readonly entryUrl: string
  readonly initialStyleUrls: readonly string[]
  /** Awaitable expression which imports the ESM entry and stages its CSS lease. */
  readonly importSource: string
  /** Synchronous expression which makes staged generation styles active. */
  readonly publishSource: string
  /** Synchronous expression which removes styles and leaves a late-link tombstone. */
  readonly retireSource: string
  retire(): void
}

export interface PluginGenerationArtifactServer {
  readonly origin: string
  lease(
    module: RuntimeModuleAccess,
    moduleGeneration: string,
    artifact?: unknown,
  ): Promise<PluginGenerationGraphLease>
  requestTrace(): readonly PluginGenerationArtifactRequestTrace[]
  close(): Promise<void>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const accepted = new Set(keys)
  const unknown = Object.keys(value).find(key => !accepted.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

function logicalPath(value: unknown, pattern: RegExp, label: string): `./${string}` {
  if (typeof value !== 'string' || value.length > 512 || !pattern.test(value)) {
    throw new Error(`${label} must be a normalized artifact-relative path`)
  }
  return value as `./${string}`
}

function integer(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} is outside the supported range`)
  }
  return value as number
}

function sorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value, 'en') < 0)
}

function freezeArtifact(value: PluginGenerationArtifactV1): PluginGenerationArtifactV1 {
  const files = value.files.map(file =>
    Object.freeze(
      file.kind === 'asset' ? { ...file } : {
        ...file,
        ...(file.kind === 'module'
          ? {
            imports: Object.freeze([...file.imports]),
            dynamicImports: Object.freeze([...file.dynamicImports]),
            styles: Object.freeze([...file.styles]),
          }
          : {}),
        assets: Object.freeze([...file.assets]),
      },
    )
  )
  return Object.freeze({
    ...value,
    initialStyles: Object.freeze([...value.initialStyles]),
    sharedImports: Object.freeze([...value.sharedImports]),
    files: Object.freeze(files),
  })
}

const SHARED_IMPORTS = new Set<PluginGenerationSharedImportV1>([
  'cordisx/contracts',
  'cordisx/react',
  'cordisx/react/jsx-dev-runtime',
  'cordisx/react/jsx-runtime',
  'cordisx/ui',
  'react',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
])

const ASSET_MEDIA_TYPES: Readonly<Record<string, PluginGenerationAssetMediaTypeV1>> = Object.freeze({
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
})

function closedPaths(
  value: unknown,
  pattern: RegExp,
  label: string,
  maximum: number,
): readonly `./${string}`[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid`)
  const output = value.map((item, index) => logicalPath(item, pattern, `${label}[${index}]`))
  if (!sorted(output)) {
    throw new Error(`${label} must be unique and sorted`)
  }
  return output
}

function assertClosedGraph(artifact: PluginGenerationArtifactV1): void {
  const files = new Map(artifact.files.map(file => [file.path, file]))
  const expectedKind = (
    edges: readonly `./${string}`[],
    kind: PluginGenerationArtifactFileKind,
    label: string,
  ): void => {
    for (const edge of edges) {
      if (files.get(edge)?.kind !== kind) throw new Error(`${label} references a missing or incompatible file: ${edge}`)
    }
  }
  for (const file of artifact.files) {
    if (file.kind === 'module') {
      expectedKind(file.imports, 'module', `${file.path}.imports`)
      expectedKind(file.dynamicImports, 'module', `${file.path}.dynamicImports`)
      expectedKind(file.styles, 'stylesheet', `${file.path}.styles`)
      expectedKind(file.assets, 'asset', `${file.path}.assets`)
    } else if (file.kind === 'stylesheet') expectedKind(file.assets, 'asset', `${file.path}.assets`)
  }
  expectedKind(artifact.initialStyles, 'stylesheet', 'plugin generation artifact initialStyles')

  const staticModules = new Set<`./${string}`>()
  const visitStatic = (modulePath: `./${string}`): void => {
    if (staticModules.has(modulePath)) return
    staticModules.add(modulePath)
    const file = files.get(modulePath)
    if (file?.kind !== 'module') return
    for (const imported of file.imports) visitStatic(imported)
  }
  visitStatic(artifact.entry)
  const expectedInitialStyles = [...staticModules]
    .flatMap(modulePath => {
      const file = files.get(modulePath)
      return file?.kind === 'module' ? [...file.styles] : []
    })
    .filter((style, index, values) => values.indexOf(style) === index)
    .sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(expectedInitialStyles) !== JSON.stringify(artifact.initialStyles)) {
    throw new Error('plugin generation artifact initialStyles does not match the entry static closure')
  }

  const reachable = new Set<`./${string}`>()
  const visit = (filePath: `./${string}`): void => {
    if (reachable.has(filePath)) return
    reachable.add(filePath)
    const file = files.get(filePath)
    if (file?.kind === 'module') {
      for (const edge of [...file.imports, ...file.dynamicImports, ...file.styles, ...file.assets]) visit(edge)
    } else if (file?.kind === 'stylesheet') { for (const edge of file.assets) visit(edge) }
  }
  visit(artifact.entry)
  if (reachable.size !== files.size) throw new Error('plugin generation artifact contains an unreachable file')
}

/** Parse the closed browser graph object written beside an immutable module entry. */
export function parsePluginGenerationArtifactV1(value: unknown): PluginGenerationArtifactV1 {
  const manifest = record(value, 'plugin generation artifact')
  exactKeys(manifest, [
    '$schema',
    'contract',
    'schemaVersion',
    'format',
    'entry',
    'initialStyles',
    'sharedImports',
    'files',
  ], 'plugin generation artifact')
  if (
    manifest.$schema !== ARTIFACT_SCHEMA || manifest.contract !== ARTIFACT_CONTRACT
    || manifest.schemaVersion !== 1 || manifest.format !== ARTIFACT_FORMAT
  ) {
    throw new Error('plugin generation artifact contract is unsupported')
  }
  const declaredEntry = logicalPath(manifest.entry, MODULE_PATH, 'plugin generation artifact entry')
  if (
    !Array.isArray(manifest.initialStyles) || !Array.isArray(manifest.files)
    || manifest.files.length < 1 || manifest.files.length > MAX_PLUGIN_GENERATION_GRAPH_FILES
  ) {
    throw new Error('plugin generation artifact file lists are invalid')
  }
  if (
    !Array.isArray(manifest.sharedImports) || manifest.sharedImports.length > SHARED_IMPORTS.size
    || manifest.sharedImports.some(item =>
      typeof item !== 'string' || !SHARED_IMPORTS.has(item as PluginGenerationSharedImportV1)
    )
    || !sorted(manifest.sharedImports as string[])
  ) {
    throw new Error('plugin generation artifact sharedImports must be closed, unique, and sorted')
  }
  const seen = new Set<string>()
  const folded = new Set<string>()
  let totalBytes = 0
  const files = manifest.files.map((raw, index): PluginGenerationArtifactFileV1 => {
    const file = record(raw, `plugin generation artifact files[${index}]`)
    const kind = file.kind
    exactKeys(
      file,
      kind === 'module'
        ? ['path', 'kind', 'mediaType', 'digest', 'byteLength', 'imports', 'dynamicImports', 'styles', 'assets']
        : kind === 'stylesheet'
        ? ['path', 'kind', 'mediaType', 'digest', 'byteLength', 'assets']
        : ['path', 'kind', 'mediaType', 'digest', 'byteLength'],
      `plugin generation artifact files[${index}]`,
    )
    if (kind !== 'module' && kind !== 'stylesheet' && kind !== 'asset') {
      throw new Error(`plugin generation artifact files[${index}].kind is unsupported`)
    }
    const filePath = logicalPath(
      file.path,
      kind === 'module' ? MODULE_PATH : kind === 'stylesheet' ? STYLESHEET_PATH : ASSET_PATH,
      `plugin generation artifact files[${index}].path`,
    )
    const foldedPath = filePath.toLocaleLowerCase('en-US')
    if (seen.has(filePath) || folded.has(foldedPath)) {
      throw new Error(`plugin generation artifact file is duplicated: ${filePath}`)
    }
    seen.add(filePath)
    folded.add(foldedPath)
    const expectedMediaType = kind === 'module'
      ? 'text/javascript'
      : kind === 'stylesheet'
      ? 'text/css'
      : ASSET_MEDIA_TYPES[path.extname(filePath).toLocaleLowerCase('en-US')]
    if (file.mediaType !== expectedMediaType) {
      throw new Error(`plugin generation artifact files[${index}].mediaType is invalid`)
    }
    if (typeof file.digest !== 'string' || !DIGEST.test(file.digest)) {
      throw new Error(`plugin generation artifact files[${index}].digest is invalid`)
    }
    const byteLength = integer(
      file.byteLength,
      `plugin generation artifact files[${index}].byteLength`,
      MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES,
    )
    totalBytes += byteLength
    if (totalBytes > MAX_PLUGIN_GENERATION_GRAPH_BYTES) {
      throw new Error('plugin generation artifact exceeds the total byte limit')
    }
    const common = {
      path: filePath,
      digest: file.digest as `sha256:${string}`,
      byteLength,
    }
    if (kind === 'module') {
      return Object.freeze({
        ...common,
        kind,
        mediaType: 'text/javascript',
        imports: closedPaths(
          file.imports,
          MODULE_PATH,
          `plugin generation artifact files[${index}].imports`,
          MAX_PLUGIN_GENERATION_GRAPH_FILES,
        ),
        dynamicImports: closedPaths(
          file.dynamicImports,
          MODULE_PATH,
          `plugin generation artifact files[${index}].dynamicImports`,
          MAX_PLUGIN_GENERATION_GRAPH_FILES,
        ),
        styles: closedPaths(file.styles, STYLESHEET_PATH, `plugin generation artifact files[${index}].styles`, 256),
        assets: closedPaths(
          file.assets,
          ASSET_PATH,
          `plugin generation artifact files[${index}].assets`,
          MAX_PLUGIN_GENERATION_GRAPH_FILES,
        ),
      })
    }
    if (kind === 'stylesheet') {
      return Object.freeze({
        ...common,
        kind,
        mediaType: 'text/css',
        assets: closedPaths(
          file.assets,
          ASSET_PATH,
          `plugin generation artifact files[${index}].assets`,
          MAX_PLUGIN_GENERATION_GRAPH_FILES,
        ),
      })
    }
    return Object.freeze({ ...common, kind, mediaType: expectedMediaType as PluginGenerationAssetMediaTypeV1 })
  })
  if (!sorted(files.map(file => file.path))) {
    throw new Error('plugin generation artifact files must be path-sorted')
  }
  const entry = files.find(file => file.path === declaredEntry)
  if (entry?.kind !== 'module') {
    throw new Error('plugin generation artifact entry must name a declared JavaScript module')
  }
  const initialStyles = closedPaths(
    manifest.initialStyles,
    STYLESHEET_PATH,
    'plugin generation artifact initialStyles',
    256,
  )
  const artifact = freezeArtifact({
    $schema: ARTIFACT_SCHEMA,
    contract: ARTIFACT_CONTRACT,
    schemaVersion: 1,
    format: ARTIFACT_FORMAT,
    entry: declaredEntry,
    initialStyles,
    sharedImports: manifest.sharedImports as PluginGenerationSharedImportV1[],
    files,
  })
  assertClosedGraph(artifact)
  return artifact
}

/** Read a graph manifest, returning undefined only for an actual legacy artifact. */
export async function readPluginGenerationArtifactV1(
  artifactDirectory: string,
): Promise<PluginGenerationArtifactV1 | undefined> {
  if (!path.isAbsolute(artifactDirectory)) throw new Error('plugin artifact directory must be absolute')
  const root = await realpath(artifactDirectory)
  const manifestPath = path.join(root, 'artifact.json')
  const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    },
  )
  if (handle === undefined) return undefined
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
      throw new Error('plugin generation artifact manifest is not a bounded regular file')
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength !== metadata.size) {
      throw new Error('plugin generation artifact manifest changed during readback')
    }
    return parsePluginGenerationArtifactV1(JSON.parse(bytes.toString('utf8')) as unknown)
  } finally {
    await handle.close()
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function readVerifiedFile(
  root: string,
  file: PluginGenerationArtifactFileV1,
): Promise<Buffer> {
  const unresolved = path.resolve(root, file.path.slice(2))
  if (!inside(root, unresolved)) throw new Error('plugin generation artifact request escapes its immutable root')
  const resolved = await realpath(unresolved)
  if (!inside(root, resolved)) throw new Error('plugin generation artifact request resolves outside its immutable root')
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const metadata = await handle.stat()
    if (
      !metadata.isFile() || metadata.size !== file.byteLength || metadata.size > MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES
    ) {
      throw new Error('plugin generation artifact file metadata failed integrity readback')
    }
    const bytes = await handle.readFile()
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (bytes.byteLength !== file.byteLength || digest !== file.digest) {
      throw new Error('plugin generation artifact file failed integrity readback')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function resourceRegistryInstallSource(): string {
  return `(() => {
  if (globalThis.__cordisxPluginGenerationResourcesV1 !== undefined) return;
  const records = new Map();
  const links = new Map();
  const styleLink = node => node instanceof HTMLLinkElement && node.relList.contains('stylesheet');
  const matching = href => {
    for (const record of records.values()) if (href.startsWith(record.baseUrl)) return record;
    return undefined;
  };
  const remember = link => {
    if (!styleLink(link)) return;
    const record = matching(link.href);
    if (record === undefined) return;
    if (record.state === 'retired') {
      if (!links.has(link)) links.set(link, { record, media: link.getAttribute('media') });
      record.links.add(link);
      link.dataset.cordisxPluginGeneration = record.id;
      link.media = 'not all';
      link.disabled = true;
      try { link.remove(); } catch {}
      if (!link.isConnected) {
        links.delete(link);
        record.links.delete(link);
      }
      return;
    }
    if (!links.has(link)) links.set(link, { record, media: link.getAttribute('media') });
    record.links.add(link);
    link.dataset.cordisxPluginGeneration = record.id;
    if (record.state === 'staged') link.media = 'not all';
  };
  const visit = node => {
    if (!(node instanceof Element)) return;
    remember(node);
    for (const link of node.querySelectorAll('link[rel~="stylesheet"]')) remember(link);
  };
  const observer = new MutationObserver(changes => {
    for (const change of changes) for (const node of change.addedNodes) visit(node);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const api = Object.freeze({
    stage(input) {
      const current = records.get(input.id);
      if (current !== undefined) {
        if (current.baseUrl !== input.baseUrl || current.state === 'retired') throw new Error('plugin generation resource lease is stale');
        return current.publicLease;
      }
      let rejectReady;
      const retired = new Promise((_, reject) => { rejectReady = reject; });
      const record = { id: input.id, baseUrl: input.baseUrl, state: 'staged', links: new Set(), publicLease: undefined, rejectReady };
      const loading = input.initialStyles.map(href => new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.media = 'not all';
        link.addEventListener('load', () => resolve(), { once: true });
        link.addEventListener('error', () => reject(new Error('plugin generation stylesheet failed to load')), { once: true });
        links.set(link, { record, media: null });
        record.links.add(link);
        link.dataset.cordisxPluginGeneration = record.id;
        (document.head || document.documentElement).append(link);
      }));
      const ready = Promise.race([Promise.all(loading).then(() => undefined), retired]);
      ready.catch(() => undefined);
      record.publicLease = Object.freeze({ id: record.id, ready });
      records.set(record.id, record);
      for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) remember(link);
      return record.publicLease;
    },
    publish(id) {
      const record = records.get(id);
      if (record === undefined || record.state === 'retired') throw new Error('plugin generation resource lease is stale');
      for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) remember(link);
      record.state = 'published';
      for (const link of record.links) {
        const tracked = links.get(link);
        if (tracked?.media === null) link.removeAttribute('media');
        else if (tracked !== undefined) link.setAttribute('media', tracked.media);
      }
      return true;
    },
    retire(id) {
      const record = records.get(id);
      if (record === undefined) return false;
      for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) remember(link);
      record.state = 'retired';
      record.rejectReady(new Error('plugin generation resource lease was retired'));
      let removed = true;
      for (const link of [...record.links]) {
        link.media = 'not all';
        link.disabled = true;
        try { link.remove(); } catch { removed = false; }
        if (link.isConnected) removed = false;
        else {
          links.delete(link);
          record.links.delete(link);
        }
      }
      if (!removed) throw new Error('plugin generation stylesheet retirement failed');
      return true;
    },
    dispose() {
      observer.disconnect();
      for (const record of records.values()) {
        record.rejectReady(new Error('plugin generation resource registry was disposed'));
        for (const link of record.links) link.remove();
      }
      records.clear();
      links.clear();
      if (globalThis.__cordisxPluginGenerationResourcesV1 === api) delete globalThis.__cordisxPluginGenerationResourcesV1;
    },
  });
  globalThis.__cordisxPluginGenerationResourcesV1 = api;
})()`
}

interface Route {
  readonly root: string
  readonly files: ReadonlyMap<string, PluginGenerationArtifactFileV1>
}

function headers(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('cross-origin-resource-policy', 'cross-origin')
  response.setHeader('x-content-type-options', 'nosniff')
}

function status(response: ServerResponse, value: number): void {
  headers(response)
  response.statusCode = value
  response.setHeader('cache-control', 'no-store')
  response.end()
}

/** Start an in-process, launch-scoped server for exact immutable browser graph files. */
export async function startPluginGenerationArtifactServer(): Promise<PluginGenerationArtifactServer> {
  const secret = randomBytes(32).toString('hex')
  const routes = new Map<string, Route>()
  const trace: PluginGenerationArtifactRequestTrace[] = []
  let closed = false
  let origin = ''
  const rememberTrace = (item: PluginGenerationArtifactRequestTrace): void => {
    trace.push(Object.freeze(item))
    if (trace.length > MAX_REQUEST_TRACE_ENTRIES) trace.splice(0, trace.length - MAX_REQUEST_TRACE_ENTRIES)
  }
  const server: Server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? ''
      let leaseId: string | undefined
      let artifactPath: `./${string}` | undefined
      const finish = (value: number): void => {
        rememberTrace({
          method,
          ...(leaseId === undefined ? {} : { leaseId }),
          ...(artifactPath === undefined ? {} : { artifactPath }),
          status: value,
        })
        status(response, value)
      }
      if (method !== 'GET' && method !== 'HEAD') {
        finish(405)
        return
      }
      let url: URL
      try {
        url = new URL(request.url ?? '/', origin)
      } catch {
        finish(400)
        return
      }
      if (url.search !== '' || url.hash !== '') {
        finish(404)
        return
      }
      let decoded: string
      try {
        decoded = decodeURIComponent(url.pathname)
      } catch {
        finish(400)
        return
      }
      const prefix = `/cordisx-plugin-artifacts/${secret}/`
      if (!decoded.startsWith(prefix)) {
        finish(404)
        return
      }
      const remainder = decoded.slice(prefix.length)
      const separator = remainder.indexOf('/')
      if (separator < 1) {
        finish(404)
        return
      }
      leaseId = remainder.slice(0, separator)
      const relative = `./${remainder.slice(separator + 1)}`
      if (!MODULE_PATH.test(relative) && !STYLESHEET_PATH.test(relative) && !ASSET_PATH.test(relative)) {
        finish(404)
        return
      }
      artifactPath = relative as `./${string}`
      const route = routes.get(leaseId)
      const file = route?.files.get(artifactPath)
      if (route === undefined || file === undefined) {
        finish(404)
        return
      }
      try {
        const bytes = await readVerifiedFile(route.root, file)
        headers(response)
        response.statusCode = 200
        response.setHeader('content-type', file.mediaType)
        response.setHeader('content-length', String(bytes.byteLength))
        response.setHeader('cache-control', 'public, max-age=31536000, immutable')
        response.setHeader('etag', `"${file.digest.slice('sha256:'.length)}"`)
        rememberTrace({ method, leaseId, artifactPath, status: 200 })
        response.end(method === 'HEAD' ? undefined : bytes)
      } catch {
        finish(409)
      }
    })().catch(() => {
      rememberTrace({ method: request.method ?? '', status: 500 })
      if (!response.headersSent) status(response, 500)
      else response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    async lease(module, moduleGeneration, suppliedArtifact) {
      if (closed) throw new Error('plugin generation artifact server is closed')
      if (!path.isAbsolute(module.artifactDirectory)) {
        throw new Error('runtime module projection is invalid')
      }
      if (!GENERATION.test(moduleGeneration)) throw new Error('plugin module generation is invalid')
      const root = await realpath(module.artifactDirectory)
      const artifact = suppliedArtifact === undefined
        ? await readPluginGenerationArtifactV1(root)
        : parsePluginGenerationArtifactV1(suppliedArtifact)
      if (artifact === undefined) throw new Error('plugin generation artifact graph is unavailable')
      if (module.runtimeEntry !== artifact.entry) throw new Error('runtime module projection entry is invalid')
      // Keep descriptor-count concurrency from turning into thousands of open
      // files while still binding every route to verified bytes before exposure.
      const verifiedFiles = new Map<`./${string}`, Uint8Array>()
      for (const file of artifact.files) verifiedFiles.set(file.path, await readVerifiedFile(root, file))
      await assertPluginGenerationArtifactFileReferences(artifact, verifiedFiles)
      const leaseId = createHash('sha256')
        .update(randomBytes(32))
        .update('\0')
        .update(module.packageIdentity.pluginId)
        .update('\0')
        .update(module.packageIdentity.integrity)
        .update('\0')
        .update(moduleGeneration)
        .digest('hex')
      const files = new Map(artifact.files.map(file => [file.path, file]))
      routes.set(leaseId, { root, files })
      const baseUrl = `${origin}/cordisx-plugin-artifacts/${secret}/${leaseId}/`
      const entryUrl = new URL(artifact.entry.slice(2), baseUrl).href
      const initialStyleUrls = artifact.initialStyles.map(style => new URL(style.slice(2), baseUrl).href)
      const registry = '__cordisxPluginGenerationResourcesV1'
      const install = resourceRegistryInstallSource()
      let retired = false
      const importSource = `(async () => { ${install}; const resources = globalThis.${registry}.stage(${
        JSON.stringify({ id: leaseId, baseUrl, initialStyles: initialStyleUrls })
      }); try { await resources.ready; return await import(${
        JSON.stringify(entryUrl)
      }); } catch (error) { globalThis.${registry}.retire(${JSON.stringify(leaseId)}); throw error; } })()`
      return Object.freeze({
        leaseId,
        pluginId: module.packageIdentity.pluginId,
        moduleGeneration,
        baseUrl,
        entryUrl,
        initialStyleUrls: Object.freeze(initialStyleUrls),
        importSource,
        publishSource:
          `(() => { const registry = globalThis.${registry}; if (registry === undefined || registry.publish(${
            JSON.stringify(leaseId)
          }) !== true) throw new Error('plugin generation resource publication failed'); return true })()`,
        retireSource:
          `(() => { const registry = globalThis.${registry}; if (registry === undefined || registry.retire(${
            JSON.stringify(leaseId)
          }) !== true) throw new Error('plugin generation resource retirement failed'); return true })()`,
        retire(): void {
          if (retired) return
          retired = true
          routes.delete(leaseId)
        },
      })
    },
    requestTrace() {
      return Object.freeze(trace.map(item => Object.freeze({ ...item })))
    },
    async close() {
      if (closed) return
      closed = true
      routes.clear()
      await new Promise<void>((resolve, reject) =>
        server.close(error => error === undefined ? resolve() : reject(error))
      )
    },
  }
}
