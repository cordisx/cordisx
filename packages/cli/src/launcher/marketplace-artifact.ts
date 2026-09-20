import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ReadEntry, t as inspectTar } from 'tar'
import { isValidMarketplacePackageName } from '../marketplace-package-name.js'
import type { CordisXPluginLifecycleResultV1 } from '../plugin-lifecycle-contracts.js'
import type { MarketplaceArtifactInspectionRequest } from '../renderer/marketplace-artifact-binding.js'
import type { PluginLifecycleBridgeHandler } from './plugin-lifecycle-rpc.js'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_PACKAGE_JSON_BYTES = 64 * 1024
const MAX_README_BYTES = 1024 * 1024
const MAX_REDIRECTS = 4
const DOWNLOAD_TIMEOUT_MS = 30_000
const README_PATH = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|markdown)$/

function downloadError(error: unknown, url: URL, signal: AbortSignal): Error {
  if (signal.aborted && signal.reason?.name !== 'TimeoutError') return signal.reason
  const codes = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])
  const pending: unknown[] = [error]
  let code: string | undefined
  for (let index = 0; index < pending.length && index < 8; index++) {
    const cause = pending[index]
    if (cause === null || typeof cause !== 'object') continue
    const candidate = Reflect.get(cause, 'code')
    if (typeof candidate === 'string' && codes.has(candidate)) {
      code = candidate
      break
    }
    pending.push(Reflect.get(cause, 'cause'))
    if (cause instanceof AggregateError) pending.push(...cause.errors.slice(0, 8))
  }
  const timedOut = signal.reason?.name === 'TimeoutError' || error instanceof Error && error.name === 'TimeoutError'
  // Redirect URLs and raw transport messages may contain credentials. Expose only the host and known codes.
  return new Error(
    `Plugin download from ${url.hostname} ${timedOut ? 'timed out' : 'failed'}${code ? ` (${code})` : ''}. `
      + 'Check network access to this host and retry.',
    { cause: error },
  )
}

export type MarketplaceArtifactBindingRequest =
  | {
    readonly kind: 'inspect' | 'preview'
    readonly requestId: string
    readonly request: MarketplaceArtifactInspectionRequest
  }
  | { readonly kind: 'cancel'; readonly requestId: string; readonly targetRequestId: string }

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const accepted = new Set(keys)
  const unknown = Object.keys(value).find(key => !accepted.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

function identifier(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function artifactUrl(value: unknown, label: string, redirect = false): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw new Error(`${label} is invalid`)
  const url = new URL(value)
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
    || (!redirect && (url.search !== '' || url.href !== value))
  ) {
    throw new Error(`${label} must be a canonical HTTPS URL without credentials`)
  }
  return url
}

