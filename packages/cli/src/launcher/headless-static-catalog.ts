import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startLocalCodexAppServer } from '../providers/codex-app-server.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** A private catalog used only by a newly started Host-owned app-server. */
export async function prepareHeadlessStaticCatalog(input: {
  readonly enabled: boolean
  readonly nativeVersion: string
  readonly executable: string
  readonly codexHome: string
  readonly userHome: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly startProbe?: typeof startLocalCodexAppServer
}): Promise<{ path: string; bytes: Uint8Array; sha256: string; close(): Promise<void> } | undefined> {
  if (!input.enabled || input.nativeVersion !== '0.167.0-alpha.3.2') return undefined
  let directory: string | undefined
  try {
    const probe = await (input.startProbe ?? startLocalCodexAppServer)({
      id: 'catalog-probe',
      kind: 'local-codex',
      displayName: 'Catalog probe',
      sourceProviderId: 'codex',
      codexExecutable: input.executable,
      codexHome: input.codexHome,
      enabled: true,
      timeoutMs: 5_000,
    }, { environment: { ...input.environment, HOME: input.userHome }, experimentalApi: true })
    try {
      const config = object(object(await probe.request('config/read', { cwd: input.cwd, includeLayers: false })).config)
      const requirementsValue = object(await probe.request('configRequirements/read', {})).requirements
      const requirements = object(requirementsValue)
      // Never replace a user-selected or managed startup catalog.
      if (
        !Object.hasOwn(config, 'model_catalog_json') || config.model_catalog_json !== null
        || requirementsValue !== null
          && (!Object.hasOwn(requirements, 'modelCatalogJson') || requirements.modelCatalogJson !== null)
      ) return undefined
    } finally {
      await probe.close()
    }
    const raw = await readFile(path.join(input.codexHome, 'models_cache.json'))
    if (raw.byteLength > 16 * 1024 * 1024) return undefined
    const cache = object(JSON.parse(raw.toString('utf8')))
    if (!Array.isArray(cache.models) || !cache.models.length) return undefined
    const bytes = Buffer.from(JSON.stringify({ models: cache.models }))
    directory = await mkdtemp(path.join(os.tmpdir(), 'cx-model-catalog-'))
    const file = path.join(directory, 'catalog.json')
    await writeFile(file, bytes, { mode: 0o400, flag: 'wx' })
    await chmod(file, 0o400)
    const owned = directory
    return {
      path: file,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      close: () => rm(owned, { recursive: true, force: true }),
    }
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    return undefined
  }
}

/** Read only the existing opt-in; malformed or unavailable state never enables a catalog freeze. */
export async function headlessLiveBudgetEnabled(file: string): Promise<boolean> {
  try {
    const data = object(JSON.parse(await readFile(file, 'utf8')))
    const defaults = object(object(data.continuationDefaults).policy)
    if (defaults.enabled === true) return true
    const entries = object(data.continuations)
    return Object.values(entries).some(value => object(object(object(value).livePolicy).overrides).enabled === true)
  } catch {
    return false
  }
}
