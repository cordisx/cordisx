import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindHeadlessCatalog } from '../packages/cli/src/launcher/headless-catalog-binding.js'

describe('headless catalog binding', () => {
  it('requires the same running server to report the same catalog and unchanged bytes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-binding-'))
    try {
      const file = path.join(directory, 'catalog.json'), bytes = Buffer.from('{"models":[{"slug":"m"}]}')
      await writeFile(file, bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      let reported = file
      const server = {
        generation: 'server-1',
        close: async () => {},
        request: async (method: string) =>
          method === 'config/read'
            ? { config: { model_catalog_json: reported } }
            : { requirements: { modelCatalogJson: null } },
      }
      const input = {
        server: server as never,
        catalog: { path: file, bytes, sha256 },
        nativeVersion: '0.167.0-alpha.3.2',
        cwd: directory,
      }
      expect(await bindHeadlessCatalog(input)).toMatchObject({ serverId: 'server-1', catalogSha256: sha256 })
      reported = '/different/catalog'
      expect(await bindHeadlessCatalog(input)).toBeUndefined()
      reported = file
      await writeFile(file, '{}')
      expect(await bindHeadlessCatalog(input)).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
