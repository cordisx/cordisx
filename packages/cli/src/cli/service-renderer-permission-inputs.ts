import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { parseConfigDocument } from '../launcher/config.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ServiceRendererBootstrapEntry } from './service-renderer-bootstrap-state.js'

/** Recheck the effective owner config and the selected configured archive without staging it again. */
export async function serviceRendererPermissionInputsCurrent(input: {
  readonly entry: ServiceRendererBootstrapEntry
  readonly profileId: string
  readonly pluginId: string
  readonly signal: AbortSignal
  readonly isCurrent: () => boolean
}): Promise<boolean> {
  try {
    const config = input.entry.config
    if (!config?.configPath || !config.projectRoot || input.signal.aborted || !input.isCurrent()) return false
    const raw = await readFile(config.configPath)
    const parsed = parseConfigDocument(JSON.parse(raw.toString('utf8')), config.configPath, {
      profileId: input.profileId,
      projectRoot: config.projectRoot,
    })
    const { plugins: loaded, ...expectedConfig } = config
    const { plugins: configured, ...actualConfig } = parsed
    const expectedPlugins = loaded.map(plugin => {
      const archive = plugin.configuredArchiveDigest !== undefined
      if (archive && plugin.manifestFiles?.length !== 1) throw new Error('configured archive is unavailable')
      return {
        id: plugin.id,
        entry: archive ? plugin.manifestFiles![0]! : plugin.entry,
        ...(plugin.developmentIdentityEntry === undefined ? {} : {
          developmentIdentityEntry: plugin.developmentIdentityEntry,
        }),
        enabled: plugin.enabled,
        config: plugin.config,
        revision: plugin.revision ?? 0,
      }
    })
    if (!attachmentEqual(expectedConfig, actualConfig) || !attachmentEqual(expectedPlugins, configured)) return false
    const selected = loaded.find(plugin => plugin.id === input.pluginId)
    if (selected?.configuredArchiveDigest !== undefined) {
      const archive = selected.manifestFiles?.[0]
      const integrity = selected.distributionArtifact?.integrity
      if (!archive || !integrity) return false
      const before = await stat(archive, { bigint: true })
      if (!before.isFile()) return false
      const digest = createHash('sha256')
      const stream = createReadStream(archive, {
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]),
      })
      for await (const chunk of stream) digest.update(chunk)
      const after = await stat(archive, { bigint: true })
      if (
        !after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || `sha256:${digest.digest('hex')}` !== integrity
      ) return false
    }
    const confirmed = await readFile(config.configPath)
    return raw.equals(confirmed) && !input.signal.aborted && input.isCurrent()
  } catch {
    return false
  }
}
