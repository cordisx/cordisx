import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { startLocalCodexAppServer } from '../providers/codex-app-server.js'

const exec = promisify(execFile)
const MAX_BYTES = 16 * 1024 * 1024
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Codex 0.149 has no provider requirement keys; newer fields, if present, must be unset. */
export function headlessManagedCatalogRequirements(value: unknown): boolean {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const requirements = value as Record<string, unknown>
  return Object.hasOwn(requirements, 'modelCatalogJson') && requirements.modelCatalogJson === null
    && ['modelProvider', 'modelProviders'].every(key => !Object.hasOwn(requirements, key) || requirements[key] === null)
}

/** Freeze a complete native catalog only after native config and requirements agree. */
export async function prepareHeadlessManagedBaseCatalog(input: {
  readonly nativeVersion: string
  readonly executable: string
  readonly codexHome: string
  readonly userHome: string
  readonly environment: NodeJS.ProcessEnv
  readonly startProbe?: typeof startLocalCodexAppServer
  readonly runDebug?: () => Promise<string>
}) {
  if (input.nativeVersion !== '0.149.1') return undefined
  let directory: string | undefined
  let probe: Awaited<ReturnType<typeof startLocalCodexAppServer>> | undefined
  try {
    const environment = { ...input.environment, HOME: input.userHome, CODEX_HOME: input.codexHome }
    probe = await (input.startProbe ?? startLocalCodexAppServer)({
      id: 'managed-catalog-probe',
      kind: 'local-codex',
      displayName: 'Catalog probe',
      sourceProviderId: 'codex',
      codexExecutable: input.executable,
      codexHome: input.codexHome,
      enabled: true,
      timeoutMs: 5_000,
    }, { environment, experimentalApi: true })
    const configuration = async () => {
      const config = object(
        object(await probe!.request('config/read', { cwd: input.codexHome, includeLayers: false })).config,
      )
      const requirements = object(await probe!.request('configRequirements/read', {})).requirements
      if (!Object.hasOwn(config, 'model_catalog_json') || !headlessManagedCatalogRequirements(requirements)) {
        return undefined
      }
      if (config.model_catalog_json !== null && typeof config.model_catalog_json !== 'string') return undefined
      return { config, requirements }
    }
    const before = await configuration()
    if (!before) return undefined
    const configuredPath = before.config.model_catalog_json
    let bytes: Buffer
    if (typeof configuredPath === 'string') {
      const file = path.resolve(input.codexHome, configuredPath)
      if ((await stat(file)).size > MAX_BYTES) return undefined
      bytes = await readFile(file)
    } else {
      const raw = input.runDebug
        ? await input.runDebug()
        : (await exec(input.executable, ['debug', 'models'], {
          cwd: input.codexHome,
          env: environment,
          timeout: 15_000,
          maxBuffer: MAX_BYTES,
        })).stdout
      bytes = Buffer.from(raw)
    }
    if (!bytes.length || bytes.length > MAX_BYTES) return undefined
    const document = object(JSON.parse(bytes.toString('utf8')))
    if (!Array.isArray(document.models) || !document.models.length || document.models.length > 20_000) return undefined
    const slugs = document.models.map(row => object(row).slug)
    if (slugs.some(slug => typeof slug !== 'string' || !slug) || new Set(slugs).size !== slugs.length) return undefined
    const after = await configuration()
    if (!after || !isDeepStrictEqual(before, after)) return undefined
    // A user-provided catalog could change while it is being copied.
    if (
      typeof configuredPath === 'string'
      && !(await readFile(path.resolve(input.codexHome, configuredPath))).equals(bytes)
    ) {
      return undefined
    }
    directory = await mkdtemp(path.join(os.tmpdir(), 'cx-managed-catalog-'))
    const file = path.join(directory, 'catalog.json')
    await writeFile(file, bytes, { flag: 'wx', mode: 0o400 })
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
  } finally {
    await probe?.close().catch(() => undefined)
  }
}
