import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HomeConfigModelServiceProvider, HomeConfigProvider } from '../config/home-config.js'
import { claudeSpeaks, modelServicesOf, modelsForApp, servicesForApp } from './model-service-projection.js'

/**
 * Seeds the data directory a CordisX-owned Claude Desktop profile reads.
 *
 * Claude Desktop reads its third-party inference setup from
 * `<data>/configLibrary/<uuid>.json`, picked by `appliedId` in `_meta.json`.
 * The launcher points the app at `<data>` with `CLAUDE_USER_DATA_DIR`, so the
 * app treats it as its third-party directory directly.
 *
 * Credentials never land in these files: each entry uses the app's
 * `helper-script` credential kind, and the helper prints the key from the
 * environment variable the declaration names. The launcher puts that variable
 * in the app's environment.
 */

/** Claude only loads an `appliedId` that is a lowercase 36-character UUID. */
export function claudeLibraryIdFor(providerId: string): string {
  const hex = createHash('sha256').update(`cordisx-model-service:${providerId}`).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${
    hex.slice(20, 32)
  }`
}

export const CLAUDE_CREDENTIAL_HELPER = path.join('cordisx', 'credential-helper.sh')

/** Keys a CordisX entry owns; every other key in an existing entry is kept as the user left it. */
const OWNED_KEYS = [
  'inferenceProvider',
  'inferenceGatewayBaseUrl',
  'inferenceGatewayApiKey',
  'inferenceCredentialKind',
  'inferenceCredentialHelper',
  'inferenceCredentialHelperArgs',
  'disableDeploymentModeChooser',
] as const

const HELPER_SCRIPT = `#!/bin/sh
# Written by CordisX. Prints the gateway key from the environment variable
# named by its first argument; the key itself is never stored on disk.
case "$1" in
  ''|*[!A-Za-z0-9_]*) echo "cordisx credential helper: invalid variable name" >&2; exit 2 ;;
esac
value=$(printenv "$1")
if [ -z "$value" ]; then
  echo "cordisx credential helper: $1 is not set" >&2
  exit 1
