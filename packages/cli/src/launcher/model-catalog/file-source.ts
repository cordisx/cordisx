import { type FSWatcher, watch } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { boundedString, CatalogError, type CatalogModel, object } from './contracts.js'

export async function readCatalogFile(file: string, signal?: AbortSignal): Promise<readonly CatalogModel[]> {
  const handle = await open(file, 'r')
  try {
    signal?.throwIfAborted()
    const before = await handle.stat()
    if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new CatalogError('source-invalid')
    // Read one byte beyond the budget, even if a writer grows the file after stat.
    const bytes = Buffer.alloc(Math.min(before.size + 1, 32 * 1024 * 1024 + 1))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const after = await handle.stat()
    signal?.throwIfAborted()
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new CatalogError('source-invalid')
    }
    const body = object(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')))
    if (!Array.isArray(body?.models) || body.models.length > 10_000) throw new CatalogError('source-invalid')
    const models = new Map<string, CatalogModel>()
    for (const item of body.models) {
      const model = object(item)
      const id = model?.id ?? model?.slug
      const label = model?.label ?? model?.display_name ?? id
      const aliases = model?.aliases ?? []
      if (
        !boundedString(id) || !boundedString(label, 256) || !Array.isArray(aliases)
        || aliases.length > 128 || aliases.some(alias => !boundedString(alias, 256))
      ) {
        throw new CatalogError('source-invalid')
      }
      if (!models.has(id)) models.set(id, Object.freeze({ id, label, aliases: Object.freeze([...aliases]) }))
    }
    return Object.freeze([...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  } catch {
    throw new CatalogError('source-invalid')
  } finally {
    await handle.close()
  }
}

/** Watch parent directories so atomic-save renames do not strand an inode watcher. */
export function watchCatalogFiles(
  files: readonly string[],
  changed: () => void,
  options: { debounceMs?: number; reconcileMs?: number } = {},
): { dispose(): void } {
  const paths = [...new Set(files.map(file => path.resolve(file)))]
  if (paths.length > 256) throw new Error('Too many catalog files')
  const watchers: FSWatcher[] = []
  let disposed = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let maximum: ReturnType<typeof setTimeout> | undefined
  let polling = false
  let signatures: string[] | undefined
  const flush = () => {
    if (debounce) clearTimeout(debounce)
    if (maximum) clearTimeout(maximum)
    debounce = maximum = undefined
    if (!disposed) changed()
  }
  const dirty = () => {
    if (disposed) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(flush, options.debounceMs ?? 250)
    debounce.unref?.()
    maximum ??= setTimeout(flush, 2000)
    maximum.unref?.()
  }
  const directories = new Map<string, Set<string>>()
  for (const file of paths) {
    const directory = path.dirname(file)
    const names = directories.get(directory) ?? new Set<string>()
    names.add(path.basename(file))
    directories.set(directory, names)
  }
  for (const [directory, names] of directories) {
    try {
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (name === null || names.has(String(name))) dirty()
      })
      watcher.on('error', () => {
        watcher.close()
        dirty()
      })
      watchers.push(watcher)
    } catch { /* A missing directory is handled by bounded reconciliation. */ }
  }
  const reconcile = async () => {
    if (disposed || polling) return
    polling = true
    try {
      const next = await Promise.all(paths.map(async file => {
        try {
          const value = await stat(file)
          return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`
        } catch {
          return 'missing'
        }
      }))
      if (signatures && next.some((value, index) => value !== signatures![index])) dirty()
      signatures = next
    } finally {
      polling = false
    }
  }
  void reconcile()
  const timer = setInterval(() => {
    void reconcile()
  }, options.reconcileMs ?? 30_000)
  timer.unref?.()
  return {
    dispose() {
      disposed = true
      clearInterval(timer)
      if (debounce) clearTimeout(debounce)
      if (maximum) clearTimeout(maximum)
      for (const watcher of watchers) watcher.close()
    },
  }
}
