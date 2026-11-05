import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { modelServiceRuntimeOwnership } from '../launcher/model-service-codex-options-projection.js'
import { readCodexProviderTarget } from '../launcher/provider-profile-sync-codex-target.js'

const table = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

// Codex's defaults matter only when an older scalar from a lower layer would
// survive an omitted value. Keep the source representation optional.
// See ModelProviderInfo in the bundled Codex v0.166.0-alpha.6:
// https://github.com/openai/codex/blob/rust-v0.166.0-alpha.6/codex-rs/model-provider-info/src/lib.rs
const DEFAULTS = {
  supports_websockets: false,
  request_max_retries: 4,
  stream_max_retries: 5,
  stream_idle_timeout_ms: 300_000,
} as const

function selectsNativeProfile(args: readonly string[]): boolean {
  const separator = args.indexOf('--')
  return (separator < 0 ? args : args.slice(0, separator)).some(arg =>
    arg === '--profile' || arg.startsWith('--profile=') || arg.startsWith('-p')
  )
}

/** For a known collision, add a one-use Codex V2 layer before the final CLI provider table. */
export async function prepareTerminalCodexProviderLayer(
  service: {
    readonly providerId: string
    readonly provider: Readonly<Record<string, unknown>>
    readonly runtimeOptionsOwned: boolean
  },
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<
  {
    readonly name?: string
    readonly provider: Readonly<Record<string, unknown>>
    close(): Promise<void>
  } | undefined
> {
  const codexHome = path.resolve(environment.CODEX_HOME ?? path.join(environment.HOME ?? homedir(), '.codex'))
  let snapshot
  try {
    snapshot = await readCodexProviderTarget({
      adapterId: 'codex',
      hostInstanceId: 'terminal-model-service',
      profileId: 'default',
      configRoot: codexHome,
    })
  } catch {
    if (service.runtimeOptionsOwned) {
      throw new Error('Cannot safely read the Codex provider configuration for this service')
    }
    return undefined
  }
  const ownership = snapshot && modelServiceRuntimeOwnership(snapshot.raw).get(service.providerId)
  if (!service.runtimeOptionsOwned && ownership !== 'source') return undefined
  if (selectsNativeProfile(args)) {
    throw new Error('A Codex native --profile cannot be combined with CordisX-managed runtime options for this service')
  }
  const native = table(table(snapshot?.config.model_providers)?.[service.providerId])
  if (typeof snapshot?.config.profile === 'string') {
    throw new Error('The default Codex native profile conflicts with CordisX-managed runtime options for this service')
  }
  if (native === undefined) return undefined

  const provider = { ...service.provider }
  for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
    if (Object.hasOwn(native, key) && !Object.hasOwn(provider, key)) provider[key] = defaultValue
  }
  const masks = ['http_headers', 'env_http_headers'].filter(key => {
    const inherited = table(native[key])
    const desired = table(provider[key])
    if (!inherited || !Object.keys(inherited).some(name => !desired || !Object.hasOwn(desired, name))) return false
    provider[key] = desired ?? {}
    return true
  })
  if (masks.length === 0) return { provider, async close() {} }

  const root = await lstat(codexHome)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Codex runtime options require a regular CODEX_HOME directory')
  }
  const directory = await realpath(codexHome)
  const name = `cordisx-terminal-${randomUUID()}`
  const filename = path.join(directory, `${name}.config.toml`)
  const handle = await open(filename, 'wx', 0o600)
  let owned: Awaited<ReturnType<typeof handle.stat>> | undefined
  const close = async () => {
    try {
      const existing = await lstat(filename)
      if (owned && existing.isFile() && existing.dev === owned.dev && existing.ino === owned.ino) await unlink(filename)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    owned = await handle.stat()
    // Change the type only for maps with inherited keys. The higher CLI layer
    // replaces those maps; other fields in the same provider table survive.
    await handle.writeFile(
      `[model_providers.${JSON.stringify(service.providerId)}]\n`
        + masks.map(key => `${key} = false\n`).join(''),
    )
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await close()
    throw error
  }
  return { name, provider, close }
}
