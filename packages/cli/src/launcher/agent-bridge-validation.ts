import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BridgeValidationCache, BridgeValidationKey } from './agent-bridge-contract.js'

/**
 * Remembers which app + provider + model + cwd combinations a start already
 * validated, so a later `dryRun` answers from here instead of repeating the
 * checks. It lives under the CordisX home (`<home>/run/bridge-validation.json`)
 * because it belongs to that home's model services, not to one launch.
 */

/** `<home>/run/bridge-validation.json`: what earlier starts proved works. */
export function bridgeValidationPath(cordisxHomeDir: string): string {
  return path.join(cordisxHomeDir, 'run', 'bridge-validation.json')
}

/** One line per combination: never split on a path or model id. */
export function validationKey(key: BridgeValidationKey): string {
  return JSON.stringify([
    key.app,
    key.providerId ?? '',
    key.model ?? '',
    key.cwd,
    createHash('sha256').update(key.configuration ?? '').digest('hex'),
  ])
}

const MAX_ENTRIES = 200

/** The same memory for one handler's lifetime, for a caller with no CordisX home to write under. */
export function memoryValidationCache(): BridgeValidationCache {
  const known = new Set<string>()
  return {
    remembers: async key => known.has(validationKey(key)),
    remember: async key => {
      known.add(validationKey(key))
    },
  }
}

export function createBridgeValidationCache(cordisxHomeDir: string): BridgeValidationCache {
  let entries: Promise<Set<string>> | undefined
  const load = (): Promise<Set<string>> => {
    entries ??= (async () => {
      try {
        const document = JSON.parse(await readFile(bridgeValidationPath(cordisxHomeDir), 'utf8')) as {
          entries?: unknown
        }
        return new Set(
          (Array.isArray(document.entries) ? document.entries : []).filter(
            (entry): entry is string => typeof entry === 'string',
          ),
        )
      } catch {
        return new Set<string>()
      }
    })()
    return entries
  }
  return {
    async remembers(key) {
      return (await load()).has(validationKey(key))
    },
    async remember(key) {
      const known = await load()
      const value = validationKey(key)
      if (known.has(value)) return
      known.add(value)
      // Oldest first: drop the front when the file would grow without bound.
      const kept = [...known].slice(-MAX_ENTRIES)
      entries = Promise.resolve(new Set(kept))
      const file = bridgeValidationPath(cordisxHomeDir)
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        const temporary = `${file}.${randomUUID()}.tmp`
        await writeFile(temporary, `${JSON.stringify({ version: 1, entries: kept })}\n`, { mode: 0o600 })
        await rename(temporary, file)
      } catch { /* a cache that cannot be written only costs a repeated check */ }
    },
  }
}