export function parseMarketplaceArtifactBindingRequest(value: unknown): MarketplaceArtifactBindingRequest {
  const input = object(value, 'Marketplace artifact request')
  const requestId = identifier(
    input.requestId,
    'Marketplace artifact request id',
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  )
  if (input.kind === 'cancel') {
    exactKeys(input, ['kind', 'requestId', 'targetRequestId'], 'Marketplace artifact cancel request')
    return {
      kind: 'cancel',
      requestId,
      targetRequestId: identifier(
        input.targetRequestId,
        'Marketplace artifact target request id',
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
      ),
    }
  }
  if (input.kind !== 'inspect' && input.kind !== 'preview') {
    throw new Error('Marketplace artifact operation is unsupported')
  }
  exactKeys(input, ['kind', 'requestId', 'request'], 'Marketplace artifact inspect request')
  const request = object(input.request, 'Marketplace artifact identity')
  exactKeys(
    request,
    ['schemaVersion', 'pluginId', 'version', 'canonicalSource', 'artifact'],
    'Marketplace artifact identity',
  )
  const schemaVersion = request.schemaVersion
  if (
    schemaVersion !== 3 && schemaVersion !== 4 && schemaVersion !== 5 && schemaVersion !== 6
    && schemaVersion !== 7 && schemaVersion !== 8
  ) {
    throw new Error('Marketplace schema version is unsupported')
  }
  const artifact = object(request.artifact, 'Marketplace artifact')
  exactKeys(
    artifact,
    schemaVersion === 8
      ? ['publisherIdentity', 'packageName', 'downloadUrl', 'integrity']
      : ['publisherIdentity', 'packageNamespace', 'packageName', 'downloadUrl', 'integrity'],
    'Marketplace artifact',
  )
  const pluginId = identifier(request.pluginId, 'Marketplace plugin id', /^[a-z0-9][a-z0-9._-]*$/)
  const version = identifier(
    request.version,
    'Marketplace plugin version',
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  )
  const canonicalSource = artifactUrl(request.canonicalSource, 'Marketplace canonical source').href.replace(/\/$/u, '')
  const packageName = identifier(artifact.packageName, 'Marketplace package name', /^.{1,214}$/)
  if (
    schemaVersion === 8
      ? !isValidMarketplacePackageName(packageName)
      : !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(packageName)
  ) throw new Error('Marketplace package name is invalid')
  const packageNamespace = artifact.packageNamespace === undefined
    ? undefined
    : identifier(artifact.packageNamespace, 'Marketplace package namespace', /^@[a-z0-9][a-z0-9._-]*$/)
  const publisherIdentity = artifact.publisherIdentity === undefined
    ? undefined
    : identifier(
      artifact.publisherIdentity,
      'Marketplace publisher identity',
      /^npm:(?:@[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/,
    )
  if (
    schemaVersion <= 7
    && (publisherIdentity !== `npm:${packageNamespace}` || !packageName.startsWith(`${packageNamespace}/`))
  ) {
    throw new Error('Marketplace package identity is inconsistent')
  }
  const integrity = identifier(artifact.integrity, 'Marketplace artifact integrity', /^sha256:[a-f0-9]{64}$/)
  return {
    kind: input.kind,
    requestId,
    request: {
      schemaVersion,
      pluginId,
      version,
      canonicalSource,
      artifact: {
        ...(publisherIdentity === undefined ? {} : { publisherIdentity }),
        ...(packageNamespace === undefined ? {} : { packageNamespace }),
        packageName,
        downloadUrl: artifactUrl(artifact.downloadUrl, 'Marketplace artifact URL').href,
        integrity,
      },
    },
  }
}

async function download(
  url: URL,
  destination: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ readonly url: string; readonly digest: `sha256:${string}` }> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      accept: 'application/octet-stream',
      'accept-encoding': 'identity',
      'user-agent': 'CordisX-Marketplace/0.1',
    },
    signal,
  }).catch(error => {
    throw downloadError(error, url, signal)
  })
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= MAX_REDIRECTS) throw new Error('Marketplace artifact redirected too many times')
    const location = response.headers.get('location')
    if (location === null) throw new Error('Marketplace artifact redirect has no location')
    await response.body?.cancel()
    return await download(
      artifactUrl(new URL(location, url).href, 'Marketplace artifact redirect', true),
      destination,
      signal,
      redirects + 1,
    )
  }
  if (!response.ok || response.body === null) {
    throw new Error(`Marketplace artifact download failed with HTTP ${response.status}`)
  }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_ARTIFACT_BYTES) throw new Error('Marketplace artifact exceeds 64 MiB')
  const file = await open(destination, 'wx', 0o600)
  const hash = createHash('sha256')
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const chunk = await reader.read().catch(error => {
        throw downloadError(error, url, signal)
      })
      if (chunk.done) break
      const bytes = Buffer.from(chunk.value)
      size += bytes.byteLength
      if (size > MAX_ARTIFACT_BYTES) throw new Error('Marketplace artifact exceeds 64 MiB')
      hash.update(bytes)
      await file.write(bytes)
    }
  } finally {
    reader.releaseLock()
    await file.close()
  }
  return { url: response.url || url.href, digest: `sha256:${hash.digest('hex')}` }
}