fi
printf '%s' "$value"
`

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
}

export interface ClaudeProfileSeedDiagnostic {
  readonly providerId: string
  readonly code: 'protocol-unsupported' | 'provider-unknown'
}

export interface ClaudeProfileSeedResult {
  readonly providerIds: readonly string[]
  readonly appliedProviderId?: string
  readonly diagnostics: readonly ClaudeProfileSeedDiagnostic[]
}

/**
 * Writes every Claude-capable declaration into `<dataDir>/configLibrary`.
 *
 * `selectedId` makes that declaration the applied one. Without it, an entry the
 * profile already applied stays applied, so a plain relaunch keeps the user's
 * last choice; a fresh profile applies the first declaration.
 */
export async function seedClaudeDesktopProfile(input: {
  readonly dataDir: string
  readonly providers: readonly HomeConfigProvider[]
  readonly selectedId?: string | undefined
}): Promise<ClaudeProfileSeedResult> {
  const diagnostics: ClaudeProfileSeedDiagnostic[] = []
  const declared = servicesForApp(input.providers, 'claude')
  for (const provider of modelServicesOf(input.providers)) {
    if (provider.enabled === false || claudeSpeaks(provider)) continue
    if (provider.appliesTo !== undefined && !provider.appliesTo.includes('claude')) continue
    diagnostics.push({ providerId: provider.id, code: 'protocol-unsupported' })
  }
  if (input.selectedId !== undefined && !declared.some(provider => provider.id === input.selectedId)) {
    diagnostics.push({ providerId: input.selectedId, code: 'provider-unknown' })
  }

  const library = path.join(input.dataDir, 'configLibrary')
  await mkdir(library, { recursive: true, mode: 0o700 })
  const helper = path.join(input.dataDir, CLAUDE_CREDENTIAL_HELPER)
  await mkdir(path.dirname(helper), { recursive: true, mode: 0o700 })
  await writeFile(helper, HELPER_SCRIPT, { mode: 0o700 })
  await chmod(helper, 0o700)

  for (const provider of declared) {
    const file = path.join(library, `${claudeLibraryIdFor(provider.id)}.json`)
    const existing = await readJson(file) ?? {}
    for (const key of OWNED_KEYS) delete existing[key]
    await writePrivateJson(file, {
      ...existing,
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: provider.baseUrl,
      inferenceCredentialKind: 'helper-script',
      inferenceCredentialHelper: helper,
      inferenceCredentialHelperArgs: [provider.apiKeyEnv],
      disableDeploymentModeChooser: true,
    })
  }

  const metaFile = path.join(library, '_meta.json')
  const meta = await readJson(metaFile) ?? {}
  const ownIds = new Map(declared.map(provider => [claudeLibraryIdFor(provider.id), provider]))
  const previousEntries = Array.isArray(meta.entries) ? meta.entries as Array<{ id?: unknown; name?: unknown }> : []
  // Entries the user added in Claude's own settings survive; CordisX rewrites only its own.
  const foreign = previousEntries.filter(entry => typeof entry.id === 'string' && !ownIds.has(entry.id))
  const previousApplied = typeof meta.appliedId === 'string' ? meta.appliedId : undefined
  const selected = input.selectedId === undefined
    ? undefined
    : declared.find(provider => provider.id === input.selectedId)
  const appliedId = selected !== undefined
    ? claudeLibraryIdFor(selected.id)
    : previousApplied !== undefined
        && (ownIds.has(previousApplied) || foreign.some(entry => entry.id === previousApplied))
    ? previousApplied
    : declared[0] === undefined
    ? previousApplied
    : claudeLibraryIdFor(declared[0].id)
  await writePrivateJson(metaFile, {
    ...meta,
    ...(appliedId === undefined ? {} : { appliedId }),
    entries: [
      ...declared.map(provider => ({ id: claudeLibraryIdFor(provider.id), name: provider.displayName })),
      ...foreign,
    ],
  })

  // A config that already says 1p would keep the app out of gateway mode.
  const desktopConfigFile = path.join(input.dataDir, 'claude_desktop_config.json')
  const desktopConfig = await readJson(desktopConfigFile) ?? {}
  if (desktopConfig.deploymentMode !== '3p') {
    await writePrivateJson(desktopConfigFile, { ...desktopConfig, deploymentMode: '3p' })
  }

  const applied = [...ownIds.entries()].find(([id]) => id === appliedId)?.[1]
  return Object.freeze({
    providerIds: Object.freeze(declared.map(provider => provider.id)),
    ...(applied === undefined ? {} : { appliedProviderId: applied.id }),
    diagnostics: Object.freeze(diagnostics),
  })
}

/** One provider as the Claude side shows it: declared in CordisX, or already in the library. */
export interface ClaudeProviderCatalogEntry {
  readonly providerId: string
  readonly libraryId: string
  readonly title: string
  readonly baseUrl?: string
  readonly models: readonly string[]
  /** `declared` is a CordisX model service; `library` is an entry only Claude's own config holds. */
  readonly source: 'declared' | 'library'
  readonly applied: boolean
}

/**
 * Reads the provider catalog for Claude: the CordisX declarations merged with
 * the entries already in the profile's `configLibrary`. A declaration and the
 * library entry it produced share one library id and appear once. Credentials
 * are never read out.
 */
export async function readClaudeProviderCatalog(
  providers: readonly HomeConfigProvider[],
  dataDir: string,
): Promise<readonly ClaudeProviderCatalogEntry[]> {
  const library = path.join(dataDir, 'configLibrary')
  const meta = await readJson(path.join(library, '_meta.json'))
  const appliedId = typeof meta?.appliedId === 'string' ? meta.appliedId : undefined
  const entries = Array.isArray(meta?.entries) ? meta.entries as Array<{ id?: unknown; name?: unknown }> : []

  const declared: ClaudeProviderCatalogEntry[] = servicesForApp(providers, 'claude').map(
    (provider: HomeConfigModelServiceProvider) => {
      const libraryId = claudeLibraryIdFor(provider.id)
      return Object.freeze({
        providerId: provider.id,
        libraryId,
        title: provider.displayName,
        baseUrl: provider.baseUrl,
        models: Object.freeze([...modelsForApp(provider, 'claude')]),
        source: 'declared' as const,
        applied: libraryId === appliedId,
      })
    },
  )
  const declaredIds = new Set(declared.map(entry => entry.libraryId))
  const fromLibrary: ClaudeProviderCatalogEntry[] = []
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || declaredIds.has(entry.id)) continue
    const document = await readJson(path.join(library, `${entry.id}.json`))
    const baseUrl = typeof document?.inferenceGatewayBaseUrl === 'string' ? document.inferenceGatewayBaseUrl : undefined
    fromLibrary.push(Object.freeze({
      providerId: entry.id,
      libraryId: entry.id,
      title: typeof entry.name === 'string' ? entry.name : entry.id,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      models: Object.freeze([]),
      source: 'library' as const,
      applied: entry.id === appliedId,
    }))
  }
  return Object.freeze([...declared, ...fromLibrary])
}
