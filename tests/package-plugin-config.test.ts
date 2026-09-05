import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'

describe('package plugin configuration store', () => {
  it('publishes CAS candidates, restores last-good on abort, and recovers a stale generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-package-config-'))
    try {
      const first = new PackagePluginConfigStore(root, 'work', 'runtime-a')
      expect(await first.load('fixture')).toEqual({ revision: 0, config: {} })
      expect(await first.stage('fixture', 0, { timeout: 30 }, 'a'.repeat(64))).toEqual({ candidateRevision: 1 })
      await expect(first.stage('fixture', 0, { timeout: 45 }, 'a'.repeat(64))).rejects.toMatchObject({
        actualRevision: 0,
      })
      await first.abort('fixture', 1, 'a'.repeat(64))
      expect(await first.load('fixture')).toEqual({ revision: 0, config: {} })

      await first.stage('fixture', 0, { timeout: 45 }, 'a'.repeat(64))
      expect(await first.commit('fixture', 1, 'a'.repeat(64))).toEqual({ revision: 1, config: { timeout: 45 } })
      await first.stage('fixture', 1, { timeout: 60 }, 'a'.repeat(64))
      const second = new PackagePluginConfigStore(root, 'work', 'runtime-b')
      expect(await second.load('fixture')).toEqual({ revision: 1, config: { timeout: 45 } })
      const stored = JSON.parse(
        await readFile(path.join(root, 'state/profiles/work/plugins/config/fixture.json'), 'utf8'),
      ) as { candidate?: unknown }
      expect(stored.candidate).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