async function npmPackageIdentity(archive: string): Promise<{ readonly name: string; readonly version: string }> {
  let packageJson: Buffer | undefined
  let duplicate = false
  await inspectTar({
    file: archive,
    onentry: (entry: ReadEntry) => {
      const entryPath = entry.path.replaceAll('\\', '/')
      if (entryPath !== 'package/package.json' && entryPath !== 'package.json') {
        entry.resume()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      entry.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.byteLength
        if (size > MAX_PACKAGE_JSON_BYTES) entry.destroy(new Error('Marketplace package.json exceeds 64 KiB'))
        else chunks.push(bytes)
      })
      entry.once('end', () => {
        if (packageJson !== undefined) duplicate = true
        else packageJson = Buffer.concat(chunks)
      })
    },
  })
  if (duplicate) throw new Error('Marketplace artifact contains multiple package.json identities')
  if (packageJson === undefined) throw new Error('Marketplace artifact has no package.json identity')
  const value = JSON.parse(packageJson.toString('utf8')) as { readonly name?: unknown; readonly version?: unknown }
  if (typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error('Marketplace artifact package.json identity is invalid')
  }
  return { name: value.name, version: value.version }
}

async function archiveDigest(archive: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

async function archiveEntry(
  archive: string,
  paths: readonly string[],
  maximumBytes: number,
): Promise<{ readonly path: string; readonly bytes: Buffer } | undefined> {
  let found: { readonly path: string; readonly bytes: Buffer } | undefined
  let duplicate = false
  await inspectTar({
    file: archive,
    onentry: (entry: ReadEntry) => {
      const entryPath = entry.path.replaceAll('\\', '/')
      if (!paths.includes(entryPath)) {
        entry.resume()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      entry.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.byteLength
        if (size > maximumBytes) entry.destroy(new Error(`${entryPath} exceeds preview size limit`))
        else chunks.push(bytes)
      })
      entry.once('end', () => {
        if (found !== undefined) duplicate = true
        else found = { path: entryPath, bytes: Buffer.concat(chunks) }
      })
    },
  })
  if (duplicate) throw new Error(`Marketplace artifact contains multiple ${paths.at(-1) ?? 'requested'} files`)
  return found
}

async function cordisxPackageIdentity(
  archive: string,
): Promise<{ readonly id: string; readonly version: string; readonly canonicalSource: string }> {
  const manifest = await archiveEntry(
    archive,
    ['package/cordisx-package.json', 'cordisx-package.json'],
    MAX_PACKAGE_JSON_BYTES,
  )
  if (manifest === undefined) throw new Error('Marketplace artifact has no CordisX package manifest')
  const value = object(JSON.parse(manifest.bytes.toString('utf8')), 'Marketplace CordisX package manifest')
  return {
    id: identifier(value.id, 'Marketplace CordisX plugin id', /^[a-z0-9][a-z0-9._-]*$/),
    version: identifier(
      value.version,
      'Marketplace CordisX plugin version',
      /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    ),
    canonicalSource: artifactUrl(value.canonicalSource, 'Marketplace CordisX canonical source').href.replace(
      /\/$/u,
      '',
    ),
  }
}

export interface MarketplaceArtifactArchiveValidation {
  readonly archive: string
  readonly size: number
  readonly schemaVersion: MarketplaceArtifactInspectionRequest['schemaVersion']
  readonly downloadUrl: string
  readonly integrity: `sha256:${string}`
  readonly packageName: string
  readonly pluginId: string
  readonly version: string
  readonly canonicalSource: string
}

async function validateMarketplaceArtifactIdentity(
  archive: string,
  request: MarketplaceArtifactInspectionRequest,
  integrity: `sha256:${string}`,
): Promise<
  Pick<
    MarketplaceArtifactArchiveValidation,
    'integrity' | 'packageName' | 'pluginId' | 'version' | 'canonicalSource'
  >
> {
  if (integrity !== request.artifact.integrity) {
    throw new Error(`Marketplace artifact SHA-256 mismatch; received ${integrity}`)
  }
  const [npmIdentity, cordisxIdentity] = await Promise.all([
    npmPackageIdentity(archive),
    cordisxPackageIdentity(archive),
  ])
  if (npmIdentity.name !== request.artifact.packageName || npmIdentity.version !== request.version) {
    throw new Error('Marketplace feed package identity does not match package.json')
  }
  if (
    cordisxIdentity.id !== request.pluginId || cordisxIdentity.version !== request.version
    || cordisxIdentity.canonicalSource !== request.canonicalSource
  ) {
    throw new Error('Marketplace feed identity does not match the packaged CordisX manifest')
  }
  return {
    integrity,
    packageName: npmIdentity.name,
    pluginId: cordisxIdentity.id,
    version: npmIdentity.version,
    canonicalSource: cordisxIdentity.canonicalSource,
  }
}

