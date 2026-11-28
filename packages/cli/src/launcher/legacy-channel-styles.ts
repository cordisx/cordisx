import { parse } from 'acorn'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { HostPackageManifest } from './packages/types.js'
import type { BuiltPluginGenerationArtifact } from './production-plugin-build.js'
import { parsePluginGenerationArtifactV1 } from './plugin-generation-artifact-server.js'
import { assertPluginGenerationArtifactFileReferences } from './plugin-generation-artifact-validation.js'

// The published 0.1.7 archive predates browser graphs and embeds this CSS in
// its entry. Keep this exception tied to the exact public release, not the
// plugin name, a self-declared version, or another source's permissions.
const ARCHIVE = 'sha256:0cc75afbf84d117835863b00a57e0412c621b8ec4e2c387327a6dd2e4f123856'
const ENTRY = 'sha256:1bf28432d70d3fae94793ea8a5ca445bd4a1470b49e9c2fb116a837c77634fdf'
const STYLES = 'sha256:0227cf822adc38b51358bf641c38dfd78a8bf70d3f54d6d92215a4a483bf42a3'
const STYLE_PATH = './assets/channel-legacy-v017.css' as const

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

/** Only the exact published archive receives the legacy compatibility path. */
export function isLegacyChannelRelease(input: {
  readonly packageManifest: Pick<HostPackageManifest, 'pluginId' | 'version' | 'canonicalSource'>
  readonly artifactIntegrity?: `sha256:${string}`
}): boolean {
  const { packageManifest } = input
  return packageManifest.pluginId === 'channel' && packageManifest.version === '0.1.7'
    && packageManifest.canonicalSource === 'https://github.com/cordisx/plugin-channel'
    && input.artifactIntegrity === ARCHIVE
}

/** Read a single static top-level literal without executing package code. */
export function extractLegacyChannelStyle(source: string): string {
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const declarations = program.body.flatMap(statement =>
    statement.type === 'VariableDeclaration'
      ? statement.declarations.filter(item => item.id.type === 'Identifier' && item.id.name === 'channel_default')
      : []
  )
  const value = declarations[0]?.init
  if (declarations.length !== 1 || value?.type !== 'Literal' || typeof value.value !== 'string') {
    throw new Error('legacy-channel-style-literal-unavailable')
  }
  return value.value
}

/** Add only the verified legacy stylesheet to the same immutable plugin graph. */
export async function restoreLegacyChannelStyle(input: {
  readonly packageManifest: Pick<HostPackageManifest, 'pluginId' | 'version' | 'canonicalSource'>
  readonly artifactIntegrity?: `sha256:${string}`
  readonly entry: string
  readonly artifact: BuiltPluginGenerationArtifact
}): Promise<BuiltPluginGenerationArtifact> {
  const { artifact } = input
  if (!isLegacyChannelRelease(input) || artifact.manifest.initialStyles.length !== 0) return artifact

  const entry = await readFile(input.entry)
  if (digest(entry) !== ENTRY) throw new Error('legacy-channel-entry-integrity-failed')
  const css = Buffer.from(extractLegacyChannelStyle(entry.toString('utf8')))
  if (digest(css) !== STYLES) throw new Error('legacy-channel-style-integrity-failed')
  if (artifact.files.has(STYLE_PATH)) throw new Error('legacy-channel-style-path-conflict')

  const files = new Map(artifact.files)
  files.set(STYLE_PATH, css)
  const descriptors = artifact.manifest.files.map(file =>
    file.path === artifact.manifest.entry && file.kind === 'module'
      ? { ...file, styles: [...file.styles, STYLE_PATH].sort((left, right) => left.localeCompare(right, 'en')) }
      : file
  )
  descriptors.push({
    path: STYLE_PATH,
    kind: 'stylesheet',
    mediaType: 'text/css',
    digest: STYLES,
    byteLength: css.byteLength,
    assets: [],
  })
  descriptors.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const manifest = parsePluginGenerationArtifactV1({
    ...artifact.manifest,
    initialStyles: [STYLE_PATH],
    files: descriptors,
  })
  await assertPluginGenerationArtifactFileReferences(manifest, files)
  return Object.freeze({ ...artifact, manifest, files })
}
