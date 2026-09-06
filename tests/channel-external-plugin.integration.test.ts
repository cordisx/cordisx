import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { ChannelManagerProjectionV1 } from '../packages/cli/src/renderer/channel-manager.js'

const entry = createRequire(import.meta.url).resolve('@cordisx/channel')
const packageRoot = path.dirname(path.dirname(entry))

const projection: ChannelManagerProjectionV1 = {
  contract: 'cordisx.channel-manager-projection/v1',
  schemaVersion: 1,
  status: 'verified',
  service: {
    configurationKind: 'host',
    configApplies: 'service-restart',
    revision: 1,
    lastGoodRevision: 1,
    writable: true,
  },
  connections: [],
  routes: [],
  accounts: [],
  bindings: [],
  logs: [],
  diagnostics: [],
}

describe('external Channel consumer', () => {
  it('loads both runtime entries from the exact standalone package', async () => {
    const imported = await import(pathToFileURL(entry).href) as {
      readonly manifest: { readonly id: string; readonly schemaVersion: number; readonly services: readonly unknown[] }
    }
    expect(imported.manifest).toMatchObject({ id: 'channel', schemaVersion: 8 })
    expect(imported.manifest.services).toHaveLength(1)
    await expect(access(path.join(packageRoot, 'dist', 'service.mjs'))).resolves.toBeUndefined()
    await expect(readFile(path.join(packageRoot, 'src', 'channel.ts'))).rejects.toThrow()
  })

  it('builds the Host renderer composition from the external export', async () => {
    const source = await buildRendererBundle({
      version: 1,
      rootDir: packageRoot,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'channel', entry, enabled: true, config: {} }],
    }, { profileId: 'work', channelManager: projection })
    expect(source).toContain('/manager/extensions/channels')
    expect(source).not.toContain('packages/cli/src/plugins/channel')
    expect(source).not.toContain('channelManagerLegacy')
  })
})
