import { type AdapterBundle, bundle as builtin } from '@cordisx/codex-adapter'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { diagnostic } from '../../diagnostics/context.js'
import { type AdapterCandidate, type AdapterSelection } from './selection.js'
import {
  type AdapterLease,
  type AdapterReceipt,
  adapterReceipts,
  readAdapterState,
  verifyInstalledAdapter,
} from './store.js'
import { ownedDirectory, withStoreLock, writePrivateJson } from './files.js'

export interface AdapterRuntime {
  readonly candidates: readonly AdapterCandidate[]
  readonly identity: string
  readonly rejected: readonly { identity: string; reason: string }[]
  selected(selection: AdapterSelection): Promise<{
    lifecycle(target: string, status: 'active' | 'unavailable'): Promise<void>
    close(): Promise<void>
  }>
}
/** Packages are trusted launcher code, not plugins and not a sandbox. Never load an unverified entry. */
export async function openAdapterRuntime(root: string): Promise<AdapterRuntime> {
  const candidates: AdapterCandidate[] = []
  const rejected: Array<{ identity: string; reason: string }> = []
  let receipts: AdapterReceipt[] = []
  let preferBuiltin = true
  try {
    await ownedDirectory(root)
    const state = await readAdapterState(root)
    preferBuiltin = state.preferred.length === 0
    receipts = await adapterReceipts(root)
    for (const id of [...new Set([...state.preferred, ...state.rollback])]) {
      if (state.revoked.includes(id)) {
        rejected.push({ identity: id, reason: 'locally revoked' })
        continue
      }
      const receipt = receipts.find(r => r.id === id)
      try {
        if (!receipt) throw new Error('Selected adapter is not installed')
        const entry = await verifyInstalledAdapter(root, receipt)
        const loaded = await import(pathToFileURL(entry).href) as { bundle: AdapterBundle }
        if (loaded.bundle?.version !== receipt.version) throw new Error('Adapter entry/receipt version mismatch')
        if (loaded.bundle.apiVersion !== 1 || loaded.bundle.relayContract !== 1) {
          throw new Error('Host adapter API or relay contract incompatible')
        }
        if (
          !Array.isArray(loaded.bundle.resourceHints)
          || !loaded.bundle.resourceHints.every(h =>
            Array.isArray(h) && h.length > 0 && h.every(s => typeof s === 'string' && s.length > 0)
          )
        ) throw new Error('Adapter discovery hints incompatible')
        candidates.push({ identity: id, bundle: loaded.bundle })
      } catch (error) {
        rejected.push({ identity: id, reason: String(error) })
      }
    }
  } catch (error) {
    rejected.push({ identity: 'store', reason: String(error) })
  }
  // This deterministic build identity invalidates local transformed-source caches on every rule change.
  const fallbackBytes = await readFile(new URL('../../../codex-adapter/adapter.mjs', import.meta.url))
    .catch(async () => readFile(new URL('../../../../codex-adapter/dist/adapter.mjs', import.meta.url)))
  const builtinCandidate = {
    identity: `builtin:${createHash('sha256').update(fallbackBytes).digest('hex')}`,
    bundle: builtin,
  }
  if (preferBuiltin) candidates.unshift(builtinCandidate)
  else candidates.push(builtinCandidate)
  const identity = createHash('sha256').update(JSON.stringify(candidates.map(c => c.identity))).digest('hex')
  return {
    candidates,
    identity,
    rejected,
    async selected({ modules, rejected: selectionRejected }) {
      const packages = [...new Set(modules.map(m => m.identity).filter(id => !id.startsWith('builtin:')))]
      const file = path.join(root, 'leases', `${randomUUID()}.json`)
      let closed = false
      const documents: Record<string, 'active' | 'unavailable'> = {}
      let queue = Promise.resolve()
      const save = async () => {
        const lease: AdapterLease = {
          pid: process.pid,
          packages,
          modules: modules,
          documents: { ...documents },
        }
        await writePrivateJson(file, lease)
      }
      // Lease creation and pruning share the store lock. Keep even pending modules until process teardown.
      await withStoreLock(root, async () => {
        for (const id of packages) {
          const receipt = receipts.find(r => r.id === id)!
          await verifyInstalledAdapter(root, receipt)
        }
        const state = await readAdapterState(root)
        if (packages.some(id => state.revoked.includes(id))) throw new Error('Adapter revoked before selection')
        for (const id of packages) state.lastUsed[id] = Date.now()
        await writePrivateJson(path.join(root, 'state.json'), state)
        await save()
      }).catch(error => {
        if (packages.length > 0) throw error
        rejected.push({ identity: 'store', reason: String(error) })
      })
      diagnostic({
        event: 'codex-adapter-selected',
        modules: JSON.stringify(modules),
        rejected: JSON.stringify([...rejected, ...selectionRejected]),
      })
      return {
        async lifecycle(target, status) {
          if (closed) return
          documents[target] = status
          queue = queue.catch(() => {}).then(save).catch(error => {
            diagnostic({ event: 'codex-adapter-status-unavailable', reason: String(error) })
          })
          await queue
        },
        async close() {
          closed = true
          await queue.catch(() => {})
          await rm(file, { force: true })
        },
      }
    },
  }
}