export async function validateMarketplaceArtifactArchive(
  archive: string,
  request: MarketplaceArtifactInspectionRequest,
): Promise<MarketplaceArtifactArchiveValidation> {
  const archiveStats = await stat(archive)
  if (!archiveStats.isFile()) throw new Error('Marketplace artifact archive must be a file')
  if (archiveStats.size > MAX_ARTIFACT_BYTES) throw new Error('Marketplace artifact exceeds 64 MiB')
  const validated = await validateMarketplaceArtifactIdentity(archive, request, await archiveDigest(archive))
  return {
    archive: path.resolve(archive),
    size: archiveStats.size,
    schemaVersion: request.schemaVersion,
    downloadUrl: request.artifact.downloadUrl,
    ...validated,
  }
}

async function packagedReadme(archive: string): Promise<string | undefined> {
  const manifest = await archiveEntry(
    archive,
    ['package/cordisx-package.json', 'cordisx-package.json'],
    MAX_PACKAGE_JSON_BYTES,
  )
  if (manifest === undefined) throw new Error('Marketplace artifact has no CordisX package manifest')
  const value = JSON.parse(manifest.bytes.toString('utf8')) as { readonly readme?: unknown }
  if (value.readme === undefined) return undefined
  if (typeof value.readme !== 'string' || !README_PATH.test(value.readme)) {
    throw new Error('Marketplace artifact README path is invalid')
  }
  const prefix = manifest.path.slice(0, manifest.path.length - 'cordisx-package.json'.length)
  const readmePath = `${prefix}${value.readme.slice(2)}`
  const readme = await archiveEntry(archive, [readmePath], MAX_README_BYTES)
  if (readme === undefined) throw new Error('Marketplace artifact declares a missing README')
  return readme.bytes.toString('utf8')
}

export async function inspectMarketplaceArtifactPackage(
  handler: PluginLifecycleBridgeHandler,
  request: MarketplaceArtifactInspectionRequest,
  signal: AbortSignal,
): Promise<CordisXPluginLifecycleResultV1> {
  const staged = await stageMarketplaceArtifactPackage(handler, request, signal)
  return await handler.coordinator.inspectStagedPackage(staged, `marketplace-${randomUUID()}`)
}

async function stageMarketplaceArtifactPackage(
  handler: PluginLifecycleBridgeHandler,
  request: MarketplaceArtifactInspectionRequest,
  signal: AbortSignal,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordisx-marketplace-artifact-'))
  const archive = path.join(directory, 'artifact.tgz')
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  try {
    const downloaded = await download(new URL(request.artifact.downloadUrl), archive, combined)
    await validateMarketplaceArtifactIdentity(archive, request, downloaded.digest)
    combined.throwIfAborted()
    const staged = await handler.coordinator.stagePackageSource({
      kind: 'downloaded-tarball',
      location: pathToFileURL(archive).href,
      downloadedFrom: request.artifact.downloadUrl,
      distributionIntegrity: request.artifact.integrity,
    })
    if (
      staged.manifest.id !== request.pluginId || staged.manifest.version !== request.version
      || staged.manifest.canonicalSource !== request.canonicalSource
    ) {
      throw new Error('Marketplace feed identity does not match the packaged CordisX manifest')
    }
    combined.throwIfAborted()
    return staged
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function previewMarketplaceArtifactPackage(
  _handler: PluginLifecycleBridgeHandler,
  request: MarketplaceArtifactInspectionRequest,
  signal: AbortSignal,
): Promise<{ readonly readme?: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordisx-marketplace-preview-'))
  const archive = path.join(directory, 'artifact.tgz')
  const combined = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
  try {
    const downloaded = await download(new URL(request.artifact.downloadUrl), archive, combined)
    await validateMarketplaceArtifactIdentity(archive, request, downloaded.digest)
    combined.throwIfAborted()
    const readme = await packagedReadme(archive)
    return readme === undefined ? {} : { readme }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
